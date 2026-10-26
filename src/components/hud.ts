// 会议实时双语同传与智能推测 HUD 视图组件 (Live Meeting HUD)
import type { FullAppConfig } from '../types/domain';

export interface SubtitleItem {
  id: string;
  speaker: string; // e.g., "Speaker 1", "Me (Mic)"
  speakerId?: number; // 1, 2, 3...
  isTrackRemote: boolean;
  original: string;
  translated: string;
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
  audioDevices?: string[];
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
  const strictIcon = config?.soniox?.language_hints_strict !== false ? '🔒' : '';
  const targetCode = config?.soniox?.target_language || 'zh';
  const targetName = TARGET_LANG_NAMES[targetCode] || targetCode.toUpperCase();
  if (!isOneWay) {
    return `中 ⇄ 英 双向 (${hints}${strictIcon}) ▾`;
  }
  return `[${hints}${strictIcon}] ➔ ${targetName} ▾`;
}

export function renderHudView(
  state: HudState,
  config?: FullAppConfig,
  _onAction?: (action: string, payload?: any) => void
): string {
  const isMicHealthy = state.hasMicPermission && state.micVolume > 0;

  return `
    <div class="hud-window ${state.isClickThrough ? 'is-click-through' : ''}" data-tauri-drag-region>
      <!-- 顶部轻量拖拽把手区 (按住可自由拖动浮窗) -->
      <div class="drag-handle-pill" data-tauri-drag-region title="按住拖拽移动 HUD 浮窗"></div>

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
          ${
            !state.hasMicPermission
              ? `
            <button class="permission-pill no-drag warning" 
                    id="btnRequestMic"
                    title="点击授权麦克风权限"
                    onclick="window.__livehear_action('requestMicPermission')">
              ⚠️ 麦克风未授权 (点击授权)
            </button>
          `
              : `
            <div class="track-indicator ${isMicHealthy ? 'active' : ''}" 
                 id="micIndicator"
                 title="麦克风实时输入音量: ${state.micVolume}%">
              <span class="track-dot ${state.micVolume > 3 ? 'pulse-green' : 'active'}"></span>
              <span id="micVolumeText">麦克风: ${state.micVolume}%</span>
            </div>
            <div class="wave-visualizer ${state.micVolume > 3 ? 'animating' : ''}" id="micWaveVisualizer" title="输入音量: ${state.micVolume}%">
              <span class="bar bar-1"></span>
              <span class="bar bar-2"></span>
              <span class="bar bar-3"></span>
              <span class="bar bar-4"></span>
            </div>
          `
          }

          <!-- 语种范围与目标语言快捷切换胶囊 (点击弹出快捷面板) -->
          <button class="lang-auto-badge no-drag interactive-lang-pill"
                  id="btnQuickLangPill"
                  title="点击快速切换收听语种范围 (Language Hints) 与目标翻译语言"
                  onclick="window.__livehear_action('toggleQuickLangPopover')">
            <span class="globe-icon">🌐</span>
            <span id="topbarLangBadgeText">${escapeHtml(formatTopbarLangBadgeText(config))}</span>
          </button>

          <!-- 智能 VAD 节费状态微标 -->
          <div class="vad-eco-badge" title="智能静音降费门禁已激活：静音时不推流扣费，节省 60-70% Token 支出">
            <span class="eco-leaf">🌱</span>
            <span>静音降费</span>
          </div>
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
          <!-- 实时流式同传延时指示 (由后端 soniox-latency 实时驱动) -->
          <span class="latency-badge" id="hudLatencyBadge" title="Soniox 端到端流式往返极速延时">
            ⚡ ${state.sonioxLatencyMs || 64}ms
          </span>

          <!-- 一键发言提词 / 帮我接话按钮 -->
          <button class="copilot-trigger-pill no-drag ${state.hasPredictSuggestion ? 'active' : ''}"
                  id="btnOpenCopilot"
                  title="根据上文快速生成我方发言提词与回应建议 (快捷键: ⌘+K)"
                  onclick="window.__livehear_action('openCopilotDrawer')">
            <span>💡</span>
            <span>帮我接话</span>
          </button>

          <!-- 投屏隐身防录屏模式 (Stealth Mode) -->
          <button class="icon-btn no-drag ${state.isStealthMode ? 'active stealth-active' : ''}"
                  id="btnToggleStealth"
                  title="${state.isStealthMode ? '投屏隐身已开启：共享屏幕/截图时此窗口完全隐形 (⌘+Shift+H)' : '点击开启投屏隐身：Zoom/腾讯会议/飞书共享屏幕时隐藏此浮窗 (⌘+Shift+H)'}"
                  onclick="window.__livehear_action('toggleStealthMode')">
            🕶️
          </button>

          <!-- 鼠标穿透模式 (Click-Through) -->
          <button class="icon-btn no-drag ${state.isClickThrough ? 'active' : ''}"
                  id="btnToggleClickThrough"
                  title="${state.isClickThrough ? '鼠标穿透已开启 (按 ⌘+Shift+X 恢复点击)' : '点击开启鼠标穿透：不遮挡底层软件点击 (⌘+Shift+X)'}"
                  onclick="window.__livehear_action('toggleClickThrough')">
            👻
          </button>

          <button class="icon-btn no-drag" 
                  title="一键导出为会议速记 Markdown 纪要 (自动附带 AI 决议与待办提炼)"
                  onclick="window.__livehear_action('exportTranscript')">
            📥
          </button>

          <button class="icon-btn no-drag ${state.isAlwaysOnTop ? 'active' : ''}" 
                  id="btnTogglePin"
                  title="${state.isAlwaysOnTop ? '窗口已置顶固定' : '点击开启置顶'}"
                  onclick="window.__livehear_action('toggleTopmost')">
            📌
          </button>

          <button class="icon-btn no-drag" title="清空当前字幕列表" onclick="window.__livehear_action('clearSubtitles')">
            🗑️
          </button>

          <button class="icon-btn no-drag ${state.isSettingsOpen ? 'active' : ''}" 
                  id="btnToggleSettings"
                  title="配置中心 (Soniox API Key / AI 智囊 / 语言)" 
                  onclick="window.__livehear_action('toggleSettings')">
            ⚙️
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
            : state.subtitles.map((item) => renderSubtitleTurnHtml(item, state.displayMode)).join('')
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
        <span class="placeholder-emoji">${!hasPermission ? '🎙️' : isStreaming ? '🗣️' : '⏸️'}</span>
      </div>
      <div class="placeholder-title">
        ${
          !hasPermission
            ? '需要麦克风访问权限'
            : isStreaming
            ? '系统已就绪，正在实时收音中...'
            : '实时同传已暂停'
        }
      </div>
      <div class="placeholder-desc">
        ${
          !hasPermission
            ? 'LiveHear 需要麦克风权限来捕获实时发言并完成同传翻译。点击下方按钮授予授权：'
            : isStreaming
            ? '请开始说话（无需指定语言，Soniox 会自动识别全语种及说话人声纹，并在毫秒级流式打字上屏）。'
            : '点击顶部「开始同传」按钮以开启系统声音与麦克风采集。'
        }
      </div>
      ${
        !hasPermission
          ? `
        <button class="btn-primary no-drag start-cta-btn" onclick="window.__livehear_action('requestMicPermission')">
          🎙️ 立即请求 macOS 麦克风授权
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

// 连贯自然流式对话项 (支持同发言人连续语句紧凑时间轴分组、已确认词与临时词分层渲染)
export function renderSubtitleTurnHtml(item: SubtitleItem, displayMode: SubtitleDisplayMode): string {
  const speakerClass = getSpeakerClass(item);
  const origTrim = (item.original || '').trim();
  const transTrim = (item.translated || '').trim();
  const textLang = detectTextLanguage(origTrim);
  const transLang = detectTextLanguage(transTrim);

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
  // 若开启了双向互译（中文原声 -> 英文译文），则完整展示双语对照！
  const hasForeignTranslation =
    Boolean(transTrim) &&
    transTrim !== '正在同传中...' &&
    transTrim !== origTrim &&
    transLang !== null &&
    transLang !== 'zh';
  const isNativeZh = isChineseSpeech && !hasForeignTranslation;

  // 复制内容：默认优先复制最清晰的译文，若为纯中文直接复制原文
  const copyContent = isNativeZh ? (origTrim || transTrim) : (transTrim || origTrim);

  let langLabel = '';
  if (isNativeZh) {
    langLabel = '中文原声';
  } else if (isChineseSpeech && hasForeignTranslation) {
    langLabel = `中文 ➔ ${(transLang || 'EN').toUpperCase()}`;
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

  return `
    <div class="stream-turn-block selectable-text ${item.isPartial ? 'is-partial' : ''} ${isCont ? 'is-continuation' : ''}" data-id="${escapeHtml(item.id)}" data-speaker="${escapeHtml(item.speaker)}">
      <!-- 左侧发言人指示条与时间轴轴线 -->
      <div class="turn-gutter">
        ${
          isCont
            ? `<div class="turn-continuation-dot ${speakerClass}" title="${escapeHtml(item.speaker)} · ${item.timestamp}"></div>`
            : `
          <div class="turn-speaker-avatar ${speakerClass}">
            <span class="avatar-icon">${item.isTrackRemote ? '👤' : '🎙️'}</span>
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
            ${item.toneTag ? `<span class="turn-tone-tag">${escapeHtml(item.toneTag)}</span>` : ''}
            <div class="turn-actions-group">
              <button class="turn-reply-action no-drag"
                      title="针对这句话生成我方接话提词"
                      onclick="window.__livehear_action('promptReplyForTurn', '${escapeJs(item.id)}')">
                <span>💬</span>
                <span>接话</span>
              </button>
              <button class="turn-copy-action no-drag" 
                      title="点击复制此句内容"
                      onclick="window.__livehear_action('copyText', '${escapeJs(copyContent)}', this)">
                <span class="copy-icon">📋</span>
                <span class="copy-label">复制</span>
              </button>
            </div>
          </div>
        `
            : `
          <div class="turn-meta">
            <span class="turn-speaker-name ${speakerClass}">${escapeHtml(item.speaker)}</span>
            <span class="turn-time">${item.timestamp}</span>
            ${langLabel ? `<span class="turn-lang-tag">${escapeHtml(langLabel)}</span>` : ''}
            ${item.toneTag ? `<span class="turn-tone-tag">${escapeHtml(item.toneTag)}</span>` : ''}

            <div class="turn-actions-group">
              <button class="turn-reply-action no-drag"
                      title="针对这句话生成我方接话提词"
                      onclick="window.__livehear_action('promptReplyForTurn', '${escapeJs(item.id)}')">
                <span>💬</span>
                <span>接话</span>
              </button>
              <button class="turn-copy-action no-drag" 
                      title="点击复制此句内容"
                      onclick="window.__livehear_action('copyText', '${escapeJs(copyContent)}', this)">
                <span class="copy-icon">📋</span>
                <span class="copy-label">复制</span>
              </button>
            </div>
          </div>
        `
        }

        <!-- 文本流内容区：显式清晰标注 [同传] 与 [原声] -->
        <div class="turn-body">
          ${renderTurnTextLines(item, displayMode, isNativeZh, detected)}
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
  const badgeTitle = item.isPolished ? 'OpenAI DeepSeek AI 智能串联润色' : 'Soniox 实时流式同传译文';
  const badgeText = item.isPolished ? '同传 · 润色' : '同传';
  const fallbackTrans = item.translated || (item.isPartial ? '正在同传中...' : item.original);
  const transBody =
    item.isPartial && (item.confirmedTranslated || item.provisionalTranslated)
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
          <span class="glow-bulb">💡</span>
          <span class="title-text">实时发言提词 &amp; 应答智囊</span>
          <span class="jev-badge">${escapeHtml(intentCategory || '结合上文提词')}</span>
        </div>
        <div class="predict-header-actions">
          <button class="copilot-mini-btn tldr-btn no-drag" title="走神救星：3秒浓缩过去几分钟的讨论焦点、共识与待拍板事项" onclick="window.__livehear_action('summarizeRecentContext')">
            📝 浓缩前文
          </button>
          <button class="copilot-mini-btn no-drag" title="结合最新上下文重新生成 3 条英文接话提词" onclick="window.__livehear_action('refreshCopilotPrompts')">
            🔄 换批提词
          </button>
          <button class="copilot-close-btn no-drag" title="收起提词面板" onclick="window.__livehear_action('closeCopilotDrawer')">
            ✕
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
          ✨ 生成发言词
        </button>
        <button class="copilot-note-btn no-drag" title="将输入框内容作为带时间戳的个人备忘插入字幕流，并在会后合并进 AI 纪要" onclick="window.__livehear_action('insertQuickNote')">
          📌 记笔记
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
                <span class="shortcut-tag">${sug.shortcut} · 点击复制英文</span>
              </div>
              <div class="suggestion-detail">${escapeHtml(mainText)}</div>
              ${subNote ? `<div class="suggestion-subnote">💬 ${escapeHtml(subNote)}</div>` : ''}
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

export function renderQuickLangPopoverHtml(config: FullAppConfig): string {
  const isOneWay = config.soniox.translation_type !== 'two_way';
  const hintsStr = (config.soniox.language_hints || ['en', 'zh']).join(', ');
  const isStrict = config.soniox.language_hints_strict !== false;
  const targetLang = config.soniox.target_language || 'zh';

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

  return `
    <div class="quick-lang-popover no-drag" id="quickLangPopover">
      <div class="ql-header">
        <span class="ql-title">🎯 识别语种范围 &amp; 目标翻译语言快捷切换</span>
        <button class="ql-close" onclick="window.__livehear_action('toggleQuickLangPopover')">✕</button>
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
          <label class="ql-strict-toggle" title="开启后 Soniox 仅在上方指定语种内解码，彻底杜绝乱码">
            <input type="checkbox" id="quickStrictCheckbox" ${isStrict ? 'checked' : ''} />
            <span>🔒 严格锁定</span>
          </label>
        </div>
      </div>

      <div class="ql-section">
        <div class="ql-label">2. 同传方向与目标语言 (Target Language)</div>
        <div class="ql-mode-row">
          <button class="ql-mode-btn ${isOneWay ? 'active' : ''}"
                  onclick="window.__livehear_action('quickSetTransMode', 'one_way')">
            🌐 单向同传 (外语 ➔ 目标语)
          </button>
          <button class="ql-mode-btn ${!isOneWay ? 'active' : ''}"
                  onclick="window.__livehear_action('quickSetTransMode', 'two_way')">
            🔄 中 ⇄ 英 双向互译
          </button>
        </div>
        ${
          isOneWay
            ? `
          <div class="ql-target-chips">
            ${targets
              .map(
                (t) => `
              <button class="ql-target-chip ${targetLang === t.code ? 'active' : ''}"
                      onclick="window.__livehear_action('quickSetTargetLang', '${t.code}')">
                ${escapeHtml(t.label)} (${t.code})
              </button>
            `
              )
              .join('')}
          </div>
        `
            : ''
        }
      </div>

      <div class="ql-footer">
        <span class="ql-tip">修改后点击右侧按钮即刻热重载语音流</span>
        <button class="btn-primary ql-apply-btn" onclick="window.__livehear_action('applyQuickLangConfig')">
          ⚡ 立即应用并热切
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
        <button class="slp-close" onclick="window.__livehear_action('closeSelectionLookup')">✕</button>
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
            ? `<div class="slp-context">💡 语境解读：${escapeHtml(data.context_explanation)}</div>`
            : ''
        }
        <div class="slp-actions">
          <button class="slp-btn" onclick="window.__livehear_action('copyText', '${escapeJs(data.meaning)}')">
            📋 复制释义
          </button>
          ${
            data.term_pair
              ? `
            <button class="slp-btn primary" onclick="window.__livehear_action('addTermFromLookup', '${escapeJs(data.term_pair)}')">
              ➕ 加入术语表 (${escapeHtml(data.term_pair)})
            </button>
          `
              : `
            <button class="slp-btn primary" onclick="window.__livehear_action('addTermFromLookup', '${escapeJs(`${data.text}=${data.meaning}`)}')">
              ➕ 加入术语库
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

  return `
    <div class="settings-overlay no-drag" id="settingsOverlay" onclick="if(event.target === this) window.__livehear_action('toggleSettings')">
      <div class="settings-modal no-drag">
        <div class="settings-header">
          <div class="settings-title">
            <span>⚙️</span>
            <h3>LiveHear 会议同传控制中心</h3>
          </div>
          <button class="close-modal-btn no-drag" onclick="window.__livehear_action('toggleSettings')">✕</button>
        </div>

        <div class="settings-body">
          <div class="setting-group">
            <label>Soniox API Key (项目专有密钥)</label>
            <div class="input-with-button">
              <input type="password" id="cfgSonioxApiKey" value="${escapeHtml(config.soniox.api_key)}" placeholder="snx_proj_..." />
              <button class="btn-subtle" onclick="window.__livehear_action('testSonioxConnection')">⚡ 测试连通</button>
            </div>
            <div class="setting-tip">基于 Soniox stt-rt-v5 极速流式引擎，支持原生声纹说话人分离与低至 60ms 同传打字上屏。</div>
          </div>

          <div class="setting-group">
            <label>同传工作模式</label>
            <div class="radio-pill-group">
              <label class="radio-pill ${isOneWay ? 'active' : ''}">
                <input type="radio" name="cfgTranslationType" value="one_way" ${isOneWay ? 'checked' : ''} />
                <span>🌐 涉外会议单向同传 (推荐)</span>
              </label>
              <label class="radio-pill ${!isOneWay ? 'active' : ''}">
                <input type="radio" name="cfgTranslationType" value="two_way" ${!isOneWay ? 'checked' : ''} />
                <span>🔄 跨国双向对话互译 (中英互译)</span>
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
              <label>目标同传语言</label>
              <select id="cfgSonioxTargetLang">
                <option value="zh" ${config.soniox.target_language === 'zh' ? 'selected' : ''}>中文 (简体)</option>
                <option value="en" ${config.soniox.target_language === 'en' ? 'selected' : ''}>English (英语)</option>
                <option value="ja" ${config.soniox.target_language === 'ja' ? 'selected' : ''}>日本語 (日语)</option>
                <option value="fr" ${config.soniox.target_language === 'fr' ? 'selected' : ''}>Français (法语)</option>
                <option value="de" ${config.soniox.target_language === 'de' ? 'selected' : ''}>Deutsch (德语)</option>
                <option value="es" ${config.soniox.target_language === 'es' ? 'selected' : ''}>Español (西班牙语)</option>
              </select>
            </div>

            <div class="setting-group">
              <label>预期语种提示 (Language Hints)</label>
              <input type="text" id="cfgLanguageHints" value="${escapeHtml(hintsStr)}" placeholder="en, zh" />
              <label class="checkbox-label" style="margin-top: 6px;">
                <input type="checkbox" id="cfgLanguageHintsStrict" ${config.soniox.language_hints_strict !== false ? 'checked' : ''} />
                <span>🔒 严格锁定上述语种 (Strict Mode · 杜绝跨语种乱码)</span>
              </label>
            </div>
          </div>

          <div class="setting-row-2col">
            <div class="setting-group">
              <label>多人会议断句窗口 (Endpoint Delay)</label>
              <select id="cfgEndpointDelay">
                <option value="1500" ${(config.soniox.max_endpoint_delay_ms || 2000) <= 1600 ? 'selected' : ''}>⚡ 紧凑对话 (1500ms · 快节奏问答)</option>
                <option value="2000" ${(config.soniox.max_endpoint_delay_ms || 2000) > 1600 && (config.soniox.max_endpoint_delay_ms || 2000) <= 2300 ? 'selected' : ''}>🎯 多人会议标准 (2000ms · 语义最准，推荐)</option>
                <option value="2600" ${(config.soniox.max_endpoint_delay_ms || 2000) > 2300 ? 'selected' : ''}>🎙️ 深度长句讨论 (2600ms · 复杂从句最稳)</option>
              </select>
              <div class="setting-tip">留足上下文窗口供 Soniox 完整理解长句语义与声纹，消除半句切碎与直译错误。</div>
            </div>

            <div class="setting-group">
              <label>多说话人声纹分离 (Diarization)</label>
              <label class="checkbox-label" style="margin-top: 6px;">
                <input type="checkbox" id="cfgSpeakerDiarization" ${config.soniox.enable_speaker_diarization !== false ? 'checked' : ''} />
                <span>👥 自动区分 Speaker 1 / 2 / 3</span>
              </label>
              <div class="setting-tip">仅由终态确认词驱动换人，免疫临时词声纹抖动。</div>
            </div>
          </div>

          <div class="setting-group">
            <label class="checkbox-label">
              <input type="checkbox" id="cfgEnableVad" ${config.soniox.enable_vad !== false ? 'checked' : ''} />
              <span>🌱 开启智能静音降费门禁 (Voice Activity Gating + 自动 Finalize)</span>
            </label>
            <div class="setting-tip">停顿 &gt;1.2s 自动向 Soniox 发送 <code>finalize</code> 锁定尾句并暂停静音推流，内置 300ms 预卷缓冲与 8s Keepalive 保活。</div>
          </div>

          <div class="setting-group">
            <label>会议专业术语 &amp; 专有译名库 (Context &amp; Translation Terms)</label>
            <textarea id="cfgCustomTerms" rows="2" placeholder="支持单个术语或 原文=译文 映射，如：Soniox, Kubernetes, ODS=运营数据存储, ARR=年度经常性收入">${escapeHtml(customTermsStr)}</textarea>
            <div class="setting-tip">同时注入 Soniox <code>terms</code> 声学偏置与 <code>translation_terms</code> 专有译名映射。</div>
          </div>

          <div class="setting-group">
            <label>AI 智囊 / OpenAI API Key</label>
            <input type="password" id="cfgOpenRouterApiKey" value="${escapeHtml(config.openrouter.api_key)}" placeholder="sk-..." />
          </div>

          <div class="setting-group">
            <label>AI 智囊 / OpenAI 接口地址 (Base URL)</label>
            <input type="text" id="cfgOpenRouterBaseUrl" value="${escapeHtml(config.openrouter.base_url)}" />
          </div>

          <div class="setting-group">
            <label>AI 同传润色与串联模型 (Model)</label>
            <input type="text" id="cfgOpenRouterModel" value="${escapeHtml(config.openrouter.translate_model || 'deepseek/deepseek-chat')}" placeholder="deepseek/deepseek-chat" />
            <div class="setting-tip">推荐配置 DeepSeek Chat (如 gpt-4o-mini 等版本)，极速执行同一发言人多句合并后的自然润色与口语去重。</div>
          </div>

          <div class="setting-group">
            <label class="checkbox-label">
              <input type="checkbox" id="cfgEnablePolish" ${config.openrouter?.enable_polish !== false ? 'checked' : ''} />
              <span>✨ 开启 OpenAI AI 实时同传段落润色串联 (DeepSeek Flash)</span>
            </label>
            <div class="setting-tip">同一人连续发言沉淀后，自动在后台消除口吃重复，将散碎短句重组成流利高级的技术中文。</div>
          </div>

          <div class="setting-group">
            <label>会议纪要自动归档 (Auto-Save on Meeting End)</label>
            <label class="checkbox-label">
              <input type="checkbox" id="cfgAutoSave" ${config.storage?.auto_save !== false ? 'checked' : ''} />
              <span>💾 会议同传结束后自动将内容保存为文本纪要</span>
            </label>
            <div class="setting-tip">每次停止同传时，系统会自动将全场发言与双语同传以时间戳为文件名静默保存。</div>
          </div>

          <div class="setting-group">
            <label>纪要保存目录 (Configurable Directory)</label>
            <div class="input-with-button">
              <input type="text" id="cfgSaveDir" value="${escapeHtml(config.storage?.save_dir || '~/Documents/livehear')}" placeholder="~/Documents/livehear" />
              <button class="btn-subtle" onclick="window.__livehear_action('openSaveDir')">📂 打开目录</button>
            </div>
            <div class="setting-tip">默认存放到 <code>~/Documents/livehear</code>，若目录不存在将自动创建。支持 <code>~</code> 展开。</div>
          </div>

          <div class="setting-group">
            <label>文件保存格式</label>
            <div class="radio-pill-group">
              <label class="radio-pill ${(config.storage?.file_format || 'txt') === 'txt' ? 'active' : ''}">
                <input type="radio" name="cfgFileFormat" value="txt" ${(config.storage?.file_format || 'txt') === 'txt' ? 'checked' : ''} />
                <span>📄 纯文本 (.txt) - 适合备忘速查与全平台阅读</span>
              </label>
              <label class="radio-pill ${config.storage?.file_format === 'md' ? 'active' : ''}">
                <input type="radio" name="cfgFileFormat" value="md" ${config.storage?.file_format === 'md' ? 'checked' : ''} />
                <span>📑 Markdown (.md) - 带结构化对照表格与提炼</span>
              </label>
            </div>
          </div>

          <div class="setting-group">
            <label>音频输入源与硬件诊断 (支持麦克风 / BlackHole 系统内录切换)</label>
            <div class="mic-diag-card">
              <div class="setting-group" style="margin-bottom: 6px;">
                <select id="cfgInputDevice">
                  <option value="" ${!config.soniox.input_device ? 'selected' : ''}>🎙️ 系统默认输入设备 (Default Input)</option>
                  ${(state.audioDevices || [])
                    .map(
                      (dev) => `
                    <option value="${escapeHtml(dev)}" ${config.soniox.input_device === dev ? 'selected' : ''}>
                      ${dev.toLowerCase().includes('blackhole') || dev.toLowerCase().includes('loopback') ? '🔊 [系统内录] ' : '🎤 '}${escapeHtml(dev)}
                    </option>
                  `
                    )
                    .join('')}
                </select>
                <div class="setting-tip">戴耳机开会时，可切换至 BlackHole / Loopback 等虚拟内录设备以直接捕获 100% 纯净系统原声。</div>
              </div>
              <div class="mic-status-row">
                <span>macOS 麦克风授权:</span>
                <span class="${state.hasMicPermission ? 'text-success' : 'text-danger'}">
                  ${state.hasMicPermission ? '✅ 已授权' : '❌ 未授权'}
                </span>
              </div>
              <div class="mic-status-row">
                <span>实时输入电平:</span>
                <span style="font-weight: 600; color: #38bdf8" id="diagVolumeText">${state.micVolume}%</span>
              </div>
              <div class="mic-meter-bar">
                <div class="mic-meter-fill" id="diagMeterFill" style="width: ${state.micVolume}%"></div>
              </div>
              <button class="btn-subtle" style="margin-top: 8px; width: 100%" onclick="window.__livehear_action('requestMicPermission')">
                🎙️ 重新请求/唤醒麦克风授权
              </button>
              <button class="btn-subtle" style="margin-top: 6px; width: 100%; border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;" onclick="window.__livehear_action('simulateSpeech')">
                ▶️ 测试模拟音频推流 (8.5秒英文语音，验证同传打字上屏)
              </button>
            </div>
          </div>

          <div class="setting-group">
            <label>全局快捷键</label>
            <div class="shortcuts-guide-card">
              <div class="shortcut-item"><span>⌘ + K</span><span>一键唤起「帮我接话」发言提词 / 浓缩前文</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + H</span><span>投屏隐身防录屏模式 (共享桌面时隐藏此窗)</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + X</span><span>开启 / 关闭鼠标穿透幽灵模式</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + P</span><span>窗口置顶固定 / 取消置顶</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + C</span><span>一键清空当前字幕流</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + E</span><span>一键导出 AI 结构化会议纪要</span></div>
              <div class="shortcut-item"><span>⌘ + 1 / 2 / 3</span><span>快速复制第 1 / 2 / 3 条提词或回复</span></div>
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
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}
