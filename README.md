# B站视频总结助手 · 浏览器插件版（Edge 扩展）

> **这是本项目的主要维护版本。**
> 功能更新、格式调整、提示词优化都在这里进行。
> 另有一个**桌面 exe 版**：https://github.com/SleepyKitsuneee/bili-summarizer-exe

给一个 B 站视频链接，自动：下载 → 本地合流 → 静默上传千问 → 输出结构化总结。


---

## 它能做什么

1. **下载**：360P + 64K 音质，走你自己的 B 站登录态
2. **本地合流**：浏览器内用 ffmpeg.wasm 把视频流和音频流合成一个 mp4
3. **静默上传**：合成好的视频直接送进你已登录的千问页面，由千问自己完成附件上传
4. **结构化总结**：用能读视频的 omni 模型输出固定结构的 JSON（结论、核心要点、争议或不足、分段摘要、关键词）
5. **多标签页并行**：每个标签页独立任务，切来切去互不干扰，各自的总结互不覆盖
6. **本地调试日志**：可选把完整运行日志追加写入本地 `debug.log`，出问题能回溯

---

## 安装

> 未上架 Edge 商店，需要用**开发者模式**加载。

1. 下载本仓库
2. Edge 打开 `edge://extensions`
3. 打开右下角（或左侧）的 **开发人员模式**
4. 点 **加载解压缩的扩展** → 选择本目录（含 `manifest.json` 的那一层）
5. 打开 `https://chat.qwen.ai/` 用你自己的账号登录一次（登录态长期有效）
6. 打开任意 B 站视频页 → 点工具栏插件图标打开侧边栏 → 点「开始总结」

---

## 设置（侧边栏内）

| 项 | 说明 |
|---|---|
| **模型** | 默认 `Qwen3.8-Omni-Flash`。点「读取列表」可从已打开的千问页实时拉取可选模型。**必须选 omni 系列**，非 omni 模型读视频会张冠李戴 |
| **提示词前置说明** | 最终提示词 = 这段说明 + 固定 JSON 结构。改完点「保存」 |
| **日志** | 默认折叠。展开可查看/复制/清空完整流程日志 |
| **本地日志文件** | 可选。点「选择目录」选中本目录后，日志会持续追加到 `debug.log` |

### 本地日志文件（debug.log）

浏览器插件的日志默认只存在 `chrome.storage.session` 里 —— **浏览器一退出就没了**，出问题后无法回溯。
开启本地日志后，日志会**追加写入**你选中的目录下的 `debug.log`（推荐选中本仓库目录）。

**配置**：侧边栏 → 日志 → 展开 → 「本地日志文件」→ 点 **选择目录** → 选中本仓库目录。

**权限策略**：任务开始时静默检查；已授权直接开始，不弹窗；只有未配置或权限失效时才弹一次。
取消后本会话不再重复弹窗（手动点「立即写入」或重新「选择目录」可解除）。

**日志格式**（单行竖线分隔，方便 grep / findstr）：

```
HH:MM:SS.mmm|LEVEL|TAG|消息
```

| LEVEL | 含义 |
|---|---|
| `INFO` | 关键节点 |
| `DEBUG` | 细节（完整 URL、ffmpeg 输出、每次轮询） |
| `WARN` | 可疑但继续 |
| `ERROR` | 失败（带堆栈前 6 帧） |

| TAG | 覆盖内容 |
|---|---|
| `BOOT` / `ENV` | SW 生命周期、扩展版本、UA |
| `TASK` | 任务起止、URL、总耗时、失败原因 |
| `VIDEO` | 标题 / UP / 时长 / cid / 分P / 封面 |
| `DASH` | dash 流数量、每档 id、选中流的 codecs 与带宽、完整 URL |
| `DL` / `NET` | HTTP 状态、content-length、耗时、速率、块数、长度不符告警 |
| `FF` | 输入输出体积、exec 退出码、耗时、完整 ffmpeg stderr |
| `CDP` | 每次附加尝试、visibilityState / hasFocus、成功/失败原因 |
| `TX` | 分块传输进度、重试次数、总耗时 |
| `GEN` / `QWEN` / `RAW` | 轮询次数、失败计数、最终字数与模型、完整回答原文 |
| `STEP` | 六步进度条的每次状态变更 |
| `EXC` | 异常堆栈 |

**实现要点**（排查时可能用得上）：

- **为什么写文件在 sidepanel 而不是 background**：MV3 的 Service Worker 没有 `window`，拿不到 File System Access API；且 `showDirectoryPicker()` / `requestPermission()` 要求用户手势，只有侧边栏的点击处理器满足。
- **跨上下文队列**：background 只把日志行压进 `chrome.storage.local`（按批次存 `dbgQ:00000001…`），sidepanel 消费并写文件。
- **追加写**：`createWritable({ keepExistingData: true })` + `seek(file.size)`，不会清空已有内容。
- **句柄持久化**：目录句柄存在扩展源下的 IndexedDB（`biliExtLog` / `handles` / `logDir`）。Chrome 122+ 支持「每次访问时都允许」的持久授权。


