// 独立主工作台与系统设置面板 (Main Studio & Settings)
export interface FullAppConfig {
  soniox: {
    api_key: string;
    ws_url: string;
    model: string;
    sample_rate: number;
    enable_speaker_diarization: boolean;
    language_hints: string[];
    enable_translation?: boolean;
    translation_type?: string;
    target_language?: string;
    language_a?: string;
    language_b?: string;
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
  const isTwoWay = config.soniox.translation_type === 'two_way';
  const isOneWayZh = config.soniox.translation_type === 'one_way' && config.soniox.target_language === 'zh';
  const isOneWayEn = config.soniox.translation_type === 'one_way' && config.soniox.target_language === 'en';

  return `
    <div class="main-window">
      <!-- 左侧原生导航栏 -->
      <div class="sidebar" data-tauri-drag-region>
        <div class="brand-header">
          <div class="brand-icon-wrap">🌐</div>
          <div>
            <div class="brand-title">LiveHear</div>
            <div class="brand-subtitle">AI 会议实时同传与决策智囊</div>
          </div>
        </div>

        <div class="nav-menu">
          <div class="nav-item ${activeTab === 'soniox' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'soniox')">
            <span class="nav-icon">🎙️</span>
            <div class="nav-text">
              <span class="nav-title">Soniox 语音 ASR & 同传</span>
              <span class="nav-sub">支持说话人分离与双向翻译</span>
            </div>
          </div>

          <div class="nav-item ${activeTab === 'ai' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'ai')">
            <span class="nav-icon">🤖</span>
            <div class="nav-text">
              <span class="nav-title">OpenRouter & OpenAI</span>
              <span class="nav-sub">大模型智能网关与本地 Pi</span>
            </div>
          </div>

          <div class="nav-item ${activeTab === 'translate' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'translate')">
            <span class="nav-icon">📝</span>
            <div class="nav-text">
              <span class="nav-title">即时查词与模型测验</span>
              <span class="nav-sub">测试 LLM 与同传释义速度</span>
            </div>
          </div>

          <div class="nav-item ${activeTab === 'meeting' ? 'active' : ''}" 
               onclick="window.__livehear_action('switchTab', 'meeting')">
            <span class="nav-icon">💼</span>
            <div class="nav-text">
              <span class="nav-title">会议背景与 Jev 决策</span>
              <span class="nav-sub">过滤闲聊、自动生成策略回复</span>
            </div>
          </div>
        </div>

        <div class="sidebar-footer">
          <button class="btn-primary no-drag save-all-btn" onclick="window.__livehear_action('saveAllConfig')">
            💾 保存并生效配置
          </button>
        </div>
      </div>

      <!-- 右侧主体内容区 -->
      <div class="main-content">
        ${
          activeTab === 'soniox'
            ? `
          <div class="settings-section">
            <div class="section-title-wrap">
              <div class="section-title">Soniox 实时语音识别与原生流式同传</div>
              <div class="section-desc">集成 Soniox 最新版实时 WebSocket API，毫秒级直接输出说话人标识与双语同传。</div>
            </div>

            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">Soniox API Key <span class="tag-live">已就绪</span></div>
                  <div class="form-desc">Soniox 控制台签发的项目密钥 (snx_proj_...)</div>
                </div>
                <div style="display: flex; gap: 8px; flex: 1; max-width: 420px;">
                  <input id="cfgSonioxApiKey" class="form-input no-drag" type="password" 
                         value="${escapeHtml(config.soniox.api_key)}" placeholder="snx_proj_..." />
                  <button class="btn-secondary no-drag test-conn-btn" 
                          title="测试握手与双向同传连通性" onclick="window.__livehear_action('testSonioxConnection')">
                    ⚡ 测试连接
                  </button>
                </div>
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">Soniox 原生流式同传翻译 (Direct Translation)</div>
                  <div class="form-desc">无需等待 LLM，Soniox 在语音识别流内同时流式吐出双语翻译，零延迟上屏</div>
                </div>
                <label class="switch-toggle no-drag">
                  <input id="cfgSonioxTranslation" type="checkbox" ${config.soniox.enable_translation !== false ? 'checked' : ''} />
                  <span class="slider"></span>
                </label>
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">同传翻译模式 (Translation Mode)</div>
                  <div class="form-desc">双向互译模式适合跨国会议，一方说英文翻中文，说中文翻英文</div>
                </div>
                <select id="cfgSonioxTransMode" class="form-select no-drag">
                  <option value="two_way" ${isTwoWay ? 'selected' : ''}>🌟 双向互译: 中文 ⇄ 英文 (Two-way)</option>
                  <option value="one_way_zh" ${isOneWayZh ? 'selected' : ''}>单向同传: 任意原声 -> 中文 (Target: zh)</option>
                  <option value="one_way_en" ${isOneWayEn ? 'selected' : ''}>单向同传: 任意原声 -> 英文 (Target: en)</option>
                </select>
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">多说话人声纹分离 (Speaker Diarization)</div>
                  <div class="form-desc">自动区分 Speaker 1、Speaker 2，并在 HUD 上赋予不同色彩标签</div>
                </div>
                <label class="switch-toggle no-drag">
                  <input id="cfgSonioxDiarization" type="checkbox" ${config.soniox.enable_speaker_diarization ? 'checked' : ''} />
                  <span class="slider"></span>
                </label>
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">流式识别模型 (Model)</div>
                  <div class="form-desc">默认使用官方最新的 stt-rt-v5 极速模型</div>
                </div>
                <input id="cfgSonioxModel" class="form-input no-drag" style="max-width: 220px;" type="text" 
                       value="${escapeHtml(config.soniox.model)}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">WebSocket 流接入点</div>
                  <div class="form-desc">Soniox 高性能安全流式接入点</div>
                </div>
                <input id="cfgSonioxWsUrl" class="form-input no-drag" style="max-width: 380px;" type="text" 
                       value="${escapeHtml(config.soniox.ws_url)}" />
              </div>
            </div>

            <!-- 系统内录与麦克风采集就绪提示 -->
            <div class="info-banner">
              <span class="banner-icon">💡</span>
              <div class="banner-text">
                <strong>双轨音频采集就绪：</strong>支持通过麦克风采集自己的发言，同时通过系统内录无损捕获 Zoom、Teams、Google Meet 等会议软件中对方的语音。
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
            <div class="section-title-wrap">
              <div class="section-title">OpenRouter & 本地 OpenAI 网关</div>
              <div class="section-desc">兼容 OpenAI 标准接口协议，支持企业内部 OpenAI 集群与 OpenRouter 官方网关。</div>
            </div>

            <!-- 本地 Pi / OpenAI 一键载入卡片 -->
            <div class="quick-preset-banner">
              <div class="preset-left">
                <span class="preset-icon">🚀</span>
                <div>
                  <div class="preset-title">已扫描到本地 Pi / OpenAI 配置</div>
                  <div class="preset-desc">网关: https://openrouter.ai/api/v1 · 模型: deepseek/deepseek-chat</div>
                </div>
              </div>
              <div class="preset-actions">
                <button class="btn-primary no-drag" onclick="window.__livehear_action('applyLocalPiPreset')">
                  ⚡ 载入本地 OpenAI 配置
                </button>
                <button class="btn-secondary no-drag" onclick="window.__livehear_action('applyOpenRouterPreset')">
                  🌐 切换为 OpenRouter
                </button>
              </div>
            </div>

            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">网关 API 接口地址 (Base URL)</div>
                  <div class="form-desc">兼容 OpenAI 或 OpenRouter 统一网关</div>
                </div>
                <input id="cfgOpenRouterBaseUrl" class="form-input no-drag" style="max-width: 380px;" type="text" 
                       value="${escapeHtml(config.openrouter.base_url)}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">网关 API Key</div>
                  <div class="form-desc">Bearer Token 密钥</div>
                </div>
                <input id="cfgOpenRouterApiKey" class="form-input no-drag" style="max-width: 380px;" type="password" 
                       value="${escapeHtml(config.openrouter.api_key)}" placeholder="sk-..." />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">保底与精翻模型 (Translate Model)</div>
                  <div class="form-desc">当需要二次精翻或复杂句式解析时的 LLM 模型</div>
                </div>
                <input id="cfgTranslateModel" class="form-input no-drag" style="max-width: 260px;" type="text" 
                       value="${escapeHtml(config.openrouter.translate_model)}" />
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">会议应答智囊推测模型 (Predict Model)</div>
                  <div class="form-desc">当被提问时，迅速给出专业高情商回答策略</div>
                </div>
                <input id="cfgPredictModel" class="form-input no-drag" style="max-width: 260px;" type="text" 
                       value="${escapeHtml(config.openrouter.predict_model)}" />
              </div>
            </div>

            <div class="section-title" style="margin-top: 14px;">Jev 毫秒级决策门禁</div>
            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">启用 Jev 问句拦截门禁</div>
                  <div class="form-desc">过滤 85% 无关闲聊，仅对向我提问或排期问询时触发策略应答</div>
                </div>
                <label class="switch-toggle no-drag">
                  <input id="cfgJevEnabled" type="checkbox" ${config.jev.enabled ? 'checked' : ''} />
                  <span class="slider"></span>
                </label>
              </div>

              <div class="form-row">
                <div>
                  <div class="form-label">Jev 决策模型名</div>
                  <div class="form-desc">可使用极速轻量模型（如 deepseek/deepseek-chat）或 typesafe/jev</div>
                </div>
                <input id="cfgJevModel" class="form-input no-drag" style="max-width: 260px;" type="text" 
                       value="${escapeHtml(config.jev.model)}" />
              </div>
            </div>
          </div>
        `
            : ''
        }

        ${
          activeTab === 'translate'
            ? `
          <div class="settings-section">
            <div class="section-title-wrap">
              <div class="section-title">即时查词与模型双语翻译体验</div>
              <div class="section-desc">输入任意英语或中文，实时体验网关大模型的翻译速度与行文质量。</div>
            </div>

            <div class="form-card">
              <textarea id="studioInputText" class="form-input no-drag" 
                        style="width: 100%; height: 90px; resize: none; font-size: 13px;" 
                        placeholder="输入或粘贴英语句子或专业术语，测试 LLM 翻译引擎... (按 Cmd+Enter 快速翻译)"></textarea>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
                <div style="display: flex; gap: 8px;">
                  <button class="btn-primary no-drag" onclick="window.__livehear_action('doStudioTranslate')">
                    🚀 发起翻译
                  </button>
                  <button class="btn-secondary no-drag" onclick="window.__livehear_action('clearStudioText')">
                    🗑️ 清空
                  </button>
                </div>
                <span style="font-size: 11px; color: var(--text-tertiary);">按 Cmd+Enter 快速触发</span>
              </div>
            </div>

            <div class="form-card" id="studioResultCard" style="min-height: 90px;">
              <div class="result-card-header">
                <span class="result-label">译文输出</span>
                <span class="result-model-badge">${escapeHtml(config.openrouter.translate_model)}</span>
              </div>
              <div id="studioResultText" class="result-content">
                输入内容后点击“发起翻译”以测试连通性与实际释义。
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
            <div class="section-title-wrap">
              <div class="section-title">当前会议背景与应答智囊定制</div>
              <div class="section-desc">填写当前正在参与的会议背景、个人职责与项目卡点，AI 将量身生成高情商回答策略。</div>
            </div>

            <div class="form-card">
              <div class="form-row">
                <div>
                  <div class="form-label">自动触发推测 (Auto Predict)</div>
                  <div class="form-desc">识别到对方抛出问题时，HUD 自动滑出 3 条不同策略的回答建议卡片</div>
                </div>
                <label class="switch-toggle no-drag">
                  <input id="cfgAutoPredict" type="checkbox" ${config.meeting.auto_predict ? 'checked' : ''} />
                  <span class="slider"></span>
                </label>
              </div>

              <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 10px;">
                <div class="form-label">当前会议背景 / 角色立场 / 关注要点 (Dossier)</div>
                <div class="form-desc">例如：“跨国远程团队架构评审会，我是后端核心负责人，目前核心卡点在第三方合规签名与支付沙箱压测”</div>
                <textarea id="cfgMeetingContext" class="form-input no-drag" 
                          style="width: 100%; height: 120px; resize: none; font-size: 13px; line-height: 1.5;">${escapeHtml(config.meeting.context)}</textarea>
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

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
