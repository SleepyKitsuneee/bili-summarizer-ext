// background.js —— 任务编排（v0.1.2）
// 协议变更：offscreen 通信全部走 chrome.runtime 消息（实测 client.postMessage 通道不通）。
// 多标签页并行：每个标签页独立任务状态；千问页面阶段全局排队，其余阶段并行。
import { getVideoContext, getPlayurlDash, pickStreams, downloadStream, parseBvid, setLog as setBiliLog } from './lib/bilibili.js';
import { pollAnswer, probeChat, setLog as setQwenLog, setPageFetch, setProbeApis } from './lib/qwen.js';
import { u8ToB64, b64ToU8 } from './lib/b64.js';
import { cdpEnsureActive } from './lib/cdp.js';
import { parseSummaryJson } from './lib/json.js';
import * as dlog from './lib/dlog.js';

const OFFSCREEN = 'offscreen/offscreen.html';
const QWEN_HOME = 'https://chat.qwen.ai/';
const DNR_RULE_ID = 20260925;
const DEFAULT_MODEL = 'Qwen3.8-Omni-Flash';
const DEFAULT_PREAMBLE = [
  '请完整观看或收听这段视频，然后严格按照下面的 JSON 结构输出总结。',
  '总结总长度约 2000 字。',
  '硬性要求：',
  '1. 只输出一个 JSON 对象本体：不要 markdown 代码块、不要任何解释文字或前后缀。',
  '2. 字段名、层级、顺序必须与给定结构完全一致，不得增删字段。',
  '3. 「内容类型」从 数码测评/知识科普/访谈对话/教程教学/杂谈闲聊/游戏/生活Vlog/其他 里选一个。',
  '4. 「结论」80 字以内，开篇即给观众的核心判断与推荐。',
  '5. 「核心要点」5-8 条，每条 30 字以内。',
  '6. 「争议或不足」只写视频明确吐槽或指出的问题，没有就留空数组。',
  '7. 「分段摘要」按时间轴从前往后，8-15 段，尽量覆盖全片；时间点用 mm:ss 或 mm:ss-mm:ss；每段「主题」10 字以内、「要点」60 字以内。',
  '8. 「关键词」5-10 个。',
  '9. 除「分段摘要」是对象数组外，其余数组的每一项都是字符串。',
  '10. 只写视频里真实出现的内容，不要编造；视频没提到的信息用空字符串或空数组。',
].join('\n');
const STEPS = ['读取视频信息', '下载视频', '本地合流', '上传到千问', '发送给模型', 'AI 生成'];
const FF_CHUNK = 4 * 1024 * 1024;

// ── 运行日志 ──
// 三路输出，各有分工：
//   1) runLog 内存数组   → 侧边栏「日志」面板实时看（上限 1500 行）
//   2) chrome.storage.session → SW 重启不丢（浏览器退出清空）
//   3) lib/dlog.js 队列  → sidepanel 刷进本地 bili-ext\debug.log（永久保留）
// 格式：HH:MM:SS.mmm|LVL|TAG|tab<id>|消息 —— 单行，方便 grep。
let runLog = [];
const LOG_MAX = 1500;
const LOG_LINE_MAX = 4000;          // 单行上限（ffmpeg stderr / 模型原文需要长一些）
let logSaveTimer = null;
function logRun(msg, level = 'INFO', tag = '') {
  const t = new Date();
  const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
  let body = String(msg);
  if (body.length > LOG_LINE_MAX) {
    body = body.slice(0, LOG_LINE_MAX) + `…（截断，原长 ${String(msg).length}）`;
  }
  // 消息自带 [xx] 前缀时沿用它当 TAG，省得每个调用点都传参
  let useTag = tag;
  const m = body.match(/^\[([^\]]{1,20})\]\s*/);
  if (!useTag && m) { useTag = m[1]; body = body.slice(m[0].length); }
  const line = `${ts}|${level}|${useTag || 'LOG'}|${body}`;
  runLog.push(line);
  if (runLog.length > LOG_MAX) runLog.splice(0, runLog.length - LOG_MAX);
  dlog.enqueue(line);                                   // 进落盘队列
  // ERROR 级立刻推盘：SW 可能随时被回收，错误现场最不能丢
  if (level === 'ERROR') dlog.flushBuffer().catch(() => {});
  clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => chrome.storage.session.set({ runlog: runLog }).catch(() => {}), 300);
}
const logInfo = (msg, tag) => logRun(msg, 'INFO', tag);
const logWarn = (msg, tag) => logRun(msg, 'WARN', tag);
const logErr = (msg, tag) => logRun(msg, 'ERROR', tag);
// 把 logRun 注入 lib 层（避免 lib 反向 import background 造成循环依赖）
setBiliLog((m) => logRun(m, 'DEBUG', 'NET'));
setQwenLog((m) => logRun(m, 'DEBUG', 'QWEN'));
// 把「页面代理」注入 qwen.js：读会话必须从 chat.qwen.ai 页面内部发请求。
// 原因：SW 的 fetch 算第三方请求，千问登录 cookie 是 SameSite=Lax，不会发出，
// 接口直接返回 {"success":false,"data":{"code":"Unauthorized"}}。
setPageFetch(async (url, init = {}) => {
  // 优先用当前记录的千问标签页；后台重启后 qwenTabId 可能为 null，兜底查一次
  let tabId = qwenTabId;
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*'] }).catch(() => []);
    tabId = tabs[0]?.id ?? null;
    if (tabId != null) {
      qwenTabId = tabId;
      logRun(`[代理] qwenTabId 丢失，兜底找回标签页 ${tabId}`, 'WARN', 'GEN');
    }
  }
  if (tabId == null) throw new Error('千问标签页未就绪，无法代理请求');
  const r = await chrome.tabs.sendMessage(tabId, {
    type: 'QWEN_API_FETCH',
    url,
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body,
  }).catch((e) => { throw new Error('页面代理失败：' + e.message); });
  if (!r?.ok) throw new Error('页面代理失败：' + (r?.error || '未知'));
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json, text: r.text, page: r.page };
});

// 接口普查：读会话失败时把所有候选接口都试一遍，日志里能看到哪个能通
async function probeApis(chatId) {
  let tabId = qwenTabId;
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*'] }).catch(() => []);
    tabId = tabs[0]?.id ?? null;
  }
  if (tabId == null) { logRun('[普查] 没有千问标签页，跳过', 'WARN', 'QWEN'); return; }
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PROBE_APIS', chatId });
    if (!r?.ok) { logRun(`[普查] 失败：${r?.error || '未知'}`, 'WARN', 'QWEN'); return; }
    logRun(`[普查] 页面位置=${r.href}`, 'INFO', 'QWEN');
    for (const x of r.results || []) {
      if (x.error) logRun(`[普查] ${x.path} → 异常 ${x.error}`, 'WARN', 'QWEN');
      else logRun(`[普查] ${x.path} → HTTP ${x.status} · success=${x.success} · code=${x.code}`
        + ` · ${x.ms}ms · 顶层=[${x.keys}] · data=[${x.dataKeys}] · ${x.head}`, 'INFO', 'QWEN');
    }
  } catch (e) {
    logRun(`[普查] 异常：${String(e?.message ?? e)}`, 'WARN', 'QWEN');
  }
}
setProbeApis(probeApis);
// 异常专用：连 stack 一起记，只看 message 往往定位不到行号
function logEx(prefix, e, tag = 'EXC') {
  const msg = e?.message ?? e;
  const stack = String(e?.stack || '').split('\n').slice(0, 6).join(' ⏎ ');
  logRun(`${prefix}：${msg}${stack ? ' ⏎ ' + stack : ''}`, 'ERROR', tag);
}
async function loadRunLog() {
  if (runLog.length) return runLog;
  const got = await chrome.storage.session.get('runlog').catch(() => ({}));
  if (got && Array.isArray(got.runlog)) runLog = got.runlog;
  return runLog;
}
// SW 冷启动：恢复日志并打生命周期标记（含环境快照，出问题时能确认版本/UA）
(async () => {
  try {
    await loadRunLog();
    logRun('── SW 启动/唤醒（内存已清空，以下为新生命周期）──', 'INFO', 'BOOT');
    try {
      const mf = chrome.runtime.getManifest();
      logRun(`扩展 v${mf.version} · MV${mf.manifest_version} · UA=${navigator.userAgent}`, 'INFO', 'ENV');
    } catch {}
  } catch {}
})();

