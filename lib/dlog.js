// dlog.js —— 运行日志落盘（追加写入本地 debug.log）
//
// 为什么需要：插件版的运行日志原本只存在 chrome.storage.session —— 浏览器一退出就没了，
// 出问题后完全无法回溯（桌面版有 desktop/logs/engine-*.log，插件版一直没有等价物）。
//
// 分工（MV3 的硬约束决定的，不是设计偏好）：
//   · background（Service Worker）**没有 window**，用不了 File System Access API，
//     它只负责把日志行压进 chrome.storage.local 的队列；
//   · sidepanel（有 window、有用户手势）负责选目录、续授权、把队列刷进 debug.log。
// 队列按批次存成独立 key（dbgQ:00000001…），避免每次落盘都 get/set 整个大数组。
//
// 权限策略（用户指定）：任务开始时静默检查；没配置或权限失效才弹窗。

const DB_NAME = 'biliExtLog';
const DB_VERSION = 1;
const DB_STORE = 'handles';
const HANDLE_KEY = 'logDir';
export const LOG_FILE = 'debug.log';

const QIDX = 'dbgQIdx';
const QKEY = (n) => 'dbgQ:' + String(n).padStart(8, '0');
const MAX_BATCHES = 2000;             // 最多留 2000 批（约 40 万行），超出丢最旧的
const MAX_LINES_PER_BATCH = 200;
const MAX_CHARS_PER_BATCH = 64 * 1024;

// ── IndexedDB：只存一个目录句柄（同源共享，sidepanel / offscreen 都能读）──
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
export async function getDirHandle() {
  try { return (await idbOp('readonly', (s) => s.get(HANDLE_KEY))) || null; } catch { return null; }
}
export async function setDirHandle(h) {
  try {
    if (h) await idbOp('readwrite', (s) => s.put(h, HANDLE_KEY));
    else await idbOp('readwrite', (s) => s.delete(HANDLE_KEY));
    return true;
  } catch { return false; }
}

// ── 队列写入（background 调用）──
// ⚠️ 这里踩过一个坑：最初用 setTimeout 做 800ms 防抖批量落盘，结果**日志全丢**。
// 原因：MV3 的 Service Worker 在没有事件处理时会休眠，长任务里一旦 await 网络请求，
// 事件循环就交出去，setTimeout 的回调可能被推迟到很久之后、甚至随 SW 回收一起消失。
// 现在改成 Promise 链：每次 enqueue 都把「写入这一行」串到链尾，不依赖任何定时器。
// 链保证顺序；同一 tick 内连续入队的行会被合并成一次 pushBatch（见 drainPending）。
let pending = [];                 // 待写入的行
let chain = Promise.resolve();    // 串行化写操作，保证顺序且不丢
let queued = false;               // 是否已有一次刷盘排在链上

export function enqueue(line) {
  const s = String(line ?? '');
  if (!s) return;
  pending.push(s);
  scheduleFlush();
}

// 保证「pending 里只要有行，就一定有一次 flushPending 排在链上」。
// 关键：不能只看 queued 就返回 —— 若上一轮 flushPending 已经把 pending 取走、
// 但自己还没结束时，新行会进到新的 pending 里而没人负责刷（旧实现的丢日志原因之一）。
function scheduleFlush() {
  if (queued) return;
  queued = true;
  chain = chain.then(() => {
    queued = false;                 // 先清标志：本次执行期间新入队的行会再排一次
    return flushPending();
  }).catch(() => { queued = false; })
    .then(() => {
      // 兜底：如果这一轮期间又有新行进来，继续排
      if (pending.length) scheduleFlush();
    });
}

async function flushPending() {
  if (!pending.length) return;
  const lines = pending;
  pending = [];
  // 切成若干批，避免单条 storage 记录过大
  let cur = [], curChars = 0;
  const batches = [];
  for (const l of lines) {
    if (cur.length >= MAX_LINES_PER_BATCH || curChars + l.length > MAX_CHARS_PER_BATCH) {
      if (cur.length) batches.push(cur);
      cur = []; curChars = 0;
    }
    cur.push(l);
    curChars += l.length + 1;
  }
  if (cur.length) batches.push(cur);
  for (const b of batches) await pushBatch(b);
}

