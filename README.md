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


## 许可证

本项目代码采用 **MIT License**（见 [LICENSE](LICENSE)）。

**例外**：`vendor/ffmpeg-core.js` 与 `vendor/ffmpeg-core.wasm` 属于 FFmpeg 项目，遵循其自身许可证（LGPL-2.1+ / GPL-2，取决于构建配置），**不适用于本仓库的 MIT 声明**。

本项目仅供个人学习使用，请遵守 B 站与千问的服务条款。