// ── 小工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeName = (s) => String(s || 'video').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
let SCHEMA = null;
async function schema() {
  if (!SCHEMA) SCHEMA = await (await fetch(chrome.runtime.getURL('summary_schema.json'))).json();
  return SCHEMA;
}
function buildPrompt(schema, preamble) {
  return preamble + '\n\nJSON 结构：\n' + JSON.stringify(schema, null, 2);
}

// ── 保活（引用计数：有任务才保活）──
let keepalive = null;
let activeTasks = 0;
function startKeepalive() {
  activeTasks++;
  if (!keepalive) keepalive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 25_000);
}
function stopKeepalive() {
  activeTasks = Math.max(0, activeTasks - 1);
  if (activeTasks === 0 && keepalive) { clearInterval(keepalive); keepalive = null; }
}

// ── 每标签页任务状态（持久化，SW 被回收也不丢）──
const taskStates = new Map();   // tabId -> {busy, steps, details, stepTitle, error, done, result}
const STATE_KEY = (tabId) => 'tabstate_' + tabId;
const saveTimers = new Map();

function flushState(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.delete(tabId);
  const s = taskStates.get(tabId);
  if (s) chrome.storage.session.set({ [STATE_KEY(tabId)]: s }).catch(() => {});
}
function scheduleSave(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => flushState(tabId), 400));
}
async function loadState(tabId) {
  if (taskStates.has(tabId)) return taskStates.get(tabId);
  const key = STATE_KEY(tabId);
  const got = await chrome.storage.session.get(key).catch(() => ({}));
  if (got && got[key]) taskStates.set(tabId, got[key]);
  return taskStates.get(tabId) || null;
}

function getState(tabId) {
  let s = taskStates.get(tabId);
  if (!s) {
    s = { busy: false, steps: {}, details: {}, stepTitle: '', error: null, done: false, result: null };
    taskStates.set(tabId, s);
  }
  return s;
}
function report(tabId, step, detail = '') {
  const s = getState(tabId);
  if (step === '失败') { s.error = detail; s.busy = false; }
  else if (step === '完成') {
    for (const n of STEPS) s.steps[n] = 'done';
    s.busy = false; s.done = true; s.details['完成'] = detail;
  } else {
    if (STEPS.includes(step)) s.steps[step] = 'running';
    if (detail) s.details[step] = detail;
    if (step === '读取视频信息' && detail) s.stepTitle = detail;
  }
  // 进度日志去重 + 降频：下载/合流进度每 1% 都会回调，逐条记会把日志刷爆
  //（实测一次任务 2537 行里 600+ 行是「视频 0%/1%/2%…」，加上音频/合流/传输共 1010 行）。
  // 规则：
  //   · 百分比类进度每 10% 记一行（0/10/20…/100）
  //   · 用「阶段+前缀」做独立游标，视频/音频/合流/传输互不干扰
  //   · 其他 detail 变化时才记
  //   · 失败/完成永远记
  const PCT_STEP = 10;
  const pctMatch = detail.match(/^(\D*)(\d+)%$/);
  let shouldLog;
  if (pctMatch) {
    const pct = parseInt(pctMatch[2], 10);
    const bucket = Math.floor(pct / PCT_STEP) * PCT_STEP;
    const key = `${step}|${pctMatch[1]}`;                 // 例：下载视频|视频
    if (!s._pctCursors) s._pctCursors = {};
    shouldLog = s._pctCursors[key] !== bucket;             // 每个前缀独立比较档位
    if (shouldLog) s._pctCursors[key] = bucket;
  } else {
    shouldLog = s._lastLogKey !== `${step}|${detail}`;
    if (shouldLog) s._lastLogKey = `${step}|${detail}`;
  }
  if (step === '失败' || step === '完成') shouldLog = true;   // 关键节点永远记
  if (shouldLog) {
    logRun(`[进度] 标签页${tabId} · ${step}${detail ? ' · ' + detail : ''}`,
      step === '失败' ? 'ERROR' : 'INFO', 'STEP');
  }
  if (step === '完成' || step === '失败') {
    flushState(tabId);                               // 关键节点立刻落盘
    // 日志：先把队列推完，再请 sidepanel 写文件（SW 自己写不了文件）
    dlog.flushBuffer()
      .then(() => chrome.runtime.sendMessage({ type: 'LOG_FLUSH_NOW' }))
      .catch(() => {});
  } else scheduleSave(tabId);
  chrome.runtime.sendMessage({ type: 'PROGRESS', tabId, step, detail }).catch(() => {});
}

// ── DNR：给 bilivideo CDN 的请求改 Referer（防盗链）──
async function ensureDNR() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [{
      id: DNR_RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
      ] },
      condition: {
        requestDomains: ['bilivideo.cn', 'bilivideo.com'],
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });
}

// ── offscreen ffmpeg（runtime 消息协议）──
function waitOffscreenModuleReady(maxMs = 20_000) {
  return new Promise((res, rej) => {
    const listener = (msg) => {
      if (msg?.type === 'OFFSCREEN_READY') { cleanup(); res(); }
      return false;
    };
    const timer = setTimeout(() => { cleanup(); rej(new Error('offscreen 文档加载超时')); }, maxMs);
    function cleanup() { clearTimeout(timer); chrome.runtime.onMessage.removeListener(listener); }
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (ctx.length) return;
  const ready = waitOffscreenModuleReady();          // 先挂监听再创建，防错过消息
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL(OFFSCREEN),
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'ffmpeg.wasm 本地合流',
  });
  await ready;
}

// 合流结果回收（offscreen 分块回传 base64，这里收集解码）
const ffJobs = new Map();     // taskId -> { b64s: [], resolve, reject }

// 二进制分块发送（runtime 消息是 JSON 序列化，必须 base64；逐块 ack 保序）
async function sendChunks(type, taskId, u8, which, onProgress) {
  const total = Math.ceil(u8.byteLength / FF_CHUNK);
  for (let seq = 0; seq < total; seq++) {
    const b64 = u8ToB64(u8.subarray(seq * FF_CHUNK, (seq + 1) * FF_CHUNK));
    const r = await chrome.runtime.sendMessage({ type, taskId, which, seq, total, b64 });
    if (!r?.ok) throw new Error('对端未确认数据块 ' + seq);
    onProgress?.((seq + 1) / total);
  }
}

