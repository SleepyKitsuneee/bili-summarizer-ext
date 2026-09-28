// background.js —— 任务编排（v0.1.2）
// 协议变更：offscreen 通信全部走 chrome.runtime 消息（实测 client.postMessage 通道不通）。
// 多标签页并行：每个标签页独立任务状态；千问页面阶段全局排队，其余阶段并行。
import { getVideoContext, getPlayurlDash, pickStreams, downloadStream, parseBvid } from './lib/bilibili.js';
import { pollAnswer } from './lib/qwen.js';
import { u8ToB64, b64ToU8 } from './lib/b64.js';
import { cdpEnsureActive } from './lib/cdp.js';

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

// ── 运行日志（事无巨细，供排错复制；存 session，SW 重启不丢，上限 1200 行）──
let runLog = [];
const LOG_MAX = 1200;
let logSaveTimer = null;
function logRun(msg) {
  const t = new Date();
  const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
  runLog.push(`[${ts}] ${String(msg).slice(0, 500)}`);
  if (runLog.length > LOG_MAX) runLog.splice(0, runLog.length - LOG_MAX);
  clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => chrome.storage.session.set({ runlog: runLog }).catch(() => {}), 300);
}
async function loadRunLog() {
  if (runLog.length) return runLog;
  const got = await chrome.storage.session.get('runlog').catch(() => ({}));
  if (got && Array.isArray(got.runlog)) runLog = got.runlog;
  return runLog;
}
// SW 冷启动：恢复日志并打生命周期标记
(async () => {
  try {
    await loadRunLog();
    logRun('── SW 启动/唤醒（内存已清空，以下为新生命周期）──');
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
  logRun(`[进度] 标签页${tabId} · ${step}${detail ? ' · ' + detail : ''}`);
  if (step === '完成' || step === '失败') flushState(tabId);   // 关键节点立刻落盘
  else scheduleSave(tabId);
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

async function offscreenMerge(taskId, vBuf, aBuf, onProgress) {
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
    await chrome.runtime.sendMessage({ type: 'FF_MERGE_RUN', taskId });
    return await doneP;
  } finally {
    clearTimeout(timer);
    ffJobs.delete(taskId);
  }
}

// ── qwen 标签页 ──
async function waitForTabComplete(tabId, maxMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('qwen 标签页被关闭');
    if (t.status === 'complete') { await sleep(1500); return; }
    await sleep(500);
  }
  throw new Error('qwen 页面加载超时');
}

// 确认 qwen 页面的驱动脚本在线；不在就按需注入（扩展重载后旧标签页会失效）
async function pingDriver(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'QWEN_PING' });
    return !!r?.ok;
  } catch { return false; }
}
async function ensureDriver(tabId, ours) {
  if (await pingDriver(tabId)) return;
  // 1) 按需注入
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/qwen-driver.js'],
  }).catch(() => {});
  await sleep(800);
  if (await pingDriver(tabId)) return;
  // 2) 仍然没有（页面可能被休眠/丢弃）——只有我们自己创建的页面才重载
  if (ours) {
    await chrome.tabs.reload(tabId).catch(() => {});
    await waitForTabComplete(tabId);
    await sleep(1200);
    if (await pingDriver(tabId)) return;
  }
  throw new Error('千问页面驱动脚本未就绪：请确认 chat.qwen.ai 标签页可正常打开并已登录');
}

