# LiveHear — 跨国会议实时双语同传与 AI 发言智囊 HUD

**LiveHear** 是一款基于 **Tauri v2 (Rust + TypeScript)** 构建的原生低延迟跨国会议实时双语字幕、语义纠偏与主动发言提词（Speaking Co-Pilot）悬浮 HUD 桌面端应用。

它专为跨国技术评审、商务谈判、远程日常同步（Standup）与在线面试设计，结合 **Soniox `stt-rt-v5` 原生流式语音识别与同传** 与 **OpenRouter / OpenAI 兼容大模型上下文后处理**，在毫秒级延迟下提供高准确度双语字幕、说话人分离、语气感知与高情商双语接话建议。

---

## 核心特性

### 1. 广播级实时音频前处理与多音源捕获 (Rust Native DSP)
- **多音源自由切换**：支持麦克风直采，或配合 **BlackHole 2ch** / **macOS 多输出设备（聚合设备）** 捕获 Zoom / Teams / Google Meet 系统内部声音（佩戴耳机也能同传）。
- **三阶实时音频 DSP 管线**：
  - **一阶高通直流阻断器（~65Hz High-Pass DC Blocker）**：滤除空调低频嗡鸣与桌面震动。
  - **多相抗混叠低通滤波降采样（Polyphase Anti-Aliasing Decimator）**：消除 48kHz 降至 16kHz 时的齿音（`s/sh/th/f`）频谱折叠失真。
  - **自适应柔和自动增益控制（Adaptive Soft-AGC + `tanh` 软限幅）**：自动拉升远场微弱人声并防止爆音削波。
- **零丢字智能静音门禁（VAD + 500ms 环形预卷缓冲）**：静音期仅发送 160ms 心跳静音包，为你节省 **60%~70%** 的 Soniox 流式计费；一旦检测到人声，立即回放前 500ms 预卷缓冲，确保句首辅音（如 `What / Can / Please`）绝不丢失。

### 2. Soniox `stt-rt-v5` 实时双流状态机与置信度门控
- **单连接双流同传**：原生支持 **单向同传 (`one_way`)**（任意外语实时译为目标母语）与 **双向互译 (`two_way`)**（如中英、中泰、中日双向自动互译）。
- **顶栏一键语种范围锁定 (`language_hints_strict`)**：点击顶栏语种胶囊即可快速切换识别语种范围（如 `中+英`、`中+英+泰`、`中+英+日` 或自定义 ISO 语种码），消除相近音素跨语种误判，提升 30%+ 识别准确率。
- **置信度门控说话人防抖（Confidence-Gated Diarization Hysteresis）**：过滤连词、气音与置信度 `< 0.62` 的瞬态角色跳变，避免同一人说话被切碎为多个 Speaker。
- **语义完整性驱动的智能断句（Semantic Endpointing）**：默认 `2000ms` 语义尾音容忍度 + 句尾从句/连词跨包自动续接合并。

### 3. LLM 上下文双轨精修、语气标签与划词精译
- **低置信度靶向纠偏 + 译文精修**：自动追踪 Soniox Token 级 `confidence < 0.78` 的疑似同音误识词，在句子定稿后结合前 4 句多轮对话上下文与自定义术语表，异步精修 **原文 (`original`)** 与 **译文 (`translated`)**。
- **语用语气与潜台词识别 (`tone_tag`)**：自动标注定稿句子的语用色彩（如 `🔍 追问求证`、`⚠️ 委婉异议`、`📌 明确承诺`、`⏳ 缓兵推迟`、`🤝 寻求共识`），跨文化沟通不错过言外之意。
- **双击单词 / 划选短语语境精译**：在字幕区双击任意单词或划选短语，立即弹出悬浮词典卡片，展示音标、词典释义与当前会议语境下的精准含义，支持一键 **`+ 加入术语表`** 热更新 Soniox 识别词库。

### 4. 交互式「我」绑定与主动辅助发言 (Speak Assistant & Co-Pilot)
- **交互式「我」身份认领 (`👆 设为我` / `🎙️ 我`)**：
  - 无需猜测语种归属，点击任意字幕行的头像或 **`👆 设为我`** 即可将该说话人（如 `Speaker 2`）绑定为「我自己」，顶栏实时显示 `🎙️ 我: Speaker X ✕` 胶囊（可随时点击取消或切换）。
  - **单向听会 + 智能辅助我 Speak**：保持全局 `target_language = "zh"`（他人说的英语/泰语/日语全部同传为中文），当被标记为「我自己」的 Speaker **说中文**时，自动触发 LLM 口语精译并就地展示地道英文（或你设定的 `speak_target_language`）口语供直接照念；当你直接**说英语**时，保留英文原声与中文对照，并自动屏蔽针对你本人发言的抢答弹窗。
  - **任意中文单句手动秒译 (`🌐 译为EN`)**：未绑定「我」时，点击任意中文字幕右侧的 `🌐 译为EN` 也可随时将其转化为地道外语口语并复制到剪贴板。