async function offscreenMerge(taskId, vBuf, aBuf, onProgress, opts = {}) {
  await ensureOffscreen();
  const v = new Uint8Array(vBuf), a = new Uint8Array(aBuf);
  const job = { b64s: [] };
  const doneP = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
  const timer = setTimeout(() => job.reject?.(new Error('合流超时（10 分钟）')), 10 * 60_000);
  ffJobs.set(taskId, job);
  try {
    const totalBytes = v.byteLength + a.byteLength;
    let sentBytes = 0;
    await chrome.runtime.sendMessage({ type: 'FF_BEGIN', taskId, vTotal: Math.ceil(v.byteLength / FF_CHUNK), aTotal: Math.ceil(a.byteLength / FF_CHUNK) });
    await sendChunks('FF_MERGE_CHUNK', taskId, v, 'video', (p) => { sentBytes += v.byteLength / Math.ceil(v.byteLength / FF_CHUNK); onProgress?.(sentBytes / totalBytes); });
    await sendChunks('FF_MERGE_CHUNK', taskId, a, 'audio', (p) => { sentBytes += a.byteLength / Math.ceil(a.byteLength / FF_CHUNK); onProgress?.(sentBytes / totalBytes); });
    await chrome.runtime.sendMessage({ type: 'FF_MERGE_RUN', taskId, forceAvc: !!opts.forceAvc });
    return await doneP;
  } finally {
    clearTimeout(timer);
    ffJobs.delete(taskId);
  }
}

// ── qwen 标签页 ──
// 等标签页加载完成。
// ⚠️ 竞态：导航刚发起时，chrome.tabs.get() 还可能返回**旧页面**的 status==='complete'，
// 这时会立刻误判为「已加载完」。所以要连续两次读到 complete 且 URL 没变才算稳。
async function waitForTabComplete(tabId, maxMs = 60_000) {
  const t0 = Date.now();
  let lastUrl = null, stableHits = 0;
  while (Date.now() - t0 < maxMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('qwen 标签页被关闭');
    if (t.status === 'complete') {
      if (t.url === lastUrl) {
        stableHits++;
        if (stableHits >= 2) { await sleep(1200); return; }
      } else {
        lastUrl = t.url;
        stableHits = 0;
      }
    } else {
      stableHits = 0;
      lastUrl = t.url;
    }
    await sleep(400);
  }
  throw new Error('qwen 页面加载超时');
}

// 按需注入 MAIN world 补丁（qwen-main-patch.js）。
// 它负责拦 #filesUpload.click()、抓网络证据、抓创建会话的 chat_id。
// 正常由 manifest 的 document_start + world:MAIN 自动注入，
// 但扩展重载后已打开的页面里没有它 → dataset.qwenPatch 不存在 → 附件注入会失败。
// 幂等：补丁内部有 window.__qwenPatch 守卫，重复注入安全。
async function ensureMainPatch(tabId) {
  try {
    const has = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PING_PATCH' });
    if (has?.ok) return true;
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/qwen-main-patch.js'],
      world: 'MAIN',
    });
    await sleep(300);
    const has = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PING_PATCH' });
    if (has?.ok) {
      logRun(`[补丁] MAIN world 补丁按需注入成功（tabId=${tabId}）`, 'INFO', 'GEN');
      return true;
    }
    logRun(`[补丁] 注入后仍未检测到（tabId=${tabId}）`, 'WARN', 'GEN');
    return false;
  } catch (e) {
    logRun(`[补丁] MAIN world 注入失败：${String(e?.message ?? e)}`, 'WARN', 'GEN');
    return false;
  }
}

// 确认 qwen 页面的驱动脚本在线；不在就按需注入（扩展重载后旧标签页会失效）
async function pingDriver(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PING' });
    return !!r?.ok;
  } catch (e) {
    pingDriver._lastErr = String(e?.message ?? e);
    return false;
  }
}
async function ensureDriver(tabId, ours) {
  // MAIN world 补丁也要按需注入：它只在 document_start 自动注入，
  // 扩展重载后已打开的旧页面里没有 → dataset.qwenPatch 不存在 → 附件注入会直接抛错。
  await ensureMainPatch(tabId);
  if (await pingDriver(tabId)) return;
  // 1) 按需注入
  let injectErr = '';
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/qwen-driver.js'],
    });
  } catch (e) { injectErr = String(e?.message ?? e); }
  await sleep(1200);
  if (await pingDriver(tabId)) return;
  // 2) 仍然没有（页面可能被休眠/丢弃）——重载一次再试（自己的页面优先，用户页面也试一次）
  logRun(`[驱动] 注入后仍未就绪，尝试重载标签页 ${tabId}`
    + `（注入错误=${injectErr || '无'} · ping错误=${pingDriver._lastErr || '无'}）`, 'WARN', 'GEN');
  try {
    await chrome.tabs.reload(tabId);
  } catch (e) {
    logRun(`[驱动] 重载失败：${String(e?.message ?? e)}`, 'WARN', 'GEN');
  }
  await waitForTabComplete(tabId);
  await sleep(1500);
  if (await pingDriver(tabId)) return;
  // 3) 再试一次注入（重载后 manifest 的 content script 应该已自动注入，
  //    但扩展重载过的旧页面可能没有）
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/qwen-driver.js'] });
  } catch {}
  await sleep(1200);
  if (await pingDriver(tabId)) return;
  // 4) 最后诊断：把现场记清楚
  const t = await chrome.tabs.get(tabId).catch(() => null);
  logRun(`[驱动] 最终失败：tabId=${tabId} · URL=${t?.url || '(取不到)'}`
    + ` · status=${t?.status ?? '?'} · 注入错误=${injectErr || '无'}`
    + ` · ping错误=${pingDriver._lastErr || '无'} · 是自己创建的=${ours}`, 'ERROR', 'GEN');
  throw new Error(`千问页面驱动脚本未就绪（tabId=${tabId}, URL=${t?.url || '未知'}）。`
    + `请确认 chat.qwen.ai 标签页可正常打开并已登录。`);
}

// 检查千问页面是否真的可用（不是错误页 / 网络错误提示）。
// 实测：新开的后台标签页首屏可能弹「网络错误」toast（后台标签页被限流），
// 提示框几秒后自动消失，页面随后恢复正常 —— 所以这里要多等一会儿再判定。
async function checkQwenPageReady(tabId, maxMs = 30_000) {
  const t0 = Date.now();
  let lastState = '';
  while (Date.now() - t0 < maxMs) {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PAGE_STATE' }).catch(() => null);
    if (r?.ok) {
      const st = `err=${r.error ? 1 : 0}·login=${r.hasLogin ? 1 : 0}·title=${(r.title || '').slice(0, 30)}`;
      if (st !== lastState) {
        lastState = st;
        logRun(`[页面] 状态变化：${st} · 有正文=${r.hasBody ? 1 : 0} · 文字长度=${r.textLen || 0}`, 'DEBUG', 'GEN');
      }
      // 没有网络错误、且页面有实质内容 → 认为就绪
      if (!r.error && r.hasBody && (r.textLen || 0) > 200) return { ok: true };
    } else {
      if (lastState !== 'no-reply') {
        lastState = 'no-reply';
        logRun('[页面] 还没有回复状态查询（driver 尚未就绪）', 'DEBUG', 'GEN');
      }
    }
    await sleep(1000);
  }
  const r = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PAGE_STATE' }).catch(() => null);
  logRun(`[页面] 等待就绪超时（${((Date.now() - t0) / 1000).toFixed(0)}s）`
    + ` · 状态=${lastState || '未知'}`
    + (r?.ok ? ` · 错误提示=${r.error || '无'} · 文字长度=${r.textLen || 0}` : ''), 'WARN', 'GEN');
  return { ok: false, state: lastState, page: r };
}

