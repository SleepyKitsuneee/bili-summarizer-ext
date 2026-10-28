// qwen-driver.js —— chat.qwen.ai 页面自动化（隔离世界）。
// 复刻 bili_qwen_summary.py ask_qwen 的全部交互：选模型 → 走「选择模式→上传附件」
// 入口喂文件 → 等服务端解析 → 发提问 → A/B 面板跳过 → 回报 chatId。
// 注意：延时必须用 MessageChannel 宏任务——后台标签页的 setTimeout 会被浏览器
// 强力节流（最慢 1 次/分钟），是"卡死到手动点标签页才动"的元凶。
//
// 整个文件包在 IIFE + 幂等守卫里：background 可能按需重新注入
// （chrome.scripting.executeScript），重复执行必须安全。
(() => {
if (window.__qwenDriverLoaded) return;
window.__qwenDriverLoaded = true;

// 探测应答：background 用它确认驱动脚本已就绪
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'QWEN_PING') sendResponse({ ok: true, driver: 1 });
  // 检查 MAIN world 补丁是否就绪（background 用它决定要不要按需注入）
  if (msg?.type === 'QWEN_PING_PATCH') {
    sendResponse({ ok: document.documentElement.dataset?.qwenPatch === '1' });
    return false;
  }
  return false;
});

const sleep = (ms) => new Promise((res) => {
  if (ms <= 0) { res(); return; }
  const start = Date.now();
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    if (Date.now() - start >= ms) { ch.port1.close(); res(); }
    else ch.port2.postMessage(0);
  };
  ch.port2.postMessage(0);
});
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function report(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}
// 细粒度日志：全部汇入后台运行日志（侧边栏可查看/复制）
function qlog(msg) {
  console.log('[qwen-driver]', msg);
  chrome.runtime.sendMessage({ type: 'QWEN_LOG', msg }).catch(() => {});
}

// ── 模型选择 ──
async function ensureModel(model) {
  if (!model) return;
  const cur = () => ($('.wms-trigger__text')?.innerText || '').trim();
  if (cur() === model) { qlog(`模型已是目标值「${model}」，无需切换`); return; }
  qlog(`切换模型：当前「${cur() || '(空)'}」→ 目标「${model}」`);
  $('.wms-trigger')?.click();
  await sleep(1200);
  const opt = $$('.ant-dropdown li, .ant-dropdown-menu-item, [role=option], [role=menuitem]')
    .find(e => (e.innerText || '').trim().split('\n')[0].trim() === model)
    || $$('*').find(e => {
      const t = (e.innerText || '').trim();
      return t === model && e.getBoundingClientRect().width > 0;
    });
  if (opt) { opt.click(); await sleep(1500); }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(600);
  if (cur() !== model) throw new Error(`模型切换失败：期望「${model}」，实际「${cur()}」`);
  qlog(`模型切换成功`);
}

