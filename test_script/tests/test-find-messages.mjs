// test-find-messages.mjs —— 验证消息数组自动兜底 + 空消息早退
// 用法：node test_script/tests/test-find-messages.mjs

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const { findMessageArray } = await import('../../lib/qwen.js');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

// 1) 正常：chat.messages
check('标准 messages 字段',
  findMessageArray({ messages: [{ role: 'user' }, { role: 'assistant' }] }),
  { key: 'messages', list: [{ role: 'user' }, { role: 'assistant' }] });

// 2) 字段被改名 → 靠 role 特征找到
check('字段改名为 msgs',
  findMessageArray({ msgs: [{ role: 'user' }] }).key,
  'msgs');

// 3) 靠 content_list 特征也能找到（没有 role 但有 content_list）
check('靠 content_list 特征识别',
  findMessageArray({ items: [{ content_list: [] }] }).key,
  'items');

// 4) 完全找不到 → key 为 null
check('没有消息数组',
  findMessageArray({ title: 'x', id: 1 }),
  { key: null, list: [] });

// 5) 空对象
check('空对象', findMessageArray({}), { key: null, list: [] });

// 6) null / undefined 不抛错
check('null 输入', findMessageArray(null), { key: null, list: [] });
check('undefined 输入', findMessageArray(undefined), { key: null, list: [] });

// 7) 优先用 messages（即使还有别的数组）
check('优先 messages',
  findMessageArray({
    history: [{ role: 'user' }],
    messages: [{ role: 'assistant' }],
  }).key,
  'messages');

// 8) 空数组不算命中，继续找下一个
check('跳过空数组',
  findMessageArray({ empty: [], real: [{ role: 'user' }] }).key,
  'real');

// 9) 数组元素不是对象（纯字符串数组）应跳过
check('跳过字符串数组',
  findMessageArray({ tags: ['a', 'b'], msgs: [{ role: 'user' }] }).key,
  'msgs');

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