let qwenTabId = null;
let qwenTabOurs = false;
const onQwenRoot = (u) => /^https:\/\/chat\.qwen\.ai\/?(\?.*)?$/.test(u || '');
// 导航到首页并等它真的就绪。
// 踩过的坑：chrome.tabs.update() 是异步的，调用后立刻 waitForTabComplete
// 可能读到「导航还没开始」时旧页面的 status==='complete'，于是立刻返回，
// 接着 ensureDriver 在导航中的页面上注入脚本 → 页面刷新 → driver 丢失 →
// 「千问页面驱动脚本未就绪」。
// 找到（或创建）**唯一一个**千问标签页，全程后台静默，不抢用户当前标签页。
// 需求：① 千问页不要突然切到前台；② 每次运行都开新标签页 → 改成只用一个。
// 做法：
//   · 优先用已记录的 qwenTabId，其次用已打开的 chat.qwen.ai 标签页，都没有才新建
//   · 新建时用 active:false（后台），再用 CDP 激活页面（Emulation.setFocusEmulationEnabled
//     + Page.setWebLifecycleState）——后台标签页被浏览器限流会弹「网络错误」toast，
//     CDP 能让它保持 active 且不抢焦点，这是 lib/cdp.js 已经在用的成熟方案。
//   · 每次任务前把页面导航回首页（保证「每次总结一个新会话」），但导航期间也要 CDP 保活
let cdpKeepAlive = null;              // 当前千问页的 CDP 会话（保活用）
let cdpKeepAliveTimer = null;         // 空闲多久后释放（避免浏览器一直显示「正在调试」提示条）
let cdpKeepAliveHeartbeat = null;     // 心跳：定期重新 apply 焦点模拟，防止被浏览器重新节流

async function cdpKeepAliveOn(tabId, { force = false } = {}) {
  try {
    if (cdpKeepAlive && !force) {
      // 已有会话：只要重新 apply 一次焦点模拟即可（心跳）
      try {
        await cdpKeepAlive.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await cdpKeepAlive.send('Page.setWebLifecycleState', { state: 'active' });
      } catch {}
      cdpKeepAliveTimer && clearTimeout(cdpKeepAliveTimer);
      cdpKeepAliveTimer = setTimeout(cdpKeepAliveOff, 120_000);
      cdpKeepAliveHeartbeat && clearInterval(cdpKeepAliveHeartbeat);
      cdpKeepAliveHeartbeat = setInterval(() => {
        cdpKeepAlive?.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      }, 10_000);
      return;
    }
    // 需要新 attach（force=true：导航后重挂）
    if (cdpKeepAlive) { try { cdpKeepAlive.detach(); } catch {} cdpKeepAlive = null; }
    cdpKeepAlive = await cdpEnsureActive(tabId, 3, (m) => logRun(`[CDP-保活] ${m}`, 'DEBUG', 'CDP'));
    logRun(`[CDP-保活] 已激活千问页 ${tabId}（第 ${cdpKeepAlive.attempts} 次）· 状态=${JSON.stringify(cdpKeepAlive.state)}`, 'INFO', 'CDP');
    cdpKeepAliveTimer && clearTimeout(cdpKeepAliveTimer);
    cdpKeepAliveTimer = setTimeout(cdpKeepAliveOff, 120_000);
    cdpKeepAliveHeartbeat && clearInterval(cdpKeepAliveHeartbeat);
    cdpKeepAliveHeartbeat = setInterval(() => {
      cdpKeepAlive?.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }, 10_000);
  } catch (e) {
    logRun(`[CDP-保活] 激活失败：${String(e?.message ?? e)}`, 'WARN', 'CDP');
    cdpKeepAlive = null;
  }
}
function cdpKeepAliveOff() {
  if (cdpKeepAliveTimer) { clearTimeout(cdpKeepAliveTimer); cdpKeepAliveTimer = null; }
  if (cdpKeepAliveHeartbeat) { clearInterval(cdpKeepAliveHeartbeat); cdpKeepAliveHeartbeat = null; }
  if (!cdpKeepAlive) return;
  try { cdpKeepAlive.detach(); } catch {}
  cdpKeepAlive = null;
  logRun('[CDP-保活] 已释放（空闲超时，浏览器不再显示调试提示条）', 'INFO', 'CDP');
}

// 最后的兜底：把千问标签页切到前台一小会儿再切回。
// 前台标签页绝对不会被 Chrome 节流，所以「切过去 2 秒再切回来」能保证
// 页面里的 MessageChannel / fetch 全部跑完（上传、发送、生成）。
// 代价是会短暂抢一下焦点，所以只在真的被节流时用。
async function flashForeground(tabId, ms = 2500) {
  const cur = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const prev = cur[0]?.id ?? null;
  try {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await sleep(ms);
  } finally {
    if (prev != null && prev !== tabId) {
      await chrome.tabs.update(prev, { active: true }).catch(() => {});
    } else {
      await chrome.tabs.update(tabId, { active: false }).catch(() => {});
    }
  }
  logRun(`[前台闪现] 千问页 ${tabId} 已切到前台 ${ms}ms 后切回（原标签页 ${prev ?? '无'}）`, 'INFO', 'GEN');
}

async function ensureQwenTab() {
  // ① 优先用已记录的标签页
  let tabId = null;
  if (qwenTabId != null && await chrome.tabs.get(qwenTabId).catch(() => null)) {
    tabId = qwenTabId;
  } else {
    qwenTabId = null;
    // ② 其次用已打开的 chat.qwen.ai 标签页（用户自己开的那个）
    const tabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*'] });
    if (tabs.length) {
      tabId = tabs[0].id;
      qwenTabOurs = false;
      logRun(`[标签页] 复用已打开的千问标签页 ${tabId}`, 'INFO', 'GEN');
    }
  }
  // ③ 都没有 → 新建一个（后台打开，不抢焦点）
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: QWEN_HOME, active: false, pinned: true });
    tabId = tab.id;
    qwenTabOurs = true;
    qwenTabId = tabId;
    logRun(`[标签页] 新建千问标签页 ${tabId}（后台打开，不抢焦点）`, 'INFO', 'GEN');
    await waitForTabComplete(tabId);
    await sleep(1000);
  }

  // ④ 保活（关键）：必须在**导航之前**就 attach 调试器。
  //    Page.setWebLifecycleState('active') 只在页面加载期有效，页面加载完再调用就无效了，
  //    于是后台标签页仍被 Chrome 节流（定时器最慢 1 次/分钟）→
  //    表现就是「不切到千问页，它就完全不响应；一切过去立刻开始上传」。
  //    无论标签页是新开的、复用的、还是已在首页，都必须保活。
  await cdpKeepAliveOn(tabId);

  // ⑤ 导航回首页（保证每次是新会话）
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && !onQwenRoot(t.url || '')) {
    logRun(`[标签页] 导航回首页（当前 ${t.url}）`, 'INFO', 'GEN');
    await chrome.tabs.update(tabId, { url: QWEN_HOME }).catch(() => {});
    const t0 = Date.now();
    for (;;) {
      const tt = await chrome.tabs.get(tabId).catch(() => null);
      if (!tt) break;
      if (onQwenRoot(tt.url || '')) break;
      if (Date.now() - t0 > 10_000) break;
      await sleep(200);
    }
    await waitForTabComplete(tabId);
    await sleep(800);
    // 导航会重置页面的生命周期状态 → 强制重新 attach（Page.setWebLifecycleState 只在加载期有效）
    await cdpKeepAliveOn(tabId, { force: true });
  }
  await checkQwenPageReady(tabId);
  await ensureDriver(tabId, qwenTabOurs);
  qwenTabId = tabId;
  return tabId;
}

