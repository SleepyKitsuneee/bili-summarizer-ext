// offscreen 文档：宿主 ffmpeg.wasm，执行 -c copy 合流。
// 通信全部走 chrome.runtime 消息（实测 offscreen 上 client.postMessage 通道不通）。
// 二进制必须 base64 编码传输（实测 runtime 消息直接传 Uint8Array 会丢字节）。
// wasm 二进制由本文档自己 fetch（同源扩展资源），不从 SW 转。
import { u8ToB64, b64ToU8 } from '../lib/b64.js';

const CHUNK = 4 * 1024 * 1024;
const olog = (msg) => { try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_LOG', msg }).catch(() => {}); } catch {} };
olog('offscreen 模块已加载');

let core = null;
let corePromise = null;
const ffLogs = [];               // ffmpeg stderr 收集（排错用）

async function loadCore() {
  if (core) return core;
  if (!corePromise) {
    corePromise = (async () => {
      const t0 = Date.now();
      olog('开始加载 wasm 引擎…');
      const wasm = await (await fetch(chrome.runtime.getURL('vendor/ffmpeg-core.wasm'))).arrayBuffer();
      const { default: createFFmpegCore } = await import('../vendor/ffmpeg-core.js');
      // 注意：不能传 print/printErr！传入会覆盖 core 自带的 logger 版 print，
      // ffmpeg 输出会全部进空函数。日志统一走 setLogger。
      const c = await createFFmpegCore({ wasmBinary: wasm });
      olog(`wasm 引擎就绪（${Date.now() - t0}ms，wasm ${(wasm.byteLength / 1024 / 1024).toFixed(1)}MB）`);
      return (core = c);
    })();
  }
  return corePromise;
}

async function doMerge(taskId, video, audio) {
  const c = await loadCore();
  ffLogs.length = 0;
  const vName = `in.${taskId}.video.m4s`;
  const aName = `in.${taskId}.audio.m4s`;
  const oName = `out.${taskId}.mp4`;
  olog(`[${taskId}] 写入输入：视频 ${(video.byteLength / 1024 / 1024).toFixed(1)}MB + 音频 ${(audio.byteLength / 1024 / 1024).toFixed(1)}MB`);
  c.FS.writeFile(vName, new Uint8Array(video));
  c.FS.writeFile(aName, new Uint8Array(audio));
  let ret;
  const t0 = Date.now();
  try {
    ret = c.exec('-hide_banner', '-loglevel', 'info',
      '-i', vName, '-i', aName,
      '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0',
      '-y', oName);
  } catch (e) {
    ffLogs.push('exec 异常: ' + (e?.message ?? e));
    ret = -1;
  }
  olog(`[${taskId}] exec 退出码 ${ret}（耗时 ${Date.now() - t0}ms）`);
  try { c.FS.unlink(vName); c.FS.unlink(aName); } catch {}
  if (ret !== 0) {
    let fsList = [];
    try { fsList = c.FS.readdir('/'); } catch {}
    return { ok: false, error: `ffmpeg 退出码 ${ret}｜FS:[${fsList.join(',')}]｜日志: ${ffLogs.slice(-25).join(' ⏎ ')}` };
  }
  const out = c.FS.readFile(oName);
  olog(`[${taskId}] 产物 ${out.byteLength}B，分块回传给后台…`);
  try { c.FS.unlink(oName); } catch {}
  return { ok: true, buffer: out.buffer };
}

// ── 合流任务登记表 ──
const mergeJobs = new Map();   // taskId -> {v:{total,chunks,got}, a:{...}}

// ── 大结果分块回传（SW 逐块 ack 保序）──
async function sendResult(taskId, buffer) {
  const u8 = new Uint8Array(buffer);
  const total = Math.ceil(u8.byteLength / CHUNK);
  for (let seq = 0; seq < total; seq++) {
    const b64 = u8ToB64(u8.subarray(seq * CHUNK, (seq + 1) * CHUNK));
    const r = await chrome.runtime.sendMessage({ type: 'FF_RESULT_CHUNK', taskId, seq, total, b64 });
    if (!r?.ok) throw new Error('SW 未确认结果块 ' + seq);
  }
  await chrome.runtime.sendMessage({ type: 'FF_RESULT_END', taskId, size: u8.byteLength });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'FF_DEBUG') {                     // 诊断探针
    (async () => {
      try {
        const c = await loadCore();
        ffLogs.length = 0;
        c.FS.writeFile('probe.txt', new Uint8Array([1, 2, 3]));
        const back = c.FS.readFile('probe.txt');
        let versionRet;
        try { versionRet = c.exec('-hide_banner', '-version'); } catch (e) { versionRet = 'throw: ' + (e?.message ?? e); }
        let fsList = [];
        try { fsList = c.FS.readdir('/'); } catch {}
        await chrome.runtime.sendMessage({
          type: 'FF_DEBUG_REPLY',
          fsList,
          probeOk: back.length === 3 && back[0] === 1,
          versionRet,
          logs: ffLogs.slice(0, 40),
          loggerType: typeof c.setLogger,
        });
      } catch (e) {
        await chrome.runtime.sendMessage({ type: 'FF_DEBUG_REPLY', error: String(e?.message ?? e) });
      }
    })();
    return false;
  }
  if (msg?.type === 'FF_BEGIN') {                     // 开始接收合流输入
    mergeJobs.set(msg.taskId, {
      v: { total: msg.vTotal, chunks: new Array(msg.vTotal), got: 0 },
      a: { total: msg.aTotal, chunks: new Array(msg.aTotal), got: 0 },
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'FF_MERGE_CHUNK') {
    const job = mergeJobs.get(msg.taskId);
    if (!job) { sendResponse({ ok: false }); return false; }
    const side = msg.which === 'audio' ? job.a : job.v;
    if (side.chunks[msg.seq] === undefined) {
      const u8 = msg.b64 ? b64ToU8(msg.b64) : null;
      side.chunks[msg.seq] = u8;
      side.got += u8 ? 1 : 0;
    }
    sendResponse({ ok: true, got: side.got, bytes: side.chunks[msg.seq]?.byteLength ?? -1 });
    return false;
  }
  if (msg?.type === 'FF_MERGE_RUN') {
    const job = mergeJobs.get(msg.taskId);
    mergeJobs.delete(msg.taskId);
    (async () => {
      try {
        if (!job) throw new Error('没有找到合流任务 ' + msg.taskId);
        const join = (side) => {
          const full = new Uint8Array(side.chunks.reduce((n, c) => n + c.byteLength, 0));
          let off = 0;
          for (const c of side.chunks) { full.set(c, off); off += c.byteLength; }
          return full.buffer;
        };
        const r = await doMerge(msg.taskId, join(job.v), join(job.a));
        if (r.ok) await sendResult(msg.taskId, r.buffer);
        else await chrome.runtime.sendMessage({ type: 'FF_FAILED', taskId: msg.taskId, error: r.error });
      } catch (e) {
        try { await chrome.runtime.sendMessage({ type: 'FF_FAILED', taskId: msg.taskId, error: String(e?.message ?? e) }); } catch {}
      }
    })();
    return false;
  }
  return false;
});

console.log('[offscreen] ffmpeg 工作台已加载');
// 告诉 background：模块脚本已执行完，可以派活了
try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {}); } catch {}
