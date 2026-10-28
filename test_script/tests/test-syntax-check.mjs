// test-syntax-check.mjs —— 语法自检：所有 content/lib 脚本必须能被解析
// 用法：node test_script/tests/test-syntax-check.mjs
//
// 教训：qwen-driver.js 曾因为「注释和 if 语句粘到同一行」导致 if 被注释掉，
// 整个脚本有语法错误 → content script 完全不执行 → 页面里没有任何消息监听器
// → background 报 "Could not establish connection. Receiving end does not exist."
// 而 executeScript 本身不报错，日志里显示「注入错误=无」，极具迷惑性。
// 所以必须在提交前用 node --check 把所有脚本过一遍。

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

// 需要检查的目录（都是会被浏览器加载的脚本）
const DIRS = ['content', 'lib', 'offscreen'];
const EXTRA = ['background.js', 'sidepanel/panel.js'];

let pass = 0, fail = 0;
const files = [];
for (const d of DIRS) {
  const abs = join(root, d);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    if (f.endsWith('.js')) files.push(join(d, f));
  }
}
for (const f of EXTRA) if (existsSync(join(root, f))) files.push(f);

for (const rel of files) {
  const abs = join(root, rel);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    pass++;
    console.log(`✅ ${rel}`);
  } catch (e) {
    fail++;
    const out = (e.stderr?.toString() || e.stdout?.toString() || String(e)).split('\n').slice(0, 6).join('\n');
    console.log(`❌ ${rel}\n${out}`);
  }
}

// 额外检查：content 脚本里不能出现「注释与代码粘到同一行」的坏味道
// （即一行里既有 // 注释又有非注释代码）
for (const rel of files.filter(f => f.startsWith('content'))) {
  const text = readFileSync(join(root, rel), 'utf8');
  const lines = text.split('\n');
  let bad = 0;
  lines.forEach((l, i) => {
    const c = l.indexOf('//');
    if (c < 0) return;
    const before = l.slice(0, c);
    const after = l.slice(c);
    // 注释后面还有代码 → 说明 if/语句被粘进注释里了
    if (after.replace(/^\/\/.*$/, '').trim().length > 0) {
      // 排除 URL 里的 // 和正则里的 //
      if (!/https?:\/\//.test(before + after) && !/\/[^/]*\//.test(after)) {
        bad++;
        console.log(`   ⚠ ${rel}:${i + 1} 注释后还有代码 → ${l.trim().slice(0, 90)}`);
      }
    }
  });
  if (bad) { fail++; } else { pass++; console.log(`✅ ${rel} 注释格式正常`); }
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
