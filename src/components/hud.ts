// 会议实时双语同传与智能推测 HUD 视图组件 (Live Meeting HUD)
import type { AudioDevices, FullAppConfig } from '../types/domain';
import { icon } from './icons';

export interface SubtitleItem {
  id: string;
  speaker: string; // e.g., "Speaker 1", "Me (Mic)"
  speakerId?: number; // 1, 2, 3...
  isTrackRemote: boolean;
  original: string;
  translated: string;
  rawOriginal?: string;
  rawTranslation?: string;
  aiOriginal?: string;
  aiTranslation?: string;
  showingRaw?: boolean;
  translationStatus?: 'pending' | 'unavailable';
  confirmedOriginal?: string;
  provisionalOriginal?: string;
  confirmedTranslated?: string;
  provisionalTranslated?: string;
  detectedLanguage?: string; // "en", "th", "zh", etc.
  timestamp: string;
  isPartial?: boolean;
  isPolished?: boolean;
  isContinuation?: boolean;
  lastUpdatedMs?: number;
  lowConfidenceWords?: string[];
  toneTag?: string;
}

export interface SuggestionItem {
  id: number;
  shortcut: string;
  title: string;
  detail: string;
}

export type SubtitleDisplayMode = 'bilingual' | 'target_only' | 'source_only';

export interface QuickSpeakCardData {
  input: string;
  spoken: string;
  alt?: string | null;
  tip?: string | null;
  targetLang: string;
  loading?: boolean;
}

export interface HudState {
  isMicActive: boolean;
  isSpeakerActive: boolean;
  isClickThrough: boolean;
  isAlwaysOnTop: boolean;
  isStreaming: boolean;
  sonioxLatencyMs: number;
  displayMode: SubtitleDisplayMode;
  subtitles: SubtitleItem[];
  hasPredictSuggestion: boolean;
  intentCategory?: string;
  suggestions: SuggestionItem[];
  // 麦克风硬件音量与权限诊断
  micVolume: number; // 0 - 100
  hasMicPermission: boolean;
  permissionError?: string;
  isSettingsOpen: boolean;
  isQuickLangOpen?: boolean;
  isCopilotLoading?: boolean;
  isStealthMode?: boolean;
  audioDevices?: AudioDevices;
  mySpeakerId?: number | null;
  quickSpeakCard?: QuickSpeakCardData | null;
}

export interface SelectionLookupData {
  text: string;
  phonetic_or_type: string;
  meaning: string;
  context_explanation: string;
  term_pair?: string | null;
  loading?: boolean;
  x: number;
  y: number;
}

const TARGET_LANG_NAMES: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  th: 'ไทย',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
};

export function formatTopbarLangBadgeText(config?: FullAppConfig): string {
  const isOneWay = config?.soniox?.translation_type !== 'two_way';
  const hints = (config?.soniox?.language_hints || ['en', 'zh']).map((h) => h.toUpperCase()).join('+');
  const strictIcon = config?.soniox?.language_hints_strict !== false ? ' 锁定' : '';
  const targetCode = config?.soniox?.target_language || 'zh';
  const targetName = TARGET_LANG_NAMES[targetCode] || targetCode.toUpperCase();
  const speakCode = (config?.soniox?.speak_target_language || 'en').toUpperCase();
  if (!isOneWay) {
    return `${targetName} ⇄ ${speakCode} 双向 (${hints}${strictIcon}) ▾`;
  }
  return `[${hints}${strictIcon}] 听:${targetName} · 说:${speakCode} ▾`;
}

export function renderPolishPillLabel(enabled: boolean): string {
  return enabled ? `${icon('sparkles')}<span>AI 整理：开</span>` : '<span>AI 整理：关</span>';
}

export function formatShortcut(text: string, platform?: string): string {
  const p =
    platform ||
    (typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-platform')
      : '') ||
    '';
  const isNonMac = p === 'windows' || p === 'linux';
  if (!isNonMac) return text;
  return text.replace(/⌘/g, 'Ctrl').replace(/\bCmd\+/g, 'Ctrl+');
}

export function isSystemAudioSource(device?: string | null): boolean {
  return device?.startsWith('wasapi-loopback:') ?? false;
}

export function audioLevelLabel(config?: FullAppConfig): string {
  return isSystemAudioSource(config?.soniox.input_device) ? '系统声音' : '麦克风';
}

export function renderTopbarMicStatusHtml(state: HudState, config?: FullAppConfig): string {
  if (!state.hasMicPermission && !isSystemAudioSource(config?.soniox.input_device)) {
    return `
      <button class="permission-pill no-drag warning"
              id="btnRequestMic"
              title="点击授权麦克风权限"
              onclick="window.__livehear_action('requestMicPermission')">
        ${icon('alert')} 麦克风未授权 (点击授权)
      </button>
    `;
  }
  const label = audioLevelLabel(config);
  return `
    <div class="track-indicator ${state.micVolume > 0 ? 'active' : ''}"
         id="micIndicator"
         title="${label}实时输入音量">
      <span class="track-dot ${state.micVolume > 3 ? 'pulse-green' : 'active'}"></span>
      <span id="micVolumeText">${label}: ${state.micVolume}%</span>
    </div>
    <div class="wave-visualizer ${state.micVolume > 3 ? 'animating' : ''}" id="micWaveVisualizer" title="实时输入音量">
      <span class="bar bar-1"></span>
      <span class="bar bar-2"></span>
      <span class="bar bar-3"></span>
      <span class="bar bar-4"></span>
    </div>
  `;
}

