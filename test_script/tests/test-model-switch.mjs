// test-model-switch.mjs —— 验证新版千问模型菜单的解析逻辑
// 用法：node test_script/tests/test-model-switch.mjs
//
// 新界面（2026-11 起）：两级悬浮菜单
//   左栏：Qwen3.7-Plus / Qwen4-Max / Qwen3.8-Max / 展开更多模型
//   右栏：Qwen3.8-Omni-Flash / Qwen3.7-Max / Qwen3.5-Omni-Plus
// 每个选项 innerText 含描述文字（多行），必须按第一行匹配；
// 目标模型在右栏，必须先点「展开更多模型」。

function firstLine(txt) { return (txt || '').trim().split('\n')[0].trim(); }

// 与 driver 里 findModelOption 同逻辑
function findModelOption(nodes, model) {
  const cands = [];
  for (const n of nodes) {
    const txt = (n.text || '').trim();
    if (!txt) continue;
    if (firstLine(txt) !== model) continue;
    if ((n.w || 0) < 40 || (n.h || 0) < 8) continue;
    if (txt.length > model.length + 400) continue;
    cands.push({ ...n, len: txt.length });
  }
  cands.sort((a, b) => a.len - b.len);
  return cands[0] || null;
}

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

const TARGET = 'Qwen3.8-Omni-Flash';

// 模拟真实 DOM 文本（选项含描述，首行是模型名）
const leftPanel = [
  { text: 'Qwen3.7-Plus\nQwen3.7 系列中的高性能大语言模型，支持文本和多模态任务。', w: 420, h: 60 },
  { text: 'Qwen4-Max\nQwen4 旗舰模型，具备业界领先的性能表现。', w: 420, h: 60 },
  { text: 'Qwen3.8-Max\nQwen3.8 系列的旗舰产品，提供业界领先的性能。', w: 420, h: 60 },
  { text: '展开更多模型', w: 420, h: 40 },
  // 整个左容器也可能被匹配到 → 必须被长度/首行过滤掉
  { text: '模型\n模型比较\nQwen3.7-Plus\nQwen4-Max\nQwen3.8-Max\n展开更多模型', w: 460, h: 420 },
];
const rightPanel = [
  { text: `${TARGET}\nQwen3.8 系列最新原生多模态大语言模型，支持文本、图像、音频与视频输入。`, w: 460, h: 60 },
  { text: 'Qwen3.7-Max\nQwen3.7 旗舰模型，提供业界领先的性能。当前仅支持文本输入。', w: 460, h: 60 },
  { text: 'Qwen3.5-Omni-Plus\nQwen3.5 系列最强的原生全模态大语言模型', w: 460, h: 60 },
];

// 1) 展开前：左栏里找不到目标
check('展开前找不到目标模型', findModelOption(leftPanel, TARGET), null);

// 2) 展开后：右栏能找到，且取到的是选项本身（不是大容器）
{
  const got = findModelOption(leftPanel.concat(rightPanel), TARGET);
  check('展开后找到目标模型', got?.text?.startsWith(TARGET), true);
  check('取最精简节点（不含其他模型）', got?.text?.includes('Qwen3.7-Max'), false);
}

// 3) 严格第一行匹配：描述里提到目标名不算命中
{
  const tricky = [{ text: `其他模型\n据说是 ${TARGET} 的升级版`, w: 300, h: 50 }];
  check('描述里出现不算命中', findModelOption(tricky, TARGET), null);
}

// 4) 隐藏元素要过滤
{
  const hidden = [{ text: TARGET, w: 0, h: 0 }];
  check('隐藏元素被过滤', findModelOption(hidden, TARGET), null);
}

// 5) 当前模型名读取：带描述触发器也能取到首行
{
  const trigger = 'Qwen3.7-Plus\n';
  check('触发器文本取首行', firstLine(trigger), 'Qwen3.7-Plus');
}

// 6) 已是目标模型时不误触发切换
{
  const cur = firstLine(`${TARGET}\n`);
  check('当前已是目标', cur === TARGET, true);
}

// 7) 模型列表采集：只要 Qwen 开头的模型名，排除描述与其他文字
{
  const all = leftPanel.concat(rightPanel).map(n => n.text);
  const names = all.map(firstLine).filter(t => t && t.length < 60 && /^(Qwen|qwen|通义)/.test(t));
  const uniq = [...new Set(names)];
  check('采集列表含目标', uniq.includes(TARGET), true);
  check('采集列表排除「展开更多模型」', uniq.includes('展开更多模型'), false);
  check('采集列表去重', uniq.length, new Set(uniq).size);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