let qwenTabId = null;
let qwenTabOurs = false;
// 每次任务都开新会话：只要标签页停在某个会话页（/c/xxx），就导航回首页
async function ensureQwenTab() {
  const isChatPage = (u) => /chat\.qwen\.ai\/c\//.test(u || '');
  const onQwenRoot = (u) => /^https:\/\/chat\.qwen\.ai\/?(\?.*)?$/.test(u || '');
  // 优先复用我们自己创建的标签页
  if (qwenTabId != null) {
    const t = await chrome.tabs.get(qwenTabId).catch(() => null);
    if (t) {
      if (!onQwenRoot(t.url)) await chrome.tabs.update(qwenTabId, { url: QWEN_HOME });   // 新会话
      await waitForTabComplete(qwenTabId);
      await ensureDriver(qwenTabId, qwenTabOurs);
      return qwenTabId;
    }
    qwenTabId = null;
  }
  // 复用用户已打开的千问页（只在新会话需要时导航，保证"每次总结一个新会话"）
  const tabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*'] });
  if (tabs.length) {
    qwenTabId = tabs[0].id;
    qwenTabOurs = false;
    await chrome.tabs.update(qwenTabId, { pinned: true }).catch(() => {});
    if (isChatPage(tabs[0].url) || !onQwenRoot(tabs[0].url)) {
      await chrome.tabs.update(qwenTabId, { url: QWEN_HOME });
    }
    await waitForTabComplete(qwenTabId);
    await ensureDriver(qwenTabId, false);
    return qwenTabId;
  }
  const tab = await chrome.tabs.create({ url: QWEN_HOME, active: false, pinned: true });
  qwenTabId = tab.id;
  qwenTabOurs = true;
  await waitForTabComplete(qwenTabId);
  await ensureDriver(qwenTabId, true);
  return qwenTabId;
}