async function pushBatch(lines) {
  const got = await chrome.storage.local.get(QIDX).catch(() => ({}));
  const idx = got[QIDX] || { seq: 0, keys: [] };
  idx.seq = (idx.seq || 0) + 1;
  idx.keys = (idx.keys || []).concat(QKEY(idx.seq));
  let drop = [];
  if (idx.keys.length > MAX_BATCHES) {
    drop = idx.keys.splice(0, idx.keys.length - MAX_BATCHES);
    // 记下丢了多少批，别静默丢（这个计数会随索引一起持久化）
    idx.dropped = (idx.dropped || 0) + drop.length;
  }
  await chrome.storage.local.set({ [QKEY(idx.seq)]: lines, [QIDX]: idx }).catch(() => {});
  if (drop.length) chrome.storage.local.remove(drop).catch(() => {});
}

// 立刻把内存缓冲推进 storage（关键节点用）。
// 做法：排一次显式刷盘并等它跑完，保证调用返回时 pending 已清空。
export async function flushBuffer() {
  try {
    await chain;
    if (pending.length) {
      queued = true;
      chain = chain.then(() => { queued = false; return flushPending(); }).catch(() => { queued = false; });
    }
    await chain;
  } catch {}
}

async function drainQueue() {
  const got = await chrome.storage.local.get(QIDX).catch(() => ({}));
  const idx = got[QIDX];
  if (!idx || !Array.isArray(idx.keys) || !idx.keys.length) return { lines: [], keys: [] };
  const data = await chrome.storage.local.get(idx.keys).catch(() => ({}));
  const lines = [];
  const keys = [];
  for (const k of idx.keys) {
    const arr = data[k];
    if (Array.isArray(arr)) { lines.push(...arr); keys.push(k); }
    else keys.push(k);                       // 已被别的流程删掉/从未写入：也算已处理
  }
  return { lines, keys };
}

// 只删数据键，**不重写索引**。
// 原因：background 的 pushBatch 也在读-改-写同一个 QIDX，两边同时改会互相覆盖
// （表现是日志重复或丢批）。索引保持单调递增、由 pushBatch 统一按 MAX_BATCHES 截断，
// drainQueue 跳过已不存在的数据键即可，索引与数据不同步是无害的。
async function dropKeys(keys) {
  if (!keys.length) return;
  await chrome.storage.local.remove(keys).catch(() => {});
}

export async function clearQueue() {
  pending = [];
  const { keys } = await drainQueue();
  await dropKeys(keys);
  // 注意：不删 QIDX。background 可能正在 pushBatch，删掉索引会让它的下一批
  // 从 seq=1 重新开始，与残留键撞号。只清数据键即可（drainQueue 会跳过不存在的键）。
}

// ── 权限 ──
async function ensurePermission(handle, interactive) {
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch { return false; }
}

export async function status() {
  const handle = await getDirHandle();
  if (!handle) return { configured: false, file: LOG_FILE, pending: await queueSize() };
  let permission = 'unknown';
  try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch {}
  let fileSize = null;
  try {
    const fh = await handle.getFileHandle(LOG_FILE, { create: false });
    fileSize = (await fh.getFile()).size;
  } catch {}
  return { configured: true, name: handle.name, permission, file: LOG_FILE, fileSize, pending: await queueSize() };
}

// 队列里还有多少行没写进文件（用于在侧边栏提示积压）
export async function queueSize() {
  const got = await chrome.storage.local.get(QIDX).catch(() => ({}));
  const idx = got[QIDX];
  const n = (idx && Array.isArray(idx.keys)) ? idx.keys.length : 0;
  return { batches: n, lines: pending.length };
}

