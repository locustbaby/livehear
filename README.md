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

### 4. 主动发言提词器 (Speaking Co-Pilot) 与一键 AI 纪要
- **主动接话 (`💡 帮我接话` / `⌘+K`)**：轮到你发言或被提问时，按下 `⌘+K` 或点击任意字幕右侧的 `💬 接话`，可输入简短中文意图（如“委婉推迟到下周”、“同意方案但需加人手”）或留空，1 秒生成 **3 条地道双语口语发言稿**，按 `Alt+1/2/3` 一键复制。
- **3 秒浓缩前文 (`📝 浓缩前文`)**：走神或刚进会时，一键将最近对话浓缩为 3 条核心要点（刚才在聊什么 / 核心争议或结论 / 当前轮到谁回应）。
- **时间轴快速打点 (`📌 记笔记`) 与结构化 AI 纪要导出**：会中随时记录关键灵感并嵌入时间轴；会后点击保存（`💾`）可一键生成包含议题摘要、关键决议、待办 Action Items 与完整双语逐字稿的 Markdown 会议纪要。

### 5. 隐身防录屏模式与鼠标穿透
- **隐身防共享模式 (`🕶️` / `⌘+Shift+H`)**：调用系统底层 `set_content_protected(true)`（macOS `NSWindowSharingNone` / Windows `WDA_EXCLUDEFROMCAPTURE`），在 Zoom / Teams / 腾讯会议共享整个桌面或截图时，HUD 窗口对他人完全隐形。
- **幽灵鼠标穿透模式 (`👻` / `⌘+Shift+X`)**：开启后鼠标点击直接穿透字幕悬浮窗操作底层的文档或 IDE，按 `⌘+Shift+X` 随时恢复交互。

---

## 快速开始

### 环境要求
- **Node.js** `>= 20` & **pnpm** `>= 9`
- **Rust** `>= 1.77.2` (含 Cargo 与 Xcode Command Line Tools / MSVC)
- **Soniox API Key**：用于实时多语种语音识别与流式同传（[Soniox Console](https://console.soniox.com/)）
- **OpenRouter / OpenAI 兼容 API Key**：用于双轨上下文纠偏、划词精译、主动接话提词与 AI 会议纪要

### 安装与运行

```bash
# 1. 安装前端依赖
pnpm install

# 2. 启动 Tauri 桌面端开发模式
pnpm tauri dev

# 3. 构建生产环境原生安装包 (.app / .dmg / .msi)
pnpm tauri build
```

### 配置文件说明

首次启动时，应用会在系统配置目录（macOS 下为 `~/Library/Application Support/com.livehear.client/config.json`，也可通过环境变量 `LIVEHEAR_CONFIG` 指定路径）自动生成配置文件。你可以直接在 HUD 右上角的 **`⚙️ 设置`** 面板中可视化修改并热更新，或参考项目根目录下的 [`livehear.config.example.json`](file:///Users/sexy/Documents/GitHub/livehear/livehear.config.example.json)。

---

## 快捷键一览

| 快捷键 | 功能说明 |
| :--- | :--- |
| `⌘ + K` / `Ctrl + K` | 呼出 / 收起 **主动发言提词 (Speaking Co-Pilot)** 抽屉并聚焦意图输入框 |
| `Alt + 1` / `2` / `3` | 一键复制第 1 / 2 / 3 条双语接话建议或发言提词 |
| `⌘ + Shift + H` | 切换 **隐身防录屏模式 (Stealth Mode)**（共享屏幕/录屏时隐藏 HUD） |
| `⌘ + Shift + X` | 切换 **幽灵鼠标穿透模式 (Click-Through Mode)** |
| `双击单词` / `划选文字` | 弹出 **当前会议语境词典精译卡片**（支持一键加入识别术语表） |

---

## 架构与技术规范

关于音频 DSP 处理链、Soniox `stt-rt-v5` 双流状态机、说话人防抖算法、LLM 双轨后处理协议及 60fps 零重排 DOM 渲染架构的详细设计，请参阅 [`ARCHITECTURE.md`](file:///Users/sexy/Documents/GitHub/livehear/ARCHITECTURE.md)。
