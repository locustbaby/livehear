import { renderBubbleView, type BubbleState } from './components/bubble';
import { renderHudView, type HudState } from './components/hud';
import { renderStudioView, type FullAppConfig } from './components/studio';

type AppViewMode = 'bubble' | 'hud' | 'studio';

// 动态安全调用 Tauri API (在非 Tauri 浏览器环境也能正常优雅降级展示)
async function tauriInvoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
    try {
      const core = await import('@tauri-apps/api/core');
      return await core.invoke<T>(cmd, args);
    } catch (e) {
      console.warn(`Tauri invoke [${cmd}] 失败:`, e);
      throw e;
    }
  }
  throw new Error('当前运行在纯浏览器预览模式，未连接 Tauri 原生运行时');
}

class LiveHearApp {
  private currentView: AppViewMode = 'bubble';
  private currentPlatform: 'macos' | 'windows' = 'macos';

  // 完整业务配置 (与 livehear.config.json 一一对应)
  private appConfig: FullAppConfig = {
    soniox: {
      api_key: '',
      ws_url: 'wss://stt-rt.soniox.com/transcribe-websocket',
      model: 'stt-rt-v5',
      sample_rate: 16000,
      enable_speaker_diarization: true,
      language_hints: ['en', 'zh'],
    },
    openrouter: {
      api_key: '',
      base_url: 'https://openrouter.ai/api/v1',
      translate_model: 'deepseek/deepseek-chat',
      predict_model: 'anthropic/claude-3.5-haiku',
    },
    jev: {
      enabled: true,
      api_key: '',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'typesafe/jev-1.13',
      confidence_threshold: 0.8,
    },
    meeting: {
      auto_predict: true,
      context: '跨国远程团队日常同步与架构评审周会',
    },
  };

  private studioActiveTab: string = 'soniox';

  // Bubble State
  private bubbleState: BubbleState = {
    sourceLang: '英语 (自动检测)',
    targetLang: '中文 (简体)',
    sourceText: 'The core bottleneck in real-time translation lies in token latency and boundary chunking.',
    translatedText: '实时翻译的核心瓶颈在于 Token 延迟与语义切句断句。',
    isStreaming: false,
    isPinned: false,
    altTranslations: ['核心瓶颈', '语义断句', '延迟控制', '流式分块'],
    engine: 'DeepSeek-V3 (OpenRouter)',
    latencyMs: 78,
  };

  // HUD State
  private hudState: HudState = {
    isMicActive: true,
    isSpeakerActive: true,
    isClickThrough: false,
    isAlwaysOnTop: true,
    sonioxLatencyMs: 95,
    hasPredictSuggestion: true,
    intentCategory: '排期与卡点提问 (Jev 触发)',
    subtitles: [
      {
        id: '1',
        speaker: 'John (Tech Lead)',
        isTrackRemote: true,
        original: 'Can we deliver the checkout API by this Friday, or are we still blocked by third-party compliance?',
        translated: '我们周五前能交付收银台 API 吗，还是说依然被第三方合规卡点？',
        timestamp: '17:10:42',
      },
      {
        id: '2',
        speaker: 'Me (Mic)',
        isTrackRemote: false,
        original: 'Let me double check the sandbox status with QA team.',
        translated: '我稍后和 QA 团队核对一下沙箱测试进度。',
        timestamp: '17:10:48',
      },
    ],
    suggestions: [
      {
        id: 1,
        shortcut: 'Cmd+1',
        title: '稳妥推迟（强调风险）',
        detail: 'Suggest pushing to next Tuesday to leave enough buffer for stress testing and third-party signing.',
      },
      {
        id: 2,
        shortcut: 'Cmd+2',
        title: '乐观承诺（附加条件）',
        detail: 'If partner approval arrives by tomorrow noon, we can roll out by Friday evening.',
      },
      {
        id: 3,
        shortcut: 'Cmd+3',
        title: '抛出关键依赖',
        detail: 'The core codebase is fully verified, but waiting for partner webhook certificate.',
      },
    ],
  };

  constructor() {
    this.detectPlatform();
    this.bindGlobalHandlers();
    this.initTauriListeners();
    this.loadConfigFromBackend();
    this.render();
  }

  private detectPlatform() {
    const userAgent = navigator.userAgent.toLowerCase();
    this.currentPlatform = userAgent.includes('win') ? 'windows' : 'macos';
    this.applyPlatformTheme();
  }

  public setPlatform(platform: 'macos' | 'windows') {
    this.currentPlatform = platform;
    this.applyPlatformTheme();
    this.render();
  }

  private applyPlatformTheme() {
    document.documentElement.setAttribute('data-platform', this.currentPlatform);
    const select = document.getElementById('platformSelect') as HTMLSelectElement;
    if (select) {
      select.value = this.currentPlatform;
    }
  }

