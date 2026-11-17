// test-parse-json.mjs —— 验证 parseSummaryJson 的健壮性
// 用法：node test/test-parse-json.mjs

const { parseSummaryJson, isSummaryData, parseSummaryFromCandidates, sanitizeJson } = await import('../../lib/json.js');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

const good = { 结论: '值得买', 核心要点: ['a', 'b'], 关键词: ['x'] };

// 1) 纯 JSON
check('纯 JSON', parseSummaryJson(JSON.stringify(good)), good);

// 2) ```json 代码块
check('json 代码块',
  parseSummaryJson('```json\n' + JSON.stringify(good) + '\n```'),
  good);

// 3) 前后有说明文字
check('前后说明文字',
  parseSummaryJson('好的，以下是总结：\n' + JSON.stringify(good) + '\n希望对你有帮助。'),
  good);

// 4) 说明文字里带花括号（旧实现会拼出非法 JSON）
check('说明文字含花括号',
  parseSummaryJson('注意格式 {不要照抄} ，结果如下：\n' + JSON.stringify(good)),
  good);

// 5) 字符串值里含花括号（配平扫描必须跳过字符串内部）
const withBraces = { 结论: '他说 {这是重点} 要记住', 核心要点: ['x{y}z'] };
check('值内含花括号',
  parseSummaryJson(JSON.stringify(withBraces)),
  withBraces);

// 6) 转义引号
const withQuote = { 结论: '他说 "不错"', 核心要点: [] };
check('值内含转义引号',
  parseSummaryJson(JSON.stringify(withQuote)),
  withQuote);

// 7) 前面有个不像总结的 JSON，后面才是真的
check('跳过示例 JSON 取真正的总结',
  parseSummaryJson('示例：{"foo":1}\n正式结果：' + JSON.stringify(good)),
  good);

// 8) 没有任何 JSON
check('无 JSON', parseSummaryJson('抱歉，我无法完成这个请求。'), null);

// 9) 空输入
check('空输入', parseSummaryJson(''), null);
check('null 输入', parseSummaryJson(null), null);

// 10) 数组不是总结对象
check('顶层是数组 → null', parseSummaryJson('[1,2,3]'), null);

// 11) 括号未闭合（模型截断）
check('括号未闭合 → null', parseSummaryJson('{"结论":"abc"'), null);

// 12) 嵌套对象
const nested = { 结论: 'ok', 分段摘要: [{ 时间点: '00:10', 主题: '开场', 要点: '介绍' }] };
check('嵌套对象', parseSummaryJson(JSON.stringify(nested)), nested);

// ── 候选甄别（复现真实 bug：提示词模板混进页面，被误当回答）──
// 13) 模板 JSON（值都是 string｜ 占位符）不算真总结
const TEMPLATE = {
  _说明: '所有视频总结的统一输出格式...',
  视频标题: 'string｜视频的实际标题', UP主: 'string', 时长: 'string',
  内容类型: 'string｜单选一个', 结论: 'string', 核心要点: ['string'],
  争议或不足: ['string'], 分段摘要: [{ 时间点: 'string', 主题: 'string', 要点: 'string' }],
  关键词: ['string'],
};
check('模板不算真总结', isSummaryData(TEMPLATE), false);

// 14) 真总结算真
const REAL = {
  _说明: TEMPLATE._说明, 视频标题: '', UP主: '忆蓝落花', 时长: '02:35',
  内容类型: '游戏', 结论: '这是一支恶搞歌曲MV...', 核心要点: ['开场定调', '战绩梗'],
  争议或不足: [], 分段摘要: [{ 时间点: '00:00', 主题: '开场', 要点: '黑屏' }], 关键词: ['Chovy'],
};
check('真总结算真', isSummaryData(REAL), true);

// 15) 核心场景：候选里模板在前、真回答在后 → 跳模板取真回答
const candidates = [
  { text: '{"_说明":"所有视频总结的统一输出格式...', via: 'markdown-block' }, // 截断的模板片段
  { text: '```json\n' + JSON.stringify(TEMPLATE) + '\n```', via: 'markdown-group' }, // 完整模板
  { text: JSON.stringify(REAL), via: 'markdown-group' }, // 真回答
];
const picked = parseSummaryFromCandidates(candidates);
check('跳过模板取真回答', picked?.data, REAL);
check('命中来源是真回答候选#2', picked?.index, 2);

// 16) 全是模板 → null
check('全是模板返回 null',
  parseSummaryFromCandidates([{ text: JSON.stringify(TEMPLATE) }]), null);

// ── 裸引号消毒（复现真实 bug：Qwen 在字符串值里写未转义的中文引号）──
// 17) 字符串值里有裸双引号（"8884844"、"哥又来了"）
{
  const broken = '{ "视频标题": "Chovy魔咒", "结论": "用谐音"8884844"调侃其无冠", "核心要点": ["副歌反复"哥又来了"", "bilibili水印"忆蓝落花""], "关键词": ["Chovy"] }';
  const d = parseSummaryJson(broken);
  check('裸引号消毒后能解析', d?.结论, '用谐音"8884844"调侃其无冠');
  check('裸引号消毒保留核心要点', d?.核心要点?.[0], '副歌反复"哥又来了"');
}

// 18) 字符串值里有裸换行（拆块导致时间被折行）
{
  const broken = '{ "视频标题": "x", "分段摘要": [{ "时间点": "00\n:00-00\n:05", "主题": "开场", "要点": "黑屏" }] }';
  const d = parseSummaryJson(broken);
  check('裸换行消毒后能解析', d?.分段摘要?.[0]?.时间点, '00:00-00:05');
}

// 19) 多段重复 JSON 连在一起（模型把同一回答吐了 5 遍）→ 取第一段
{
  const one = JSON.stringify({ 视频标题: 'x', 结论: 'ok', 核心要点: ['a'] });
  const many = one + ' ' + one + ' ' + one;
  const d = parseSummaryJson(many);
  check('多段重复取第一段', d?.结论, 'ok');
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
