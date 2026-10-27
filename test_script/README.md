# test_script —— 测试与开发辅助文件

这个目录**不参与插件运行**，只是开发期的测试脚本和样本数据。
放在这里是为了让 `bili-ext` 根目录保持干净（根目录只留插件本体）。

整个目录已在 `.gitignore` 中忽略，不会被提交。

## 目录结构

```
test_script/
├── tests/                 Node 单元测试（无需浏览器）
│   ├── test-dlog-queue.mjs       日志队列不丢行
│   ├── test-extract-answer.mjs   extractAnswer 三层退化
│   ├── test-poll-answer.mjs      pollAnswer「done 无 answer」兜底
│   ├── test-parse-json.mjs       JSON 提取健壮性
│   └── test-ffmpeg-node.mjs      ffmpeg.wasm 合流（需真实样本）
└── test-assets/           样本数据（约 15MB）
    ├── video.m4s / audio.m4s
    ├── wasm-merged.mp4
    └── 大伟哥 9.23 交大宣讲（现场实录）.*
```

## 运行

在 `bili-ext` 目录下：

```bash
node test_script/tests/test-dlog-queue.mjs
node test_script/tests/test-extract-answer.mjs
node test_script/tests/test-poll-answer.mjs
node test_script/tests/test-parse-json.mjs
```

`test-ffmpeg-node.mjs` 会实际跑 31MB 的 wasm 引擎做合流，比较慢：

```bash
node test_script/tests/test-ffmpeg-node.mjs
```

## 说明

- 前 4 个测试用 Node 内置能力模拟 `chrome.*` API，**不需要浏览器**。
- 测试脚本通过 `../../lib/*.js` 引用被测模块，通过 `../test-assets/` 读取样本。
  移动脚本位置时要同步改这两处相对路径。
- `test-assets/` 里的 m4s 是 B 站真实流片段，仅用于验证合流逻辑。
