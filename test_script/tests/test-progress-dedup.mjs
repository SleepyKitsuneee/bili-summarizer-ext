// test-progress-dedup.mjs —— 验证进度日志去重 + 降频逻辑
// 用法：node test_script/tests/test-progress-dedup.mjs
//
// 复现用户日志的刷屏问题：一次任务 2537 行里 600+ 行是「视频 0%/1%/2%…」。
// 这里把 background.js 里 report() 的判定规则原样抽出来验证。

// 与 background.js 的 report() 保持一致的判定逻辑
const PCT_STEP = 10;
function makeDeduper() {
  const s = {};
  return (step, detail) => {
    const pctMatch = detail.match(/^(\D*)(\d+)%$/);
    let shouldLog;
    if (pctMatch) {
      const pct = parseInt(pctMatch[2], 10);
      const bucket = Math.floor(pct / PCT_STEP) * PCT_STEP;
      const key = `${step}|${pctMatch[1]}`;
      if (!s._pctCursors) s._pctCursors = {};
      shouldLog = s._pctCursors[key] !== bucket;
      if (shouldLog) s._pctCursors[key] = bucket;
    } else {
      shouldLog = s._lastLogKey !== `${step}|${detail}`;
      if (shouldLog) s._lastLogKey = `${step}|${detail}`;
    }
    if (step === '失败' || step === '完成') shouldLog = true;
    return shouldLog;
  };
}

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

// 1) 下载进度 0→100%，每 10% 记一行 → 11 行
{
  const dedup = makeDeduper();
  const logged = [];
  for (let p = 0; p <= 100; p++) {
    for (let k = 0; k < 3; k++) {
      if (dedup('下载视频', `视频 ${p}%`)) logged.push(p);
    }
  }
  check('下载进度 11 行（0,10,...,100）', logged.length, 11);
  check('下载进度档位正确', logged, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
}

// 2) 同一档位内重复回调 → 只记一次
{
  const dedup = makeDeduper();
  let n = 0;
  for (let p = 40; p <= 49; p++) {
    for (let k = 0; k < 5; k++) if (dedup('下载视频', `视频 ${p}%`)) n++;
  }
  check('40-49% 只记一行', n, 1);
}

// 3) 视频与音频进度互不干扰
{
  const dedup = makeDeduper();
  let n = 0;
  for (let p = 0; p <= 100; p++) {
    if (dedup('下载视频', `视频 ${p}%`)) n++;
    if (dedup('下载视频', `音频 ${p}%`)) n++;
  }
  check('视频/音频各 11 行 = 22', n, 22);
}

// 4) 合流进度同样降频
{
  const dedup = makeDeduper();
  let n = 0;
  for (let p = 0; p <= 100; p++) if (dedup('本地合流', `合流 ${p}%`)) n++;
  check('合流进度 11 行', n, 11);
}

// 5) 非百分比 detail：变化才记
{
  const dedup = makeDeduper();
  const seq = ['初始化 ffmpeg 引擎…', '初始化 ffmpeg 引擎…', '准备千问页面…', '准备千问页面…'];
  const n = seq.filter(d => dedup('上传到千问', d)).length;
  check('非百分比 detail 去重', n, 2);
}

// 6) 失败/完成永远记
{
  const dedup = makeDeduper();
  dedup('失败', '出错了');
  check('失败重复也记', dedup('失败', '出错了'), true);
  check('完成重复也记', dedup('完成', '好了'), true);
}

// 7) 99% → 100% 必须记（100 属于新档位）
{
  const dedup = makeDeduper();
  dedup('本地合流', '合流 99%');
  check('99% → 100% 必须记', dedup('本地合流', '合流 100%'), true);
}

// 7b) 100% 重复回调不应重复记
{
  const dedup = makeDeduper();
  dedup('本地合流', '合流 100%');
  check('100% 重复回调只记一次', dedup('本地合流', '合流 100%'), false);
}

// 8) 真实场景总量估算
{
  const dedup = makeDeduper();
  let n = 0;
  for (let p = 0; p <= 100; p++) {
    for (let k = 0; k < 4; k++) {
      if (dedup('下载视频', `视频 ${p}%`)) n++;
      if (dedup('下载视频', `音频 ${p}%`)) n++;
    }
  }
  for (let p = 0; p <= 100; p++) {
    for (let k = 0; k < 4; k++) if (dedup('本地合流', `合流 ${p}%`)) n++;
  }
  for (let p = 0; p <= 100; p++) {
    for (let k = 0; k < 4; k++) if (dedup('上传到千问', `传输给页面 ${p}%`)) n++;
  }
  console.log(`   进度类日志总量：${n} 行（旧版 1800+ 行，上一版 1010 行）`);
  if (n <= 100) { pass++; console.log('✅ 总量可控（≤100 行）'); }
  else { fail++; console.log(`❌ 总量仍然过多：${n}`); }
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