export function renderHudView(
  state: HudState,
  config?: FullAppConfig,
  _onAction?: (action: string, payload?: any) => void
): string {
  return `
    <div class="hud-window ${state.isClickThrough ? 'is-click-through' : ''}" data-tauri-drag-region>
      <!-- 顶部轻量拖拽把手区 (按住可自由拖动浮窗) -->
      <div class="drag-handle-pill" data-tauri-drag-region title="按住拖拽移动 HUD 浮窗"></div>

      <div class="win-window-controls no-drag">
        <button class="win-ctrl-btn no-drag" title="最小化窗口" aria-label="最小化窗口"
                onclick="window.__livehear_action('minimizeWindow')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10"/></svg>
        </button>
        <button class="win-ctrl-btn close-btn no-drag" title="关闭窗口" aria-label="关闭窗口"
                onclick="window.__livehear_action('closeWindow')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10"/></svg>
        </button>
      </div>

      <!-- HUD 顶栏状态与控制 (左侧留出 70px 避让 macOS 原生红黄绿交通灯) -->
      <div class="hud-topbar" data-tauri-drag-region>
        <div class="hud-status-group" data-tauri-drag-region>
          <!-- 实时同传大按钮开关 -->
          <button class="live-status-pill no-drag ${state.isStreaming ? 'streaming' : 'paused'}"
                  id="btnToggleLive"
                  title="${state.isStreaming ? '正在实时录音识别与同传中 (点击暂停)' : '点击启动实时录音与同传'}"
                  onclick="window.__livehear_action('toggleLiveStream')">
            <span class="live-dot-pulse"></span>
            <span class="live-text">${state.isStreaming ? '正在同传' : '开始同传'}</span>
          </button>

          <!-- 麦克风权限与音量实时监测 -->
          <span class="topbar-mic-slot" id="topbarMicSlot">${renderTopbarMicStatusHtml(state, config)}</span>

          <!-- 语种范围与目标语言快捷切换胶囊 (点击弹出快捷面板) -->
          <button class="lang-auto-badge no-drag interactive-lang-pill"
                  id="btnQuickLangPill"
                  title="点击快速切换收听语种范围 (Language Hints) 与目标翻译语言"
                  onclick="window.__livehear_action('toggleQuickLangPopover')">
            <span class="globe-icon">${icon('globe')}</span>
            <span id="topbarLangBadgeText">${escapeHtml(formatTopbarLangBadgeText(config))}</span>
          </button>

          <button class="lang-auto-badge no-drag interactive-lang-pill"
                  id="btnAsrBackend"
                  title="切换识别引擎；本地模式使用分段识别，不支持说话人分离"
                  onclick="window.__livehear_action('toggleAsrBackend')">
            ${config?.asr_backend?.provider === 'ollama' ? '识别：Ollama' : '识别：Soniox'}
          </button>
          <button class="lang-auto-badge no-drag interactive-lang-pill"
                  id="btnTogglePolish"
                  aria-pressed="${config?.openrouter?.enable_polish !== false}"
                  title="后续定稿字幕去除无意义语气词、结合上下文重译；需要 AI API Key，会产生模型费用"
                  onclick="window.__livehear_action('togglePolish')">
            ${renderPolishPillLabel(config?.openrouter?.enable_polish !== false)}
          </button>

          <!-- 智能 VAD 节费状态微标 -->
          <div class="vad-eco-badge" title="静音门禁可减少音频发送；实际费用以服务商账单为准">
            <span class="eco-leaf">${icon('leaf')}</span>
            <span>静音降费</span>
          </div>

          <span class="latency-badge"
                id="sonioxLatencyBadge"
                title="Soniox 实时流端到端响应延迟"
                style="${state.isStreaming && state.sonioxLatencyMs > 0 && config?.asr_backend?.provider !== 'ollama' ? '' : 'display:none'}">${icon('zap')}<span class="latency-value">${state.sonioxLatencyMs}ms</span></span>

          <span id="topbarMySpeakerSlot">
            ${
              state.mySpeakerId
                ? `
              <button class="my-speaker-top-pill no-drag"
                      title="已将 Speaker ${state.mySpeakerId} 绑定为「我自己」(标记本人发言并屏蔽抢答弹窗；单向/本地模式自动译为外语，双向模式由 Soniox 原生互译)。点击可取消绑定"
                      onclick="window.__livehear_action('toggleMySpeaker', ${state.mySpeakerId})">
                <span>${icon('mic')} 我: Speaker ${state.mySpeakerId}</span>
                <span class="ms-clear">${icon('x')}</span>
              </button>
            `
                : ''
            }
          </span>
        </div>

        <!-- 中部字幕模式切换器 (双语 / 仅译文 / 仅原文) -->
        <div class="hud-mode-pill no-drag">
          <button class="mode-btn ${state.displayMode === 'bilingual' ? 'active' : ''}" 
                  id="modeBtnBilingual"
                  title="同时显示外语原声与中文翻译"
                  onclick="window.__livehear_action('setSubtitleMode', 'bilingual')">
            双语对照
          </button>
          <button class="mode-btn ${state.displayMode === 'target_only' ? 'active' : ''}" 
                  id="modeBtnTarget"
                  title="仅显示清晰中文译文"
                  onclick="window.__livehear_action('setSubtitleMode', 'target_only')">
            仅看译文
          </button>
          <button class="mode-btn ${state.displayMode === 'source_only' ? 'active' : ''}" 
                  id="modeBtnSource"
                  title="仅显示外语原声识别"
                  onclick="window.__livehear_action('setSubtitleMode', 'source_only')">
            仅看原声
          </button>
        </div>

        <!-- 右侧状态徽章与快捷工具 -->
        <div class="hud-badges no-drag">
          <!-- 一键发言提词 / 帮我接话按钮 -->
          <button class="copilot-trigger-pill no-drag ${state.hasPredictSuggestion ? 'active' : ''}"
                  id="btnOpenCopilot"
                  title="${formatShortcut('根据上文快速生成我方发言提词与回应建议 (快捷键: ⌘+K)')}"
                  onclick="window.__livehear_action('openCopilotDrawer')">
            ${icon('bulb')}
            <span>帮我接话</span>
          </button>

          <!-- 投屏隐身防录屏模式 (Stealth Mode) -->
          <button class="icon-btn no-drag ${state.isStealthMode ? 'active stealth-active' : ''}"
                  id="btnToggleStealth"
                  aria-label="投屏隐身"
                  title="${formatShortcut(state.isStealthMode ? '投屏隐身已开启：共享屏幕/截图时此窗口完全隐形 (⌘+Shift+H)' : '点击开启投屏隐身：Zoom/腾讯会议/飞书共享屏幕时隐藏此浮窗 (⌘+Shift+H)')}"
                  onclick="window.__livehear_action('toggleStealthMode')">
            ${icon('eyeOff')}
          </button>

          <!-- 鼠标穿透模式 (Click-Through) -->
          <button class="icon-btn no-drag ${state.isClickThrough ? 'active' : ''}"
                  id="btnToggleClickThrough"
                  aria-label="鼠标穿透"
                  title="${formatShortcut(state.isClickThrough ? '鼠标穿透已开启 (按 ⌘+Shift+X 恢复点击)' : '点击开启鼠标穿透：不遮挡底层软件点击 (⌘+Shift+X)')}"
                  onclick="window.__livehear_action('toggleClickThrough')">
            ${icon('pointer')}
          </button>

          <button class="icon-btn no-drag" 
                  aria-label="导出会议纪要"
                  title="一键导出为会议速记 Markdown 纪要 (自动附带 AI 决议与待办提炼)"
                  onclick="window.__livehear_action('exportTranscript')">
            ${icon('download')}
          </button>

          <button class="icon-btn no-drag ${state.isAlwaysOnTop ? 'active' : ''}" 
                  id="btnTogglePin"
                  aria-label="窗口置顶"
                  title="${state.isAlwaysOnTop ? '窗口已置顶固定' : '点击开启置顶'}"
                  onclick="window.__livehear_action('toggleTopmost')">
            ${icon('pin')}
          </button>

          <button class="icon-btn no-drag" title="清空当前字幕列表" aria-label="清空字幕" onclick="window.__livehear_action('clearSubtitles')">
            ${icon('trash')}
          </button>

          <button class="icon-btn no-drag ${state.isSettingsOpen ? 'active' : ''}" 
                  id="btnToggleSettings"
                  aria-label="配置中心"
                  title="配置中心 (Soniox API Key / AI 智囊 / 语言)" 
                  onclick="window.__livehear_action('toggleSettings')">
            ${icon('settings')}
          </button>

        </div>
      </div>

      <!-- 顶栏快捷语种范围与目标语言热切浮层 -->
      <div id="quickLangPopoverContainer">
        ${state.isQuickLangOpen && config ? renderQuickLangPopoverHtml(config) : ''}
      </div>

      <!-- 划词 / 点击单词语境精译悬浮卡片容器 -->
      <div id="selectionLookupContainer"></div>

      <!-- 连续无边界流式字幕流瀑布 (Fluid River Stream - 无生硬卡片外框，视觉连贯透气) -->
      <div class="subtitles-stream selectable-text" id="subtitlesStream">
        ${
          state.subtitles.length === 0
            ? renderEmptyPlaceholder(state.isStreaming, state.hasMicPermission)
            : state.subtitles
                .map((item) =>
                  renderSubtitleTurnHtml(
                    item,
                    state.displayMode,
                    state.mySpeakerId,
                    config?.soniox?.speak_target_language || 'en'
                  )
                )
                .join('')
        }
      </div>

      <!-- 智能回到底部悬浮小药丸 (当用户向上回溯浏览时出现) -->
      <button class="btn-jump-bottom no-drag hide" id="btnJumpToBottom" onclick="window.__livehear_action('jumpToBottom')">
        <span>↓ 回到最新</span>
      </button>

      <!-- Jev 决策网关拦截并触发的推测建议 (Smart Response Drawer) -->
      <div id="predictDrawerContainer">
        ${
          state.hasPredictSuggestion && state.suggestions.length > 0
            ? renderSuggestionsHtml(state.suggestions, state.intentCategory)
            : ''
        }
      </div>

      <!-- 常驻底部快捷输入秒译 & 辅助发言栏 (Quick Speak Dock) -->
      <div id="quickSpeakDockContainer">
        ${renderQuickSpeakDockHtml(state, config)}
      </div>

      <!-- 内嵌式轻量设置抽屉 (In-Window Settings Modal) -->
      <div id="settingsOverlayContainer">
        ${state.isSettingsOpen && config ? renderSettingsModalHtml(config, state) : ''}
      </div>
    </div>
  `;
}

