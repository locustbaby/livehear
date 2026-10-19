// 会议实时双语字幕与智能推测 HUD 视图组件 (Live Meeting HUD)
export interface SubtitleItem {
  id: string;
  speaker: string; // e.g., "John (Tech Lead)", "Me (Mic)"
  isTrackRemote: boolean;
  original: string;
  translated: string;
  timestamp: string;
}

export interface SuggestionItem {
  id: number;
  shortcut: string; // e.g., "Cmd+1" or "Alt+1"
  title: string;
  detail: string;
}

export interface HudState {
  isMicActive: boolean;
  isSpeakerActive: boolean;
  isClickThrough: boolean;
  isAlwaysOnTop: boolean;
  sonioxLatencyMs: number;
  subtitles: SubtitleItem[];
  hasPredictSuggestion: boolean;
  intentCategory?: string;
  suggestions: SuggestionItem[];
}

export function renderHudView(
  state: HudState,
  _onAction?: (action: string, payload?: any) => void
): string {
  return `
    <div class="hud-window ${state.isClickThrough ? 'is-click-through' : ''}" data-tauri-drag-region>
      <!-- 顶部专用轻量拖拽把手区 (避免与文本选中冲突) -->
      <div class="drag-handle-pill" data-tauri-drag-region title="按住拖动窗口位置"></div>

      <!-- HUD 顶栏状态与控制 -->
      <div class="hud-topbar" data-tauri-drag-region>
        <div class="hud-status-group">
          <div class="track-indicator">
            <span class="track-dot ${state.isSpeakerActive ? 'active' : ''}"></span>
            <span>扬声器 (对方)</span>
          </div>
          <div class="track-indicator">
            <span class="track-dot ${state.isMicActive ? 'active' : ''}"></span>
            <span>麦克风 (自己)</span>
          </div>
        </div>

        <div class="hud-badges">
          <span class="latency-badge">Soniox: ${state.sonioxLatencyMs}ms</span>
          
          <button class="icon-btn no-drag ${state.isClickThrough ? 'active' : ''}" 
                  title="${state.isClickThrough ? '鼠标穿透已开启 (按 ⌥+Shift+P 退出)' : '开启鼠标穿透 (点击穿透到底层会议)'}"
                  onclick="window.__livehear_action('toggleClickThrough')">
            👻
          </button>
          
          <button class="icon-btn no-drag ${state.isAlwaysOnTop ? 'active' : ''}" 
                  title="${state.isAlwaysOnTop ? '已置顶' : '取消置顶'}"
                  onclick="window.__livehear_action('toggleTopmost')">
            📌
          </button>

          <button class="icon-btn no-drag" title="缩小为迷你条" onclick="window.__livehear_action('toggleCompact')">
            ↕
          </button>
        </div>
      </div>

      <!-- 实时双语字幕流 (支持鼠标直接划词选中复制) -->
      <div class="subtitles-stream selectable-text" id="subtitlesStream">
        ${state.subtitles
          .map(
            (item) => `
          <div class="subtitle-line selectable-text">
            <div class="speaker-header">
              <span class="speaker-tag ${item.isTrackRemote ? 'remote' : 'me'}">
                ${item.isTrackRemote ? '👤 ' + item.speaker : '🎙️ ' + item.speaker}
              </span>
              <span style="font-size: 10px; color: var(--text-tertiary);">${item.timestamp}</span>
            </div>
            <!-- 原句：参考信息层 -->
            <div class="speech-original" title="英文原声">${escapeHtml(item.original)}</div>
            <!-- 译文：视觉焦点核心层 -->
            <div class="speech-translated" title="AI 实时译文">
              ${escapeHtml(item.translated)}
              ${item.translated.includes('...') ? '<span class="streaming-pulse-cursor"></span>' : ''}
            </div>
          </div>
        `
          )
          .join('')}
      </div>

      <!-- Jev 决策网关拦截并触发的推测建议 (Smart Response Drawer) -->
      ${
        state.hasPredictSuggestion
          ? `
        <div class="predict-drawer">
          <div class="predict-header">
            <div class="predict-title">
              <span>💡 智能应答预测</span>
              <span class="jev-badge">Jev 意图: ${state.intentCategory || '技术排期问询'}</span>
            </div>
            <span style="font-size: 10px; color: var(--text-tertiary);">按快捷键一键复制回答</span>
          </div>

          <div class="suggestions-list">
            ${state.suggestions
              .map(
                (sug) => `
              <div class="suggestion-card no-drag" onclick="window.__livehear_action('copySuggestion', ${sug.id})">
                <div class="suggestion-text">
                  <strong>${escapeHtml(sug.title)}:</strong>
                  <span>${escapeHtml(sug.detail)}</span>
                </div>
                <span class="shortcut-tag">${sug.shortcut}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }
    </div>
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