- **常驻底部「快捷输入秒译 & 辅助发言栏」(Quick Speak Dock)**：
  - **回车极速口语秒译 (`Enter` / `⚡ 秒译`)**：在底部输入框打几个中文词或半截中英混杂草稿按回车，1 秒内结合最近 4 轮对话语境转化为 **地道会议口语 (`spoken`) + 简短替代句 (`alt`) + 发音/语境提示 (`tip`)**，并自动复制到剪贴板。
  - **多角度建议生成 (`Shift+Enter` / `✨ 3种建议`)**：生成 3 条不同策略（直接回应 / 补充推进 / 委婉周旋）的双语发言稿。
  - **一键切换发言目标外语 (`🗣️ 译为:EN ▾`)**：支持在 `EN / JA / TH / KO / FR / DE / ES` 间循环切换。
- **字幕行内一键表态 Chips (`👍 赞同` / `⏳ 缓议` / `❓ 追问` / `💬 接话`)**：悬停在对方任意一句话上，无需打字即可一键生成对应态度的地道外语回应。
- **3 秒浓缩前文 (`📝 浓缩前文`) & 时间轴笔记 (`📌 记笔记`)**：走神或刚进会时一键浓缩最近讨论焦点；会中随时记录灵感嵌入时间轴，会后一键导出包含 AI 高管摘要、核心决议、Action Items 与双语逐字稿的 Markdown 纪要。

### 5. 隐身防录屏模式与鼠标穿透
- **隐身防共享模式 (`🕶️` / `⌘+Shift+H`)**：调用系统底层 `set_content_protected(true)`（macOS `NSWindowSharingNone` / Windows `WDA_EXCLUDEFROMCAPTURE`），在 Zoom / Teams / 腾讯会议共享整个桌面或截图时，HUD 窗口对他人完全隐形。
- **幽灵鼠标穿透模式 (`👻` / `⌘+Shift+X`)**：开启后鼠标点击直接穿透字幕悬浮窗操作底层的文档或 IDE，按 `⌘+Shift+X` 随时恢复交互。

---

## 快速开始与跨平台构建

