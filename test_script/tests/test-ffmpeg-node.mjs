// Node 端验证：ffmpeg.wasm 能否完成 -c copy 合流（扩展 offscreen 里的同款逻辑）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, '..', '..', 'vendor');

// core 是 worker 专用构建（引用 self/location）——Node 里垫 shim
globalThis.self = globalThis;
globalThis.location = { href: 'file://' + wasmDir + '/ffmpeg-core.js' };

const { default: createFFmpegCore } = await import('../../vendor/ffmpeg-core.js');

const V = (n) => join(here, '..', 'test-assets', n);

const t0 = Date.now();
const core = await createFFmpegCore({
  wasmBinary: readFileSync(join(wasmDir, 'ffmpeg-core.wasm')),   // 免去 XHR 拉 wasm
  print: () => {},
  printErr: (m) => process.stderr.write('[ff] ' + m + '\n'),
});
console.log('core 就绪', Date.now() - t0, 'ms');

const args = [
  '-hide_banner', '-loglevel', 'info',
  '-i', 'in.video.m4s', '-i', 'in.audio.m4s',
  '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0',
  '-y', 'out.mp4',
];
// 写入虚拟 FS
core.FS.writeFile('in.video.m4s', readFileSync(V('video.m4s')));
core.FS.writeFile('in.audio.m4s', readFileSync(V('audio.m4s')));

let ret;
try {
  ret = core.exec(...args);
} catch (e) {
  console.log('exec 抛异常:', e?.message ?? e);
  ret = -1;
}
console.log('exec 返回:', ret, '| 耗时', Date.now() - t0, 'ms');

if (ret === 0) {
  const out = core.FS.readFile('out.mp4');
  writeFileSync(join(here, '..', 'test-assets', 'wasm-merged.mp4'), out);
  console.log('合流成功:', out.length, '字节 → test-assets/wasm-merged.mp4');
} else {
  // 打印 FS 目录帮助排错
  console.log('FS 根目录:', core.FS.readdir('/'));
  process.exit(1);
}
