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

// ── 附件上传：双路径注入（菜单+input / dropzone 拖拽），卡片或网络证据任一出现即成功 ──
async function attachFile(fileId, fileName) {
  const file = takeFile(fileId, fileName);
  if (!file) throw new Error('未收到完整文件分块（' + fileName + '）');

  if (document.documentElement.dataset.qwenPatch !== '1') {
    throw new Error('页面补丁未就绪（MAIN world 注入失败）');
  }

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
    if (!/loading|spin|uploading|progress/i.test(c.outerHTML)) return;
  }
  // 5 分钟仍在加载态：选择器可能误报，别死等，放行走发送流程
}

// ── 发送提问 ──
async function sendPrompt(prompt) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ta = $('textarea');
    if (!ta) throw new Error('找不到输入框');
    ta.focus();
    await sleep(300);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, prompt);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(900);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(5000);
    if (/\/c\/[0-9a-f-]{20,}/.test(location.pathname)) return;
    // 兜底：回车没触发就点发送按钮
    const sendBtn = $('button[aria-label*="发送"], button[aria-label*="Send"], .send-button, #send-message-button')
      || $$('button').find(b => /发送|Send/.test(b.getAttribute('aria-label') || b.innerText || ''));
    if (sendBtn) { sendBtn.click(); await sleep(4000); }
    if (/\/c\/[0-9a-f-]{20,}/.test(location.pathname)) return;
    console.log('[qwen-driver] 第', attempt, '次发送未进入会话页');
  }
  throw new Error('发送失败：未进入会话页');
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
      const m = location.pathname.match(/\/c\/([0-9a-f-]{20,})/);
      if (!m) throw new Error('发送后未进入会话页');
      qlog(`已进入会话页 chatId=${m[1]}，开始回报后台（带确认重试）`);
      // QWEN_SENT 带确认重试：后台可能在长流程中重启过（内存握手会丢），
      // 而本流程活在页面里不受影响——重试直到后台确认，任务就能续上
      for (let i = 0; i < 100; i++) {
        try {
          const r = await chrome.runtime.sendMessage({ type: 'QWEN_SENT', chatId: m[1] });
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