export function renderEmptyPlaceholder(isStreaming: boolean, hasPermission: boolean): string {
  return `
    <div class="empty-stream-placeholder">
      <div class="placeholder-icon-wrap">
        <span class="placeholder-radar ${isStreaming ? 'pulsing' : ''}"></span>
        <span class="placeholder-emoji">${!hasPermission ? icon('mic') : isStreaming ? icon('speak') : icon('pause')}</span>
      </div>
      <div class="placeholder-title">
        ${
          !hasPermission
            ? '需要麦克风访问权限'
            : isStreaming
            ? '同传已连接，等待字幕'
            : '实时同传已暂停'
        }
      </div>
      <div class="placeholder-desc">
        ${
          !hasPermission
            ? 'LiveHear 需要麦克风权限来捕获实时发言并完成同传翻译。点击下方按钮授予授权：'
            : isStreaming
            ? '播放会议音频或对麦克风说话。若顶栏电平一直为 0%，请在设置中检查当前音频源。'
            : '点击顶部「开始同传」按钮，从所选音频输入设备开始识别。'
        }
      </div>
      ${
        !hasPermission
          ? `
        <button class="btn-primary no-drag start-cta-btn" onclick="window.__livehear_action('requestMicPermission')">
          ${icon('mic')} 立即请求系统麦克风授权
        </button>
      `
          : !isStreaming
          ? `
        <button class="btn-primary no-drag start-cta-btn" onclick="window.__livehear_action('toggleLiveStream')">
          ▶ 立即启动实时双语同传
        </button>
      `
          : ''
      }
    </div>
  `;
}

export function detectTextLanguage(text: string): 'zh' | 'en' | 'th' | 'ja' | null {
  if (!text) return null;
  let zh = 0, en = 0, th = 0, ja = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) zh++;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) en++;
    else if (code >= 0x0e00 && code <= 0x0e7f) th++;
    else if (code >= 0x3040 && code <= 0x30ff) ja++;
  }
  if (zh > 0 && zh >= en) return 'zh';
  if (th > 0) return 'th';
  if (ja > 0) return 'ja';
  if (en > 0) return 'en';
  return null;
}

// 连贯自然流式对话项 (支持同发言人连续语句紧凑时间轴分组、已确认词与临时词分层渲染、点击一键认领「我自己」)
export function renderSubtitleTurnHtml(
  item: SubtitleItem,
  displayMode: SubtitleDisplayMode,
  mySpeakerId?: number | null,
  speakTargetLang = 'en'
): string {
  const isMe = !item.isTrackRemote || (Boolean(mySpeakerId) && item.speakerId === mySpeakerId);
  const speakerClass = isMe ? 'speaker-me' : getSpeakerClass(item);
  const origTrim = (item.original || '').trim();
  const transTrim = (item.translated || '').trim();
  const textLang = detectTextLanguage(origTrim);
  const transLang = detectTextLanguage(transTrim);
  const speakUpper = (speakTargetLang || 'en').toUpperCase();

  // 结合后端识别语种与文本字形分析，纠正语种漂移
  let detected = item.detectedLanguage ? item.detectedLanguage.toLowerCase() : '';
  if (detected === 'zh' && textLang === 'en') {
    detected = 'en';
  } else if (detected === 'en' && textLang === 'zh') {
    detected = 'zh';
  } else if (!detected && textLang) {
    detected = textLang;
  }

  const isChineseSpeech = (detected === 'zh' || textLang === 'zh') && isMainlyChinese(origTrim);
  // 仅当中文原声且译文未翻成外语（如单向同传目标也是中文，或译文与原文一致）时才单行展示；
  // 若开启了双向互译或「我自己」说中文翻成了外语，则完整展示双语对照！
  const hasForeignTranslation =
    Boolean(transTrim) &&
    transTrim !== '正在同传中...' &&
    transTrim !== origTrim &&
    (!isMainlyChinese(transTrim) || (transLang !== null && transLang !== 'zh'));
  const isNativeZh = isChineseSpeech && !hasForeignTranslation && !item.translationStatus;

  // 复制内容：默认优先复制最清晰的译文，若为纯中文直接复制原文
  const copyContent = isNativeZh ? (origTrim || transTrim) : (transTrim || origTrim);

  let langLabel = '';
  if (isNativeZh) {
    langLabel = isMe ? `中文原声 · 点右侧译${speakUpper}` : '中文原声';
  } else if (isChineseSpeech && hasForeignTranslation) {
    langLabel = `中文 ➔ ${(transLang || speakTargetLang || 'EN').toUpperCase()}`;
  } else if (detected === 'en' || textLang === 'en') {
    langLabel = 'EN ➔ 中文';
  } else if (detected === 'th' || textLang === 'th') {
    langLabel = 'TH ➔ 中文';
  } else if (detected === 'ja' || textLang === 'ja') {
    langLabel = 'JA ➔ 中文';
  } else if (detected) {
    langLabel = `${detected.toUpperCase()} ➔ 中文`;
  } else {
    langLabel = 'EN ➔ 中文';
  }

  const isCont = Boolean(item.isContinuation);
  const canSelectSpeaker = typeof item.speakerId === 'number' && item.speakerId > 0;
  const displaySpeakerName = isMe && item.speakerId ? `我 (${item.speaker})` : item.speaker;

  const actionButtonsHtml = `
    ${item.rawOriginal && (item.aiOriginal || item.aiTranslation) ? `<button class="turn-copy-action no-drag" onclick="window.__livehear_action('toggleTranscriptVersion', '${escapeJs(item.id)}')">${item.showingRaw ? '查看 AI 版' : '恢复原始版'}</button>` : ''}
    ${
      isChineseSpeech
        ? `
      <button class="turn-speak-trans-action no-drag"
              title="使用配置的 AI 翻译模型，将这句中文润色为地道 ${speakUpper} 口语"
              onclick="window.__livehear_action('translateTurnToForeign', '${escapeJs(item.id)}')">
        ${icon('globe')}
        <span>译为${speakUpper}</span>
      </button>
    `
        : ''
    }
    ${
      !isMe
        ? `
      <button class="turn-quick-chip no-drag"
              title="针对这句话生成【赞同并推进】的 ${speakUpper} 发言词"
              onclick="window.__livehear_action('promptReplyWithIntent', '${escapeJs(item.id)}', '赞同对方观点并顺势推进')">
        ${icon('thumbsUp')} 赞同
      </button>
      <button class="turn-quick-chip no-drag"
              title="针对这句话生成【委婉缓议/推迟】的 ${speakUpper} 发言词"
              onclick="window.__livehear_action('promptReplyWithIntent', '${escapeJs(item.id)}', '委婉表示需要会后确认或推迟排期')">
        ${icon('clock')} 缓议
      </button>
      <button class="turn-quick-chip no-drag"
              title="针对这句话生成【追问核心细节】的 ${speakUpper} 发言词"
              onclick="window.__livehear_action('promptReplyWithIntent', '${escapeJs(item.id)}', '针对对方刚才的话追问关键技术或排期细节')">
        ${icon('help')} 追问
      </button>
    `
        : ''
    }
    <button class="turn-reply-action no-drag"
            title="针对这句话生成 3 种角度的 ${speakUpper} 接话提词"
            onclick="window.__livehear_action('promptReplyForTurn', '${escapeJs(item.id)}')">
      ${icon('message')}
      <span>接话</span>
    </button>
    <button class="turn-copy-action no-drag" 
            title="点击复制此句内容"
            onclick="window.__livehear_action('copyText', '${escapeJs(copyContent)}', this)">
      <span class="copy-icon">${icon('copy')}</span>
      <span class="copy-label">复制</span>
    </button>
  `;

  return `
    <div class="stream-turn-block selectable-text ${item.isPartial ? 'is-partial' : ''} ${isCont ? 'is-continuation' : ''} ${isMe ? 'is-me-turn' : ''}" data-id="${escapeHtml(item.id)}" data-speaker="${escapeHtml(item.speaker)}">
      <!-- 左侧发言人指示条与时间轴轴线 -->
      <div class="turn-gutter">
        ${
          isCont
            ? `<div class="turn-continuation-dot ${speakerClass} ${canSelectSpeaker ? 'clickable-avatar no-drag' : ''}"
                    title="${canSelectSpeaker ? `${escapeHtml(displaySpeakerName)} · 点击切换「我自己」绑定` : `${escapeHtml(displaySpeakerName)} · ${item.timestamp}`}"
                    ${canSelectSpeaker ? `onclick="window.__livehear_action('toggleMySpeaker', ${item.speakerId})"` : ''}></div>`
            : `
          <div class="turn-speaker-avatar ${speakerClass} ${canSelectSpeaker ? 'clickable-avatar no-drag' : ''}"
               title="${canSelectSpeaker ? (isMe ? '当前已设为「我自己」· 点击取消绑定' : `点击将 ${escapeHtml(item.speaker)} 设为「我自己」(标记我方发言与屏蔽抢答；单向/本地模式自动译为 ${escapeHtml(speakUpper)})`) : escapeHtml(displaySpeakerName)}"
               ${canSelectSpeaker ? `onclick="window.__livehear_action('toggleMySpeaker', ${item.speakerId})"` : ''}>
            <span class="avatar-icon">${isMe ? icon('mic') : icon('user')}</span>
          </div>
        `
        }
        <div class="turn-timeline-line"></div>
      </div>

      <!-- 右侧主体内容 -->
      <div class="turn-content">
        ${
          isCont
            ? `
          <div class="turn-meta is-compact-meta">
            <span class="turn-time">${item.timestamp}</span>
            ${
              canSelectSpeaker
                ? `
              <button class="turn-claim-me-btn no-drag ${isMe ? 'active' : ''}"
                      title="${isMe ? '点击取消「我自己」绑定' : `点击将 ${escapeHtml(item.speaker)} 标记为「我自己」(过滤本人抢答弹窗；单向/本地模式自动译为 ${escapeHtml(speakUpper)})`}"
                      onclick="window.__livehear_action('toggleMySpeaker', ${item.speakerId})">
                ${isMe ? `${icon('check')} 我本人` : `${icon('user')} 设为我`}
              </button>
            `
                : ''
            }
            ${item.toneTag ? `<span class="turn-tone-tag">${escapeHtml(item.toneTag)}</span>` : ''}
            <div class="turn-actions-group">
              ${actionButtonsHtml}
            </div>
          </div>
        `
            : `
          <div class="turn-meta">
            <span class="turn-speaker-name ${speakerClass}">${escapeHtml(displaySpeakerName)}</span>
            ${
              canSelectSpeaker
                ? `
              <button class="turn-claim-me-btn no-drag ${isMe ? 'active' : ''}"
                      title="${isMe ? '点击取消「我自己」绑定' : `点击将 ${escapeHtml(item.speaker)} 标记为「我自己」(过滤本人抢答弹窗；单向/本地模式自动译为 ${escapeHtml(speakUpper)})`}"
                      onclick="window.__livehear_action('toggleMySpeaker', ${item.speakerId})">
                ${isMe ? `${icon('check')} 我本人` : `${icon('user')} 设为我`}
              </button>
            `
                : ''
            }
            <span class="turn-time">${item.timestamp}</span>
            ${langLabel ? `<span class="turn-lang-tag">${escapeHtml(langLabel)}</span>` : ''}
            ${item.toneTag ? `<span class="turn-tone-tag">${escapeHtml(item.toneTag)}</span>` : ''}

            <div class="turn-actions-group">
              ${actionButtonsHtml}
            </div>
          </div>
        `
        }

        <!-- 文本流内容区：显式清晰标注 [同传] 与 [原声] -->
        <div class="turn-body">
          ${renderTurnTextLines(item, displayMode, isNativeZh, detected)}
          ${!item.isPartial && item.rawOriginal ? `<details class="raw-transcript no-drag"><summary>查看原始识别${item.aiOriginal || item.aiTranslation ? ' · 已有 AI 整理' : ''}</summary><div>原始识别：${escapeHtml(item.rawOriginal)}</div>${item.rawTranslation ? `<div>原始译文：${escapeHtml(item.rawTranslation)}</div>` : ''}</details>` : ''}
        </div>
      </div>
    </div>
  `;
}