---

## 架构

```
B站视频页
   │ 点击开始总结
   ▼
background.js（任务编排，每个标签页独立）
   ├─ lib/bilibili.js   取视频信息 + DASH 流 + 下载
   ├─ offscreen/        ffmpeg.wasm 合流
   ├─ lib/cdp.js        chrome.debugger 激活千问页
   ├─ content/qwen-driver.js   驱动千问页面：选模型 → 喂附件 → 发送
   ├─ lib/qwen.js       轮询答案
   ├─ lib/json.js       从回答里提取总结 JSON
   ├─ lib/dlog.js       日志落盘（队列 + 目录句柄）
   └─ sidepanel/        界面：进度 / 总结 / 历史 / 设置 / 日志
```

---

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage` / `unlimitedStorage` | 保存历史、设置、日志 |
| `sidePanel` | 侧边栏界面 |
| `offscreen` | 宿主 ffmpeg.wasm 做合流 |
| `scripting` / `tabs` | 按需注入/驱动千问页面 |
| `declarativeNetRequestWithHostAccess` | 给 B 站 CDN 请求补 Referer（防盗链） |
| `debugger` | 后台静默激活千问页，避免浏览器节流导致上传卡住 |

---


## 更新日志

### v0.7.6（2026-10-27）

**修复**

- 修复拿不到真实 chatId（致命）：页面 URL 可能停在 `/c/new-chat`（前端占位符），真实会话 ID 只在「创建会话」接口的响应体里；旧实现只认 URL，导致后台拿无效 ID 查会话、返回 `Unauthorized`。现在改为 URL 与网络响应双来源解析。
- 修复「未进入会话页」被直接判为失败：实测页面消息已发出、AI 也正常回答，只是 URL 没跳转。现在改为继续解析 chatId，并从输入框是否被清空推断消息是否已发出。

**新增**

- MAIN world 补丁捕获「创建会话」接口响应中的 `chat_id`（支持 `chat_id`/`chatId`/`conversation_id` 等字段名，递归查找）。
- `resolveChatId()`：URL → 网络响应 → 轮询等待（最长 45s）三级解析，日志标明来源。
- 发送环节诊断：输入框内容长度、页面上所有按钮的标识、输入框残留字数。

### v0.7.5（2026-10-27）

**改进（全链路诊断）**

- 读会话日志补齐所有可能影响结果的信息：通道（页面代理/SW 直连）、实际 URL、referer、完整响应体结构。
- 新增页面现场日志：`location.href`、是否在会话页、`document.cookie` 长度与 cookie 名、登录态标记；页面 URL 不含 chatId 时告警。
- 新增接口普查：读会话失败时自动把所有候选接口（`/api/v2/chats`、`/api/v1/chats`、`/api/v2/conversations` 等 6 个）逐个试一遍，日志里能看到哪个能通。
- 新增附件元信息日志：文件名、大小、MIME、`lastModified`、页面上所有 `input[type=file]` 的 accept 属性。
- 新增发送现场日志：发送前后 URL、页面上的会话链接、是否进入会话页、命中报错关键词（「输入或附件无效」等）及原文片段。

**修复**

- 修复 `referer` 用首页导致可能被判跨会话：现在拼成完整会话页 `https://chat.qwen.ai/c/{chatId}`（与桌面版 `page.url` 一致）。
- 修复 ffmpeg 日志全是 `[object Object]`：logger 收到对象时改取 `message`/`text`/`line` 字段。

### v0.7.4（2026-10-27）

**修复**

- 修复读会话返回 `Unauthorized`（致命）：SW 的 fetch 算第三方请求，千问登录 cookie 是 `SameSite=Lax` 不会发出；改为由 chat.qwen.ai 页面内部发同源请求（`QWEN_API_FETCH` 代理）。
- 修复代理分支里 `r.status` 未定义导致 `Cannot read properties of undefined`。
- 修复代理通道故障时错误被吞成通用错误：现在原样抛出，日志能看到真实原因。

**改进**

- 后台重启后 `qwenTabId` 丢失时自动兜底查找千问标签页。
- 新增 `test-page-proxy.mjs`（5 例）：无代理识别 Unauthorized、有代理走页面、pollAnswer 经代理取答案、代理失败信息清晰、日志标明通道。

### v0.7.3（2026-10-27）

**修复**

- 修复选流排序完全失效（致命）：`rank()` 返回数组，数组相减得 `NaN`，`sort` 比较函数返回 `NaN` 时不做任何排序，导致经常选中 HEVC 流，上传后千问报「输入或附件无效」。
- 修复千问报「附件无效」时无法定位：现在非 AVC 编码会打 WARN 日志，并在合流时自动转码 H.264。

