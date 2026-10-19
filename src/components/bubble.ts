// 划词小气泡视图组件 (Bubble Popover)
export interface BubbleState {
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  translatedText: string;
  isStreaming: boolean;
  isPinned: boolean;
  altTranslations: string[];
  engine: string;
  latencyMs: number;
}

export function renderBubbleView(
  state: BubbleState,
  _onAction?: (action: string, payload?: any) => void
): string {
  return `
    <div class="bubble-window" data-tauri-drag-region>
      <!-- 平台专属控制条 -->
      <div class="window-header" data-tauri-drag-region>
        <div class="mac-traffic-lights">
          <div class="traffic-light close" title="关闭 (Esc)" onclick="window.__livehear_action('close')"></div>
          <div class="traffic-light minimize" title="最小化" onclick="window.__livehear_action('minimize')"></div>
          <div class="traffic-light maximize" title="钉住" onclick="window.__livehear_action('togglePin')"></div>
        </div>

        <div class="lang-bar">
          <span class="lang-badge">
            <span class="flag">🇬🇧</span> ${state.sourceLang}
          </span>
          <span class="lang-arrow">⇄</span>
          <span class="lang-badge">
            <span class="flag">🇨🇳</span> ${state.targetLang}
          </span>
        </div>

        <div class="action-buttons">
          <button class="icon-btn no-drag ${state.isPinned ? 'active' : ''}" 
                  title="${state.isPinned ? '取消固定' : '钉在屏幕上'}"
                  onclick="window.__livehear_action('togglePin')">
            📌
          </button>
          <button class="icon-btn no-drag" title="朗读发音" onclick="window.__livehear_action('speak')">
            🔊
          </button>
          <button class="icon-btn no-drag" title="复制译文" onclick="window.__livehear_action('copy')">
            📋
          </button>
        </div>

        <div class="win-controls">
          <button class="win-btn close" title="关闭" onclick="window.__livehear_action('close')">✕</button>
        </div>
      </div>

      <!-- 翻译正文区域 -->
      <div class="translation-body">
        <div class="source-box" title="选中的原文">
          ${escapeHtml(state.sourceText)}
        </div>

        <div class="target-box" title="AI 译文">
          <span>${escapeHtml(state.translatedText)}</span>
          ${state.isStreaming ? '<span class="streaming-indicator"></span>' : ''}
        </div>

        ${
          state.altTranslations.length > 0
            ? `
          <div class="alt-translations">
            ${state.altTranslations
              .map(
                (item) => `
              <span class="alt-chip" onclick="window.__livehear_action('selectAlt', '${escapeHtml(item)}')">${escapeHtml(item)}</span>
            `
              )
              .join('')}
          </div>
        `
            : ''
        }
      </div>

      <!-- 底部引擎与耗时 -->
      <div class="bubble-footer">
        <span class="engine-tag">
          ⚡ ${state.engine} · ${state.latencyMs}ms
        </span>
        <span>按 Esc 关闭</span>
      </div>
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
