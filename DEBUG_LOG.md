# 本地调试日志（debug.log）

浏览器插件版现在可以把运行日志**追加写入**到本地文件，位置就是你选中的目录下的 `debug.log`（推荐选中 `bili-ext` 文件夹，即 `bili-ext\debug.log`）。

## 一次性配置

1. 打开侧边栏 → 展开「日志」卡片
2. 在「本地日志文件」区点 **选择目录**
3. 选中 `d:\py_project\b站视频总结\bili-ext`
4. 状态行变成 `目录：bili-ext ／ 文件：debug.log ／ ✅ 已授权` 即配置完成

## 权限策略

按需求实现为**任务开始时静默检查、权限失效才弹窗**：

- 已授权 → 点「开始总结」直接开始，不弹任何窗
- 未配置 / 权限失效 → 点「开始总结」时才弹一次选择/授权窗
- 取消后本次会话不再重复弹（避免每次点开始都被打断）
- 手动点「立即写入」或重新「选择目录」会解除这个「不再询问」标记

## 日志格式

单行、竖线分隔，方便 `grep` / `findstr`：

```
HH:MM:SS.mmm|LEVEL|TAG|消息
```

- `LEVEL`：`INFO` / `WARN` / `ERROR` / `DEBUG`
- `TAG`：`TASK` `VIDEO` `DASH` `DL` `FF` `CDP` `TX` `GEN` `NET` `QWEN` `STEP` `BOOT` `ENV` `EXC` `RAW` `LOG`

示例：

```
19:51:28.412|INFO|TASK|开始 · 标签页123 · url=https://... · bvid=BV1jtkMBsE2G
19:51:29.055|INFO|VIDEO|标题=一个人，为什么要用两部手机？ · UP=xxx · 时长=313s · cid=123 · 分P=1 · 封面=有
19:51:30.114|DEBUG|NET|[网络] playurl HTTP 200 · code=0 · accept_qn=[127,126,...]
19:51:30.230|INFO|DASH|选流：视频 id=16 codecs=avc1.64001E 带宽=xxx｜音频 id=30216 带宽=64000
19:51:33.887|INFO|DL|完成：视频 3.61MB + 音频 2.45MB · 累计 5.5s
19:51:41.201|INFO|FF|产物 16.60MB · 耗时 7.3s
19:51:52.640|INFO|CDP|附加成功（第 1 次）· 页面状态={"v":"visible","f":true}
19:51:58.002|DEBUG|TX|块 4/5 已确认 · 4096KB base64/块 · 累计 5.4s
19:52:07.551|INFO|GEN|回答完成：2807 字 · 模型=qwen3.8-omni-flash · 耗时 109.4s
```

## 采集点

| TAG | 内容 |
|---|---|
| `BOOT` / `ENV` | SW 生命周期、扩展版本、UA |
| `TASK` | 任务起止、URL、总耗时、失败原因 + 堆栈 |
| `VIDEO` | 标题 / UP / 时长 / cid / 分P / 封面 |
| `DASH` | dash 流数量、每档 id、选中流的 codecs 与带宽、完整 URL（DEBUG） |
| `DL` / `NET` | HTTP 状态、content-length、耗时、速率、块数、长度不符告警 |
| `FF` | 输入输出体积、exec 退出码、耗时、**完整 ffmpeg stderr**（失败时逐行上报） |
| `CDP` | 每次附加尝试、visibilityState / hasFocus、成功/失败原因 |
| `TX` | 分块传输进度（每 10 块一行）、重试次数、总耗时 |
| `GEN` / `QWEN` | 轮询次数、失败计数、每次长度、最终字数与模型、完整回答原文（DEBUG/RAW） |
| `STEP` | 六步进度条的每次状态变更 |
| `EXC` | 异常堆栈（前 6 帧） |

## 实现要点（排查时可能用得上）

- **为什么写文件在 sidepanel 而不是 background**：MV3 的 Service Worker 没有 `window`，拿不到 File System Access API；且 `showDirectoryPicker()` / `requestPermission()` 要求用户手势，只有侧边栏的点击处理器满足。
- **跨上下文队列**：background 只把日志行压进 `chrome.storage.local`（按批次存 `dbgQ:00000001…`），sidepanel 负责消费并写文件。队列最多留 400 批，超出丢最旧。
- **追加写**：`createWritable({ keepExistingData: true })` + `seek(file.size)`，不会清空已有内容。
- **句柄持久化**：目录句柄存在扩展源下的 IndexedDB（`biliExtLog` / `handles` / `logDir`）。Chrome 122+ 支持「每次访问时都允许」的持久授权。
- **索引竞态**：`dropKeys` 只删数据键、不重写索引，避免与 background 的 `pushBatch` 互相覆盖。

## 已知限制

- 浏览器完全退出后 `chrome.storage.session` 清空；本地文件里的内容不受影响（已落盘的部分永久保留）。
- 若在 `chrome://extensions` 里重载扩展，IndexedDB 里的句柄保留，但权限可能变为 `prompt`，下次任务开始时会弹一次授权。
- 若 `showDirectoryPicker()` 抛 `AbortError` 且无论选什么目录都失败，是 Chromium 的历史 bug（crbug 40240444，Chromium 117 前在扩展中必现）。升级浏览器即可。
