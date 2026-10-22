// 会议实时双语字幕与智能推测 HUD 视图组件 (Live Meeting HUD)
import type { FullAppConfig } from './studio';

export interface SubtitleItem {
  id: string;
  speaker: string; // e.g., "Speaker 1", "Me (Mic)"
  speakerId?: number; // 1, 2, 3...
  isTrackRemote: boolean;
  original: string;
  translated: string;
  timestamp: string;
  isPartial?: boolean;
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
              <span class="bar bar-1" style="height: ${Math.max(4, Math.min(18, state.micVolume * 0.35))}px"></span>
              <span class="bar bar-2" style="height: ${Math.max(6, Math.min(22, state.micVolume * 0.5))}px"></span>
              <span class="bar bar-3" style="height: ${Math.max(4, Math.min(16, state.micVolume * 0.3))}px"></span>
              <span class="bar bar-4" style="height: ${Math.max(6, Math.min(20, state.micVolume * 0.45))}px"></span>
            </div>
          `
          }

          <!-- 语种模式指示徽章 -->
          <div class="lang-auto-badge" title="Soniox v5 引擎自动侦测 60+ 语种并实时同传至目标语种">
            <span class="globe-icon">🌐</span>
            <span>全语种自适应 ➔ 中文</span>
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
            仅译文
          </button>
          <button class="mode-btn ${state.displayMode === 'source_only' ? 'active' : ''}" 
                  id="modeBtnSource"
                  title="仅显示外语原声识别"
                  onclick="window.__livehear_action('setSubtitleMode', 'source_only')">
            仅原文
          </button>
        </div>

        <!-- 右侧状态徽章与快捷工具 -->
        <div class="hud-badges no-drag">
          <span class="latency-badge" title="Soniox 原生流式同传极速延时">
            ⚡ Soniox v5
          </span>

          <button class="icon-btn no-drag" 
                  title="一键导出为会议速记 Markdown 纪要"
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

      <!-- 实时双语字幕流列表 (支持在发言进行中随时鼠标划词复制) -->
      <div class="subtitles-stream selectable-text" id="subtitlesStream">
        ${
          state.subtitles.length === 0
            ? renderEmptyPlaceholder(state.isStreaming, state.hasMicPermission)
            : state.subtitles.map((item) => renderSubtitleCardHtml(item, state.displayMode)).join('')
        }
      </div>

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

export function renderSubtitleCardHtml(item: SubtitleItem, displayMode: SubtitleDisplayMode): string {
  const speakerClass = getSpeakerClass(item);
  return `
    <div class="subtitle-card selectable-text ${item.isPartial ? 'is-partial' : ''}" data-id="${escapeHtml(item.id)}">
      <div class="subtitle-header">
        <span class="speaker-pill ${speakerClass}">
          ${item.isTrackRemote ? '👤' : '🎙️'} ${escapeHtml(item.speaker)}
        </span>
        <span class="timestamp-pill">${item.timestamp}</span>
        <div class="line-actions no-drag">
          <button class="mini-copy-btn" title="复制此句译文" 
                  onclick="window.__livehear_action('copyText', '${escapeJs(item.translated || item.original)}')">
            📋
          </button>
        </div>
      </div>

      <!-- 译文：核心主视觉 (加粗、高对比度、清晰阅读) -->
      ${
        displayMode !== 'source_only'
          ? `
        <div class="speech-target" title="实时流式同传译文">
          <span>${escapeHtml(item.translated || '正在同传中...')}</span>
          ${item.isPartial ? '<span class="streaming-pulse-cursor"></span>' : ''}
        </div>
      `
          : ''
      }

      <!-- 原文：辅视觉参考 (轻盈、便于对齐术语与原句) -->
      ${
        displayMode !== 'target_only'
          ? `
        <div class="speech-source" title="语音识别原声">
          <span class="quote-symbol">“</span>
          <span class="source-content">${escapeHtml(item.original || '...')}</span>
          <span class="quote-symbol">”</span>
        </div>
      `
          : ''
      }
    </div>
  `;
}

export function renderSuggestionsHtml(suggestions: SuggestionItem[], intentCategory?: string): string {
  return `
    <div class="predict-drawer">
      <div class="predict-header">
        <div class="predict-title">
          <span class="glow-bulb">💡</span>
          <span class="title-text">智能会议应答建议</span>
          <span class="jev-badge">${escapeHtml(intentCategory || '排期问询')}</span>
        </div>
        <span class="shortcut-tip">按快捷键一键复制回答</span>
      </div>

      <div class="suggestions-list">
        ${suggestions
          .map(
            (sug) => `
          <div class="suggestion-card no-drag" onclick="window.__livehear_action('copySuggestion', ${sug.id})">
            <div class="suggestion-meta">
              <span class="strategy-badge">${escapeHtml(sug.title)}</span>
              <span class="shortcut-tag">${sug.shortcut}</span>
            </div>
            <div class="suggestion-detail">${escapeHtml(sug.detail)}</div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

export function renderSettingsModalHtml(config: FullAppConfig, state: HudState): string {
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
            <div class="setting-tip">Soniox v5 引擎支持原生全语种自动侦测，无须手动限制语言；已开启说话人声纹识别与端点自动断句。</div>
          </div>

          <div class="setting-group">
            <label>同传目标语言</label>
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
            <label>本地 AI 智囊 / OpenAI 配置 (用于问句应答推测)</label>
            <input type="text" id="cfgOpenRouterBaseUrl" value="${escapeHtml(config.openrouter.base_url)}" />
            <div class="setting-tip">已连通本地 Pi OpenAI: ${escapeHtml(config.openrouter.translate_model)}</div>
          </div>

          <div class="setting-group">
            <label>麦克风硬件诊断</label>
            <div class="mic-diag-card">
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
              <div class="shortcut-item"><span>⌘ + Shift + P</span><span>窗口置顶固定 / 取消置顶</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + C</span><span>一键清空当前字幕流</span></div>
              <div class="shortcut-item"><span>⌘ + Shift + E</span><span>一键导出会议 Markdown 纪要</span></div>
              <div class="shortcut-item"><span>⌘ + 1 / 2 / 3</span><span>快速复制第 1 / 2 / 3 条策略回复</span></div>
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
  const spk = item.speaker.toLowerCase();
  if (spk.includes('1') || spk.includes('speaker 1')) return 'speaker-1';
  if (spk.includes('2') || spk.includes('speaker 2')) return 'speaker-2';
  if (spk.includes('3') || spk.includes('speaker 3')) return 'speaker-3';
  return 'speaker-4';
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
