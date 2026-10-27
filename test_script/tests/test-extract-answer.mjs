// test-extract-answer.mjs —— 验证 extractAnswer 的三层退化 + pollAnswer 保底
// 用法：node test/test-extract-answer.mjs

globalThis.chrome = { storage: { local: { async get() { return {}; }, async set() {}, async remove() {} }, session: { async get() { return {}; }, async set() {}, async remove() {} } } };

const { extractAnswer } = await import('../../lib/qwen.js');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = actual === expect;
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

// 1) content 直接有值 → 优先用它
check('content 优先',
  extractAnswer({ role: 'assistant', content: '  正文  ' }),
  '正文');

// 2) 正常 answer 段
check('取 answer 段',
  extractAnswer({ role: 'assistant', content: '', content_list: [
    { phase: 'think', content: '思考中…' },
    { phase: 'answer', content: '{"结论":"好"}' },
  ] }),
  '{"结论":"好"}');

// 3) 没有 answer 段 → 退化取非 think（这是之前卡死的场景）
check('退化：取非 think 段',
  extractAnswer({ role: 'assistant', content: '', content_list: [
    { phase: 'think', content: '思考中…' },
    { phase: 'response', content: '{"结论":"好"}' },
  ] }),
  '{"结论":"好"}');

// 4) 只有 think 段 → 再退化为全取（总比空串好，至少能拿到东西）
check('退化：只有 think 时全取',
  extractAnswer({ role: 'assistant', content: '', content_list: [
    { phase: 'think', content: '{"结论":"好"}' },
  ] }),
  '{"结论":"好"}');

// 5) phase 是 null / 数字（严格相等会漏掉）
check('退化：phase 非字符串',
  extractAnswer({ role: 'assistant', content: '', content_list: [
    { phase: null, content: 'A' },
    { phase: 0, content: 'B' },
  ] }),
  'A\n\nB');

// 6) content_list 为空 → 空串
check('空 content_list',
  extractAnswer({ role: 'assistant', content: '', content_list: [] }),
  '');

// 7) 非 assistant 角色 → 空串
check('非 assistant',
  extractAnswer({ role: 'user', content: 'hi' }),
  '');

// 8) 多个 answer 段拼接
check('多 answer 段拼接',
  extractAnswer({ role: 'assistant', content: '', content_list: [
    { phase: 'answer', content: 'A' },
    { phase: 'answer', content: 'B' },
  ] }),
  'A\n\nB');

// 9) content 是空白字符串时不应被采用
check('空白 content 不采用',
  extractAnswer({ role: 'assistant', content: '   ', content_list: [
    { phase: 'answer', content: '正文' },
  ] }),
  '正文');

// 10) content_list 里有 null 项
check('content_list 含 null 项',
  extractAnswer({ role: 'assistant', content: '', content_list: [
    null,
    { phase: 'answer', content: '正文' },
  ] }),
  '正文');

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