  public switchView(view: AppViewMode) {
    this.currentView = view;
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
    if (view === 'bubble') document.getElementById('tabBubble')?.classList.add('active');
    if (view === 'hud') document.getElementById('tabHud')?.classList.add('active');
    if (view === 'studio') document.getElementById('tabStudio')?.classList.add('active');
    this.render();
  }

  private async loadConfigFromBackend() {
    try {
      const cfg = await tauriInvoke<FullAppConfig>('get_config');
      if (cfg) {
        this.appConfig = cfg;
        this.render();
      }
    } catch {
      // 纯网页预览环境下使用默认配置
    }
  }

  private async initTauriListeners() {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        // 监听 Soniox 流式 Token
        await listen<any>('soniox-partial', (event) => {
          const { speaker, text } = event.payload;
          const last = this.hudState.subtitles[this.hudState.subtitles.length - 1];
          if (last && last.speaker === speaker) {
            last.original = text;
          } else {
            this.hudState.subtitles.push({
              id: Date.now().toString(),
              speaker,
              isTrackRemote: true,
              original: text,
              translated: '正在翻译中...',
              timestamp: new Date().toLocaleTimeString(),
            });
          }
          this.render();
        });

        // 监听 Soniox 最终断句
        await listen<any>('soniox-final', async (event) => {
          const { speaker, text } = event.payload;
          this.hudState.subtitles.push({
            id: Date.now().toString(),
            speaker,
            isTrackRemote: true,
            original: text,
            translated: '正在获取高精度翻译...',
            timestamp: new Date().toLocaleTimeString(),
          });
          this.render();

          // 自动触发 OpenRouter 翻译
          try {
            const translated = await tauriInvoke<string>('translate', {
              text,
              sourceLang: 'en',
              targetLang: 'zh',
            });
            const item = this.hudState.subtitles[this.hudState.subtitles.length - 1];
            if (item) item.translated = translated;
            this.render();
          } catch (e) {
            console.error('翻译出错:', e);
          }

          // 自动触发 Jev 问句检测与应答推测
          if (this.appConfig.meeting.auto_predict) {
            try {
              const res = await tauriInvoke<any>('evaluate_and_predict', { text });
              if (res.is_question && res.suggestions.length > 0) {
                this.hudState.hasPredictSuggestion = true;
                this.hudState.intentCategory = res.intent;
                this.hudState.suggestions = res.suggestions;
                this.render();
              }
            } catch (e) {
              console.error('推测出错:', e);
            }
          }
        });
      } catch (e) {
        console.warn('初始化 Tauri 事件监听失败:', e);
      }
    }
  }

  private bindGlobalHandlers() {
    (window as any).__livehear_switch_view = (view: AppViewMode) => this.switchView(view);
    (window as any).__livehear_set_platform = (plat: 'macos' | 'windows') => this.setPlatform(plat);
    (window as any).__livehear_action = (action: string, payload?: any) => {
      this.handleAction(action, payload);
    };
  }

  private async handleAction(action: string, payload?: any) {
    switch (action) {
      case 'togglePin':
        this.bubbleState.isPinned = !this.bubbleState.isPinned;
        this.render();
        break;

      case 'copy':
        navigator.clipboard.writeText(this.bubbleState.translatedText);
        this.showToast('已复制译文到剪贴板！');
        break;

      case 'speak':
        this.speakText(this.bubbleState.translatedText);
        break;

      case 'toggleClickThrough':
        this.hudState.isClickThrough = !this.hudState.isClickThrough;
        this.showToast(this.hudState.isClickThrough ? '已开启鼠标穿透 👻' : '已关闭鼠标穿透');
        this.render();
        break;

      case 'toggleTopmost':
        this.hudState.isAlwaysOnTop = !this.hudState.isAlwaysOnTop;
        this.showToast(this.hudState.isAlwaysOnTop ? '窗口已置顶 📌' : '取消置顶');
        this.render();
        break;

      case 'copySuggestion':
        const item = this.hudState.suggestions.find((s) => s.id === payload);
        if (item) {
          navigator.clipboard.writeText(item.detail);
          this.showToast(`已复制: "${item.title}"`);
        }
        break;

      case 'switchTab':
        this.studioActiveTab = payload;
        this.render();
        break;

      case 'testSonioxConnection':
        const sonioxKeyInput = document.getElementById('cfgSonioxApiKey') as HTMLInputElement;
        const key = sonioxKeyInput ? sonioxKeyInput.value : this.appConfig.soniox.api_key;
        this.showToast('正在向 Soniox 发起 WebSocket 握手测试...');
        try {
          const res = await tauriInvoke<string>('test_soniox', { apiKey: key });
          this.showToast(`✅ ${res}`);
        } catch (err: any) {
          this.showToast(`❌ 连接失败: ${err?.message || err}`);
        }
        break;

      case 'saveAllConfig':
        this.syncInputsToConfig();
        try {
          await tauriInvoke('save_config', { newConfig: this.appConfig });
          this.showToast('✅ 配置已成功保存至 livehear.config.json');
        } catch (e: any) {
          this.showToast(`⚠️ 保存失败: ${e?.message || e}`);
        }
        this.render();
        break;

      case 'doStudioTranslate':
        const input = document.getElementById('studioInputText') as HTMLTextAreaElement;
        const result = document.getElementById('studioResultText');
        if (input && result) {
          const text = input.value.trim();
          if (!text) {
            this.showToast('请输入要翻译的内容');
            return;
          }
          result.innerHTML = `<span style="color: var(--color-primary)">正在调用 OpenRouter 进行智能翻译...</span>`;
          try {
            const translated = await tauriInvoke<string>('translate', {
              text,
              sourceLang: 'en',
              targetLang: 'zh',
            });
            result.innerText = translated;
          } catch (e: any) {
            result.innerText = `[模拟翻译演示]: ${text} -> 实时低延迟流式释义 (请在设置填入 OpenRouter Key 后体验真机调用)`;
          }
        }
        break;

      case 'clearStudioText':
        const area = document.getElementById('studioInputText') as HTMLTextAreaElement;
        if (area) area.value = '';
        break;

      case 'close':
      case 'minimize':
        this.showToast(`触发系统窗口操作: ${action}`);
        break;
    }
  }

  private syncInputsToConfig() {
    const getVal = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value;
    const getChecked = (id: string) => (document.getElementById(id) as HTMLInputElement)?.checked;

    if (getVal('cfgSonioxApiKey') !== undefined) this.appConfig.soniox.api_key = getVal('cfgSonioxApiKey');
    if (getVal('cfgSonioxWsUrl') !== undefined) this.appConfig.soniox.ws_url = getVal('cfgSonioxWsUrl');
    if (getVal('cfgSonioxModel') !== undefined) this.appConfig.soniox.model = getVal('cfgSonioxModel');
    if (getChecked('cfgSonioxDiarization') !== undefined) this.appConfig.soniox.enable_speaker_diarization = getChecked('cfgSonioxDiarization');

    if (getVal('cfgOpenRouterApiKey') !== undefined) this.appConfig.openrouter.api_key = getVal('cfgOpenRouterApiKey');
    if (getVal('cfgOpenRouterBaseUrl') !== undefined) this.appConfig.openrouter.base_url = getVal('cfgOpenRouterBaseUrl');
    if (getVal('cfgTranslateModel') !== undefined) this.appConfig.openrouter.translate_model = getVal('cfgTranslateModel');
    if (getVal('cfgPredictModel') !== undefined) this.appConfig.openrouter.predict_model = getVal('cfgPredictModel');

    if (getChecked('cfgJevEnabled') !== undefined) this.appConfig.jev.enabled = getChecked('cfgJevEnabled');
    if (getVal('cfgJevModel') !== undefined) this.appConfig.jev.model = getVal('cfgJevModel');
    if (getVal('cfgJevApiKey') !== undefined) this.appConfig.jev.api_key = getVal('cfgJevApiKey');

    if (getChecked('cfgAutoPredict') !== undefined) this.appConfig.meeting.auto_predict = getChecked('cfgAutoPredict');
    if (getVal('cfgMeetingContext') !== undefined) this.appConfig.meeting.context = getVal('cfgMeetingContext');
  }

  private speakText(text: string) {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      window.speechSynthesis.speak(utterance);
    } else {
      this.showToast('当前环境不支持语音合成');
    }
  }

  private showToast(message: string) {
    let toast = document.getElementById('livehearToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'livehearToast';
      toast.style.position = 'fixed';
      toast.style.bottom = '20px';
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.background = 'rgba(0, 0, 0, 0.88)';
      toast.style.border = '1px solid rgba(255, 255, 255, 0.18)';
      toast.style.color = '#fff';
      toast.style.padding = '7px 16px';
      toast.style.borderRadius = '20px';
      toast.style.fontSize = '12px';
      toast.style.zIndex = '99999';
      toast.style.pointerEvents = 'none';
      toast.style.transition = 'all 0.25s ease';
      document.body.appendChild(toast);
    }
    toast.innerText = message;
    toast.style.opacity = '1';
    setTimeout(() => {
      if (toast) toast.style.opacity = '0';
    }, 2200);
  }

  private render() {
    const container = document.getElementById('app');
    if (!container) return;

    if (this.currentView === 'bubble') {
      container.innerHTML = renderBubbleView(this.bubbleState, (a, p) => this.handleAction(a, p));
    } else if (this.currentView === 'hud') {
      container.innerHTML = renderHudView(this.hudState, (a, p) => this.handleAction(a, p));
      const stream = document.getElementById('subtitlesStream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    } else if (this.currentView === 'studio') {
      container.innerHTML = renderStudioView(this.appConfig, this.studioActiveTab, (a, p) =>
        this.handleAction(a, p)
      );
    }
  }
}

new LiveHearApp();
