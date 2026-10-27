// test-biz-error.mjs —— 验证「接口返回业务错误」能被如实识别并立刻失败
// 用法：node test_script/tests/test-biz-error.mjs
//
// 复现用户遇到的真实响应：
//   { success: false, request_id: '...', data: { code: ..., details: ... } }
// 旧实现只看 HTTP 200 就报「chatId 有效」，然后白轮询 30 次（4 分钟）。

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 5000 ? 0 : ms);

let mode = 'biz-error';
let calls = 0;
const logs = [];

globalThis.fetch = async () => {
  calls++;
  let body;
  if (mode === 'biz-error') {
    // 用户日志里的真实结构
    body = {
      success: false,
      request_id: 'req-abc',
      data: { code: 'InvalidChatId', details: 'chat not found or expired' },
    };
  } else if (mode === 'ok') {
    body = {
      success: true,
      data: { chat: { messages: [{ role: 'user', content: 'hi' }] } },
    };
  } else if (mode === 'no-chat') {
    body = { success: true, data: {} };
  }
  return { ok: true, status: 200, async json() { return body; } };
};

const { probeChat, pollAnswer, setLog } = await import('../../lib/qwen.js');
setLog((m) => logs.push(String(m)));

let pass = 0, fail = 0;

// 场景 1：业务错误 → probeChat 必须报 ok:false + bizError:true
mode = 'biz-error';
calls = 0;
{
  const r = await probeChat('bad-chat-id');
  if (r.ok === false && r.bizError === true) {
    pass++; console.log(`✅ 场景1：probeChat 如实报业务错误（${r.error.slice(0, 60)}）`);
  } else {
    fail++; console.log(`❌ 场景1：probeChat 没识别业务错误，返回 ${JSON.stringify(r)}`);
  }
}

// 场景 2：业务错误 → pollAnswer 必须立刻失败，不轮询
mode = 'biz-error';
calls = 0;
logs.length = 0;
{
  const t0 = Date.now();
  try {
    await pollAnswer('bad-chat-id', { maxMs: 25 * 60_000 });
    fail++; console.log('❌ 场景2：本该立刻失败，却正常返回了');
  } catch (e) {
    const ms = Date.now() - t0;
    const isBiz = /业务错误/.test(e.message);
    const fast = ms < 5000 && calls <= 3;
    if (isBiz && fast) {
      pass++; console.log(`✅ 场景2：立刻失败（${ms}ms，请求 ${calls} 次）`);
    } else {
      fail++;
      console.log(`❌ 场景2：${isBiz ? '识别对了' : '没识别业务错误'}，`
        + `但${fast ? '快' : `慢（${ms}ms / ${calls} 次）`}：${e.message.slice(0, 100)}`);
    }
  }
}

// 场景 3：正常响应 → probeChat 报 ok:true
mode = 'ok';
calls = 0;
{
  const r = await probeChat('good-id');
  if (r.ok && r.messageKey === 'messages' && r.total === 1) {
    pass++; console.log('✅ 场景3：正常响应识别正确');
  } else {
    fail++; console.log(`❌ 场景3：正常响应识别错：${JSON.stringify(r)}`);
  }
}

// 场景 4：success=true 但没有 chat → probeChat 应报 ok:false（不是谎称有效）
mode = 'no-chat';
calls = 0;
{
  const r = await probeChat('empty-id');
  if (r.ok === false) {
    pass++; console.log(`✅ 场景4：没有 chat 时如实报失败（${String(r.error).slice(0, 50)}）`);
  } else {
    fail++; console.log(`❌ 场景4：谎称有效：${JSON.stringify(r)}`);
  }
}

// 场景 5：诊断日志必须包含 data.code 与 details 的具体值
mode = 'biz-error';
calls = 0;
logs.length = 0;
await probeChat('bad-chat-id');
{
  const text = logs.join('\n');
  const hasCode = text.includes('InvalidChatId');
  const hasDetails = text.includes('chat not found');
  if (hasCode && hasDetails) {
    pass++; console.log('✅ 场景5：诊断日志记录了 data.code 与 details 的具体值');
  } else {
    fail++;
    console.log(`❌ 场景5：诊断日志缺少具体值（code=${hasCode} details=${hasDetails}）`);
    console.log('   日志：' + text.slice(0, 300));
  }
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
