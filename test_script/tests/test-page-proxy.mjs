// test-page-proxy.mjs —— 验证「页面代理读取会话」能绕过 Unauthorized
// 用法：node test_script/tests/test-page-proxy.mjs
//
// 真实故障：SW 直连 /api/v2/chats/{id} 返回
//   {"success":false,"data":{"code":"Unauthorized","details":"您没有权限访问此资源。"}}
// 原因：SW 的 fetch 算第三方请求，千问登录 cookie 是 SameSite=Lax，不会发出。
// 解法：由 chat.qwen.ai 页面内部发 fetch（同源），cookie 自动带上。

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 5000 ? 0 : ms);

let swCalls = 0;
let pageCalls = 0;

// SW 直连：模拟缺 cookie → Unauthorized
globalThis.fetch = async () => {
  swCalls++;
  return {
    ok: true, status: 200,
    async json() {
      return { success: false, data: { code: 'Unauthorized', details: '您没有权限访问此资源。' } };
    },
  };
};

const { probeChat, pollAnswer, setPageFetch, setLog } = await import('../../lib/qwen.js');
const logs = [];
setLog((m) => logs.push(String(m)));

let pass = 0, fail = 0;

// 场景 1：没有页面代理 → 走 SW 直连 → 识别为业务错误
{
  setPageFetch(null);
  swCalls = 0;
  const r = await probeChat('any-id');
  if (r.ok === false && r.bizError === true && /Unauthorized/.test(r.error) && swCalls >= 1) {
    pass++; console.log(`✅ 场景1：无代理时走 SW 直连并识别 Unauthorized（${swCalls} 次）`);
  } else {
    fail++; console.log(`❌ 场景1：${JSON.stringify(r)}（swCalls=${swCalls}）`);
  }
}

// 场景 2：有页面代理 → 走页面 → 成功拿到消息
{
  setPageFetch(async (url) => {
    pageCalls++;
    return {
      ok: true, status: 200,
      json: {
        success: true,
        data: { chat: { messages: [
          { role: 'user', content: '请总结' },
          { role: 'assistant', done: true, model: 'omni', content_list: [{ phase: 'answer', content: '{"结论":"ok"}' }] },
        ] } },
      },
    };
  });
  swCalls = 0; pageCalls = 0;
  const r = await probeChat('good-id');
  if (r.ok && r.total === 2 && r.assistants === 1 && pageCalls === 1 && swCalls === 0) {
    pass++; console.log(`✅ 场景2：有代理时走页面，拿到 2 条消息（页面 ${pageCalls} 次 / SW ${swCalls} 次）`);
  } else {
    fail++; console.log(`❌ 场景2：${JSON.stringify(r)}（page=${pageCalls} sw=${swCalls}）`);
  }
}

// 场景 3：有代理时 pollAnswer 能正常取到答案
{
  setPageFetch(async () => ({
    ok: true, status: 200,
    json: {
      success: true,
      data: { chat: { messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', done: true, model: 'omni', content_list: [{ phase: 'answer', content: '{"结论":"代理生效"}' }] },
      ] } },
    },
  }));
  try {
    const r = await pollAnswer('good-id', { maxMs: 60_000 });
    if (r.text.includes('代理生效')) {
      pass++; console.log('✅ 场景3：pollAnswer 经代理取到答案');
    } else {
      fail++; console.log(`❌ 场景3：结果不对：${r.text}`);
    }
  } catch (e) {
    fail++; console.log(`❌ 场景3：抛错：${e.message.slice(0, 120)}`);
  }
}

// 场景 4：代理本身抛错时，错误信息要能看出是代理问题
{
  setPageFetch(async () => { throw new Error('页面代理失败：Receiving end does not exist'); });
  try {
    await probeChat('any-id');
    fail++; console.log('❌ 场景4：本该抛错');
  } catch (e) {
    if (/代理失败/.test(e.message)) {
      pass++; console.log('✅ 场景4：代理失败时错误信息清晰');
    } else {
      fail++; console.log(`❌ 场景4：错误信息不清晰：${e.message.slice(0, 120)}`);
    }
  }
}

// 场景 5：诊断日志要标明走的是哪条通道
{
  setPageFetch(async () => ({
    ok: true, status: 200,
    json: { success: true, data: { chat: { messages: [{ role: 'user' }] } } },
  }));
  logs.length = 0;
  await probeChat('id');
  const joined = logs.join('\n');
  if (/经页面代理读取/.test(joined)) {
    pass++; console.log('✅ 场景5：日志标明走页面代理');
  } else {
    fail++; console.log(`❌ 场景5：日志没标明通道：${joined.slice(0, 200)}`);
  }
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