**改进**

- 合流默认 `-c copy`；源编码不是 AVC 时改用 `libx264` 转码，并加 `-movflags +faststart`。
- 新增 `test-pick-streams.mjs`（11 例）：AVC 优先、画质上限语义、带宽排序、只有 HEVC 时降级。

### v0.7.2（2026-10-27）

**修复**

- 修复把「接口业务错误」误判为「还没开始生成」：`success=false` 时 `data` 里只有 `code`/`details`，旧逻辑只看 HTTP 200 就报「chatId 有效」，白轮询 30 次。
- 修复诊断日志只记字段名不记值：现在完整记录 `data.code`、`data.details`、`data.message`，业务错误时 dump 完整响应体。
- 修复进度日志刷屏：下载/合流/传输进度每 1% 都记一行（一次任务 600+ 行），改为每 10% 记一行，实测从 1800+ 行降到 44 行。
- 修复进度游标未按前缀隔离：视频/音频/合流/传输各自独立计数，不再互相覆盖。

**改进**

- 接口报业务错误时立即失败（实测 0ms / 1 次请求），不再等超时。
- 轮询中途出现业务错误也立刻早退。
- 新增 `test-biz-error.mjs`、`test-progress-dedup.mjs` 两个测试。

### v0.7.1（2026-10-27）

**修复**

- 修复「查不到 assistant 消息」时干等 25 分钟：连续 30 次（约 4 分钟）拿不到 assistant 消息即早退报错，并在错误里带上 chatId、消息字段名、会话消息条数。
- 修复早退异常被 `catch` 吞掉导致无法退出：改用致命标志在循环外抛出。

**新增**

- 轮询前先探一次 chatId：1 秒内确认会话是否有效、消息字段在哪、有几条 assistant 消息，不再盲等。
- `fetchChat` 支持诊断模式，记录顶层/data/chat 的字段名、消息字段、roles 分布、末条消息字段。
- 消息数组自动兜底（`findMessageArray`）：`messages` 被改名或换层级时，靠 `role`/`content_list` 特征自动识别，并提示「接口结构可能已变」。
- 新增 `test-find-messages.mjs`、`test-empty-earlyexit.mjs` 两个测试。

### v0.7.0（2026-10-27）

**修复**

- 修复「AI 生成」阶段永久卡死：`extractAnswer` 只认 `phase === 'answer'`，模型把正文写进其他 phase 时正文恒为空，一直轮询到 25 分钟超时；改为三层退化 + 连续 done 兜底。
- 修复运行日志丢失：日志入队用 `setTimeout` 防抖，MV3 的 SW 在长任务中会丢掉定时器回调；改为 Promise 链串行刷盘，ERROR 级立即落盘。
- 修复 JSON 解析过于脆弱：原来用 `slice(indexOf('{'), lastIndexOf('}'))`，遇到花括号干扰或多段 JSON 会解析失败；改用括号配平扫描。

**新增**

- 本地调试日志落盘 `debug.log`：侧边栏选择目录后持续追加写入，任务开始时静默检查权限，失效才弹窗。
- 日志采集点扩充至 `TASK`/`VIDEO`/`DASH`/`DL`/`NET`/`FF`/`CDP`/`TX`/`GEN`/`RAW`/`STEP`/`EXC`，覆盖网络状态码、ffmpeg 完整 stderr、CDP 附加尝试、轮询失败计数、异常堆栈。
- 新增 `DEBUG_LOG.md` 说明文档。
- 新增 4 个 Node 单元测试（`test_script/tests/`），覆盖日志队列、`extractAnswer`、`pollAnswer` 兜底、JSON 提取。

**改进**

- 日志单行上限 500 → 4000 字，内存上限 1200 → 1500 行。
- 分块传输日志改为每 10 块一行，避免刷屏。
- ffmpeg 失败时逐行上报完整 stderr（原来只留最后 25 行）。
- 任务进行中切换标签页不再中断日志定时落盘。

### v0.6.1

- 多标签页并行任务，每个标签页独立状态与视图缓存。
- 千问阶段全局排队，避免两个任务争抢同一个千问标签页。
- CDP 激活千问页，解决后台标签页节流导致上传冻结。
- 后台被浏览器重启后可凭 `activeTask` + `chatId` 恢复生成阶段。
- 侧边栏日志面板（查看 / 复制 / 清空）。

---

## 许可证

本项目代码采用 **MIT License**（见 [LICENSE](LICENSE)）。

**例外**：`vendor/ffmpeg-core.js` 与 `vendor/ffmpeg-core.wasm` 属于 FFmpeg 项目，遵循其自身许可证（LGPL-2.1+ / GPL-2，取决于构建配置），**不适用于本仓库的 MIT 声明**。

本项目仅供个人学习使用，请遵守 B 站与千问的服务条款。