// ── 分块接收（background 合流后 base64 直传过来）──
const b64ToU8 = (b64) => {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
};
const fileParts = new Map();   // id -> { chunks: [], received: 0, total: 0, done: false }
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'QWEN_FILE_CHUNK') {
    let f = fileParts.get(msg.id);
    if (!f) { f = { chunks: new Array(msg.total), received: 0, total: msg.total, done: false }; fileParts.set(msg.id, f); }
    if (f.chunks[msg.seq] === undefined) { f.chunks[msg.seq] = b64ToU8(msg.b64); f.received++; }
    sendResponse({ ok: true, got: f.received });
    return;
  }
  if (msg?.type === 'QWEN_FILE_END') {
    const f = fileParts.get(msg.id);
    if (f) f.done = true;
    sendResponse({ ok: true });
    return;
  }
  // ── 页面内代理请求（同源 fetch，自带登录 cookie）──
  // 背景：Service Worker 的 fetch 算第三方请求，千问的登录 cookie 是 SameSite=Lax，
  // 不会随 credentials:'include' 发出 → 读会话接口返回 Unauthorized。
  // 由页面自己发请求就没有这个问题。
  // 同时回传页面现场（location / cookie / 登录态），方便在日志里一眼看出是哪种情况。
  if (msg?.type === 'QWEN_API_FETCH') {
    (async () => {
      try {
        const page = {
          href: location.href,
          onChatPage: /\/c\/[0-9a-f-]{20,}/.test(location.pathname),
          cookieLen: (document.cookie || '').length,
          cookieNames: (document.cookie || '').split(';').map(s => s.split('=')[0].trim()).filter(Boolean),
          hasLoginHint: !(document.body?.innerText || '').includes('注册'),
          title: document.title,
        };
        const r = await fetch(msg.url, {
          method: msg.method || 'GET',
          credentials: 'include',
          headers: msg.headers || {},
          body: msg.body,
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        sendResponse({ ok: true, status: r.status, json, text: text.slice(0, 2000), page });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    })();
    return true;                                     // 异步回执
  }
  // ── 页面状态查询（判断是否真的加载好了、有没有网络错误）──
  if (msg?.type === 'QWEN_PAGE_STATE') {
    try {
      const t = document.body?.innerText || '';
      // 网络错误 / 加载失败的特征文案
      const errHit = t.match(/(网络错误|无法访问此网站|ERR_[A-Z_]+|连接超时|请检查网络|服务暂时不可用|访问验证)/i);
      // 登录态判断：千问首页/会话页会出现「新建对话」「我的作品」等
      const hasLogin = /新建对话|我的作品|新 chat|发送/.test(t);
      sendResponse({
        ok: true,
        href: location.href,
        title: document.title,
        hasBody: !!document.body,
        textLen: t.length,
        error: errHit ? errHit[0] : '',
        hasLogin,
        // 前 200 字首屏文字，便于判断页面停在哪一步
        head: t.slice(0, 200).replace(/\s+/g, ' '),
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return;
  }
  // ── 从页面 DOM 读答案（主方案，绕开接口鉴权）──
  if (msg?.type === 'QWEN_READ_DOM') {
    try {
      const r = readAnswerFromDom();
      sendResponse({ ok: true, ...r, href: location.href });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return;
  }
  // ── 诊断：探测多个候选接口，找出哪个能读到会话 ──
  if (msg?.type === 'QWEN_PROBE_APIS') {
    (async () => {
      const id = msg.chatId;
      const candidates = [
        `/api/v2/chats/${id}`,
        `/api/v2/chat/${id}`,
        `/api/v1/chats/${id}`,
        `/api/v2/chats/${id}/messages`,
        `/api/v2/conversations/${id}`,
        `/api/v2/chat/completions/${id}`,
      ];
      const out = [];
      for (const path of candidates) {
        const t0 = Date.now();
        try {
          const r = await fetch(path, {
            credentials: 'include',
            headers: { 'accept': 'application/json', 'source': 'web', 'version': '0.2.91' },
          });
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          out.push({
            path,
            status: r.status,
            ms: Date.now() - t0,
            success: json?.success ?? null,
            code: json?.data?.code ?? null,
            keys: json ? Object.keys(json).join(',') : '',
            dataKeys: json?.data ? Object.keys(json.data).join(',') : '',
            head: text.slice(0, 160),
          });
        } catch (e) {
          out.push({ path, error: String(e?.message ?? e) });
        }
      }
      sendResponse({ ok: true, results: out, href: location.href });
    })();
    return true;
  }
  if (msg?.type === 'QWEN_LIST_MODELS') {           // 只读模型名字给侧边栏做下拉候选
    (async () => {
      try {
        $('.wms-trigger')?.click();
        await sleep(1000);
        const names = $$('.wms-list__name, [role=option], [role=menuitem]')
          .map(e => (e.innerText || '').trim().split('\n')[0].trim())
          .filter(Boolean);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        sendResponse({ ok: true, models: [...new Set(names)].slice(0, 40) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    })();
    return true;                                     // 异步回执
  }
  return;
});

function takeFile(id, name) {
  const f = fileParts.get(id);
  if (!f || !f.done || f.received !== f.total) return null;
  fileParts.delete(id);
  const total = f.chunks.reduce((n, c) => n + c.byteLength, 0);
  if (!total) return null;
  const full = new Uint8Array(total);
  let off = 0;
  for (const c of f.chunks) { full.set(c, off); off += c.byteLength; }
  return new File([full], name, { type: 'video/mp4' });
}

// ── 附件相关工具 ──
async function waitFor(fn, timeout, step = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let ok = false;
    try { ok = fn(); } catch {}
    if (ok) return true;
    await sleep(step);
  }
  return false;
}

// 找页面里的附件卡片（上传后会出现；类名可能随版本变化，多路匹配）
function findAttachCard() {
  if ($('.file-card-list')) return $('.file-card-list');
  const hit = $$('[class*="file-card"],[class*="attachment"],[class*="upload-item"]')
    .find(e => e.getBoundingClientRect().width > 0);
  return hit || null;
}

// 读 MAIN world 补丁捕获的网络证据（getstsToken / OSS 上传请求）
function netEvidence(sinceMs = 0) {
  try {
    const cap = JSON.parse(document.documentElement.dataset.qwenCapture || '{}');
    const net = cap.__net || [];
    return net.filter(x => Date.now() - x.t < sinceMs);
  } catch { return []; }
}

// ── 直接从页面读答案 ──
// 背景：读会话接口 /api/v2/chats/{id} 对扩展请求返回 Unauthorized（后端另有鉴权），
// 但页面自己能正常拿到并渲染回答。所以主方案改成直接读 DOM，绕开接口鉴权。
// 多路选择器兜底：不同版本类名不同，全试一遍取最完整的那段文本。

// 常见的 assistant 消息容器（按可靠性排序）
const ASSISTANT_SELECTORS = [
  '[class*="assistant"] [class*="message"]',
  '[class*="message"] [class*="assistant"]',
  '[data-role="assistant"]',
  '[class*="chat-message"][class*="ai"]',
  '[class*="msg"][class*="ai"]',
  '[class*="markdown"]',
  '[class*="response"] [class*="content"]',
];

function isUserNode(el) {
  const t = (el.className || '') + ' ' + (el.getAttribute?.('data-role') || '');
  if (/user|question|input-msg|human/i.test(t)) return true;
  // 用户那条消息是 909 字的提示词，内容固定，可以据此排除
  const txt = (el.innerText || '');
  if (txt.includes('请完整观看或收听这段视频') || txt.includes('只输出一个 JSON 对象本体')) return true;
  return false;
}

// 判断页面是否还在生成（出现"停止生成"之类的按钮）
function isGenerating() {
  const t = document.body?.innerText || '';
  if (/停止生成|停止回答|生成中|思考中|正在思考/.test(t)) return true;
  const stopBtn = $$('button').find(b => /停止/.test(b.innerText || b.getAttribute('aria-label') || ''));
  return !!stopBtn;
}

// 页面是否显示错误
function pageError() {
  const t = document.body?.innerText || '';
  const m = t.match(/(糟糕[！!][^\n]{0,120}|输入或附件无效[^\n]{0,80}|出现问题[^\n]{0,80}|请检查后重试[^\n]{0,60})/);
  return m ? m[0].trim() : '';
}

// 从页面上提取最新的 assistant 回答（同步，一次调用拿全部信息）
function readAnswerFromDom() {
  const nodes = [];
  const seen = new Set();
  for (const sel of ASSISTANT_SELECTORS) {
    let list;
    try { list = $$(sel); } catch { continue; }
    for (const n of list) {
      if (!n || seen.has(n)) continue;
      if (isUserNode(n)) continue;
      const txt = (n.innerText || '').trim();
      if (txt.length < 20) continue;      // 太短，多半是按钮/图标容器
      seen.add(n);
      nodes.push({ sel, node: n, text: txt });
    }
  }
  const base = { count: nodes.length, generating: isGenerating(), error: pageError() };
  if (!nodes.length) return { ok: false, reason: 'no-node', ...base };
  let best = nodes[0];
  for (const n of nodes) if (n.text.length > best.text.length) best = n;
  const last = nodes[nodes.length - 1];
  // 流式输出时最后一个节点才是最新的；否则取最完整的那段
  const pick = (last.text.length >= best.text.length * 0.6) ? last : best;
  return {
    ok: true,
    text: pick.text,
    via: pick.sel,
    lengths: nodes.map(n => n.text.length),
    ...base,
  };
}

// ── 附件上传：双路径注入（菜单+input / dropzone 拖拽），卡片或网络证据任一出现即成功 ──
async function attachFile(fileId, fileName) {
  const file = takeFile(fileId, fileName);
  if (!file) throw new Error('未收到完整文件分块（' + fileName + '）');

  if (document.documentElement.dataset.qwenPatch !== '1') {
    throw new Error('页面补丁未就绪（MAIN world 注入失败）');
  }

  // 诊断：把文件元信息记全，附件无效时能对照服务端限制
  qlog(`待上传文件：name=${file.name} · size=${(file.size / 1024 / 1024).toFixed(2)}MB`
    + ` · type=${file.type || '(空)'} · lastModified=${file.lastModified}`);
  const inputs = $$('input[type=file]').map(i => ({
    id: i.id, accept: i.accept, multiple: i.multiple,
  }));
  qlog(`页面文件输入框：${JSON.stringify(inputs)}`);

  const netBefore = netEvidence(10 * 60_000).length;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // 路径 1：菜单 + 文件输入框
    qlog(`附件注入第 ${attempt}/2 轮 · 路径1（菜单+输入框）`);
    $('.mode-select-open')?.click();
    await sleep(900);
    const item = $$('[role=menuitem]').find(e => /上传附件/.test(e.innerText || ''));
    if (!item) throw new Error('找不到「上传附件」菜单项');
    item.click();                                   // 内部 input.click() 已被补丁跳过
    await sleep(700);
    const input = $('#filesUpload')
      || $$('input[type=file]').find(i => /video|file|all/i.test(i.accept || ''));
    if (!input) throw new Error('找不到文件输入框');

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    qlog(`已注入文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 到 input（files.length=${input.files.length}），并派发 input/change 事件`);
    // React 兜底：直接调组件 props 上的 onChange（部分 React 版本不吃合成 change 事件）
    const rk = Object.keys(input).find(k => k.startsWith('__reactProps$'));
    if (rk && typeof input[rk]?.onChange === 'function') {
      try { input[rk].onChange({ target: input, currentTarget: input }); qlog('已直调 React onChange 兜底'); } catch {}
    }

    // 判定：附件卡片（后台渲染可能被节流拖慢）或页面发出上传网络请求，任一即可
    if (await waitFor(() => !!findAttachCard() || netEvidence(60_000).length > netBefore, 25_000, 1500)) {
      qlog(`注入成功判定：卡片=${!!findAttachCard()} 网络证据=${netEvidence(60_000).length - netBefore} 条`);
      break;
    }
    qlog('路径1无响应（卡片与网络证据均未出现）');

    // 路径 2：dropzone 拖拽注入（走页面原生 drop 处理，绕开文件选择框机制）
    console.log('[qwen-driver] 路径1无响应，尝试 dropzone drop 注入，第', attempt, '轮');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(600);
    const dz = document.getElementById('dropzone-container')
      || document.querySelector('.message-input-container') || $('textarea')?.parentElement;
    qlog(`drop 注入目标元素：${dz ? (dz.id || dz.className || 'textarea父级') : '未找到'}`);
    if (dz) {
      const dt2 = new DataTransfer();
      dt2.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        dz.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt2 }));
        await sleep(300);
      }
      if (await waitFor(() => !!findAttachCard() || netEvidence(60_000).length > netBefore, 25_000, 1500)) {
        qlog('drop 注入成功判定');
        break;
      }
    }

    if (attempt === 2) {
      throw new Error('附件注入失败：卡片与上传网络请求均未出现（后台节流或页面改版）');
    }
  }
}

// ── 等服务端解析（卡片进入非加载态；已确认卡片存在后才调用）──
async function waitParsed(maxMs = 5 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(2000);
    const c = findAttachCard();
    if (!c) continue;
    if (!/loading|spin|uploading|progress/i.test(c.outerHTML)) {
      qlog(`服务端解析完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      return;
    }
  }
  // 5 分钟仍在加载态：选择器可能误报，别死等，放行走发送流程
  qlog(`等待解析超过 ${(maxMs / 1000).toFixed(0)}s，卡片仍处加载态，放行`);
}

// ── 发送提问 ──
// 注意：这里「没进入会话页」不再等于失败。
// 实测页面可能停在 /c/new-chat 但消息已经发出、AI 也在正常回答
//（真实会话 ID 只在创建会话的响应体里）。所以 sendPrompt 只负责把内容发出去，
// chatId 由 resolveChatId() 从 URL 或网络响应里取。
async function sendPrompt(prompt) {
  let sent = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ta = $('textarea');
    if (!ta) throw new Error('找不到输入框');
    qlog(`发送提问第 ${attempt}/2 次 · 提示词 ${prompt.length} 字 · 发送前 URL=${location.href}`);
    // 发送前记录页面上可见的会话链接（用于对比 chatId 来源）
    const links = $$('a[href*="/c/"]').map(a => a.getAttribute('href')).filter(Boolean).slice(0, 5);
    if (links.length) qlog(`发送前页面上的会话链接：[${links.join(', ')}]`);
    ta.focus();
    await sleep(300);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, prompt);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(900);
    // 记录输入框实际内容长度（诊断：确认文字真的进到了输入框）
    qlog(`输入框内容长度=${String(ta.value || '').length} 字`);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(5000);
    if (/\/c\/[0-9a-f-]{20,}/.test(location.pathname)) {
      qlog(`回车发送成功，已进入会话页 · URL=${location.href}`);
      return;
    }
    // 兜底：回车没触发就点发送按钮
    const sendBtn = $('button[aria-label*="发送"], button[aria-label*="Send"], .send-button, #send-message-button')
      || $$('button').find(b => /发送|Send/.test(b.getAttribute('aria-label') || b.innerText || ''));
    if (sendBtn) { qlog('回车无效，改点发送按钮'); sendBtn.click(); await sleep(4000); }
    else {
      // 诊断：把页面上所有按钮的标识列出来，便于下次补选择器
      const btns = $$('button').map(b => (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim().slice(0, 12)).filter(Boolean);
      qlog(`回车无效且没找到发送按钮 · 页面上的按钮=[${btns.slice(0, 30).join('|')}]`, 'ERROR');
    }
    if (/\/c\/[0-9a-f-]{20,}/.test(location.pathname)) {
      qlog(`按钮发送成功，已进入会话页 · URL=${location.href}`);
      return;
    }
    // 没进会话页时把现场记全：URL、页面是否有报错提示、附件卡片还在不在
    const bodyText = (document.body?.innerText || '').slice(0, 300).replace(/\s+/g, ' ');
    const inputText = String(ta.value || '').length;
    qlog(`第 ${attempt} 次未进入会话页 · path=${location.pathname}`
      + ` · 输入框残留 ${inputText} 字`
      + ` · 附件卡片=${!!findAttachCard()}`
      + ` · 页面首屏文字=${bodyText}`);
    // 输入框被清空 = 消息大概率已发出（页面取走了内容）
    if (inputText === 0) { sent = true; qlog('输入框已清空，判断消息已发出'); break; }
  }
  if (!sent) qlog('两次尝试后仍未确认发送成功，将继续尝试解析 chatId', 'WARN');
}

// ── A/B 对比面板跳过 ──
setInterval(() => {
  try {
    if (document.body && document.body.innerText.includes('更喜欢哪个回复')) {
      const skip = $$('button').find(b => /跳过/.test(b.innerText || ''));
      if (skip) skip.click();
    }
  } catch {}
}, 3000);

// ── 解析真实 chatId ──
// 关键教训：页面 URL 可能停在 /c/new-chat（前端占位符），真实会话 ID 只在
// 「创建会话」接口的响应体里。所以按优先级依次尝试：
//   1) URL 里的 UUID（最可靠，页面确实跳过去了）
//   2) MAIN world 补丁从网络响应里抓到的 chatId（URL 没跳时靠它）
//   3) 轮询等待（会话创建有延迟，等最多 waitMs）
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function captureData() {
  try { return JSON.parse(document.documentElement.dataset.qwenCapture || '{}'); } catch { return {}; }
}
function urlChatId() {
  const m = location.pathname.match(/\/c\/([0-9a-f-]{20,})/i);
  return m && UUID_RE.test(m[1]) ? m[1] : null;
}
function capturedChatId() {
  const cap = captureData();
  const list = cap.__chatIds || [];
  return (list.length ? list[list.length - 1].id : null) || cap.__lastChatId || null;
}

async function resolveChatId(waitMs = 45_000) {
  const t0 = Date.now();
  let lastLog = 0;
  for (;;) {
    const fromUrl = urlChatId();
    if (fromUrl) {
      qlog(`chatId 来源=URL · ${fromUrl} · URL=${location.href}`);
      return fromUrl;
    }
    const fromNet = capturedChatId();
    if (fromNet) {
      const cap = captureData();
      const hit = (cap.__chatIds || []).find(x => x.id === fromNet);
      qlog(`chatId 来源=网络响应 · ${fromNet}`
        + ` · 来自 ${hit ? hit.src + ' ' + hit.u : '未知'}`
        + ` · 当前 URL=${location.href}（URL 里没有 UUID）`);
      return fromNet;
    }
    if (Date.now() - t0 > waitMs) {
      const cap = captureData();
      qlog(`等待 chatId 超时（${(waitMs / 1000).toFixed(0)}s）`
        + ` · URL=${location.href}`
        + ` · 捕获到的 chatIds=${JSON.stringify(cap.__chatIds || [])}`
        + ` · 捕获字段=[${Object.keys(cap).join(',')}]`, 'ERROR');
      return null;
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      const cap = captureData();
      qlog(`等待 chatId…（已等 ${((Date.now() - t0) / 1000).toFixed(0)}s）`
        + ` · URL=${location.href} · 已捕获 ${(cap.__chatIds || []).length} 个`);
    }
    await sleep(500);
  }
}

// ── 主流程 ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'QWEN_SEND') return;
  (async () => {
    try {
      const body = document.body?.innerText || '';
      if (body.includes('登录') && body.includes('注册')) {
        throw new Error('千问未登录：请在这个标签页里先登录一次');
      }
      qlog(`收到 QWEN_SEND：文件=${msg.fileName} 模型=${msg.model} 提示词=${(msg.prompt || '').length} 字符`);
      await ensureModel(msg.model);
      report({ type: 'QWEN_STEP', step: '上传并解析', detail: '页面内上传附件…' });
      await attachFile(msg.fileName, msg.fileName);
      report({ type: 'QWEN_STEP', step: '上传并解析', detail: '等待服务端解析…' });
      await waitParsed();
      report({ type: 'QWEN_STEP', step: 'AI 生成', detail: '发送提问…' });
      await sendPrompt(msg.prompt);
      // 不再只认 URL：页面可能停在 /c/new-chat，真实 chatId 要从网络响应里拿
      const chatId = await resolveChatId(45_000);
      if (!chatId) throw new Error('拿不到真实 chatId（URL 停在占位页，也没捕获到创建会话的响应）');
      const bodyText = (document.body?.innerText || '');
      const errHints = ['糟糕', '出现问题', '输入或附件无效', '请检查后重试', '访问验证', '请求过于频繁']
        .filter(k => bodyText.includes(k));
      qlog(`页面状态：附件卡片=${!!findAttachCard()}`
        + ` · 页面文字长度=${bodyText.length}`
        + ` · 命中报错关键词=[${errHints.join(',') || '无'}]`);
      if (errHints.length) {
        const idx = Math.max(...errHints.map(k => bodyText.indexOf(k)));
        qlog(`⚠ 页面报错原文：${bodyText.slice(Math.max(0, idx - 40), idx + 160).replace(/\s+/g, ' ')}`, 'ERROR');
      }
      qlog(`开始回报后台 chatId=${chatId}（带确认重试）`);
      // QWEN_SENT 带确认重试：后台可能在长流程中重启过（内存握手会丢），
      // 而本流程活在页面里不受影响——重试直到后台确认，任务就能续上
      for (let i = 0; i < 100; i++) {
        try {
          const r = await chrome.runtime.sendMessage({ type: 'QWEN_SENT', chatId });
          if (r?.ok) { qlog(`发送回执已确认（第 ${i + 1} 次）`); return; }
        } catch {}
        if (i % 10 === 0) qlog(`回执尚未确认，第 ${i + 1} 次重试中…（后台可能重启过）`);
        await sleep(3000);
      }
      throw new Error('发送回执始终未被后台确认');
    } catch (e) {
      report({ type: 'QWEN_DRIVER_ERROR', error: String(e?.message ?? e) });
    }
  })();
});

console.log('[qwen-driver] 驱动脚本已就绪');
})();
