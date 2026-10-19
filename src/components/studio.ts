// 独立主工作台与设置面板 (Main Studio & Settings)
export interface FullAppConfig {
  soniox: {
    api_key: string;
    ws_url: string;
    model: string;
    sample_rate: number;
    enable_speaker_diarization: boolean;
    language_hints: string[];
  };
  openrouter: {
    api_key: string;
    base_url: string;
    translate_model: string;
    predict_model: string;
  };
  jev: {
    enabled: boolean;
    api_key: string;
    base_url: string;
    model: string;
    confidence_threshold: number;
  };
  meeting: {
    auto_predict: boolean;
    context: string;
  };
}

export function renderStudioView(
  config: FullAppConfig,
  activeTab: string,
  _onAction?: (action: string, payload?: any) => void
): string {
  return `
    <div class="main-window">
      <!-- 左侧原生导航栏 -->
      <div class="sidebar" data-tauri-drag-region>
        <div class="brand-header">
          <span class="brand-logo">🌐</span>
          <span class="brand-title">LiveHear</span>
        </div>

        <div class="nav-menu">
          <div class="nav-item ${activeTab === 'translate' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'translate')">
            <span>📝</span>
            <span>查词与即时翻译</span>
          </div>
          <div class="nav-item ${activeTab === 'soniox' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'soniox')">
            <span>🎙️</span>
            <span>Soniox 语音 ASR</span>
          </div>
          <div class="nav-item ${activeTab === 'ai' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'ai')">
            <span>🤖</span>
            <span>OpenRouter & Jev</span>
          </div>
          <div class="nav-item ${activeTab === 'meeting' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'meeting')">
            <span>💼</span>
            <span>会议背景与推测</span>
          </div>
        </div>

        <div style="margin-top: auto; padding: 10px 0;">
          <button class="btn-primary no-drag" style="width: 100%; font-size: 11px;" 
                  onclick="window.__livehear_action('saveAllConfig')">
            💾 保存所有配置
          </button>
        </div>
      </div>

      <!-- 右侧主体内容区 -->
      <div class="main-content">
        ${
          activeTab === 'translate'
            ? `
          <div class="settings-section">
            <div class="section-title">即时查词与长文翻译 (调用 OpenRouter)</div>
            <div class="form-card">
              <textarea id="studioInputText" class="form-input no-drag" 
                        style="width: 100%; height: 90px; resize: none; font-size: 13px;" 
                        placeholder="输入或粘贴英语/中文，测试 LLM 翻译引擎..."></textarea>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; gap: 8px;">
                  <button class="btn-primary no-drag" onclick="window.__livehear_action('doStudioTranslate')">
                    🚀 发起翻译
                  </button>
                  <button class="icon-btn no-drag" title="清空" onclick="window.__livehear_action('clearStudioText')">
                    🗑️
                  </button>
                </div>
                <span style="font-size: 11px; color: var(--text-tertiary);">按 Cmd+Enter 快速翻译</span>
              </div>
            </div>

            <div class="form-card" id="studioResultCard" style="min-height: 80px;">
              <div style="font-size: 11px; color: var(--text-tertiary); margin-bottom: 6px;">
                译文输出 (${config.openrouter.translate_model})
              </div>
              <div id="studioResultText" style="font-size: 14px; line-height: 1.5; color: var(--text-primary);">
                输入内容后点击“发起翻译”以测试连通性与实际释义。
              </div>
            </div>
          </div>
        `
            : ''
        }

        ${
          activeTab === 'soniox'
            ? `
          <div class="settings-section">
            <div class="section-title">Soniox 实时 Live WebSocket API 配置</div>
            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">Soniox API Key</div>
                  <div class="form-desc">Soniox 控制台签发的密钥</div>
                </div>
                <div style="display: flex; gap: 6px;">
                  <input id="cfgSonioxApiKey" class="form-input no-drag" type="password" 
                         value="${config.soniox.api_key}" placeholder="soniox_api_key..." />
                  <button class="icon-btn no-drag" style="width: auto; padding: 0 10px;" 
                          title="测试握手" onclick="window.__livehear_action('testSonioxConnection')">
                    ⚡ 测试连接
                  </button>
                </div>
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">WebSocket 地址</div>
                  <div class="form-desc">Soniox 实时流式接入点</div>
                </div>
                <input id="cfgSonioxWsUrl" class="form-input no-drag" type="text" 
                       value="${config.soniox.ws_url}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">识别模型 (Model)</div>
                  <div class="form-desc">如 stt-rt-v5 或定制会议模型</div>
                </div>
                <input id="cfgSonioxModel" class="form-input no-drag" type="text" 
                       value="${config.soniox.model}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">多说话人声纹分离 (Speaker Diarization)</div>
                  <div class="form-desc">开启后自动标注 Speaker 1, Speaker 2</div>
                </div>
                <input id="cfgSonioxDiarization" type="checkbox" ${config.soniox.enable_speaker_diarization ? 'checked' : ''} />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">系统内录驱动状态</div>
                  <div class="form-desc">macOS: ScreenCaptureKit · Windows: WASAPI Loopback</div>
                </div>
                <span class="lang-badge" style="color: var(--color-success);">● 双端原生就绪 (无需安装驱动)</span>
              </div>
            </div>
          </div>
        `
            : ''
        }

        ${
          activeTab === 'ai'
            ? `
          <div class="settings-section">
            <div class="section-title">OpenRouter 统一 AI 网关配置</div>
            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">OpenRouter API Key</div>
                  <div class="form-desc">同时支持调用 DeepSeek、Claude、OpenAI 和 Jev</div>
                </div>
                <input id="cfgOpenRouterApiKey" class="form-input no-drag" type="password" 
                       value="${config.openrouter.api_key}" placeholder="sk-or-v1-..." />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">OpenRouter 接口地址</div>
                  <div class="form-desc">默认为 https://openrouter.ai/api/v1</div>
                </div>
                <input id="cfgOpenRouterBaseUrl" class="form-input no-drag" type="text" 
                       value="${config.openrouter.base_url}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">翻译主模型 (Translate Model)</div>
                  <div class="form-desc">极速且高性价比模型</div>
                </div>
                <input id="cfgTranslateModel" class="form-input no-drag" type="text" 
                       value="${config.openrouter.translate_model}" placeholder="deepseek/deepseek-chat" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">会议应答推测模型 (Predict Model)</div>
                  <div class="form-desc">高情商与专业策略生成模型</div>
                </div>
                <input id="cfgPredictModel" class="form-input no-drag" type="text" 
                       value="${config.openrouter.predict_model}" placeholder="anthropic/claude-3.5-haiku" />
              </div>
            </div>

            <div class="section-title" style="margin-top: 10px;">Jev 系统一毫秒级决策门禁</div>
            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">启用 Jev 问句拦截门禁</div>
                  <div class="form-desc">过滤 85% 无关闲聊，仅对向我提问触发大模型推测</div>
                </div>
                <input id="cfgJevEnabled" type="checkbox" ${config.jev.enabled ? 'checked' : ''} />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">Jev 模型名 (OpenRouter / TypeSafe)</div>
                  <div class="form-desc">通常为 typesafe/jev-1.13 或 jev-1.14</div>
                </div>
                <input id="cfgJevModel" class="form-input no-drag" type="text" 
                       value="${config.jev.model}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">Jev 独立 API Key (可选)</div>
                  <div class="form-desc">留空则复用 OpenRouter API Key</div>
                </div>
                <input id="cfgJevApiKey" class="form-input no-drag" type="password" 
                       value="${config.jev.api_key}" placeholder="可选，留空复用 OpenRouter Key" />
              </div>
            </div>
          </div>
        `
            : ''
        }

        ${
          activeTab === 'meeting'
            ? `
          <div class="settings-section">
            <div class="section-title">当前会议背景与应答智囊定制</div>
            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">自动触发推测 (Auto Predict)</div>
                  <div class="form-desc">识别到对方抛出问题时，自动弹出建议答辩卡片</div>
                </div>
                <input id="cfgAutoPredict" type="checkbox" ${config.meeting.auto_predict ? 'checked' : ''} />
              </div>

              <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
                <div class="form-label">当前会议背景 / 角色立场 / 关注要点 (Dossier)</div>
                <div class="form-desc">如：“Q3 跨境支付周会，我是后端开发负责人，核心卡点在合规牌照与沙箱压测”</div>
                <textarea id="cfgMeetingContext" class="form-input no-drag" 
                          style="width: 100%; height: 110px; resize: none; font-size: 13px;">${config.meeting.context}</textarea>
              </div>
            </div>
          </div>
        `
            : ''
        }
      </div>
    </div>
  `;
}
