// test-parse-json.mjs —— 验证 parseSummaryJson 的健壮性
// 用法：node test/test-parse-json.mjs

const { parseSummaryJson } = await import('../lib/json.js');

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

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
