// test-read-dom.mjs —— 验证「从页面 DOM 读答案」的提取逻辑
// 用法：node test_script/tests/test-read-dom.mjs
//
// 复现真实场景：页面渲染了 assistant 的 JSON 回答，同时还有
//   · 用户那条 909 字提示词（不能当成答案）
//   · 左侧历史会话列表里的旧消息（不能当成答案）
// 提取时必须只拿到真正的回答。

// ── 从 driver 复刻的判定逻辑 ──
const ASSISTANT_SELECTORS = [
  '[class*="assistant"] [class*="message"]',
  '[class*="message"] [class*="assistant"]',
  '[data-role="assistant"]',
  '[class*="chat-message"][class*="ai"]',
  '[class*="msg"][class*="ai"]',
  '[class*="markdown"]',
  '[class*="response"] [class*="content"]',
];

function isUserNode(el) {
  const t = (el.className || '') + ' ' + (el.getAttribute?.('data-role') || '');
  if (/user|question|input-msg|human/i.test(t)) return true;
  const txt = (el.innerText || '');
  if (txt.includes('请完整观看或收听这段视频') || txt.includes('只输出一个 JSON 对象本体')) return true;
  return false;
}

function pick(nodes) {
  if (!nodes.length) return null;
  let best = nodes[0];
  for (const n of nodes) if (n.text.length > best.text.length) best = n;
  const last = nodes[nodes.length - 1];
  return (last.text.length >= best.text.length * 0.6) ? last : best;
}

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

const ANSWER = '{"结论":"值得买","核心要点":["a","b"],"关键词":["x"]}';
const PROMPT = '请完整观看或收听这段视频，然后严格按照下面的 JSON 结构输出总结。总结总长度约 2000 字。硬性要求：1. 只输出一个 JSON 对象本体：不要 markdown 代码块、不要任何解释文字或前后缀。2. 字段名、层级、顺序必须与给定结构完全一致，不得增删字段。3. 「内容类型」从 数码测评/知识科普/访谈对话/教程教学/杂谈闲聊/游戏/生活Vlog/其他 里选一个。';

// 1) 正常：只有一条 assistant 回答
{
  const nodes = [{ text: ANSWER, cls: 'assistant-msg' }].filter(n => !isUserNode({ className: n.cls, innerText: n.text }));
  check('只有 assistant 回答', pick(nodes).text, ANSWER);
}

// 2) 用户提示词必须被排除
{
  const all = [
    { text: PROMPT, cls: 'user-msg' },
    { text: ANSWER, cls: 'assistant-msg' },
  ];
  const nodes = all.filter(n => !isUserNode({ className: n.cls, innerText: n.text }));
  check('用户提示词被排除', nodes.length, 1);
  check('排除后取到回答', pick(nodes).text, ANSWER);
}

// 3) 用户节点类名不含 user，但内容是提示词 → 也要排除
{
  const nodes = [{ text: PROMPT, cls: 'markdown' }].filter(n => !isUserNode({ className: n.cls, innerText: n.text }));
  check('按内容排除提示词', nodes.length, 0);
}

// 4) 过短的节点要排除（按钮/图标容器）
{
  const nodes = [{ text: '复制', cls: 'markdown' }, { text: ANSWER, cls: 'markdown' }]
    .filter(n => n.text.length >= 20 && !isUserNode({ className: n.cls, innerText: n.text }));
  check('排除过短节点', nodes.length, 1);
  check('取到完整回答', pick(nodes).text, ANSWER);
}

// 5) 多个回答：取最长的（流式输出中间态）
{
  const nodes = [
    { text: '正在思考', cls: 'm' },
    { text: ANSWER.slice(0, 30), cls: 'm' },
    { text: ANSWER, cls: 'm' },
  ].filter(n => n.text.length >= 20);
  check('取最长的那段', pick(nodes).text, ANSWER);
}

// 6) 最后一条明显更长（多轮对话）→ 取最后一条
{
  const short = '{"结论":"第一轮"}';
  const long = ANSWER + ' 加上很多额外内容'.repeat(20);
  const nodes = [{ text: short, cls: 'm' }, { text: long, cls: 'm' }].filter(n => n.text.length >= 20);
  const r = pick(nodes);
  check('最后一条更长时取最后一条', r.text, long);
}

// 7) 空的节点列表
check('空节点返回 null', pick([]), null);

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
