// test-poll-answer.mjs —— 验证 pollAnswer 在「done 但无 answer 段」时能保底返回
// 用法：node test/test-poll-answer.mjs
//
// 复现用户遇到的真实故障：千问页面已经把 JSON 输出完，接口返回 done=true，
// 但 content_list 里没有 phase==='answer' 的段（全在 think / 或 phase 异常），
// 旧实现会一直轮询到 25 分钟超时。

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

// 把 pollAnswer 里的 8 秒等待改成 0，否则测试要跑很久
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 5000 ? 0 : ms);

let mode = 'no-answer';
globalThis.fetch = async () => {
  const base = {
    done: true,
    model: 'qwen3.8-omni-flash',
  };
  let content_list;
  if (mode === 'no-answer') {
    // 关键故障场景：只有 think，没有 answer
    content_list = [{ phase: 'think', content: '{"结论":"这是正文被错放进 think"}' }];
  } else if (mode === 'normal') {
    content_list = [
      { phase: 'think', content: '思考…' },
      { phase: 'answer', content: '{"结论":"正常"}' },
    ];
  } else if (mode === 'phase-null') {
    content_list = [{ phase: null, content: '{"结论":"phase 是 null"}' }];
  }
  return {
    ok: true,
    status: 200,
    async json() { return { data: { chat: { messages: [{ role: 'assistant', ...base, content_list }] } } }; },
  };
};

const { pollAnswer } = await import('../lib/qwen.js');

let pass = 0, fail = 0;
async function expectOk(name, wantSubstr) {
  try {
    const r = await pollAnswer('fake-chat-id', { maxMs: 60_000 });
    if (r.text.includes(wantSubstr)) { pass++; console.log(`✅ ${name} → ${r.text.slice(0, 40)}`); }
    else { fail++; console.log(`❌ ${name}\n   返回正文不含「${wantSubstr}」：${r.text.slice(0, 80)}`); }
  } catch (e) {
    fail++; console.log(`❌ ${name}\n   抛错：${e.message}`);
  }
}

// 场景 1：done 但无 answer 段 → 必须在几轮内退化返回，而不是等到超时
mode = 'no-answer';
await expectOk('done 但无 answer 段（用户遇到的真故障）', '这是正文被错放进 think');

// 场景 2：正常路径不受影响
mode = 'normal';
await expectOk('正常 answer 段', '正常');

// 场景 3：phase 是 null
mode = 'phase-null';
await expectOk('phase 为 null', 'phase 是 null');

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
