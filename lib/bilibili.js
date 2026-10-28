// bilibili.js —— 取视频信息 / playurl / 选流 / 下载（复刻 bili_dl.py 的算法）
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view?bvid=';
const PLAY_API = 'https://api.bilibili.com/x/player/wbi/playurl';

// 可选日志回调（由 background 注入，避免 lib 反向依赖 background）
let _log = () => {};
export function setLog(fn) { if (typeof fn === 'function') _log = fn; }

const timed = async (label, fn) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    _log(`[网络] ${label} 成功 · ${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    _log(`[网络] ${label} 失败 · ${Date.now() - t0}ms · ${e?.message ?? e}`);
    throw e;
  }
};

export async function getVideoContext(bvid) {
  return timed('view API', async () => {
    const r = await fetch(VIEW_API + bvid, { credentials: 'include' });
    const j = await r.json();
    _log(`[网络] view HTTP ${r.status} · code=${j.code} ${j.message ?? ''}`);
    if (j.code !== 0) throw new Error('取视频信息失败：' + (j.message ?? j.code));
    const d = j.data;
    return {
      bvid,
      title: d.title || '',
      pic: d.pic || '',
      up: (d.owner && d.owner.name) || '',
      durationSec: d.duration || 0,
      cid: d.cid,
      pages: (d.pages || []).map(p => ({ cid: p.cid, page: p.page, part: p.part })),
    };
  });
}

export async function getPlayurlDash(bvid, cid) {
  return timed('playurl API', async () => {
    const u = `${PLAY_API}?bvid=${bvid}&cid=${cid}&qn=127&fnval=4048&fourk=1`;
    const r = await fetch(u, { credentials: 'include' });
    const j = await r.json();
    _log(`[网络] playurl HTTP ${r.status} · code=${j.code} ${j.message ?? ''} · accept_qn=${JSON.stringify(j.data?.accept_quality ?? [])}`);
    if (j.code !== 0) throw new Error('取播放地址失败：' + (j.message ?? j.code));
    return j.data.dash || null;
  });
}

// 与 bili_dl.py 默认一致：视频 360P（id=16）优先 AVC，音频 64K（id=30216）
const VIDEO_QN_ORDER = [16, 32, 64, 80, 74, 112, 116, 120, 125, 126, 127];
const AUDIO_ORDER = [30216, 30232, 30280, 30250, 30251];
const codecRank = (c) => (String(c || '').startsWith('avc') ? 0 : String(c || '').startsWith('hev') ? 1 : 2);

// 画质档位在 VIDEO_QN_ORDER 里的下标（未知给 99）
const qnRank = (id) => {
  const i = VIDEO_QN_ORDER.indexOf(id);
  return i === -1 ? 99 : i;
};

export function pickStreams(dash, videoCapId = 16) {
  const videos = (dash.video || []).slice();
  if (!videos.length) throw new Error('没有 DASH 视频流（可能需要登录）');
  const capIdx = VIDEO_QN_ORDER.indexOf(videoCapId);
  const allow = new Set(VIDEO_QN_ORDER.slice(0, capIdx + 1));
  let cand = videos.filter(v => allow.has(v.id));
  if (!cand.length) cand = videos;                       // 兜底：全量

  // ⚠️ 这里踩过一个致命坑：原来写成 `sort((a,b) => rank(a) - rank(b))`，
  // 而 rank() 返回的是数组 → 数组相减得 NaN → 比较函数返回 NaN 时 sort 完全不起作用，
  // 顺序被原样保留。B 站同一画质会返回 avc1 / hvc1 / av01 三条流，
  // 于是经常选中 HEVC(hvc1)，上传到千问后被判「输入或附件无效」（omni 模型解不了 HEVC）。
  // 现在改成显式逐项比较：先比画质档位，再比编码偏好（AVC 优先）。
  cand.sort((a, b) => {
    const dq = qnRank(a.id) - qnRank(b.id);
    if (dq !== 0) return dq;
    const dc = codecRank(a.codecs) - codecRank(b.codecs);
    if (dc !== 0) return dc;
    // 同画质同编码时选带宽更高的，画面更稳
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  const video = cand[0];

  const audios = dash.audio || [];
  let audio = null;
  for (const q of AUDIO_ORDER) {
    const hit = audios.filter(a => a.id === q);
    if (hit.length) { audio = hit[0]; break; }
  }
  if (!audio && audios.length) audio = audios[0];
  return { video, audio: audio || null };
}

// 单次读取的超时：reader.read() 在连接半开时会永远挂着（实测卡在 80% 十分钟不动），
// 没有超时整个任务就死在这里。
const READ_TIMEOUT_MS = 20_000;

/**
 * 下载一个流，带超时与重试。
 * @param {string} url
 * @param {(got:number,total:number)=>void} [onProgress]
 * @param {{attempts?:number, timeoutMs?:number}} [opts]
 */
export async function downloadStream(url, onProgress, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await downloadOnce(url, onProgress, timeoutMs);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      if (attempt >= attempts) break;
      // 超时/网络中断 → 重试（换 URL 重新拉，CDN 会给新的签名）
      _log(`[网络] 下载中断（第 ${attempt}/${attempts} 次）：${msg} · 2s 后重试`, 'WARN', 'NET');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr || new Error('下载失败');
}

async function downloadOnce(url, onProgress, timeoutMs) {
  const t0 = Date.now();
  const r = await fetch(url, { credentials: 'include' });
  const total = Number(r.headers.get('content-length') || 0);
  _log(`[网络] 下载 HTTP ${r.status} · content-length=${total || '未声明'} · type=${r.headers.get('content-type') || '?'}`, 'DEBUG', 'NET');
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  if (!r.body) throw new Error('响应没有 body（无法流式读取）');
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    // 带超时的读取：连接半开时 read() 会永不返回，用 Promise.race 兜住
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`读取超时（${timeoutMs / 1000}s 无数据）`)), timeoutMs)),
    ]).catch(async (e) => {
      try { await reader.cancel(); } catch {}
      throw e;
    });
    if (chunk.done) break;
    chunks.push(chunk.value);
    got += chunk.value.length;
    if (onProgress && total) onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  const sec = (Date.now() - t0) / 1000;
  _log(`[网络] 下载完成 ${(got / 1024 / 1024).toFixed(2)}MB · ${sec.toFixed(1)}s · ${(got / 1024 / sec).toFixed(0)}KB/s · 块数=${chunks.length}`
    + (total && got !== total ? ` ⚠ 长度不符（期望 ${total}）` : ''));
  return buf.buffer;
}

export function parseBvid(text) {
  const m = String(text || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}