// 保持向前兼容导出
export const renderSubtitleCardHtml = renderSubtitleTurnHtml;

function renderSegmentedTokens(
  fullText: string,
  confirmed?: string,
  provisional?: string,
  isPartial?: boolean
): string {
  if (isPartial && (confirmed || provisional)) {
    const confHtml = confirmed ? `<span class="token-confirmed">${escapeHtml(confirmed)}</span>` : '';
    const provHtml = provisional ? `<span class="token-provisional">${escapeHtml(provisional)}</span>` : '';
    return `${confHtml}${provHtml}`;
  }
  return `<span class="token-confirmed">${escapeHtml(fullText)}</span>`;
}

function renderTurnTextLines(
  item: SubtitleItem,
  displayMode: SubtitleDisplayMode,
  isNativeZh: boolean,
  detectedLang: string
): string {
  // 如果当前发言本身就是中文（且无外语互译），直接单行大字优雅呈现
  if (isNativeZh) {
    const nativeBody = renderSegmentedTokens(
      item.original || item.translated,
      item.confirmedOriginal,
      item.provisionalOriginal,
      item.isPartial
    );
    const zhBadgeText = item.isPolished ? '中文 · 纠偏' : '中文';
    return `
      <div class="turn-line-trans is-native-zh ${item.isPolished ? 'is-polished' : ''}" title="${item.isPolished ? 'AI 已结合前后文完成同音词与术语纠偏' : '中文发言原声'}">
        <span class="role-badge zh-badge ${item.isPolished ? 'polished' : ''}">${zhBadgeText}</span>
        <span class="line-text">${nativeBody}</span>
        ${item.isPartial ? '<span class="streaming-pulse-cursor"></span>' : ''}
      </div>
    `;
  }

  // 跨语言场景：原声 + 实时流式同传
  const badgeTitle = item.isPolished ? 'AI 智能语境串联润色' : '实时翻译结果';
  const badgeText = item.isPolished ? '同传 · 润色' : '同传';
  const fallbackTrans = item.translated || (item.isPartial ? '正在同传中...' : item.original);
  const transBody = item.translationStatus === 'pending'
    ? `<span class="token-provisional">正在翻译…</span>`
    : item.translationStatus === 'unavailable'
    ? `<span class="token-provisional">译文不可用</span>`
    : item.isPartial && (item.confirmedTranslated || item.provisionalTranslated)
      ? renderSegmentedTokens(
          fallbackTrans,
          item.confirmedTranslated,
          item.provisionalTranslated,
          true
        )
      : !item.translated && item.isPartial
      ? `<span class="token-provisional">正在同传中...</span>`
      : `<span class="token-confirmed">${escapeHtml(fallbackTrans)}</span>`;

  const transLine = `
    <div class="turn-line-trans ${item.isPolished ? 'is-polished' : ''}" title="${badgeTitle}">
      <span class="role-badge trans-badge ${item.isPolished ? 'polished' : ''}">${badgeText}</span>
      <span class="line-text">${transBody}</span>
      ${item.isPartial ? '<span class="streaming-pulse-cursor"></span>' : ''}
    </div>
  `;

  const langTag = detectedLang ? ` [${detectedLang.toUpperCase()}]` : ' [EN]';
  const origBody = renderSegmentedTokens(
    item.original || '...',
    item.confirmedOriginal,
    item.provisionalOriginal,
    item.isPartial
  );
  const origLine = `
    <div class="turn-line-orig" title="原声语音识别">
      <span class="role-badge orig-badge">原声${langTag}</span>
      <span class="orig-quote">“${origBody}”</span>
    </div>
  `;

  if (displayMode === 'target_only') {
    return transLine;
  }
  if (displayMode === 'source_only') {
    return origLine;
  }

  // 双语对照：同传译文居上（大字核心），原声音频识别居下（精准引语）
  return `${transLine}${origLine}`;
}

function splitBilingualDetail(detail: string): { mainText: string; subNote: string } {
  const trimmed = (detail || '').trim();
  const match = trimmed.match(/^(.*?)\s*[\(（]([^\)）]+)[\)）]\s*$/);
  if (match && match[1].trim()) {
    return { mainText: match[1].trim(), subNote: match[2].trim() };
  }
  return { mainText: trimmed, subNote: '' };
}

