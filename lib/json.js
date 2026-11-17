// json.js —— 从模型回答里提取总结 JSON
// 单独成模块是为了可测试（background.js 依赖 chrome API，无法在 Node 里直接 import）。

// 比 `slice(indexOf('{'), lastIndexOf('}'))` 健壮：
//   · 回答可能带 ```json 代码块
//   · 前面可能有一段说明文字（含花括号，比如举例），粗暴 slice 会拼出非法 JSON
//   · 回答里可能有多段 JSON（正文 + 补充），取第一个像总结的对象
// 做法：逐个 '{' 起头做括号配平扫描（跳过字符串内的花括号），配平成功就尝试解析。
export function parseSummaryJson(raw) {
  if (!raw) return null;
  const text = String(raw)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch { return null; }
  };

  // 先整体试一次（最常见的理想情况）
  const direct = tryParse(text);
  if (direct) return direct;

  // 再逐个起点配平扫描
  let fallbackCand = null;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const cand = tryParse(text.slice(start, i + 1));
          if (cand) {
            // 优先返回含总结特征字段的对象，避免抓到示例片段
            if ('结论' in cand || '核心要点' in cand || '视频标题' in cand) return cand;
            if (!fallbackCand) fallbackCand = cand;
          }
          break;
        }
      }
    }
  }
  return fallbackCand;
}

// 判断解析出的对象是不是「真正的总结」，而不是提示词里的 JSON 结构模板。
// 模板的特征：核心字段的值都是 "string" 或 "string｜..." 占位符。
// 真总结的特征：视频标题/结论/核心要点 里至少有一个是实际内容。
export function isSummaryData(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = ['视频标题', 'UP主', '结论', '核心要点', '分段摘要', '关键词', '内容类型'];
  const hit = keys.filter(k => k in obj);
  if (hit.length < 2) return false;                 // 字段太少，不像总结
  // 只要有任一关键字段是「真实内容」（非 string 占位符），就认作真总结
  const isPlaceholder = (v) => v == null
    || (typeof v === 'string' && /^string(\s*[|｜].*)?$/.test(v.trim()));
  const real = ['视频标题', 'UP主', '结论', '内容类型'].some(k => k in obj && !isPlaceholder(obj[k]));
  if (real) return true;
  // 数组：每个元素若是字符串，检查是否占位符；若是对象，检查其所有值是否都是占位符
  const itemReal = (x) => {
    if (typeof x === 'string') return !isPlaceholder(x);
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.values(x).some(v => !isPlaceholder(v));
    }
    return false;
  };
  const arrReal = ['核心要点', '关键词', '分段摘要'].some(k =>
    Array.isArray(obj[k]) && obj[k].length > 0 && obj[k].some(itemReal));
  return arrReal;
}

// 从多个候选文本里挑第一个能解析出真总结的：返回 { data, source } 或 null。
// 用于页面 DOM 场景——回答被拆成多块、且提示词模板也混在页面里时，逐个尝试最稳。
export function parseSummaryFromCandidates(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (let i = 0; i < candidates.length; i++) {
    const raw = typeof candidates[i] === 'string' ? candidates[i] : candidates[i]?.text;
    const data = parseSummaryJson(raw);
    if (data && isSummaryData(data)) return { data, index: i, source: candidates[i]?.via || '' };
  }
  return null;
}