// 触发页面流程；chatId/错误通过 storage 会话键回传——
// 不用内存握手：后台脚本中途被浏览器重启也不会丢（这是"卡在提交提问但结果已出"的根因）
const liveAskTabs = new Set();                       // 正在等回执的 qwen 标签页（存活 runTask）
async function askTab(qtab, taskTabId, payload) {
  liveAskTabs.add(qtab);
  logRun(`[提问] 已触发页面流程（qwenTab=${qtab}，文件=${payload.fileName}），开始轮询回执…`);
  try {
    await chrome.tabs.sendMessage(qtab, { type: 'QWEN_SEND', ...payload });
    const chatKey = 'pendingChat_' + qtab;
    const errKey = 'pendingErr_' + qtab;
    const t0 = Date.now();
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
      await sleep(3000);
    }
    throw new Error('等待发送回执超时（15 分钟）');
  } finally {
    liveAskTabs.delete(qtab);
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

// 生成阶段（可从任意地方恢复执行）：轮询答案 → 解析 → 入历史 → 通知
let resuming = false;
async function finishGeneration(meta, chatId) {
  if (resuming) { logRun('[生成] 已有生成阶段在进行，跳过重复调用'); return; }
  resuming = true;
  startKeepalive();
  logRun(`[生成] 开始轮询答案 chatId=${chatId}（taskTabId=${meta.taskTabId}）`);
  try {
    report(meta.taskTabId, 'AI 生成', '正在等待生成结果…');
    const { text, model } = await pollAnswer(chatId, {
      onTick: (len, m) => report(meta.taskTabId, 'AI 生成', `已生成 ${len} 字（${m}）`),
    });
    let data = null, err = null;
    try {
      const t = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      data = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    } catch (e) { err = String(e); }
    if (data) {
      if (meta.title) data['视频标题'] = meta.title;
      if (meta.up) data['UP主'] = meta.up;
      const m = meta.durationSec;
      if (m) data['时长'] = `${Math.floor(m / 60)}分${m % 60}秒`;
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
        if (retry >= 5) throw new Error('向 qwen 页面传文件失败：' + e.message);
        // 断连自愈：页面被刷新/丢弃时驱动会掉线，重新就绪后继续
        if (/Receiving end|Could not establish/i.test(e.message)) {
          await ensureDriver(tabId, qwenTabOurs).catch(() => {});
        }
        await sleep(1500);                              // 页面脚本可能还没就绪
      }
    }
    onProgress?.(Math.round((seq + 1) / total * 100));
    logRun(`[传输] 块 ${seq + 1}/${total} → 已确认（${(b64.length / 1024).toFixed(0)}KB base64）`);
  }
  logRun(`[传输] 文件 ${fileName} 全部送达（${u8.byteLength}B / ${total} 块）`);
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
function enqueueQwen(fn) {
  const run = qwenChain.then(fn);
  qwenChain = run.catch(() => {});
  if (qwenChain !== run) logRun('[队列] 千问阶段已有任务在跑，本任务排队等待');
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
  logRun(`[任务] 开始 · 标签页${tabId} · url=${url} · bvid=${bvid ?? '解析失败'}`);
  if (!bvid) { report(tabId, '失败', '链接里没找到 BV 号'); stopKeepalive(); return; }

  try {
    report(tabId, '读取视频信息');
    const info = await getVideoContext(bvid);
    report(tabId, '读取视频信息', info.title);

    report(tabId, '下载视频', '360P + 64K');
    const dash = await getPlayurlDash(bvid, info.cid);
    const { video, audio } = pickStreams(dash, 16);
    if (!audio) throw new Error('没有可用的音频流');
    logRun(`[下载] 选流：视频=${(video.baseUrl || video.base_url || '').slice(0, 80)} 音频=${(audio.baseUrl || audio.base_url || '').slice(0, 80)}`);
    let vBuf = await downloadStream(video.baseUrl || video.base_url,
      (g, t) => report(tabId, '下载视频', `视频 ${Math.round(g / t * 100)}%`));
    let aBuf = await downloadStream(audio.baseUrl || audio.base_url,
      (g, t) => report(tabId, '下载视频', `音频 ${Math.round(g / t * 100)}%`));

    report(tabId, '本地合流', '初始化 ffmpeg 引擎…');
    const mergeTaskId = `t${tabId}-${Date.now()}`;
    logRun(`[合流] 任务 ${mergeTaskId}：视频 ${vBuf.byteLength}B + 音频 ${aBuf.byteLength}B`);
    let merged = await offscreenMerge(mergeTaskId, vBuf, aBuf,
      (p) => report(tabId, '本地合流', `合流 ${Math.round(p * 100)}%`));
    logRun(`[合流] 产物 ${merged.byteLength}B`);
    vBuf = aBuf = null;

    report(tabId, '上传到千问', '准备千问页面…');
    const name = safeName(info.title) + '.mp4';
    const st0 = await chrome.storage.local.get({ model: DEFAULT_MODEL, prompt_preamble: DEFAULT_PREAMBLE });
    const useModel = st0.model || DEFAULT_MODEL;
    const prompt = buildPrompt(await schema(), st0.prompt_preamble || DEFAULT_PREAMBLE);
    logRun(`[配置] 模型=${useModel} · 提示词长度=${prompt.length} 字符（前置 ${st0.prompt_preamble.length} + 结构）`);

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

      // 零跳转保活：先给千问标签页附加调试器并**验证**页面已变为 visible，
      // 否则页面 JS 会被后台节流（上传管线冻结）。用户视图完全不动。
      let cdp = null;
      try {
        cdp = await cdpEnsureActive(qtab, 4, (m) => logRun(`[CDP] ${m}`));
        logRun(`[CDP] 附加成功（第 ${cdp.attempts} 次）· 页面状态=${JSON.stringify(cdp.state)}`);
        report(tabId, '上传到千问', `页面已激活（第 ${cdp.attempts} 次附加成功）`);
      } catch (e) {
        logRun(`[CDP] 激活失败：${e.message}`);
        report(tabId, '上传到千问', `未能激活页面（${e.message}），上传可能变慢`);
      }

      try {
        await sendFileToTab(qtab, merged, name,
          (p) => report(tabId, '上传到千问', `传输给页面 ${p}%`));
        report(tabId, '发送给模型', '提交提问…');
        return await askTab(qtab, tabId, { fileName: name, model: useModel, prompt });
      } finally {
        cdp?.detach();                               // 发送完即解除，提示条消失
      }
    });
    merged = null;
    report(tabId, 'AI 生成', '模型正在观看视频…');
    await finishGeneration(meta, sent.chatId);       // 统一出口（后台重启后也可从这里恢复）
  } catch (e) {
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
    logRun(`[页面] ${msg.msg}`);
    return false;
  }
  if (msg?.type === 'OFFSCREEN_LOG') {               // offscreen 的合流日志
    logRun(`[合流引擎] ${msg.msg}`);
    return false;
  }
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
    logRun('── 日志已清空 ──');
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
});
ensureDNR().catch(() => {});