export function renderSuggestionsHtml(
  suggestions: SuggestionItem[],
  intentCategory?: string,
  isLoading = false,
  customIntent = ''
): string {
  return `
    <div class="predict-drawer no-drag">
      <div class="predict-header">
        <div class="predict-title">
          <span class="glow-bulb">${icon('bulb')}</span>
          <span class="title-text">实时发言提词 &amp; 应答智囊</span>
          <span class="jev-badge">${escapeHtml(intentCategory || '结合上文提词')}</span>
        </div>
        <div class="predict-header-actions">
          <button class="copilot-mini-btn tldr-btn no-drag" title="走神救星：3秒浓缩过去几分钟的讨论焦点、共识与待拍板事项" onclick="window.__livehear_action('summarizeRecentContext')">
            ${icon('notes')} 浓缩前文
          </button>
          <button class="copilot-mini-btn no-drag" title="结合最新上下文重新生成 3 条英文接话提词" onclick="window.__livehear_action('refreshCopilotPrompts')">
            ${icon('refresh')} 换批提词
          </button>
          <button class="copilot-close-btn no-drag" title="收起提词面板" aria-label="收起提词面板" onclick="window.__livehear_action('closeCopilotDrawer')">
            ${icon('x')}
          </button>
        </div>
      </div>

      <!-- 自定义发言意图秒转地道外语提词栏 + 随手记笔记 (Hyprnote 风格) -->
      <div class="copilot-intent-bar">
        <input type="text"
               id="copilotIntentInput"
               class="copilot-intent-input no-drag"
               value="${escapeHtml(customIntent)}"
               placeholder="输入中文想法回车秒生英文发言词，或点右侧「记笔记」插入会议时间轴..."
               onkeydown="if(event.key === 'Enter') window.__livehear_action('submitCopilotIntent')" />
        <button class="copilot-intent-submit no-drag" onclick="window.__livehear_action('submitCopilotIntent')">
          ${icon('sparkles')} 生成发言词
        </button>
        <button class="copilot-note-btn no-drag" title="将输入框内容作为带时间戳的个人备忘插入字幕流，并在会后合并进 AI 纪要" onclick="window.__livehear_action('insertQuickNote')">
          ${icon('pin')} 记笔记
        </button>
      </div>

      ${
        isLoading
          ? `
        <div class="copilot-loading-row">
          <span class="streaming-pulse-cursor"></span>
          <span>正在结合前序会议对话生成地道双语发言提词...</span>
        </div>
      `
          : `
        <div class="suggestions-list">
          ${suggestions
            .map((sug) => {
              const { mainText, subNote } = splitBilingualDetail(sug.detail);
              return `
            <div class="suggestion-card no-drag" onclick="window.__livehear_action('copySuggestion', ${sug.id})">
              <div class="suggestion-meta">
                <span class="strategy-badge">${escapeHtml(sug.title)}</span>
                <span class="shortcut-tag">${escapeHtml(formatShortcut(sug.shortcut))} · 点击复制英文</span>
              </div>
              <div class="suggestion-detail">${escapeHtml(mainText)}</div>
              ${subNote ? `<div class="suggestion-subnote">${icon('message')} ${escapeHtml(subNote)}</div>` : ''}
            </div>
          `;
            })
            .join('')}
        </div>
      `
      }
    </div>
  `;
}

export function renderQuickSpeakDockHtml(state: HudState, config?: FullAppConfig): string {
  const speakLang = config?.soniox?.speak_target_language || 'en';
  const speakUpper = speakLang.toUpperCase();
  const speakName = TARGET_LANG_NAMES[speakLang] || speakUpper;
  const card = state.quickSpeakCard;

  return `
    <div class="quick-speak-dock no-drag">
      ${
        card
          ? `
        <div class="quick-speak-result-card">
          <div class="qsr-header">
            <span class="qsr-badge">${icon('speak')} 口语秒译 (${escapeHtml(card.targetLang.toUpperCase())})</span>
            <span class="qsr-orig">原意: ${escapeHtml(card.input)}</span>
            <button class="qsr-close" title="关闭秒译结果" aria-label="关闭" onclick="window.__livehear_action('closeQuickSpeakCard')">${icon('x')}</button>
          </div>
          ${
            card.loading
              ? `
            <div class="qsr-loading">
              <span class="streaming-pulse-cursor"></span>
              <span>正在转化为地道 ${escapeHtml(speakName)} 会议口语...</span>
            </div>
          `
              : `
            <div class="qsr-main-row" title="点击复制此句口语" onclick="window.__livehear_action('copyText', '${escapeJs(card.spoken)}', this)">
              <span class="qsr-spoken-text">${escapeHtml(card.spoken)}</span>
              <span class="qsr-copy-hint">${icon('copy')} 点击复制</span>
            </div>
            ${
              card.alt
                ? `
              <div class="qsr-alt-row" title="点击复制简短替代句" onclick="window.__livehear_action('copyText', '${escapeJs(card.alt)}', this)">
                <span class="qsr-alt-tag">${icon('zap')} 简短版</span>
                <span class="qsr-alt-text">${escapeHtml(card.alt)}</span>
              </div>
            `
                : ''
            }
            ${
              card.tip
                ? `<div class="qsr-tip-row">${icon('bulb')} ${escapeHtml(card.tip)}</div>`
                : ''
            }
          `
          }
        </div>
      `
          : ''
      }
      <div class="quick-speak-bar">
        <button class="qs-lang-pill no-drag"
                title="点击快速切换「我方发言目标外语」(EN / JA / TH / KO / FR / DE / ES)"
                onclick="window.__livehear_action('cycleSpeakTargetLang')">
          <span>${icon('speak')} 译为:${escapeHtml(speakUpper)}</span>
          <span class="qs-caret">▾</span>
        </button>
        <input type="text"
               id="quickSpeakInput"
               class="qs-input no-drag"
               placeholder="${formatShortcut(`快捷辅助 Speak：输入中文回车秒译 ${escapeHtml(speakUpper)} 口语，点『3种建议』生成多角度提词 (⌘+K)...`)}"
               onkeydown="if(event.key === 'Enter' && event.shiftKey) { event.preventDefault(); window.__livehear_action('submitQuickSpeakSuggestions'); } else if(event.key === 'Enter') { event.preventDefault(); window.__livehear_action('submitQuickSpeakTranslate'); }" />
        <button class="qs-btn primary no-drag"
                title="将输入的中文极速翻译为地道 ${escapeHtml(speakUpper)} 口语并自动复制 (Enter)"
                onclick="window.__livehear_action('submitQuickSpeakTranslate')">
          ${icon('zap')} 秒译
        </button>
        <button class="qs-btn copilot no-drag"
                title="结合会议上下文生成 3 种不同语气的发言建议卡片 (Shift+Enter)"
                onclick="window.__livehear_action('submitQuickSpeakSuggestions')">
          ${icon('sparkles')} 3种建议
        </button>
        <button class="qs-btn note no-drag"
                title="将输入框内容作为个人笔记插入字幕时间轴"
                onclick="window.__livehear_action('insertQuickNoteFromDock')">
          ${icon('pin')} 记笔记
        </button>
      </div>
    </div>
  `;
}

