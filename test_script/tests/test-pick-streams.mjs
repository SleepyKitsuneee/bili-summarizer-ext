// test-pick-streams.mjs —— 验证选流逻辑（AVC 优先，不被 HEVC 抢走）
// 用法：node test_script/tests/test-pick-streams.mjs
//
// 复现用户日志里的真实场景：
//   [DASH] dash 流数：视频 12 条（id=80,80,80,64,64,64,32,32,32,16,16,16）
//   [DASH] 选流：视频 id=16 codecs=hvc1.1.6.L120.90 带宽=122630   ← 选错了
// 根因：rank() 返回数组，数组相减得 NaN，sort 的比较函数返回 NaN 时完全不排序。

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const { pickStreams } = await import('../../lib/bilibili.js');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   期望: ${JSON.stringify(expect)}\n   实际: ${JSON.stringify(actual)}`); }
}

// 用户日志里的真实 dash（B 站同画质返回 3 条不同编码）
const realDash = {
  video: [
    { id: 80, codecs: 'avc1.640032', bandwidth: 1200000 },
    { id: 80, codecs: 'hvc1.1.6.L120.90', bandwidth: 800000 },
    { id: 80, codecs: 'av01.0.08M.08', bandwidth: 900000 },
    { id: 64, codecs: 'avc1.640028', bandwidth: 700000 },
    { id: 64, codecs: 'hvc1.1.6.L120.90', bandwidth: 500000 },
    { id: 64, codecs: 'av01.0.08M.08', bandwidth: 550000 },
    { id: 32, codecs: 'avc1.4d001e', bandwidth: 400000 },
    { id: 32, codecs: 'hvc1.1.6.L120.90', bandwidth: 300000 },
    { id: 32, codecs: 'av01.0.08M.08', bandwidth: 320000 },
    // 关键：id=16 的 hvc1 排在 avc1 前面（B 站真实顺序可能如此）
    { id: 16, codecs: 'hvc1.1.6.L120.90', bandwidth: 122630 },
    { id: 16, codecs: 'avc1.64001E', bandwidth: 110000 },
    { id: 16, codecs: 'av01.0.08M.08', bandwidth: 115000 },
  ],
  audio: [
    { id: 30280, bandwidth: 192000 },
    { id: 30216, bandwidth: 65679 },
    { id: 30232, bandwidth: 132000 },
  ],
};

// 1) 默认 360P（id=16）应选 AVC，而不是排在前面的 HEVC
{
  const { video } = pickStreams(realDash, 16);
  check('360P 选 AVC（不是 HEVC）', video.codecs, 'avc1.64001E');
  check('360P 画质正确', video.id, 16);
}

// 2) videoCapId 是「画质上限」，实际选允许范围内最低的那档（省流量）
//    传 80 时允许 16/32/64/80，最终仍选 16，但必须是 AVC
{
  const { video } = pickStreams(realDash, 80);
  check('上限 1080P 时仍选最低档 360P', video.id, 16);
  check('上限 1080P 时编码是 AVC', video.codecs, 'avc1.64001E');
}

// 2b) 若只有高档可用（模拟只返回 80），则应选到 80 的 AVC
{
  const onlyHigh = {
    video: [
      { id: 80, codecs: 'hvc1.1.6.L120.90', bandwidth: 800000 },
      { id: 80, codecs: 'avc1.640032', bandwidth: 1200000 },
    ],
    audio: [{ id: 30216, bandwidth: 65679 }],
  };
  const { video } = pickStreams(onlyHigh, 80);
  check('只有 1080P 时选 AVC', video.codecs, 'avc1.640032');
}

// 3) 音频按 30216 → 30232 → 30280 优先级
{
  const { audio } = pickStreams(realDash, 16);
  check('音频选 30216', audio.id, 30216);
}

// 4) 只有 HEVC 时退而求其次（不能抛错）
{
  const onlyHevc = {
    video: [{ id: 16, codecs: 'hvc1.1.6.L120.90', bandwidth: 122630 }],
    audio: [{ id: 30216, bandwidth: 65679 }],
  };
  const { video } = pickStreams(onlyHevc, 16);
  check('只有 HEVC 时仍能选到', video.codecs, 'hvc1.1.6.L120.90');
}

// 5) 没有 AVC/HEVC 时选 av01（第三优先）
{
  const av1Only = {
    video: [
      { id: 16, codecs: 'av01.0.08M.08', bandwidth: 115000 },
      { id: 16, codecs: 'avc1.64001E', bandwidth: 110000 },
    ],
    audio: [{ id: 30216, bandwidth: 65679 }],
  };
  const { video } = pickStreams(av1Only, 16);
  check('AVC 优先于 av01', video.codecs, 'avc1.64001E');
}

// 6) 同画质同编码时选带宽高的
{
  const sameCodec = {
    video: [
      { id: 16, codecs: 'avc1.64001E', bandwidth: 100000 },
      { id: 16, codecs: 'avc1.64001E', bandwidth: 200000 },
    ],
    audio: [{ id: 30216, bandwidth: 65679 }],
  };
  const { video } = pickStreams(sameCodec, 16);
  check('同编码选高带宽', video.bandwidth, 200000);
}

// 7) 低画质优先于高画质（16 在 32 之前）
{
  const mixed = {
    video: [
      { id: 32, codecs: 'avc1.4d001e', bandwidth: 400000 },
      { id: 16, codecs: 'avc1.64001E', bandwidth: 110000 },
    ],
    audio: [{ id: 30216, bandwidth: 65679 }],
  };
  const { video } = pickStreams(mixed, 32);
  check('16 优先于 32', video.id, 16);
}

// 8) 空视频流要抛错
{
  let threw = false;
  try { pickStreams({ video: [], audio: [] }, 16); } catch { threw = true; }
  check('空视频流抛错', threw, true);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
