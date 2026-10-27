// test-empty-earlyexit.mjs —— 验证「连续查不到 assistant 消息」会早退，而不是干等 25 分钟
// 用法：node test_script/tests/test-empty-earlyexit.mjs

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

// 把轮询间隔 8 秒压到 0，否则这个测试要跑 4 分钟
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 5000 ? 0 : ms);

let mode = 'empty';
let calls = 0;

globalThis.fetch = async () => {
  calls++;
  let chat;
  if (mode === 'empty') {
    // 复现用户遇到的故障：会话存在，但 messages 里没有 assistant
    chat = { messages: [{ role: 'user', content: '请总结这个视频' }] };
  } else if (mode === 'nomessages') {
    // 更糟：连 messages 字段都没有（接口结构变了）
    chat = { title: '某个会话', id: 'x' };
  } else if (mode === 'delayed') {
    // 前 3 次空，之后才出现 assistant（正常慢生成场景，不该早退）
    chat = calls <= 3
      ? { messages: [{ role: 'user', content: 'hi' }] }
      : { messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', done: true, model: 'm', content_list: [{ phase: 'answer', content: '{"结论":"ok"}' }] },
        ] };
  }
  return { ok: true, status: 200, async json() { return { data: { chat } }; } };
};

const { pollAnswer } = await import('../../lib/qwen.js');

// 断言辅助：不仅看报错文本，还必须看「真的早退了」（耗时与请求次数）。
// 教训：旧版测试只检查错误文本包含「连续 30 次」，结果跑满 25 分钟、
// 97783 次请求也报 ✅，是假阳性。现在把耗时和请求次数都卡死。
const MAX_MS = 30_000;      // 早退应在 30 秒内（压缩延时后实际几百 ms）
const MAX_CALLS = 100;      // 最多 100 次请求（预期约 31 次）

let pass = 0, fail = 0;

function assertEarlyExit(label, ms, n) {
  const problems = [];
  if (ms > MAX_MS) problems.push(`耗时 ${ms}ms 超过 ${MAX_MS}ms（没真早退）`);
  if (n > MAX_CALLS) problems.push(`请求 ${n} 次超过 ${MAX_CALLS}（在傻等）`);
  if (problems.length) {
    fail++;
    console.log(`❌ ${label}：${problems.join('；')}`);
    return false;
  }
  pass++;
  console.log(`✅ ${label}（用时 ${ms}ms，请求 ${n} 次）`);
  return true;
}

// 场景 1：会话有 messages 但没有 assistant → 应在约 30 次轮询后早退报错
mode = 'empty';
calls = 0;
{
  const t0 = Date.now();
  try {
    await pollAnswer('fake-id', { maxMs: 25 * 60_000 });
    fail++; console.log('❌ 场景1：本该早退报错，却正常返回了');
  } catch (e) {
    const ms = Date.now() - t0;
    if (!/连续 30 次/.test(e.message)) {
      fail++; console.log(`❌ 场景1：报错内容不符：${e.message.slice(0, 120)}`);
    } else {
      assertEarlyExit('场景1：连续空消息后早退', ms, calls);
    }
  }
}

// 场景 2：连 messages 字段都没有 → 同样早退
mode = 'nomessages';
calls = 0;
{
  const t0 = Date.now();
  try {
    await pollAnswer('fake-id', { maxMs: 25 * 60_000 });
    fail++; console.log('❌ 场景2：本该早退报错，却正常返回了');
  } catch (e) {
    const ms = Date.now() - t0;
    if (!/连续 30 次/.test(e.message) || !/未找到/.test(e.message)) {
      fail++; console.log(`❌ 场景2：报错内容不符：${e.message.slice(0, 150)}`);
    } else {
      assertEarlyExit('场景2：字段缺失也早退', ms, calls);
    }
  }
}

// 场景 3：慢生成（前几次空，之后有结果）→ 不该早退，应正常返回
mode = 'delayed';
calls = 0;
{
  const t0 = Date.now();
  try {
    const r = await pollAnswer('fake-id', { maxMs: 25 * 60_000 });
    const ms = Date.now() - t0;
    if (!r.text.includes('ok')) {
      fail++; console.log(`❌ 场景3：结果不对：${r.text}`);
    } else if (ms > MAX_MS || calls > MAX_CALLS) {
      fail++; console.log(`❌ 场景3：正常路径不该慢（${ms}ms / ${calls} 次）`);
    } else {
      pass++;
      console.log(`✅ 场景3：慢生成不误判，正常取到结果（用时 ${ms}ms，请求 ${calls} 次）`);
    }
  } catch (e) {
    fail++; console.log(`❌ 场景3：不该报错，却抛了：${e.message.slice(0, 120)}`);
  }
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