// 任务开始时调用：已授权就静默通过；没配置/权限失效且 interactive=true 才弹窗。
// 注意 requestPermission()/showDirectoryPicker() 都要用户手势，interactive=true 必须来自点击处理器。
export async function ensureReady({ interactive = false } = {}) {
  // 用户已在本会话里明确取消过 → 不再弹窗（否则每点一次「开始总结」弹一次，很烦）
  if (interactive) {
    const got = await chrome.storage.session.get('logAskDismissed').catch(() => ({}));
    if (got?.logAskDismissed) return { ok: false, reason: 'dismissed' };
  }
  let handle = await getDirHandle();
  if (!handle) {
    if (!interactive) return { ok: false, reason: 'no-handle' };
    if (!('showDirectoryPicker' in window)) return { ok: false, reason: 'unsupported' };
    try {
      handle = await window.showDirectoryPicker({ id: 'biliExtLog', mode: 'readwrite', startIn: 'documents' });
    } catch (e) {
      if (e?.name === 'AbortError') {
        await chrome.storage.session.set({ logAskDismissed: true }).catch(() => {});
        return { ok: false, reason: 'canceled' };
      }
      return { ok: false, reason: String(e?.message ?? e) };
    }
    await setDirHandle(handle);
    return { ok: true, created: true, name: handle.name };
  }
  const opts = { mode: 'readwrite' };
  let perm = 'prompt';
  try { perm = await handle.queryPermission(opts); } catch {}
  if (perm === 'granted') return { ok: true, name: handle.name };
  if (!interactive) return { ok: false, reason: 'need-permission', name: handle.name };
  try { perm = await handle.requestPermission(opts); } catch (e) { return { ok: false, reason: 'request-failed' }; }
  if (perm === 'granted') return { ok: true, name: handle.name };
  await chrome.storage.session.set({ logAskDismissed: true }).catch(() => {});
  return { ok: false, reason: 'denied', name: handle.name };
}

// 用户在设置里重新选了目录，或手动点「立即写入」，就把"不再询问"标记清掉
export async function resetAskDismissed() {
  await chrome.storage.session.remove('logAskDismissed').catch(() => {});
}

export async function pickDir() {
  if (!('showDirectoryPicker' in window)) return { ok: false, reason: 'unsupported' };
  try {
    const h = await window.showDirectoryPicker({ id: 'biliExtLog', mode: 'readwrite', startIn: 'documents' });
    await setDirHandle(h);
    await resetAskDismissed();                       // 手动选了目录 → 重新允许后续静默写入
    return { ok: true, name: h.name };
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'canceled' : String(e?.message ?? e) };
  }
}

// 把队列刷进 debug.log（追加写）。sidepanel 在打开时、以及有任务在跑时定时调用。
export async function flush({ interactive = false } = {}) {
  await flushBuffer();                               // 先把内存缓冲推进队列
  // 统一走 ensureReady：没配置且 interactive 时弹选目录、权限失效且 interactive 时弹授权
  const ready = await ensureReady({ interactive });
  if (!ready.ok) return { ok: false, reason: ready.reason, name: ready.name };
  const handle = await getDirHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };
  const { lines, keys } = await drainQueue();
  if (!lines.length) {
    if (keys.length) await dropKeys(keys);
    return { ok: true, written: 0, name: handle.name };
  }
  const text = lines.join('\n') + '\n';
  const fileHandle = await handle.getFileHandle(LOG_FILE, { create: true });
  const file = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    await writable.seek(file.size);                  // 追加到末尾
    await writable.write(text);
    await writable.close();
  } catch (e) {
    try { await writable.abort(); } catch {}
    throw e;
  }
  await dropKeys(keys);
  const idx = (await chrome.storage.local.get(QIDX).catch(() => ({})))[QIDX] || {};
  return {
    ok: true, written: lines.length, bytes: text.length,
    size: file.size + text.length, name: handle.name,
    dropped: idx.dropped || 0,
  };
}

// 清空 debug.log（不是删除，只把长度归零；后续仍可追加）
export async function clearFile() {
  const handle = await getDirHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };
  if (!(await ensurePermission(handle, true))) return { ok: false, reason: 'need-permission' };
  try {
    const fileHandle = await handle.getFileHandle(LOG_FILE, { create: true });
    const writable = await fileHandle.createWritable();   // 不带 keepExistingData = 截断
    await writable.write('');
    await writable.close();
    return { ok: true, name: handle.name };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}