export function renderQuickLangPopoverHtml(config: FullAppConfig): string {
  const isOneWay = config.soniox.translation_type !== 'two_way';
  const hintsStr = (config.soniox.language_hints || ['en', 'zh']).join(', ');
  const isStrict = config.soniox.language_hints_strict !== false;
  const targetLang = config.soniox.target_language || 'zh';
  const speakLang = config.soniox.speak_target_language || 'en';

  const presets = [
    { label: '中 + 英 (推荐)', val: 'en, zh' },
    { label: '纯英语会议', val: 'en' },
    { label: '中 + 英 + 泰', val: 'en, zh, th' },
    { label: '中 + 英 + 日', val: 'en, zh, ja' },
  ];

  const targets = [
    { code: 'zh', label: '中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'th', label: 'ไทย' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
  ];

  const speakTargets = [
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'th', label: 'ไทย' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
  ];

  return `
    <div class="quick-lang-popover no-drag" id="quickLangPopover">
      <div class="ql-header">
        <span class="ql-title">${icon('target')} 识别语种范围 &amp; 听/说目标语言切换</span>
        <button class="ql-close" aria-label="关闭" onclick="window.__livehear_action('toggleQuickLangPopover')">${icon('x')}</button>
      </div>

      <div class="ql-section">
        <div class="ql-label">1. 收听语种范围 (缩小范围可大幅提升识别精度)</div>
        <div class="ql-preset-chips">
          ${presets
            .map(
              (p) => `
            <button class="ql-chip ${hintsStr.replace(/\s+/g, '') === p.val.replace(/\s+/g, '') ? 'active' : ''}"
                    onclick="window.__livehear_action('selectLangPreset', '${p.val}')">
              ${escapeHtml(p.label)}
            </button>
          `
            )
            .join('')}
        </div>
        <div class="ql-custom-row">
          <input type="text" id="quickHintsInput" value="${escapeHtml(hintsStr)}" placeholder="自定义语种代码: en, zh, th, ja, ko..." />
          <label class="ql-strict-toggle" title="限制识别范围；未列入的语种可能无法正确识别">
            <input type="checkbox" id="quickStrictCheckbox" ${isStrict ? 'checked' : ''} />
            <span>${icon('lock')} 严格锁定</span>
          </label>
        </div>
      </div>

      <div class="ql-section">
        <div class="ql-label">2. 听会同传目标语言 (他人外语 ➔ 译为我方母语)</div>
        <div class="ql-mode-row">
          <button class="ql-mode-btn ${isOneWay ? 'active' : ''}"
                  onclick="window.__livehear_action('quickSetTransMode', 'one_way')">
            ${icon('globe')} 单向听会 + 智能辅助我 Speak
          </button>
          <button class="ql-mode-btn ${!isOneWay ? 'active' : ''}"
                  onclick="window.__livehear_action('quickSetTransMode', 'two_way')">
            ${icon('refresh')} Soniox 全程双向互译（默认）
          </button>
        </div>
        <div class="ql-target-chips">
          ${targets
            .map(
              (t) => `
            <button class="ql-target-chip ${targetLang === t.code ? 'active' : ''}"
                    onclick="window.__livehear_action('quickSetTargetLang', '${t.code}')">
              听:${escapeHtml(t.label)} (${t.code})
            </button>
          `
            )
            .join('')}
        </div>
      </div>

      <div class="ql-section">
        <div class="ql-label">3. 辅助我 Speak 目标外语 (「我」说中文 / 快捷输入 ➔ 译为)</div>
        <div class="ql-target-chips">
          ${speakTargets
            .map(
              (t) => `
            <button class="ql-target-chip ${speakLang === t.code ? 'active' : ''}"
                    onclick="window.__livehear_action('quickSetSpeakTargetLang', '${t.code}')">
              ${icon('speak')} ${escapeHtml(t.label)} (${t.code})
            </button>
          `
            )
            .join('')}
        </div>
      </div>

      <div class="ql-footer">
        <span class="ql-tip">点击字幕「设为我」可标记本人发言与过滤抢答（单向/本地模式自动译为外语；双向模式由 Soniox 原生互译）</span>
        <button class="btn-primary ql-apply-btn" onclick="window.__livehear_action('applyQuickLangConfig')">
          ${icon('zap')} 立即应用并热切
        </button>
      </div>
    </div>
  `;
}

export function renderLookupPopoverHtml(data: SelectionLookupData): string {
  return `
    <div class="selection-lookup-popover no-drag"
         id="selectionLookupPopover"
         style="left: ${Math.round(data.x)}px; top: ${Math.round(data.y)}px;">
      <div class="slp-header">
        <div class="slp-word-wrap">
          <span class="slp-word">${escapeHtml(data.text)}</span>
          ${
            data.phonetic_or_type
              ? `<span class="slp-phonetic">${escapeHtml(data.phonetic_or_type)}</span>`
              : ''
          }
        </div>
        <button class="slp-close" aria-label="关闭" onclick="window.__livehear_action('closeSelectionLookup')">${icon('x')}</button>
      </div>
      ${
        data.loading
          ? `
        <div class="slp-loading">
          <span class="streaming-pulse-cursor"></span>
          <span>正在结合当前会议语境解析...</span>
        </div>
      `
          : `
        <div class="slp-meaning">${escapeHtml(data.meaning)}</div>
        ${
          data.context_explanation
            ? `<div class="slp-context">${icon('bulb')} 语境解读：${escapeHtml(data.context_explanation)}</div>`
            : ''
        }
        <div class="slp-actions">
          <button class="slp-btn" onclick="window.__livehear_action('copyText', '${escapeJs(data.meaning)}')">
            ${icon('copy')} 复制释义
          </button>
          ${
            data.term_pair
              ? `
            <button class="slp-btn primary" onclick="window.__livehear_action('addTermFromLookup', '${escapeJs(data.term_pair)}')">
              ${icon('plus')} 加入术语表 (${escapeHtml(data.term_pair)})
            </button>
          `
              : `
            <button class="slp-btn primary" onclick="window.__livehear_action('addTermFromLookup', '${escapeJs(`${data.text}=${data.meaning}`)}')">
              ${icon('plus')} 加入术语库
            </button>
          `
          }
        </div>
      `
      }
    </div>
  `;
}

export function renderSettingsModalHtml(config: FullAppConfig, state: HudState): string {
  const isOneWay = config.soniox.translation_type !== 'two_way';
  const customTermsStr = (config.soniox.custom_terms || []).join('\n');
  const hintsStr = (config.soniox.language_hints || ['en', 'zh']).join(', ');
  const inputDevices = state.audioDevices?.inputs ?? [];
  const systemOutputs = state.audioDevices?.system_outputs ?? [];
  const selectedDevice = config.soniox.input_device || '';
  const usingSystemAudio = isSystemAudioSource(selectedDevice);
  const usingDefaultInput = !selectedDevice || selectedDevice === 'default';
  const selectedIsListed = inputDevices.some((name) => name === selectedDevice)
    || systemOutputs.some(({ id }) => id === selectedDevice);

  return `
    <div class="settings-overlay no-drag" id="settingsOverlay" onclick="if(event.target === this) window.__livehear_action('toggleSettings')">
      <div class="settings-modal no-drag">
        <div class="settings-header">
          <div class="settings-title">
            ${icon('settings')}
            <h3>LiveHear 会议同传控制中心</h3>
          </div>
          <button class="close-modal-btn no-drag" aria-label="关闭设置" onclick="window.__livehear_action('toggleSettings')">${icon('x')}</button>
        </div>

        <div class="settings-body">
          <div class="setting-group">
            <label>语音识别引擎</label>
            <select id="cfgAsrProvider">
              <option value="soniox" ${config.asr_backend?.provider !== 'ollama' ? 'selected' : ''}>Soniox（实时翻译和说话人区分）</option>
              <option value="ollama" ${config.asr_backend?.provider === 'ollama' ? 'selected' : ''}>Ollama（本地分段识别）</option>
            </select>
            <div class="setting-tip">本地模式优先在停顿处分段，连续发言约 8 秒时切分；不支持说话人区分或双向自动互译，翻译依赖 AI 服务。</div>
          </div>
          <div class="setting-row-2col">
            <div class="setting-group">
              <label>Ollama 服务地址 (Ollama URL)</label>
              <input type="text" id="cfgOllamaUrl" value="${escapeHtml(config.asr_backend?.ollama_url || 'http://127.0.0.1:11434')}" placeholder="http://127.0.0.1:11434" />
            </div>
            <div class="setting-group">
              <label>Ollama 本地识别模型 (Ollama Model)</label>
              <input type="text" id="cfgOllamaModel" value="${escapeHtml(config.asr_backend?.ollama_model || 'livehear-qwen3-asr:1.7b')}" placeholder="livehear-qwen3-asr:1.7b" />
            </div>
          </div>
          <div class="setting-group">
            <label>Soniox API Key (项目专有密钥)</label>
            <div class="input-with-button">
              <input type="password" id="cfgSonioxApiKey" value="${escapeHtml(config.soniox.api_key)}" placeholder="snx_proj_..." />
              <button class="btn-subtle" onclick="window.__livehear_action('testSonioxConnection')">${icon('zap')} 测试连通</button>
            </div>
            <div class="setting-tip">Soniox 提供实时识别、翻译和说话人区分，实际延迟取决于音频、网络和断句设置。</div>
          </div>

          <div class="setting-group">
            <label>同传工作模式</label>
            <div class="radio-pill-group">
              <label class="radio-pill ${isOneWay ? 'active' : ''}">
                <input type="radio" name="cfgTranslationType" value="one_way" ${isOneWay ? 'checked' : ''} />
                <span>${icon('globe')} 涉外会议单向同传</span>
              </label>
              <label class="radio-pill ${!isOneWay ? 'active' : ''}">
                <input type="radio" name="cfgTranslationType" value="two_way" ${!isOneWay ? 'checked' : ''} />
                <span>${icon('refresh')} Soniox 双向互译（默认）</span>
              </label>
            </div>
            <div class="setting-tip">
              ${
                isOneWay
                  ? '单向听会模式：对方无论讲英语、泰语还是其他语言，全部同传为中文；自己说中文直接显示中文，不产生反向翻译。'
                  : '双向对谈模式：适合二人跨国对话，中文自动翻成英文，英文自动翻成中文。'
              }
            </div>
          </div>

          <div class="setting-row-2col">
            <div class="setting-group">
              <label>听会目标同传语言 (对方外语 ➔ 译为)</label>
              <select id="cfgSonioxTargetLang">
                <option value="zh" ${config.soniox.target_language === 'zh' ? 'selected' : ''}>中文 (简体)</option>
                <option value="en" ${config.soniox.target_language === 'en' ? 'selected' : ''}>English (英语)</option>
                <option value="ja" ${config.soniox.target_language === 'ja' ? 'selected' : ''}>日本語 (日语)</option>
                <option value="th" ${config.soniox.target_language === 'th' ? 'selected' : ''}>ไทย (泰语)</option>
                <option value="ko" ${config.soniox.target_language === 'ko' ? 'selected' : ''}>한국어 (韩语)</option>
                <option value="fr" ${config.soniox.target_language === 'fr' ? 'selected' : ''}>Français (法语)</option>
                <option value="de" ${config.soniox.target_language === 'de' ? 'selected' : ''}>Deutsch (德语)</option>
                <option value="es" ${config.soniox.target_language === 'es' ? 'selected' : ''}>Español (西班牙语)</option>
              </select>
            </div>

            <div class="setting-group">
              <label>辅助我 Speak 目标外语 (我说中文/快捷输入 ➔ 译为)</label>
              <select id="cfgSonioxSpeakTargetLang">
                <option value="en" ${(config.soniox.speak_target_language || 'en') === 'en' ? 'selected' : ''}>English (英语)</option>
                <option value="ja" ${config.soniox.speak_target_language === 'ja' ? 'selected' : ''}>日本語 (日语)</option>
                <option value="th" ${config.soniox.speak_target_language === 'th' ? 'selected' : ''}>ไทย (泰语)</option>
                <option value="ko" ${config.soniox.speak_target_language === 'ko' ? 'selected' : ''}>한국어 (韩语)</option>
                <option value="fr" ${config.soniox.speak_target_language === 'fr' ? 'selected' : ''}>Français (法语)</option>
                <option value="de" ${config.soniox.speak_target_language === 'de' ? 'selected' : ''}>Deutsch (德语)</option>
                <option value="es" ${config.soniox.speak_target_language === 'es' ? 'selected' : ''}>Español (西班牙语)</option>
              </select>
            </div>
          </div>

          <div class="setting-group">
            <label>预期语种提示 (Language Hints)</label>
            <input type="text" id="cfgLanguageHints" value="${escapeHtml(hintsStr)}" placeholder="en, zh" />
            <label class="checkbox-label" style="margin-top: 6px;">
              <input type="checkbox" id="cfgLanguageHintsStrict" ${config.soniox.language_hints_strict !== false ? 'checked' : ''} />
              <span>${icon('lock')} 严格限定上述识别语种（请包含会议中可能使用的语言）</span>
            </label>
          </div>

          <div class="setting-row-2col">
            <div class="setting-group">
              <label>多人会议断句窗口 (Endpoint Delay)</label>
              <select id="cfgEndpointDelay">
                <option value="600" ${(config.soniox.max_endpoint_delay_ms ?? 2000) <= 800 ? 'selected' : ''}>极速响应 (600ms · 低延迟字幕)</option>
                <option value="1000" ${(config.soniox.max_endpoint_delay_ms ?? 2000) > 800 && (config.soniox.max_endpoint_delay_ms ?? 2000) <= 1250 ? 'selected' : ''}>敏捷对话 (1000ms)</option>
                <option value="1500" ${(config.soniox.max_endpoint_delay_ms ?? 2000) > 1250 && (config.soniox.max_endpoint_delay_ms ?? 2000) <= 1600 ? 'selected' : ''}>紧凑对话 (1500ms · 快节奏问答)</option>
                <option value="2000" ${(config.soniox.max_endpoint_delay_ms ?? 2000) > 1600 && (config.soniox.max_endpoint_delay_ms ?? 2000) <= 2300 ? 'selected' : ''}>多人会议标准 (2000ms)</option>
                <option value="2600" ${(config.soniox.max_endpoint_delay_ms ?? 2000) > 2300 ? 'selected' : ''}>深度长句讨论 (2600ms · 复杂从句最稳)</option>
              </select>
              <div class="setting-tip">留足上下文窗口供 Soniox 完整理解长句语义与声纹，消除半句切碎与直译错误。</div>
            </div>

            <div class="setting-group">
              <label>多说话人声纹分离 (Diarization)</label>
              <label class="checkbox-label" style="margin-top: 6px;">
                <input type="checkbox" id="cfgSpeakerDiarization" ${config.soniox.enable_speaker_diarization !== false ? 'checked' : ''} />
                <span>${icon('user')} 自动区分 Speaker 1 / 2 / 3</span>
              </label>
              <div class="setting-tip">仅由终态确认词驱动换人，免疫临时词声纹抖动。</div>
            </div>
          </div>

          <div class="setting-row-2col">
            <div class="setting-group">
              <label class="checkbox-label">
                <input type="checkbox" id="cfgEnableVad" ${config.soniox.enable_vad !== false ? 'checked' : ''} />
                <span>${icon('leaf')} 开启智能静音降费门禁 (Voice Activity Gating + 自动 Finalize)</span>
              </label>
              <div class="setting-tip">检测到停顿后发送 <code>finalize</code> 并暂停静音音频，保留约 500ms 的预卷缓冲。</div>
            </div>
            <div class="setting-group">
              <label>静音门禁灵敏度阈值 (VAD Threshold)</label>
              <input type="number" id="cfgVadThreshold" step="0.1" min="0.8" max="15.0" value="${config.soniox.vad_threshold ?? 1.8}" />
              <div class="setting-tip">默认 1.8；底噪较大时可调高至 2.5~4.0，远场小声说话可降至 1.0~1.5。</div>
            </div>
          </div>

          <div class="setting-group">
            <label>当前会议主题与背景语境 (Meeting Context)</label>
            <input type="text" id="cfgMeetingContext" value="${escapeHtml(config.meeting?.context || '')}" placeholder="如：跨国远程团队日常同步与架构评审周会" />
            <div class="setting-tip">注入给 Soniox 声学上下文与 LLM 智囊，显著提升专业术语识别、指代消解与口语提词的贴合度。</div>
          </div>

          <div class="setting-group">
            <label>会议专业术语 &amp; 专有译名库 (Context &amp; Translation Terms)</label>
            <textarea id="cfgCustomTerms" rows="2" placeholder="支持单个术语或 原文=译文 映射，如：Soniox, Kubernetes, ODS=运营数据存储, ARR=年度经常性收入">${escapeHtml(customTermsStr)}</textarea>
            <div class="setting-tip">同时注入 Soniox <code>terms</code> 声学偏置与 <code>translation_terms</code> 专有译名映射。</div>
          </div>

          <div class="setting-group">
            <label>AI 智囊 API Key (OpenRouter / OpenAI 兼容)</label>
            <input type="password" id="cfgOpenRouterApiKey" value="${escapeHtml(config.openrouter.api_key)}" placeholder="sk-..." />
          </div>

          <div class="setting-group">
            <label>AI 智囊接口地址 (Base URL)</label>
            <input type="text" id="cfgOpenRouterBaseUrl" value="${escapeHtml(config.openrouter.base_url)}" />
          </div>

          <div class="setting-group">
            <label>AI 智囊统一模型 (Model)</label>
            <input type="text" id="cfgOpenRouterModel" value="${escapeHtml(config.openrouter.translate_model || 'deepseek/deepseek-chat')}" placeholder="deepseek/deepseek-chat" />
            <div class="setting-tip">推荐配置低延迟模型 (如 deepseek/deepseek-chat 或 gpt-4o-mini)，保存后将同步应用于 AI 翻译、上下文润色、Jev 问句检测与应答建议生成。</div>
          </div>

          <div class="setting-group">
            <label class="checkbox-label">
              <input type="checkbox" id="cfgEnablePolish" ${config.openrouter?.enable_polish !== false ? 'checked' : ''} />
              <span>${icon('sparkles')} 开启 AI 实时同传段落润色串联</span>
            </label>
            <div class="setting-tip">同一人连续发言沉淀后，后台结合上下文整理原文并重新翻译；可能产生额外费用。</div>
          </div>

          <div class="setting-group">
            <label class="checkbox-label">
              <input type="checkbox" id="cfgAutoPredict" ${config.meeting?.auto_predict !== false ? 'checked' : ''} />
              <span>${icon('bulb')} 对方提问时自动弹出 AI 应答建议 (Jev 问句检测门禁)</span>
            </label>
            <div class="setting-tip">自动过滤「我自己」的发言，仅当他人向你提问或确认排期时非阻塞生成 3 条回应策略。</div>
          </div>

          <div class="setting-group">
            <label>会议纪要自动归档 (Auto-Save on Meeting End)</label>
            <label class="checkbox-label">
              <input type="checkbox" id="cfgAutoSave" ${config.storage?.auto_save !== false ? 'checked' : ''} />
              <span>${icon('download')} 会议同传结束后自动将内容保存为文本纪要</span>
            </label>
            <div class="setting-tip">每次停止同传时，系统会自动将全场发言与双语同传以时间戳为文件名静默保存。</div>
          </div>

          <div class="setting-group">
            <label>纪要保存目录 (Configurable Directory)</label>
            <div class="input-with-button">
              <input type="text" id="cfgSaveDir" value="${escapeHtml(config.storage?.save_dir || '~/Documents/livehear')}" placeholder="~/Documents/livehear" />
              <button class="btn-subtle" onclick="window.__livehear_action('openSaveDir')">${icon('download')} 打开目录</button>
            </div>
            <div class="setting-tip">默认存放到 <code>~/Documents/livehear</code>，若目录不存在将自动创建。支持 <code>~</code> 展开。</div>
          </div>

          <div class="setting-group">
            <label>文件保存格式</label>
            <div class="radio-pill-group">
              <label class="radio-pill ${(config.storage?.file_format || 'txt') === 'txt' ? 'active' : ''}">
                <input type="radio" name="cfgFileFormat" value="txt" ${(config.storage?.file_format || 'txt') === 'txt' ? 'checked' : ''} />
                <span>${icon('notes')} 纯文本 (.txt) - 适合备忘速查与全平台阅读</span>
              </label>
              <label class="radio-pill ${config.storage?.file_format === 'md' ? 'active' : ''}">
                <input type="radio" name="cfgFileFormat" value="md" ${config.storage?.file_format === 'md' ? 'checked' : ''} />
                <span>${icon('notes')} Markdown (.md) - 带结构化对照表格与提炼</span>
              </label>
            </div>
          </div>

          <div class="setting-group">
            <label for="cfgInputDevice">音频源与硬件诊断</label>
            <div class="mic-diag-card">
              <div class="setting-group" style="margin-bottom: 6px;">
                <select id="cfgInputDevice">
                  <option value="" ${usingDefaultInput ? 'selected' : ''}>系统默认输入设备</option>
                  ${!usingDefaultInput && !selectedIsListed
                    ? `<option value="${escapeHtml(selectedDevice)}" selected>上次选择的音频源（未列出）</option>`
                    : ''}
                  ${inputDevices
                    .map(
                      (dev) => `
                    <option value="${escapeHtml(dev)}" ${config.soniox.input_device === dev ? 'selected' : ''}>
                      ${dev.toLowerCase().includes('blackhole') || dev.toLowerCase().includes('loopback') ? '[系统内录] ' : ''}${escapeHtml(dev)}
                    </option>
                  `
                    )
                    .join('')}
                  ${systemOutputs.length ? `
                    <optgroup label="Windows 系统声音">
                      ${systemOutputs.map(({ id, name }) => `
                        <option value="${escapeHtml(id)}" ${selectedDevice === id ? 'selected' : ''}>${escapeHtml(name)}</option>
                      `).join('')}
                    </optgroup>
                  ` : ''}
                </select>
                <div class="setting-tip">${systemOutputs.length
                  ? '听取会议远端声音时，请在「Windows 系统声音」下选择会议软件正在使用的扬声器或耳机。'
                  : '戴耳机开会时，可选择 BlackHole / Loopback 等虚拟输入设备来采集会议声音。'}</div>
              </div>
              ${usingSystemAudio ? '' : `
                <div class="mic-status-row">
                  <span>麦克风访问:</span>
                  <span class="${!state.hasMicPermission ? 'text-danger' : state.isStreaming ? 'text-success' : ''}">
                    ${!state.hasMicPermission ? '访问被拒绝' : state.isStreaming ? '采集流已打开' : '启动同传时检测'}
                  </span>
                </div>
              `}
              <div class="mic-status-row">
                <span>实时输入电平:</span>
                <span style="font-weight: 600; color: #38bdf8" id="diagVolumeText">${state.micVolume}%</span>
              </div>
              <div class="mic-meter-bar">
                <div class="mic-meter-fill" id="diagMeterFill" style="width: ${state.micVolume}%"></div>
              </div>
              ${usingSystemAudio ? '' : `
                <button class="btn-subtle" style="margin-top: 8px; width: 100%" onclick="window.__livehear_action('openMicPrivacySettings')">
                  ${icon('mic')} 打开麦克风隐私设置
                </button>
              `}
              <button class="btn-subtle" style="margin-top: 6px; width: 100%; border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;" onclick="window.__livehear_action('simulateSpeech')">
                ▶️ 测试模拟音频推流 (8.5秒英文语音，验证同传打字上屏)
              </button>
            </div>
          </div>

          <div class="setting-group">
            <label>全局快捷键</label>
            <div class="shortcuts-guide-card">
              <div class="shortcut-item"><span>${formatShortcut('⌘ + K')}</span><span>一键唤起「帮我接话」发言提词 / 浓缩前文</span></div>
              <div class="shortcut-item"><span>${formatShortcut('⌘ + Shift + H')}</span><span>投屏隐身防录屏模式 (共享桌面时隐藏此窗)</span></div>
              <div class="shortcut-item"><span>${formatShortcut('⌘ + Shift + X')}</span><span>开启 / 关闭鼠标穿透幽灵模式</span></div>
              <div class="shortcut-item"><span>${formatShortcut('⌘ + Shift + P')}</span><span>窗口置顶固定 / 取消置顶</span></div>
              <div class="shortcut-item"><span>${formatShortcut('⌘ + Shift + C')}</span><span>一键清空当前字幕流</span></div>
              <div class="shortcut-item"><span>${formatShortcut('⌘ + Shift + E')}</span><span>一键导出 AI 结构化会议纪要</span></div>
              <div class="shortcut-item"><span>${formatShortcut('⌘ + 1 / 2 / 3')}</span><span>快速复制第 1 / 2 / 3 条提词或回复</span></div>
            </div>
          </div>
        </div>

        <div class="settings-footer">
          <button class="btn-secondary no-drag" onclick="window.__livehear_action('toggleSettings')">取消</button>
          <button class="btn-primary no-drag" onclick="window.__livehear_action('saveAllConfig')">保存配置</button>
        </div>
      </div>
    </div>
  `;
}

function getSpeakerClass(item: SubtitleItem): string {
  if (!item.isTrackRemote) return 'speaker-me';
  const spk = String(item.speaker || '').toLowerCase();
  if (spk.includes('1') || spk.includes('speaker 1')) return 'speaker-1';
  if (spk.includes('2') || spk.includes('speaker 2')) return 'speaker-2';
  if (spk.includes('3') || spk.includes('speaker 3')) return 'speaker-3';
  return 'speaker-4';
}

function isMainlyChinese(str: string): boolean {
  if (!str) return false;
  let zhCount = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      zhCount++;
    }
  }
  return zhCount / Math.max(1, str.length) > 0.4;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJs(str: string): string {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
