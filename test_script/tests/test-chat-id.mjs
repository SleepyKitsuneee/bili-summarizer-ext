// test-chat-id.mjs —— 验证 chatId 的多来源解析逻辑
// 用法：node test_script/tests/test-chat-id.mjs
//
// 真实故障：页面 URL 停在 /c/new-chat（前端占位符），真实会话 ID 只在
// 「创建会话」接口的响应体里。旧实现只认 URL → 拿不到 ID → 后台 Unauthorized。

// ── 从响应 JSON 里挖 chat_id（与 qwen-main-patch.js 的 digChatId 同逻辑）──
const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function digChatId(obj, depth = 0) {
  if (!obj || depth > 4) return null;
  if (Array.isArray(obj)) {
    for (const x of obj) { const r = digChatId(x, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj !== 'object') return null;
  for (const k of ['chat_id', 'chatId', 'conversation_id', 'conversationId', 'session_id']) {
    const v = obj[k];
    if (typeof v === 'string' && CHAT_ID_RE.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const r = digChatId(v, depth + 1);
    if (r) return r;
  }
  return null;
}

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

const UUID = 'a19575c7-fdb7-4350-9273-4ea4fb611b67';

// 1) 顶层 chat_id
check('顶层 chat_id', digChatId({ chat_id: UUID }), UUID);
// 2) 驼峰 chatId
check('chatId', digChatId({ chatId: UUID }), UUID);
// 3) conversation_id
check('conversation_id', digChatId({ conversation_id: UUID }), UUID);
// 4) 嵌套在 data 里
check('嵌套 data.chat_id', digChatId({ data: { chat_id: UUID } }), UUID);
// 5) 嵌在数组里
check('数组内', digChatId({ items: [{ chat_id: UUID }] }), UUID);
// 6) 深层嵌套
check('深层嵌套', digChatId({ a: { b: { c: { chat_id: UUID } } } }), UUID);
// 7) 非 UUID 字符串要拒绝
check('拒绝非 UUID', digChatId({ chat_id: 'new-chat' }), null);
// 8) 没有 chat_id 字段
check('无 chat_id', digChatId({ foo: 'bar' }), null);
// 9) null / undefined
check('null', digChatId(null), null);
check('undefined', digChatId(undefined), null);
// 10) 深度超限要能退出（防死循环）
check('深度超限', digChatId({ a: { b: { c: { d: { e: { f: { chat_id: UUID } } } } } } }), null);
// 11) 多个候选取第一个
check('多个候选取首个', digChatId({ chat_id: UUID, conversation_id: '11111111-2222-3333-4444-555555555555' }), UUID);

// 12) URL 里的 chatId 提取：必须排除 new-chat 这类占位符
const URL_RE = /\/c\/([0-9a-f-]{20,})/i;
function urlChatId(pathname) {
  const m = pathname.match(URL_RE);
  return m && CHAT_ID_RE.test(m[1]) ? m[1] : null;
}
check('URL 含 UUID', urlChatId('/c/' + UUID), UUID);
check('URL 是 new-chat（占位符）', urlChatId('/c/new-chat'), null);
check('URL 无 /c/', urlChatId('/'), null);

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
