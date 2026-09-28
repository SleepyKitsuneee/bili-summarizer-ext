// bilibili.js —— 取视频信息 / playurl / 选流 / 下载（复刻 bili_dl.py 的算法）
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view?bvid=';
const PLAY_API = 'https://api.bilibili.com/x/player/wbi/playurl';

export async function getVideoContext(bvid) {
  const r = await fetch(VIEW_API + bvid, { credentials: 'include' });
  const j = await r.json();
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
}

export async function getPlayurlDash(bvid, cid) {
  const u = `${PLAY_API}?bvid=${bvid}&cid=${cid}&qn=127&fnval=4048&fourk=1`;
  const r = await fetch(u, { credentials: 'include' });
  const j = await r.json();
  if (j.code !== 0) throw new Error('取播放地址失败：' + (j.message ?? j.code));
  return j.data.dash || null;
}

// 与 bili_dl.py 默认一致：视频 360P（id=16）优先 AVC，音频 64K（id=30216）
const VIDEO_QN_ORDER = [16, 32, 64, 80, 74, 112, 116, 120, 125, 126, 127];
const AUDIO_ORDER = [30216, 30232, 30280, 30250, 30251];
const codecRank = (c) => (String(c || '').startsWith('avc') ? 0 : String(c || '').startsWith('hev') ? 1 : 2);

export function pickStreams(dash, videoCapId = 16) {
  const videos = (dash.video || []).slice();
  if (!videos.length) throw new Error('没有 DASH 视频流（可能需要登录）');
  const capIdx = VIDEO_QN_ORDER.indexOf(videoCapId);
  const allow = new Set(VIDEO_QN_ORDER.slice(0, capIdx + 1));
  let cand = videos.filter(v => allow.has(v.id));
  if (!cand.length) cand = videos;                       // 兜底：全量
  const rank = v => [VIDEO_QN_ORDER.indexOf(v.id) === -1 ? 99 : VIDEO_QN_ORDER.indexOf(v.id), codecRank(v.codecs)];
  cand.sort((a, b) => rank(a) - rank(b));
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

export async function downloadStream(url, onProgress) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress && total) onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf.buffer;
}

export function parseBvid(text) {
  const m = String(text || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}
