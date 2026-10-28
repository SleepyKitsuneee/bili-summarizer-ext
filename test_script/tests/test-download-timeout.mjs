// test-download-timeout.mjs —— 验证下载超时会中断并重试，而不是永远挂着
// 用法：node test_script/tests/test-download-timeout.mjs
//
// 真实故障：下载卡在 80% 十分钟不动。原因是 reader.read() 在 TCP 连接半开时
// 永不返回，任务整个死在那里。修复：单次读取加超时 + 整体重试。

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const { downloadStream } = await import('../../lib/bilibili.js');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ' · ' + extra : ''}`); }
}

// 造一个「读到一半就卡住」的流
function makeStuckStream(totalChunks, stuckAt) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < stuckAt) {
            i++;
            return { done: false, value: new Uint8Array(1024) };
          }
          // 卡住：永远不 resolve
          return new Promise(() => {});
        },
        async cancel() {},
      };
    },
  };
}

let attempt = 0;
globalThis.fetch = async () => {
  attempt++;
  const total = 4 * 1024;
  let served = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-length' ? String(total) : 'video/mp4') },
    body: makeStuckStream(4, 2),      // 读到第 2 块就卡住
  };
};

// 场景 1：卡住的流应该在超时后报错重试，不能无限挂起
{
  attempt = 0;
  const t0 = Date.now();
  let msg = '';
  try {
    await downloadStream('http://x/v.m4s', null, { attempts: 2, timeoutMs: 300 });
  } catch (e) { msg = String(e?.message ?? e); }
  const ms = Date.now() - t0;
  check('卡住的下载会超时退出', ms < 15_000, `用时 ${ms}ms`);
  check('重试过至少一次', attempt >= 2, `尝试 ${attempt} 次`);
  check('错误信息含超时提示', /超时/.test(msg), msg.slice(0, 60));
}

// 场景 2：正常流应该秒回
{
  attempt = 0;
  globalThis.fetch = async () => {
    attempt++;
    const total = 2048;
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(total) : 'video/mp4') },
      body: {
        getReader() {
          return {
            async read() {
              if (i >= 2) return { done: true, value: undefined };
              i++;
              return { done: false, value: new Uint8Array(total / 2) };
            },
            async cancel() {},
          };
        },
      },
    };
  };
  const buf = await downloadStream('http://x/v.m4s', null, { attempts: 2, timeoutMs: 2000 });
  check('正常下载返回正确字节数', buf.byteLength === 2048, `${buf.byteLength} 字节`);
  check('正常下载只请求一次', attempt === 1, `${attempt} 次`);
}

// 场景 3：HTTP 错误要立刻抛出，不重试（重试也没用）
{
  attempt = 0;
  globalThis.fetch = async () => {
    attempt++;
    return { ok: false, status: 403, headers: { get: () => '0' }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) } };
  };
  let msg = '';
  try { await downloadStream('http://x/v.m4s', null, { attempts: 3, timeoutMs: 500 }); }
  catch (e) { msg = String(e?.message ?? e); }
  check('HTTP 403 立即抛错', /403/.test(msg), msg.slice(0, 40));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