### 环境要求
- **Node.js** `>= 20` & **pnpm** `>= 9`
- **Rust** `>= 1.77.2` (含 Cargo 与 Xcode Command Line Tools / MSVC)
- **Soniox API Key**：用于实时多语种语音识别与流式同传（[Soniox Console](https://console.soniox.com/)）
- **OpenRouter / OpenAI 兼容 API Key**：用于双轨上下文纠偏、我方中文转外语口语、快捷输入秒译、划词精译、主动接话提词与 AI 会议纪要

### 本地 Ollama 识别

默认使用 Soniox；点击顶栏“识别：Soniox / Ollama”或在设置中选择引擎。切换时若正在同传，应用会重启识别流。Ollama 模式连接 `http://127.0.0.1:11434`，默认模型为 `livehear-qwen3-asr:1.7b`，可在配置文件的 `asr_backend` 中修改。

本地模式优先在停顿处分段，连续讲话约 8 秒时强制切分，不提供逐词实时字幕、说话人分离或双向自动翻译；识别文本的翻译和 AI 整理仍依赖已配置的 AI 服务。识别跟不上时界面会提示音频丢失。停止或切换时会等待已接收的尾段处理；若处理超时会提示。

通过国内 ModelScope 下载并校验模型：运行 `sh scripts/download-qwen3-asr-modelscope.sh`，然后将模型目录作为 `FROM` 导入 Ollama。首次使用前请先启动 Ollama。

### 本地开发与构建

```bash
# 1. 安装前端依赖
pnpm install

# 2. 启动 Tauri 桌面端开发模式
pnpm tauri dev

# 3. 构建当前操作系统原生安装包 (macOS 下产出 .app / .dmg)
pnpm tauri build
```

### 本地验证

```bash
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

回归测试不需要麦克风权限或真实 API Key；AI 解析测试通过本机回环 HTTP 服务模拟返回值。Windows 打包流水线也会执行这些测试与 Rust 检查。

### Windows 安装包构建 (GitHub Actions 云端流水线)
由于 Tauri v2 依赖目标系统的原生 WebView（macOS `WKWebView` / Windows `WebView2`）及 MSVC 链接器，仓库已内置 [`.github/workflows/build-windows.yml`](file:///Users/sexy/Documents/GitHub/livehear/.github/workflows/build-windows.yml) 自动化流水线：
- 在 GitHub Actions 页面点击 **Build Windows Installer -> Run workflow**（或推送 `v*` 标签），即可在 `windows-latest` 云端环境自动编译并产出 Windows `.exe` (NSIS) 与 `.msi` 安装包产物。

### 配置文件说明

首次启动时，应用会在项目目录或系统配置目录自动读取 `livehear.config.json`（已被 `.gitignore` 忽略，防止密钥泄露）。你可以直接在 HUD 右上角的 **`⚙️ 设置`** 面板中可视化修改并热更新，或参考项目根目录下的 [`livehear.config.example.json`](file:///Users/sexy/Documents/GitHub/livehear/livehear.config.example.json)。

---

## 快捷键一览

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Enter`（底部输入框） | 将输入的中文/草稿 **极速秒译为地道目标外语口语** 并自动复制 |
| `Shift + Enter`（底部输入框） | 结合上下文生成 **3 种不同语气的发言提词卡片** |
| `⌘ + K` / `Ctrl + K` | 呼出 / 刷新 **主动发言提词 (Speaking Co-Pilot)** 抽屉 |
| `⌘ + 1` / `2` / `3` | 一键复制第 1 / 2 / 3 条双语接话建议或发言提词 |
| `⌘ + Shift + H` | 切换 **隐身防录屏模式 (Stealth Mode)**（共享屏幕/录屏时隐藏 HUD） |
| `⌘ + Shift + X` | 切换 **幽灵鼠标穿透模式 (Click-Through Mode)** |
| `⌘ + Shift + P` | 切换 **窗口置顶固定 (Always on Top)** |
| `⌘ + Shift + C` | 一键清空当前字幕流 |
| `⌘ + Shift + E` | 一键导出 **AI 结构化会议纪要 (.md / .txt)** |
| `双击单词` / `划选文字` | 弹出 **当前会议语境词典精译卡片**（支持一键加入识别术语表） |

---

## 参考的主要开源项目与设计借鉴

LiveHear 在架构设计与交互打磨过程中，深度调研并融合了以下代表性开源项目的设计精华：

1. **[SevaSk/ecoute](https://github.com/SevaSk/ecoute)**
   - **核心定位**：实时双轨转录与智能应答建议鼻祖。
   - **设计借鉴**：借鉴其对「对方语音 vs 我方语音」进行角色标记并拼接成带角色标签的对话历史（`[对方 (Speaker 1)]` / `[我 (Speaker 2)]`），使 LLM 在生成回复建议与指代消解时清晰区分提问方与作答方。
2. **[Pluely](https://github.com/iamsrikanthnani/pluely) / [Natively](https://github.com/natively-ai/natively-cluely-ai-assistant) / [Free-Cluely](https://github.com/Prat011/free-cluely)**（开源版 Cluely 隐身会议 Copilot）
   - **核心定位**：防录屏隐身悬浮窗 + 实时会议主动提词器。
   - **设计借鉴**：借鉴其系统级防截屏/防桌面共享 API（`NSWindowSharingNone` / `WDA_EXCLUDEFROMCAPTURE`）、快捷表态 Chips（赞同 / 缓议 / 追问 / 浓缩前文 TL;DR）以及常驻底部的无打扰快捷输入交互栏（Quick Speak Dock）。
3. **[BetterAndBetterII/my-translator](https://github.com/BetterAndBetterII/my-translator) & [Mixed-Languages-Translator](https://github.com/unpacking622/Mixed-Languages-Translator)**
   - **核心定位**：基于 Tauri v2 (Rust + WebView) 的轻量级桌面实时双语字幕浮窗。
   - **设计借鉴**：参考其 Tauri v2 透明无边框置顶 HUD 窗口管理、鼠标点击穿透（Click-Through）以及单实例多语种混合会议场景下的非对称翻译策略。
4. **[Fastrepl/hyprnote (Char)](https://github.com/fastrepl/char) & [Zackriya-Solutions/meeting-minutes](https://github.com/Zackriya-Solutions/meeting-minutes)**
   - **核心定位**：隐私优先的 Rust + Tauri AI 会议实时笔记与结构化纪要生成。
   - **设计借鉴**：借鉴其「会中时间轴随手记笔记（`📌 记笔记`）+ 实时转录流」在会后通过 LLM 融合提炼为高管摘要、关键决议与 Action Items 的工作流。
5. **[Transkit](https://github.com/transkit-ai/transkit)**
   - **核心定位**：基于 Tauri 的 AI 划词翻译与语境词典桌面助手。
   - **设计借鉴**：参考其双击/划选字幕文本即刻弹出语境释义与一键沉淀专有术语表（Context Terms）的闭环体验。

---

## 架构与技术规范

关于音频 DSP 处理链、Soniox `stt-rt-v5` 双流状态机、说话人防抖算法、LLM 双轨后处理协议、Speak 辅助状态机及 60fps 零重排 DOM 渲染架构的详细设计，请参阅 [`ARCHITECTURE.md`](file:///Users/sexy/Documents/GitHub/livehear/ARCHITECTURE.md)。
