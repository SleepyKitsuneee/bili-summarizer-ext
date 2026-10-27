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
