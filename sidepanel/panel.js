// panel.js —— 侧边栏逻辑：输入/步骤/结果/历史
const $ = (s) => document.querySelector(s);
const STEPS = ['读取视频信息', '下载视频', '本地合流', '上传到千问', '发送给模型', 'AI 生成'];

let state = {};                     // step -> 'pending'|'running'|'done'|'failed'
let currentData = null;

// ── 步骤视图 ──
function renderSteps() {
  const ul = $('#step-list');
  ul.innerHTML = '';
  for (const name of STEPS) {
    const st = state[name] || 'pending';
    const li = document.createElement('li');
    li.className = st;
    const dot = document.createElement('span');
    dot.className = 'dot';
    li.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = name;
    li.appendChild(label);
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = currentStepDetail[name] || '';
    li.appendChild(detail);
    ul.appendChild(li);
  }
}
let currentStepDetail = {};
function setStep(name, st, detail = '') {
  if (STEPS.includes(name)) state[name] = st;
  if (detail) currentStepDetail[name] = detail;
  if (name === '下载视频' && /^视频 \d+%/.test(detail)) {
    // 下载进度映射到总进度条
    const pct = parseInt(detail, 10) / 2;             // 下载占一半
    setBar(Math.min(50, pct), false);
  } else if (name === '上传到千问' && st === 'running') setBar(60, false);
  else if (name === '发送给模型' && st === 'running') setBar(75, false);
  else if (name === 'AI 生成' && st === 'running') setBar(88, true);
  renderSteps();
}
function setBar(pct, indet) {
  const f = $('#bar-fill');
  f.classList.toggle('indeterminate', !!indet);
  f.style.width = (indet ? 40 : Math.max(6, pct)) + '%';
}