// 触发页面流程；chatId/错误通过 storage 会话键回传——
// 不用内存握手：后台脚本中途被浏览器重启也不会丢（这是"卡在提交提问但结果已出"的根因）
const liveAskTabs = new Set();                       // 正在等回执的 qwen 标签页（存活 runTask）
const lastDriverBeat = new Map();                   // tabId -> driver 最后一次活动的时刻
async function askTab(qtab, taskTabId, payload) {
  liveAskTabs.add(qtab);
  lastDriverBeat.set(qtab, Date.now());
  logRun(`[提问] 已触发页面流程（qwenTab=${qtab}，文件=${payload.fileName}），开始轮询回执…`);
  try {
    await chrome.tabs.sendMessage(qtab, { type: 'QWEN_SEND', ...payload });
    const chatKey = 'pendingChat_' + qtab;
    const errKey = 'pendingErr_' + qtab;
    const t0 = Date.now();
    let flashed = false;
    while (Date.now() - t0 < 15 * 60_000) {
      const got = await chrome.storage.session.get([chatKey, errKey]).catch(() => ({}));
      if (got && got[errKey]) {
        const e = got[errKey];
        await chrome.storage.session.remove(errKey).catch(() => {});
        throw new Error(e);
      }
      if (got && got[chatKey]) {
        const chatId = got[chatKey];
        await chrome.storage.session.remove([chatKey, errKey]).catch(() => {});
        logRun(`[提问] 收到回执 chatId=${chatId}（等待 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        return { chatId };
      }
      // 节流检测：driver 收到 QWEN_SEND 后会立刻 report 一个 QWEN_STEP。
      // 如果 8 秒内毫无动静 → 页面被 Chrome 后台节流了（MessageChannel 任务不跑）。
      // 这时把页面切到前台一小会儿，让它把活干完（前台不会被节流）。
      const idle = Date.now() - (lastDriverBeat.get(qtab) || t0);
      if (!flashed && idle > 8000) {
        flashed = true;
        logRun(`[节流] driver 已 ${(idle / 1000).toFixed(1)}s 无响应，判定页面被后台节流`
          + ` · 切前台 ${2500}ms 让它跑起来`, 'WARN', 'GEN');
        await flashForeground(qtab, 2500);
        lastDriverBeat.set(qtab, Date.now());
      }
      await sleep(3000);
    }
    throw new Error('等待发送回执超时（15 分钟）');
  } finally {
    liveAskTabs.delete(qtab);
    lastDriverBeat.delete(qtab);
  }
}

// 任务元信息落盘：后台重启后可凭它 + chatId 恢复生成阶段
async function setActiveTask(meta) {
  logRun(`[恢复点] activeTask 已落盘（taskTabId=${meta.taskTabId}, qwenTabId=${meta.qwenTabId ?? '待定'}, bvid=${meta.bvid}）`);
  await chrome.storage.session.set({ activeTask: meta }).catch(() => {});
}
async function clearActiveTask() {
  logRun('[恢复点] activeTask 已清除');
  await chrome.storage.session.remove('activeTask').catch(() => {});
}

// ── 从千问页面 DOM 直接读答案（主方案）──
// 为什么：读会话接口 /api/v2/chats/{id} 对扩展发起的请求恒返回 Unauthorized
//（后端另有鉴权，桌面版能过是因为它把浏览器 cookie 复制进了 requests session）。
// 但页面自己能拿到并渲染回答 —— 直接读 DOM 完全绕开接口鉴权，最稳。
// 页面里的 assistant 气泡是流式渲染的，所以按「长度增长 + 不再生成中」判定完成。
async function pollAnswerFromDom(qtab, { maxMs = 25 * 60_000, onTick } = {}) {
  const t0 = Date.now();
  let lastLen = 0, stable = 0, ticks = 0, errors = 0;
  let best = '';
  for (;;) {
    if (Date.now() - t0 > maxMs) {
      throw new Error(`等待页面回答超时（${ticks} 次读取，${errors} 次失败，最长 ${best.length} 字）`);
    }
    await sleep(3000);
    ticks++;
    let r = null;
    try {
      r = await chrome.tabs.sendMessage(qtab, { type: 'QWEN_READ_DOM' });
    } catch (e) {
      errors++;
      const msg = String(e?.message ?? e);
      if (errors <= 3 || errors % 10 === 0) {
        logRun(`[DOM] 读取失败（累计 ${errors}）：${msg}`, 'WARN', 'GEN');
      }
      // 消息通道断了：驱动脚本可能掉了，重新注入后再试
      if (errors === 3) await ensureDriver(qtab, qwenTabOurs).catch(() => {});
      continue;
    }
    if (!r?.ok) {
      errors++;
      if (errors <= 3) logRun(`[DOM] 页面读取失败（累计 ${errors}）：${r?.error || '未知'}`, 'WARN', 'GEN');
      continue;
    }
    errors = 0;
    // 页面自己报了错（例如「输入或附件无效」）→ 立刻失败，把原文带出来
    if (r.error) {
      logRun(`[DOM] 页面显示错误：${r.error}`, 'ERROR', 'GEN');
      throw new Error(`千问页面报错：${r.error}`);
    }
    const text = String(r.text || '').trim();
    if (text.length > lastLen) {
      lastLen = text.length;
      best = text;
      stable = 0;
      onTick?.(text.length, '页面');
      logRun(`[DOM] 已读到 ${text.length} 字 · 选择器=${r.via} · 节点数=${r.count}`
        + ` · 各节点长度=[${(r.lengths || []).join(',')}]`
        + ` · 生成中=${r.generating} · 已等待 ${((Date.now() - t0) / 1000).toFixed(0)}s`, 'DEBUG', 'GEN');
    } else {
      stable++;
    }
    // 完成判定：不再生成中 + 长度连续 2 轮没变
    if (!r.generating && text.length > 0 && stable >= 2) {
      logRun(`[DOM] 判定生成结束：${text.length} 字 · 稳定 ${stable} 轮`
        + ` · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'INFO', 'GEN');
      return { text, model: '页面读取' };
    }
    if (r.generating) {
      stable = 0;
      if (ticks % 10 === 0) {
        logRun(`[DOM] 仍在生成中…已读 ${text.length} 字`
          + ` · 已等待 ${((Date.now() - t0) / 1000).toFixed(0)}s`, 'DEBUG', 'GEN');
      }
    }
  }
}

// 生成阶段（可从任意地方恢复执行）：轮询答案 → 解析 → 入历史 → 通知
let resuming = false;
async function finishGeneration(meta, chatId) {
  if (resuming) { logRun('[生成] 已有生成阶段在进行，跳过重复调用'); return; }
  resuming = true;
  startKeepalive();
  logRun(`[生成] 开始轮询答案 chatId=${chatId}（taskTabId=${meta.taskTabId}）`, 'INFO', 'GEN');
  const gT0 = Date.now();
  try {
    report(meta.taskTabId, 'AI 生成', '正在等待生成结果…');
    // 主方案：从千问页面 DOM 直接读（绕开接口鉴权）
    let text = '', model = '页面读取';
    const qtab = meta.qwenTabId ?? qwenTabId;
    if (qtab != null) {
      try {
        const r = await pollAnswerFromDom(qtab, {
          onTick: (len) => {
            report(meta.taskTabId, 'AI 生成', `已生成 ${len} 字`);
            logRun(`[生成] 页面已输出 ${len} 字 · 已等待 ${((Date.now() - gT0) / 1000).toFixed(0)}s`, 'DEBUG', 'GEN');
          },
        });
        text = r.text; model = r.model;
      } catch (e) {
        logEx('[DOM] 读取失败，回退到接口轮询', e, 'GEN');
      }
    }
    if (!text) {
      // 兜底：接口轮询（万一页面结构变了）
      logRun('[生成] 回退到接口轮询', 'WARN', 'GEN');
      const probe = await probeChat(chatId);
      if (probe.ok) {
        logRun(`[探针] chatId=${chatId} 有效 · 消息字段=${probe.messageKey || '未找到'}`
          + ` · 共 ${probe.total} 条 · assistant ${probe.assistants} 条`, 'INFO', 'GEN');
      } else {
        logRun(`[探针] chatId=${chatId} 校验未通过：${probe.error}`, 'WARN', 'GEN');
        await probeApis(chatId);
      }
      const r = await pollAnswer(chatId, {
        onTick: (len, m) => {
          report(meta.taskTabId, 'AI 生成', `已生成 ${len} 字（${m}）`);
          logRun(`[生成] 已取到 ${len} 字 · 模型=${m} · 已等待 ${((Date.now() - gT0) / 1000).toFixed(0)}s`, 'DEBUG', 'GEN');
        },
      });
      text = r.text; model = r.model;
    }
    logRun(`[生成] 回答完成：${text.length} 字 · 模型=${model} · 耗时 ${((Date.now() - gT0) / 1000).toFixed(1)}s`, 'INFO', 'GEN');
    logRun(`[生成] 回答原文：${text.replace(/\s+/g, ' ')}`, 'DEBUG', 'RAW');
    let data = null, err = null;
    try {
      data = parseSummaryJson(text);
      if (!data) err = '没能从回答里提取出 JSON 对象';
    } catch (e) { err = String(e); }
    if (data) {
      logRun(`[生成] JSON 解析成功，字段：${Object.keys(data).join('、')}`, 'INFO', 'GEN');
      if (meta.title) data['视频标题'] = meta.title;
      if (meta.up) data['UP主'] = meta.up;
      const m = meta.durationSec;
      if (m) data['时长'] = `${Math.floor(m / 60)}分${m % 60}秒`;
    } else {
      logRun(`[生成] JSON 解析失败：${err}`, 'WARN', 'GEN');
    }
    getState(meta.taskTabId).result = data || { 原始回答: text };
    flushState(meta.taskTabId);
    await saveHistory({
      bvid: meta.bvid, title: meta.title, up: meta.up, duration: meta.durationSec,
      durationText: meta.durationSec ? `${Math.floor(meta.durationSec / 60)}分${meta.durationSec % 60}秒` : '',
      thumb: meta.thumb, ts: Date.now(), model, summary: data || { 原始回答: text }, raw: text,
    });
    report(meta.taskTabId, '完成', `总结已生成（${text.length} 字，模型 ${model}）`);
    chrome.runtime.sendMessage({ type: 'TASK_DONE', tabId: meta.taskTabId, ok: !!data, data, err }).catch(() => {});
    await clearActiveTask();
  } catch (e) {
    logEx('[生成] 失败', e, 'GEN');
    report(meta.taskTabId, '失败', '生成阶段失败：' + String(e?.message ?? e));
    chrome.runtime.sendMessage({ type: 'TASK_FAILED', tabId: meta.taskTabId, error: String(e?.message ?? e) }).catch(() => {});
    await clearActiveTask();
  } finally {
    stopKeepalive();
    resuming = false;
  }
}

// SW 冷启动：若有未完成任务且 chatId 已回传，直接恢复生成阶段
(async () => {
  try {
    const { activeTask } = await chrome.storage.session.get('activeTask');
    if (!activeTask) return;
    const qkey = 'pendingChat_' + (activeTask.qwenTabId ?? '');
    const got = await chrome.storage.session.get(qkey);
    if (got && got[qkey]) {
      const chatId = got[qkey];
      await chrome.storage.session.remove(qkey).catch(() => {});
      finishGeneration(activeTask, chatId);          // 异步恢复，不阻塞 SW 启动
    }
    // 没有 chatId：driver 还在页面里跑，它会带确认重发 QWEN_SENT（handler 负责恢复）
  } catch {}
})();

// ── 分块直传：把合流后的 mp4 字节送进 qwen 页面（base64；页面随后走自己的原生上传）──
async function sendFileToTab(tabId, buf, fileName, onProgress) {
  const u8 = new Uint8Array(buf);
  const total = Math.ceil(u8.byteLength / FF_CHUNK);
  const t0 = Date.now();
  let retries = 0;
  for (let seq = 0; seq < total; seq++) {
    const b64 = u8ToB64(u8.subarray(seq * FF_CHUNK, (seq + 1) * FF_CHUNK));
    for (let retry = 0; ; retry++) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, {
          type: 'QWEN_FILE_CHUNK', id: fileName, seq, total, b64,
        });
        if (r?.ok === false) throw new Error('页面拒绝数据块');
        break;
      } catch (e) {
        retries++;
        logRun(`[传输] 块 ${seq + 1}/${total} 失败（第 ${retry + 1} 次）：${e.message}`, 'WARN', 'TX');
        if (retry >= 5) throw new Error('向 qwen 页面传文件失败：' + e.message);
        // 断连自愈：页面被刷新/丢弃时驱动会掉线，重新就绪后继续
        if (/Receiving end|Could not establish/i.test(e.message)) {
          await ensureDriver(tabId, qwenTabOurs).catch(() => {});
        }
        await sleep(1500);                              // 页面脚本可能还没就绪
      }
    }
    onProgress?.(Math.round((seq + 1) / total * 100));
    // 每 10 块（约 40MB）记一行，不再逐块刷屏
    if (total <= 12 || (seq + 1) % 10 === 0 || seq + 1 === total) {
      logRun(`[传输] 块 ${seq + 1}/${total} 已确认 · ${(b64.length / 1024).toFixed(0)}KB base64/块 · 累计 ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'DEBUG', 'TX');
    }
  }
  logRun(`[传输] 文件 ${fileName} 全部送达（${(u8.byteLength / 1024 / 1024).toFixed(2)}MB / ${total} 块 · 重试 ${retries} 次 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`, 'INFO', 'TX');
  await chrome.tabs.sendMessage(tabId, { type: 'QWEN_FILE_END', id: fileName, total });
}

// ── 历史记录 ──
async function saveHistory(rec) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(rec);
  await chrome.storage.local.set({ history: history.slice(0, 50) });
}

// ── 千问阶段全局排队（同一个 qwen 标签页不能被两个任务同时驱动）──
let qwenChain = Promise.resolve();
let qwenBusy = false;                // 当前是否有千问阶段正在跑
function enqueueQwen(fn) {
  // 只有前一个任务真的还在跑才提示排队。
  // 旧写法 `if (qwenChain !== run)` 永远为真（qwenChain 被赋成 run.catch()，是另一个 Promise），
  // 导致每次都误报「已有任务在跑，本任务排队等待」，掩盖真实时序。
  const busy = qwenBusy;
  const run = qwenChain.then(fn);
  qwenChain = run.catch(() => {});
  qwenBusy = true;
  run.finally(() => { qwenBusy = false; });
  if (busy) logRun('[队列] 千问阶段已有任务在跑，本任务排队等待');
  return run;
}

// ── 主流程（每个标签页独立并行）──
async function runTask(url, tabId) {
  const s = getState(tabId);
  if (s.busy) { report(tabId, '提示', '这个标签页已有任务在跑'); return; }
  s.busy = true; s.error = null; s.done = false; s.result = null;
  s.steps = {}; s.details = {}; s.stepTitle = '';
  startKeepalive();
  const bvid = parseBvid(url);
  logRun(`[任务] 开始 · 标签页${tabId} · url=${url} · bvid=${bvid ?? '解析失败'}`, 'INFO', 'TASK');
  const T0 = Date.now();
  const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
  if (!bvid) { report(tabId, '失败', '链接里没找到 BV 号'); stopKeepalive(); return; }

  try {
    report(tabId, '读取视频信息');
    const info = await getVideoContext(bvid);
    report(tabId, '读取视频信息', info.title);
    logRun(`[视频] 标题=${info.title} · UP=${info.up} · 时长=${info.durationSec}s · cid=${info.cid} · 分P=${info.pages.length} · 封面=${info.pic ? '有' : '无'}`, 'INFO', 'VIDEO');

    report(tabId, '下载视频', '360P + 64K');
    const dash = await getPlayurlDash(bvid, info.cid);
    if (!dash) throw new Error('playurl 返回空 dash（可能需要登录）');
    logRun(`[下载] dash 流数：视频 ${(dash.video || []).length} 条（id=${(dash.video || []).map(v => v.id).join(',')}）音频 ${(dash.audio || []).length} 条（id=${(dash.audio || []).map(a => a.id).join(',')}）`, 'INFO', 'DASH');
    const { video, audio } = pickStreams(dash, 16);
    if (!audio) throw new Error('没有可用的音频流');
    logRun(`[下载] 选流：视频 id=${video.id} codecs=${video.codecs} 带宽=${video.bandwidth}｜音频 id=${audio.id} 带宽=${audio.bandwidth}`, 'INFO', 'DASH');
    // 千问的 omni 模型解不了 HEVC/AV1，传上去只会得到「输入或附件无效」。
    // 选流已经优先 AVC，这里再兜一层：万一站点只给了非 AVC，提前报清楚。
    const codecs = String(video.codecs || '');
    if (codecs && !codecs.startsWith('avc')) {
      logRun(`[下载] 警告：选中流的编码是 ${codecs}（非 AVC），千问可能无法解码`, 'WARN', 'DASH');
    }
    logRun(`[下载] 视频URL=${(video.baseUrl || video.base_url || '').slice(0, 100)}`, 'DEBUG', 'DASH');
    logRun(`[下载] 音频URL=${(audio.baseUrl || audio.base_url || '').slice(0, 100)}`, 'DEBUG', 'DASH');
    let vBuf = await downloadStream(video.baseUrl || video.base_url,
      (g, t) => report(tabId, '下载视频', `视频 ${Math.round(g / t * 100)}%`));
    let aBuf = await downloadStream(audio.baseUrl || audio.base_url,
      (g, t) => report(tabId, '下载视频', `音频 ${Math.round(g / t * 100)}%`));
    logRun(`[下载] 完成：视频 ${(vBuf.byteLength / 1024 / 1024).toFixed(2)}MB + 音频 ${(aBuf.byteLength / 1024 / 1024).toFixed(2)}MB · 累计 ${el()}`, 'INFO', 'DL');

    report(tabId, '本地合流', '初始化 ffmpeg 引擎…');
    const mergeTaskId = `t${tabId}-${Date.now()}`;
    logRun(`[合流] 任务 ${mergeTaskId}：视频 ${vBuf.byteLength}B + 音频 ${aBuf.byteLength}B`, 'INFO', 'FF');
    const mT0 = Date.now();
    let merged = await offscreenMerge(mergeTaskId, vBuf, aBuf,
      (p) => report(tabId, '本地合流', `合流 ${Math.round(p * 100)}%`),
      { forceAvc: !String(video.codecs || '').startsWith('avc') });
    logRun(`[合流] 产物 ${(merged.byteLength / 1024 / 1024).toFixed(2)}MB · 耗时 ${((Date.now() - mT0) / 1000).toFixed(1)}s`, 'INFO', 'FF');
    vBuf = aBuf = null;

    report(tabId, '上传到千问', '准备千问页面…');
    const name = safeName(info.title) + '.mp4';
    const st0 = await chrome.storage.local.get({ model: DEFAULT_MODEL, prompt_preamble: DEFAULT_PREAMBLE });
    const useModel = st0.model || DEFAULT_MODEL;
    const prompt = buildPrompt(await schema(), st0.prompt_preamble || DEFAULT_PREAMBLE);
    logRun(`[配置] 模型=${useModel} · 提示词长度=${prompt.length} 字符（前置 ${st0.prompt_preamble.length} + 结构）`, 'INFO', 'CFG');
    logRun(`[配置] 提示词全文：${prompt.replace(/\s+/g, ' ')}`, 'DEBUG', 'CFG');

    // 任务元信息落盘：后台中途被浏览器重启时，可凭它 + chatId 恢复生成阶段
    const meta = {
      taskTabId: tabId, bvid, title: info.title, up: info.up,
      durationSec: info.durationSec, thumb: info.pic, model: useModel,
    };
    await setActiveTask(meta);

    const sent = await enqueueQwen(async () => {
      const qtab = await ensureQwenTab();
      meta.qwenTabId = qtab;
      await setActiveTask(meta);                     // 补上 qwenTabId

      // 零跳转保活：千问页已由 ensureQwenTab 用 CDP 激活过（后台标签页不被节流）。
      // 这里若保活会话还在就直接复用 —— 同一标签页不能同时 attach 两次调试器。
      let cdp = null;
      let ownsCdp = false;
      if (cdpKeepAlive) {
        cdp = cdpKeepAlive;
        // 自检：visibilityState 不是 visible 说明页面又被浏览器节流了 → 强制重挂
        if (cdp.state?.v !== 'visible') {
          logRun(`[CDP] 页面状态已变为 ${cdp.state?.v || '未知'}（被节流？）· 重新激活`, 'WARN', 'CDP');
          await cdpKeepAliveOn(qtab, { force: true });
          cdp = cdpKeepAlive;
        }
        logRun(`[CDP] 复用保活会话 · 页面状态=${JSON.stringify(cdp?.state)}`, 'INFO', 'CDP');
        report(tabId, '上传到千问', '页面已激活（复用保活会话）');
      } else {
        try {
          cdp = await cdpEnsureActive(qtab, 4, (m) => logRun(`[CDP] ${m}`, 'DEBUG', 'CDP'));
          ownsCdp = true;
          logRun(`[CDP] 附加成功（第 ${cdp.attempts} 次）· 页面状态=${JSON.stringify(cdp.state)}`, 'INFO', 'CDP');
          report(tabId, '上传到千问', `页面已激活（第 ${cdp.attempts} 次附加成功）`);
        } catch (e) {
          logEx('[CDP] 激活失败', e, 'CDP');
          report(tabId, '上传到千问', `未能激活页面（${e.message}），上传可能变慢`);
        }
      }

      try {
        const tTx = Date.now();
        await sendFileToTab(qtab, merged, name,
          (p) => report(tabId, '上传到千问', `传输给页面 ${p}%`));
        logRun(`[传输] 送入页面完成 ${name} · 耗时 ${((Date.now() - tTx) / 1000).toFixed(1)}s`, 'INFO', 'TX');
        report(tabId, '发送给模型', '提交提问…');
        return await askTab(qtab, tabId, { fileName: name, model: useModel, prompt });
      } finally {
        // 只解除本次自己 attach 的；保活会话留给下次任务复用
        if (ownsCdp) { try { cdp?.detach(); } catch {} }
        logRun('[CDP] 调试器已解除（保活会话保留）', 'DEBUG', 'CDP');
      }
    });
    merged = null;
    report(tabId, 'AI 生成', '模型正在观看视频…');
    await finishGeneration(meta, sent.chatId);       // 统一出口（后台重启后也可从这里恢复）
    logRun(`[任务] 全流程结束 · 总耗时 ${el()}`, 'INFO', 'TASK');
  } catch (e) {
    logEx(`[任务] 失败（累计 ${el()}）`, e, 'TASK');
    report(tabId, '失败', String(e?.message ?? e));
    chrome.runtime.sendMessage({ type: 'TASK_FAILED', tabId, error: String(e?.message ?? e) }).catch(() => {});
    await clearActiveTask();
  } finally {
    stopKeepalive();
  }
}

// ── 消息路由 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // offscreen 合流结果回收（base64 分块）
  if (msg?.type === 'FF_RESULT_CHUNK') {
    const job = ffJobs.get(msg.taskId);
    if (job && job.b64s[msg.seq] === undefined) job.b64s[msg.seq] = msg.b64;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'FF_RESULT_END') {
    const job = ffJobs.get(msg.taskId);
    if (job) {
      const full = new Uint8Array(msg.size);
      let off = 0;
      for (const b64 of job.b64s) {
        const c = b64ToU8(b64);
        full.set(c, off);
        off += c.byteLength;
      }
      if (off !== msg.size) job.reject?.(new Error(`合流结果长度不匹配：收到 ${off}，期望 ${msg.size}`));
      else job.resolve(full.buffer);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'FF_FAILED') {
    const job = ffJobs.get(msg.taskId);
    if (job) job.reject?.(new Error('合流失败：' + msg.error));
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'SUMMARIZE_CURRENT' || msg?.type === 'SUMMARIZE_URL') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId != null) {
      chrome.sidePanel.open({ tabId }).catch(() => {});
    }
    runTask(msg.url, tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'GET_DEFAULTS') {
    sendResponse({ ok: true, model: DEFAULT_MODEL, preamble: DEFAULT_PREAMBLE });
    return false;
  }
  if (msg?.type === 'GET_MODELS') {
    (async () => {
      const { models = [] } = await chrome.storage.local.get('models');
      // 仅在千问标签页已打开时去页面现读；否则用缓存（不主动创建标签页）
      const tabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*'] }).catch(() => []);
      if (tabs.length) {
        try {
          const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'QWEN_LIST_MODELS' });
          if (r?.ok && r.models?.length) {
            await chrome.storage.local.set({ models: r.models });
            sendResponse({ ok: true, models: r.models, source: 'page' });
            return;
          }
        } catch {}
      }
      sendResponse({ ok: true, models, source: 'cache' });
    })();
    return true;
  }
  if (msg?.type === 'GET_TAB_STATE') {
    (async () => {
      const s = await loadState(msg.tabId);
      sendResponse({ ok: true, state: s || null });
    })();
    return true;                                     // 异步回执
  }
  if (msg?.type === 'GET_HISTORY') {
    chrome.storage.local.get('history').then(({ history = [] }) => sendResponse({ ok: true, history }));
    return true;
  }
  if (msg?.type === 'QWEN_STEP') {
    // driver 上报（无 tabId 关联，广播给所有侧边栏做通用提示）
    // 同时更新心跳：askTab 用它判断页面是否被后台节流
    if (sender.tab?.id != null) lastDriverBeat.set(sender.tab.id, Date.now());
    return false;
  }
  if (msg?.type === 'QWEN_SENT') {
    const qtab = sender.tab?.id;
    sendResponse({ ok: true });                      // 先确认，driver 不必重发
    logRun(`[回执] QWEN_SENT 收到 chatId=${msg.chatId}（qwenTab=${qtab}）`);
    (async () => {
      await chrome.storage.session.set({ ['pendingChat_' + qtab]: msg.chatId }).catch(() => {});
      // 若没有存活的 runTask 在轮询这个键（后台曾被浏览器重启），用 activeTask 恢复
      if (!liveAskTabs.has(qtab)) {
        logRun('[恢复] 无存活的等待者 → 尝试用 activeTask 恢复生成阶段');
        const { activeTask } = await chrome.storage.session.get('activeTask').catch(() => ({}));
        if (activeTask && !resuming) {
          await chrome.storage.session.remove('pendingChat_' + qtab).catch(() => {});
          finishGeneration(activeTask, msg.chatId);
        } else {
          logRun('[恢复] 无 activeTask 或已在恢复中，跳过');
        }
      }
    })();
    return false;
  }
  if (msg?.type === 'QWEN_DRIVER_ERROR') {
    const qtab = sender.tab?.id;
    sendResponse({ ok: true });
    logRun(`[错误] 页面流程报错（qwenTab=${qtab}）：${msg.error}`);
    (async () => {
      await chrome.storage.session.set({ ['pendingErr_' + qtab]: String(msg.error) }).catch(() => {});
      if (!liveAskTabs.has(qtab)) {
        const { activeTask } = await chrome.storage.session.get('activeTask').catch(() => ({}));
        if (activeTask) {
          await clearActiveTask();
          report(activeTask.taskTabId, '失败', '页面流程失败：' + msg.error);
          chrome.runtime.sendMessage({ type: 'TASK_FAILED', tabId: activeTask.taskTabId, error: msg.error }).catch(() => {});
        }
      }
    })();
    return false;
  }
  if (msg?.type === 'QWEN_LOG') {                    // driver 的细粒度日志
    // driver 一有动作就会发 QWEN_LOG → 顺带当心跳用（判断页面是否被后台节流）
    if (sender.tab?.id != null) lastDriverBeat.set(sender.tab.id, Date.now());
    logRun(`[页面] ${msg.msg}`);
    return false;
  }
  if (msg?.type === 'OFFSCREEN_LOG') {               // offscreen 的合流日志
    logRun(`[合流引擎] ${msg.msg}`, 'DEBUG', 'FF');
    return false;
  }
  // 注意：日志落盘（选目录 / 授权 / 写文件）全部在 sidepanel 里做——
  // Service Worker 没有 window，拿不到 File System Access API，也没有用户手势可用来 requestPermission。
  // 这里只负责把日志行压进队列（见 logRun → dlog.enqueue）。
  if (msg?.type === 'GET_LOG') {
    (async () => {
      const log = await loadRunLog();
      sendResponse({ ok: true, log: log.join('\n') });
    })();
    return true;
  }
  if (msg?.type === 'CLEAR_LOG') {
    runLog = [];
    chrome.storage.session.remove('runlog').catch(() => {});
    dlog.clearQueue().catch(() => {});
    logRun('── 日志已清空 ──', 'INFO', 'LOG');
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureDNR().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => ensureDNR().catch(() => {}));
// 标签页关闭时清理它的状态
chrome.tabs.onRemoved.addListener((tabId) => {
  taskStates.delete(tabId);
  chrome.storage.session.remove(STATE_KEY(tabId)).catch(() => {});
  // 千问标签页被关掉了 → 忘掉它，下次会重新找/新建
  if (tabId === qwenTabId) {
    logRun(`[标签页] 千问标签页 ${tabId} 已被关闭，下次会重新准备`, 'INFO', 'GEN');
    qwenTabId = null;
    cdpKeepAliveOff();
  }
});
ensureDNR().catch(() => {});
