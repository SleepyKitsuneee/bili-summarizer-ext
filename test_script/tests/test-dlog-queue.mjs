// test-dlog-queue.mjs —— 验证 dlog 的队列/刷盘逻辑不会丢日志
// 用法：node test/test-dlog-queue.mjs
//
// 这个测试把 chrome.storage.local 换成内存实现，然后模拟 Service Worker 的
// 真实场景：大量日志 + 中途 flushBuffer + 并发入队，检查是否每一行都进了队列。

const store = {};
const removed = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        }
        return { ...store };
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) { delete store[k]; removed.push(k); }
      },
    },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
};

// 极简 indexedDB 桩：dlog 只在 flush/status 时用，本测试不涉及
globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        transaction: () => ({ objectStore: () => ({ get: () => ({}) }) }),
        close() {},
      };
      req.onsuccess?.();
    }, 0);
    return req;
  },
};

const dlog = await import('../../lib/dlog.js');

const N = 5000;
const expect = [];
for (let i = 0; i < N; i++) {
  const line = `line-${i}`;
  expect.push(line);
  dlog.enqueue(line);
  // 中途穿插 flushBuffer，模拟 report() 里的关键节点刷盘
  if (i % 700 === 0) await dlog.flushBuffer();
}
await dlog.flushBuffer();

// 把所有批次按 seq 顺序取出来
const idx = store.dbgQIdx;
if (!idx) {
  console.error('❌ 没有生成索引 dbgQIdx');
  process.exit(1);
}
const got = [];
for (const k of idx.keys) {
  const arr = store[k];
  if (Array.isArray(arr)) got.push(...arr);
}

console.log(`入队 ${N} 行，队列里取回 ${got.length} 行`);
console.log(`批次数 ${idx.keys.length}，丢弃批次 ${idx.dropped || 0}`);

// 1) 数量与顺序
if (got.length !== expect.length) {
  console.error(`❌ 行数不符：期望 ${expect.length}，实际 ${got.length}`);
  process.exit(1);
}
for (let i = 0; i < expect.length; i++) {
  if (got[i] !== expect[i]) {
    console.error(`❌ 第 ${i} 行不符：期望 ${expect[i]}，实际 ${got[i]}`);
    process.exit(1);
  }
}
console.log('✅ 数量与顺序全部正确');

// 2) 并发入队（不 await）后必须仍能刷干净
const expect2 = [];
for (let i = 0; i < 500; i++) {
  const line = `burst-${i}`;
  expect2.push(line);
  dlog.enqueue(line);
}
await dlog.flushBuffer();
const got2 = [];
for (const k of store.dbgQIdx.keys) {
  const arr = store[k];
  if (Array.isArray(arr)) got2.push(...arr);
}
const tail = got2.slice(-500);
if (tail.join(',') !== expect2.join(',')) {
  console.error('❌ 并发入队丢行');
  console.error('  期望尾部:', expect2.slice(0, 5).join(','));
  console.error('  实际尾部:', tail.slice(0, 5).join(','));
  process.exit(1);
}
console.log('✅ 并发入队不丢行');
console.log('\n全部通过');