// ── 结果渲染（与 summary_schema 对应：结论前置）──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function renderResult(data, opts = {}) {
  currentData = data;
  const body = $('#r-body');
  body.innerHTML = '';
  const top = data['结论'] || data['一句话总结'] || '';
  $('#r-title').textContent = data['视频标题'] || '总结';
  if (top) { $('#r-quote').textContent = '结论：' + top; $('#r-quote').classList.remove('hidden'); }
  else $('#r-quote').classList.add('hidden');
  const meta = ['内容类型', '时长', 'UP主'].map(k => data[k] ? `${k}：${data[k]}` : '').filter(Boolean);
  if (meta.length) { $('#r-meta').textContent = meta.join('　｜　'); $('#r-meta').classList.remove('hidden'); }
  else $('#r-meta').classList.add('hidden');

  const section = (title, items, numbered) => {
    items = (items || []).filter(x => String(x).trim());
    if (!items.length) return;
    const h = document.createElement('div'); h.className = 'h2'; h.textContent = title; body.appendChild(h);
    items.forEach((x, i) => {
      const d = document.createElement('div');
      d.textContent = (numbered ? `${i + 1}. ` : '• ') + x;
      body.appendChild(d);
    });
  };
  section('核心要点', data['核心要点'], false);
  section('争议或不足', data['争议或不足']);
  const segs = (data['分段摘要'] || []).filter(s => typeof s === 'object');
  if (segs.length) {
    const h = document.createElement('div'); h.className = 'h2'; h.textContent = '分段摘要'; body.appendChild(h);
    for (const s of segs) {
      const d = document.createElement('div'); d.className = 'seg';
      d.textContent = `${s['时间点'] || ''}　${s['主题'] || ''}`;
      body.appendChild(d);
      if (s['要点']) { const d2 = document.createElement('div'); d2.textContent = '　　' + s['要点']; body.appendChild(d2); }
    }
  }
  const kws = (data['关键词'] || []).filter(Boolean);
  if (kws.length) {
    const h = document.createElement('div'); h.className = 'h2'; h.textContent = '关键词'; body.appendChild(h);
    const d = document.createElement('div'); d.textContent = kws.map(k => '#' + k).join('　'); body.appendChild(d);
  }
  if (data['原始回答']) {
    const h = document.createElement('div'); h.className = 'h2'; h.textContent = '原始回答（JSON 解析失败）'; body.appendChild(h);
    const d = document.createElement('div'); d.className = 'seg'; d.style.whiteSpace = 'pre-wrap';
    d.textContent = data['原始回答']; body.appendChild(d);
  }
  $('#result').classList.remove('hidden');
  if (opts.scroll !== false) $('#r-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 历史 ──
async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const ul = $('#hist');
  ul.innerHTML = '';
  $('#hist-empty').classList.toggle('hidden', history.length > 0);
  history.forEach((rec, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<img src="${rec.thumb || ''}" onerror="this.style.visibility='hidden'">
      <div><div class="t">${esc(rec.title || '(未命名)')}</div>
      <div class="s">${esc([rec.up, rec.durationText].filter(Boolean).join(' · '))}</div></div>`;
    li.addEventListener('click', () => {
      ul.querySelectorAll('li').forEach(x => x.classList.remove('sel'));
      li.classList.add('sel');
      renderResult(rec.summary || {});
      // 记住"当前标签页正打开这条总结"，切走再切回来不丢
      cacheView(myTab, snapshotView(myTab));
    });
    ul.appendChild(li);
  });
}

// ── 与 background 通信（按标签页隔离）──
let busy = false;
let myTab = null;
const BILI_VIDEO = /bilibili\.com\/video\/BV[0-9A-Za-z]{10}/i;
function showErr(text) {
  const el = $('#err-banner');
  el.textContent = text || '未知错误';
  el.classList.remove('hidden');
}

async function detectTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    myTab = tab?.id ?? null;
    return tab?.url || '';
  } catch { myTab = null; return ''; }
}

function resetView() {
  state = {}; currentStepDetail = {};
  currentData = null;
  busy = false;
  $('#steps').classList.add('hidden');
  $('#result').classList.add('hidden');
  $('#err-banner').classList.add('hidden');
  $('#step-title').textContent = '—';
  $('#badge').textContent = '就绪';
  $('#badge').className = 'badge';
  setBar(0, false);
}

// ── 视图缓存：侧边栏自己记住每个标签页看到的内容（不依赖后台进程存活）──
const viewCache = new Map();                      // tabId -> 视图快照
const VCACHE_KEY = (tabId) => 'view_' + tabId;

const scroller = () => document.scrollingElement || document.documentElement;
const curScroll = () => Math.round(scroller().scrollTop || 0);
function setScroll(y) { if (typeof y === 'number') scroller().scrollTop = y; }

function snapshotView(tabId) {
  if (tabId == null) return null;
  const err = $('#err-banner').classList.contains('hidden') ? null : $('#err-banner').textContent;
  const hasSteps = !$('#steps').classList.contains('hidden');
  const done = $('#badge').textContent.startsWith('完成') || !!currentData;   // 历史打开的总结也算"已打开"
  if (!hasSteps && !currentData && !err) return null;
  return {
    busy, steps: { ...state }, details: { ...currentStepDetail },
    stepTitle: $('#step-title').textContent, error: err, done,
    result: currentData || null, scroll: curScroll(),
  };
}
function cacheView(tabId, snap) {
  if (tabId == null) return;
  if (!snap) {
    viewCache.delete(tabId);
    chrome.storage.local.remove(VCACHE_KEY(tabId)).catch(() => {});
    return;
  }
  viewCache.set(tabId, snap);
  chrome.storage.local.set({ [VCACHE_KEY(tabId)]: snap }).catch(() => {});
}
async function getCachedView(tabId) {
  if (tabId == null) return null;
  if (viewCache.has(tabId)) return viewCache.get(tabId);
  const key = VCACHE_KEY(tabId);
  const got = await chrome.storage.local.get(key).catch(() => ({}));
  if (got && got[key]) { viewCache.set(tabId, got[key]); return got[key]; }
  return null;
}
let cacheTimer = null;
function scheduleCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => cacheView(myTab, snapshotView(myTab)), 500);
}
window.addEventListener('scroll', () => scheduleCache(), { passive: true });   // 滚动位置也进缓存

// 按状态对象把视图渲染出来（恢复时复用）
function renderState(st) {
  if (!st || !(st.busy || st.done || st.error || st.result)) return;
  busy = !!st.busy;
  $('#steps').classList.remove('hidden');
  $('#step-title').textContent = st.stepTitle || '—';
  state = {}; currentStepDetail = { ...(st.details || {}) };
  for (const [n, v] of Object.entries(st.steps || {})) state[n] = v;
  renderSteps();
  if (st.error && !st.done) {
    showErr(st.error);
    $('#badge').textContent = '失败';
    $('#badge').className = 'badge err';
  } else if (st.done || st.result) {                 // 有结果就算完成（含历史打开的总结）
    setBar(100, false);
    $('#badge').textContent = '完成';
    $('#badge').className = 'badge';
    for (const s of STEPS) if (!state[s]) state[s] = 'done';
    renderSteps();
    if (st.result) { currentData = st.result; renderResult(st.result, { scroll: false }); }
  } else {
    const idx = STEPS.findIndex(n => st.steps?.[n] === 'running');
    setBar(idx >= 0 ? (idx + 0.5) / STEPS.length * 100 : 10, true);
    $('#badge').textContent = '处理中';
    $('#badge').className = 'badge busy';
  }
}

// 标签页切换 = 严格切换视图（用户定义的行为）：
//   A 显示 X → 切到 B（B 没内容）= 空白 → 在 B 开始总结 Y → 切 C 空白 → 开始 Z
//   → 切回 A = 还是 X；切回 B = B 的进度；切回 C = Z；新标签页 D = 空白
// 恢复优先级：后台任务正在跑 → 实时进度；否则用该标签页自己的视图缓存（含历史打开的总结）。
let lastKey = null;
let lastTabId = null;
async function applyTabState() {
  const url = await detectTab();
  const key = `${myTab}|${url}`;
  if (key === lastKey) { refreshGo(url); return; }
  // 离开旧标签页前，把它当时的样子存到"它自己"名下
  if (lastTabId != null && lastTabId !== myTab) cacheView(lastTabId, snapshotView(lastTabId));
  lastKey = key;
  lastTabId = myTab;

  resetView();                                       // 先清空，再按本标签页恢复
  let bg = null;
  try { bg = (await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE', tabId: myTab }))?.state || null; } catch {}
  const cached = await getCachedView(myTab);
  let st = null;
  if (bg && (bg.busy || bg.done || bg.error)) st = bg;              // 后台权威状态：运行中或已完成（含结果）
  else if (cached && (cached.done || cached.error || cached.result)) st = cached;   // 本页上次打开的内容（含历史总结与滚动位置）
  else st = bg;                                                   // 没内容 → 保持空白

  renderState(st);
  if (st) setScroll(st.scroll);
  refreshGo(url);
}

function refreshGo(url) {
  const ok = BILI_VIDEO.test(url || '');
  $('#go').disabled = !ok || busy;
  $('#go-hint').textContent = busy ? '任务进行中…'
    : ok ? '已检测到 B站 视频页，点击开始'
    : '请先在浏览器里打开一个 B站 视频页';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PROGRESS') {
    if (msg.tabId !== myTab) return;                 // 别的标签页的任务，无视
    const { step, detail } = msg;
    if (step === '失败') {
      $('#badge').textContent = '失败';
      $('#badge').className = 'badge err';
      showErr(detail);
      setBar(0, false);
      busy = false;
    } else {
      $('#badge').textContent = '处理中';
      $('#badge').className = 'badge busy';
      setStep(step, 'running', detail);
      if (step === '读取视频信息' && detail) $('#step-title').textContent = detail;
    }
    scheduleCache();                                 // 进度期间也持续存视图（防侧边栏重开丢进度）
  }
  if (msg?.type === 'TASK_DONE') {
    loadHistory();
    if (msg.tabId !== myTab) return;
    busy = false;
    if (msg.ok && msg.data) {
      $('#badge').textContent = '完成';
      $('#badge').className = 'badge';
      setBar(100, false);
      for (const s of STEPS) setStep(s, 'done');
      renderResult(msg.data);
    } else {
      $('#badge').textContent = '完成（JSON 解析失败，看历史原始回答）';
      $('#badge').className = 'badge err';
      setBar(100, false);
      for (const s of STEPS) setStep(s, 'done');
    }
    cacheView(myTab, snapshotView(myTab));           // 结果立刻进视图缓存
  }
  if (msg?.type === 'TASK_FAILED') {
    if (msg.tabId !== myTab) return;
    busy = false;
    $('#badge').textContent = '失败';
    $('#badge').className = 'badge err';
    showErr(msg.error);
    cacheView(myTab, snapshotView(myTab));
  }
});

// ── 检测当前标签页：是 B站 视频页才允许开始 ──
chrome.tabs?.onActivated?.addListener(applyTabState);
chrome.tabs?.onUpdated?.addListener((_id, _info, tab) => { if (tab?.active) applyTabState(); });
window.addEventListener('focus', applyTabState);

$('#go').addEventListener('click', async () => {
  if (busy) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!BILI_VIDEO.test(url)) { $('#go-hint').textContent = '当前页面不是 B站 视频页'; return; }
  busy = true;
  state = {}; currentStepDetail = {};
  currentData = null;
  cacheView(tab.id, null);                           // 新任务开始，清掉这个标签页的旧视图缓存
  $('#steps').classList.remove('hidden');
  $('#result').classList.add('hidden');
  $('#err-banner').classList.add('hidden');
  $('#step-title').textContent = '—';
  $('#badge').textContent = '处理中';
  $('#badge').className = 'badge busy';
  refreshGo(url);
  chrome.runtime.sendMessage({ type: 'SUMMARIZE_URL', url, tabId: tab.id });
});
$('#refresh').addEventListener('click', loadHistory);

// ── 设置：模型 + 提示词前置说明 ──
let defaults = { model: 'Qwen3.8-Omni-Flash', preamble: '' };

function setModelOptions(list) {
  const dl = $('#model-list');
  dl.innerHTML = '';
  for (const m of list || []) {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  }
}
async function loadSettings() {
  const d = await chrome.runtime.sendMessage({ type: 'GET_DEFAULTS' }).catch(() => null);
  if (d?.ok) defaults = { model: d.model, preamble: d.preamble };
  const s = await chrome.storage.local.get({
    model: defaults.model, prompt_preamble: defaults.preamble, models: [],
  });
  if (!$('#prompt').value) $('#prompt').value = s.prompt_preamble || defaults.preamble;
  if (!$('#model').value) $('#model').value = s.model || defaults.model;
  setModelOptions(s.models);
}
function flashSaved(text = '已保存') {
  const el = $('#settings-saved');
  el.textContent = text;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2000);
}
$('#save-settings').addEventListener('click', async () => {
  const model = $('#model').value.trim() || defaults.model;
  const prompt = $('#prompt').value;
  await chrome.storage.local.set({ model, prompt_preamble: prompt });
  flashSaved();
});
$('#reset-settings').addEventListener('click', () => {
  $('#model').value = defaults.model;
  $('#prompt').value = defaults.preamble;
  flashSaved('已恢复默认值（点保存生效）');
});
$('#refresh-models').addEventListener('click', async () => {
  $('#model-tip').textContent = '正在从千问页面读取模型列表…';
  const r = await chrome.runtime.sendMessage({ type: 'GET_MODELS' }).catch(() => null);
  if (r?.models?.length) {
    setModelOptions(r.models);
    $('#model-tip').textContent = `已读到 ${r.models.length} 个模型`
      + (r.source === 'page' ? '（来自千问页面）' : '（本地缓存，打开千问页面可刷新）');
  } else {
    $('#model-tip').textContent = '读取失败：请先打开 chat.qwen.ai 标签页并刷新页面后重试';
  }
});
$('#toggle-settings').addEventListener('click', () => {
  const hidden = $('#settings').classList.toggle('hidden');
  $('#toggle-settings').textContent = hidden ? '展开' : '收起';
  if (!hidden && !$('#prompt').value) loadSettings();
});

// ── 日志：查看 / 复制 / 清空 ──
async function loadLog() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_LOG' }).catch(() => null);
  const pre = $('#log-view');
  if (r?.ok && r.log) {
    pre.textContent = r.log;
    pre.classList.remove('hidden');
    $('#log-empty').classList.add('hidden');
    pre.scrollTop = pre.scrollHeight;                    // 自动滚到最新
  } else {
    pre.classList.add('hidden');
    $('#log-empty').classList.remove('hidden');
  }
}
$('#log-refresh').addEventListener('click', loadLog);
$('#log-copy').addEventListener('click', async () => {
  const btn = $('#log-copy');
  const text = $('#log-view').textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制 ✓';
  } catch {
    // 剪贴板 API 失败（页面未聚焦等）：退回全选让用户 Ctrl+C
    const range = document.createRange();
    range.selectNodeContents($('#log-view'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    btn.textContent = '已全选，请 Ctrl+C';
  }
  setTimeout(() => { btn.textContent = '复制全部'; }, 2500);
});
$('#log-clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' }).catch(() => {});
  loadLog();
});
$('#toggle-log').addEventListener('click', () => {
  const hidden = $('#log-body').classList.toggle('hidden');
  $('#toggle-log').textContent = hidden ? '展开' : '收起';
  if (!hidden) loadLog();                              // 展开时自动拉最新日志
});

// 打开时若有进行中的任务事件（侧边栏晚开），至少恢复历史
loadHistory();
renderSteps();
loadSettings();
applyTabState();
loadLog();
