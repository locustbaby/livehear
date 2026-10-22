import {
  renderHudView,
  renderSubtitleCardHtml,
  renderEmptyPlaceholder,
  renderSuggestionsHtml,
  renderSettingsModalHtml,
  type HudState,
  type SubtitleItem,
  type SubtitleDisplayMode,
} from './components/hud';
import type { FullAppConfig } from './components/studio';

// 安全调用 Tauri API
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

// 高保真相位连续插值重采样器 (消除采样丢包与高频混叠噪声)
class StatefulResampler {
  private ratio: number;
  private phase: number = 0;
  private lastSample: number = 0;

  constructor(inputSampleRate: number, targetSampleRate: number = 16000) {
    this.ratio = inputSampleRate / targetSampleRate;
  }

  public process(input: Float32Array): Int16Array {
    if (this.ratio === 1.0) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    const outputLength = Math.floor((input.length - this.phase) / this.ratio);
    const output = new Int16Array(Math.max(0, outputLength));

    let outIdx = 0;
    while (this.phase < input.length) {
      const idx = Math.floor(this.phase);
      const frac = this.phase - idx;
      const s0 = idx === 0 ? this.lastSample : input[idx - 1];
      const s1 = input[idx];
      // 线性平滑插值
      const sample = s0 * (1 - frac) + s1 * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      output[outIdx++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.phase += this.ratio;
    }

    this.phase -= input.length;
    this.lastSample = input[input.length - 1] || 0;
    return output;
  }
}

// 浏览器 Web Audio 麦克风高保真采集器 (触发 macOS TCC 授权对话框 + 实时音量计算 + 推送 PCM)
class WebAudioRecorder {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private muteGain: GainNode | null = null;
  private resampler: StatefulResampler | null = null;
  private onAudioChunk: (chunk: number[]) => void;
  private onVolumeChange: (volume: number) => void;
  private pcmAccumulator: number[] = [];

  constructor(
    onAudioChunk: (chunk: number[]) => void,
    onVolumeChange: (volume: number) => void
  ) {
    this.onAudioChunk = onAudioChunk;
    this.onVolumeChange = onVolumeChange;
  }

  public async resumeIfSuspended(): Promise<boolean> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
        console.log('🎙️ WebAudio AudioContext 状态已恢复至:', this.audioCtx.state);
        return true;
      } catch (e) {
        console.warn('AudioContext 恢复失败:', e);
      }
    }
    return false;
  }

  public async start(): Promise<boolean> {
    try {
      console.log('🎤 正在申请浏览器麦克风流 (getUserMedia)...');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      console.log('✅ 麦克风已获授权，正在构建 WebAudio 图谱...');
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtx();

      if (this.audioCtx.state === 'suspended') {
        try {
          await this.audioCtx.resume();
          console.log('🎙️ AudioContext 已成功 resume');
        } catch {
          console.log('AudioContext 待用户手势激活');
        }
      }

      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      this.resampler = new StatefulResampler(this.audioCtx.sampleRate, 16000);

      // bufferSize 4096 (~85ms @ 48kHz)
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.muteGain = this.audioCtx.createGain();
      this.muteGain.gain.value = 0; // 防止扬声器回放麦克风产生啸叫

      let lastVolumeUpdate = 0;
      let chunkCount = 0;

      this.processor.onaudioprocess = (e) => {
        const inputBuffer = e.inputBuffer.getChannelData(0);

        // 1. 计算 RMS 音量 (0 - 100)
        let sum = 0;
        for (let i = 0; i < inputBuffer.length; i++) {
          sum += inputBuffer[i] * inputBuffer[i];
        }
        const rms = Math.sqrt(sum / inputBuffer.length);
        const volume = Math.min(100, Math.round(rms * 280));

        const now = Date.now();
        if (now - lastVolumeUpdate > 80) {
          lastVolumeUpdate = now;
          this.onVolumeChange(volume);
        }

        // 2. 状态机连续重采样为 Soniox 标准 16000Hz Mono PCM16
        const pcm16 = this.resampler!.process(inputBuffer);
        const pcmBytes = new Uint8Array(pcm16.buffer);

        for (let i = 0; i < pcmBytes.length; i++) {
          this.pcmAccumulator.push(pcmBytes[i]);
        }

        // 按 100ms (3200 字节) 一块实时分发
        while (this.pcmAccumulator.length >= 3200) {
          const chunk = this.pcmAccumulator.splice(0, 3200);
          chunkCount++;
          if (chunkCount % 20 === 0) {
            console.log(`📡 [WebAudio Push] 已推送 ${chunkCount} 块音频，音量: ${volume}%`);
          }
          this.onAudioChunk(chunk);
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.muteGain);
      this.muteGain.connect(this.audioCtx.destination);
      console.log('🎙️ WebAudio 处理链路已完全就绪，state:', this.audioCtx.state);
      return true;
    } catch (err: any) {
      console.warn('Web Audio 麦克风访问失败或用户取消:', err);
      return false;
    }
  }

  public stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.muteGain) {
      this.muteGain.disconnect();
      this.muteGain = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.resampler = null;
    this.pcmAccumulator = [];
    this.onVolumeChange(0);
  }
}

// 高性能字幕流局部 DOM 管理器 (杜绝 innerHTML 带来的 DOM 销毁、失焦与选区失效)
class SubtitleStreamManager {
  private getStreamEl(): HTMLElement | null {
    return document.getElementById('subtitlesStream');
  }

  public updateOrAppendPartial(item: SubtitleItem, displayMode: SubtitleDisplayMode) {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;

    // 移除空数据占位符
    const placeholder = streamEl.querySelector('.empty-stream-placeholder');
    if (placeholder) placeholder.remove();

    // 查找当前正在流式输入的 partial 卡片
    const partialCard = streamEl.querySelector('.subtitle-card.is-partial') as HTMLElement;
    if (partialCard) {
      // 局部更新文本节点，不破坏用户选区！
      const targetSpan = partialCard.querySelector('.speech-target > span');
      if (targetSpan && item.translated) {
        targetSpan.textContent = item.translated;
      }
      const sourceContent = partialCard.querySelector('.source-content');
      if (sourceContent && item.original) {
        sourceContent.textContent = item.original;
      }
      const speakerPill = partialCard.querySelector('.speaker-pill');
      if (speakerPill && item.speaker) {
        speakerPill.innerHTML = `👤 ${item.speaker}`;
      }
    } else {
      // 创建新 partial 卡片
      const div = document.createElement('div');
      div.innerHTML = renderSubtitleCardHtml(item, displayMode);
      if (div.firstElementChild) {
        streamEl.appendChild(div.firstElementChild);
      }
    }

    this.scrollToBottom();
  }

  public finalizeLastCard(item: SubtitleItem, displayMode: SubtitleDisplayMode) {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;

    const placeholder = streamEl.querySelector('.empty-stream-placeholder');
    if (placeholder) placeholder.remove();

    const partialCard = streamEl.querySelector('.subtitle-card.is-partial') as HTMLElement;
    if (partialCard) {
      partialCard.classList.remove('is-partial');
      const cursor = partialCard.querySelector('.streaming-pulse-cursor');
      if (cursor) cursor.remove();

      const targetSpan = partialCard.querySelector('.speech-target > span');
      if (targetSpan && item.translated) {
        targetSpan.textContent = item.translated;
      }
      const sourceContent = partialCard.querySelector('.source-content');
      if (sourceContent && item.original) {
        sourceContent.textContent = item.original;
      }
    } else {
      const div = document.createElement('div');
      div.innerHTML = renderSubtitleCardHtml(item, displayMode);
      if (div.firstElementChild) {
        streamEl.appendChild(div.firstElementChild);
      }
    }

    this.scrollToBottom();
  }

  public refreshDisplayMode(subtitles: SubtitleItem[], displayMode: SubtitleDisplayMode) {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;
    if (subtitles.length === 0) return;

    // 刷新显示模式
    streamEl.innerHTML = subtitles
      .map((item) => renderSubtitleCardHtml(item, displayMode))
      .join('');
    this.scrollToBottom();
  }

  public clear(isStreaming: boolean, hasPermission: boolean) {
    const streamEl = this.getStreamEl();
    if (streamEl) {
      streamEl.innerHTML = renderEmptyPlaceholder(isStreaming, hasPermission);
    }
  }

  public scrollToBottom() {
    const streamEl = this.getStreamEl();
    if (streamEl) {
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  }
}

class LiveHearApp {
  private appConfig: FullAppConfig = {
    soniox: {
      api_key:
        '',
      ws_url: 'wss://stt-rt.soniox.com/transcribe-websocket',
      model: 'stt-rt-v5',
      sample_rate: 16000,
      enable_speaker_diarization: true,
      language_hints: [], // 全语种原生自动识别
      enable_translation: true,
      translation_type: 'one_way',
      target_language: 'zh',
      language_a: 'en',
      language_b: 'zh',
    },
    openrouter: {
      api_key: '',
      base_url: 'https://openrouter.ai/api/v1',
      translate_model: 'deepseek/deepseek-chat',
      predict_model: 'deepseek/deepseek-chat',
    },
    jev: {
      enabled: true,
      api_key: '',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      confidence_threshold: 0.8,
    },
    meeting: {
      auto_predict: true,
      context: '跨国远程团队日常同步与架构评审周会',
    },
  };

  private hudState: HudState = {
    isMicActive: true,
    isSpeakerActive: true,
    isClickThrough: false,
    isAlwaysOnTop: true,
    isStreaming: false,
    sonioxLatencyMs: 70,
    displayMode: 'bilingual',
    subtitles: [],
    hasPredictSuggestion: false,
    suggestions: [],
    micVolume: 0,
    hasMicPermission: true,
    isSettingsOpen: false,
  };

  private audioRecorder: WebAudioRecorder;
  private streamManager: SubtitleStreamManager;

  constructor() {
    this.audioRecorder = new WebAudioRecorder(
      (chunk) => this.pushAudioChunk(chunk),
      (vol) => this.updateMicVolume(vol)
    );
    this.streamManager = new SubtitleStreamManager();

    this.detectPlatform();
    this.bindGlobalHandlers();
    this.bindKeyboardShortcuts();
    this.initTauriListeners();
    this.initialRender();
    this.loadConfigAndAutoStart();
  }

  private detectPlatform() {
    document.documentElement.setAttribute('data-platform', 'macos');
  }

  private initialRender() {
    const appEl = document.getElementById('app');
    if (!appEl) return;
    appEl.innerHTML = renderHudView(this.hudState, this.appConfig);
  }

  private updateMicVolume(volume: number) {
    if (this.hudState.micVolume !== volume) {
      this.hudState.micVolume = volume;
      const text = document.getElementById('micVolumeText');
      if (text) text.textContent = `麦克风: ${volume}%`;
      const dot = document.querySelector('.track-indicator .track-dot') as HTMLElement;
      if (dot) {
        if (volume > 3) dot.classList.add('pulse-green');
        else dot.classList.remove('pulse-green');
      }
      const bars = document.querySelectorAll('#micWaveVisualizer .bar');
      if (bars.length >= 4) {
        (bars[0] as HTMLElement).style.height = `${Math.max(4, Math.min(18, volume * 0.35))}px`;
        (bars[1] as HTMLElement).style.height = `${Math.max(6, Math.min(22, volume * 0.5))}px`;
        (bars[2] as HTMLElement).style.height = `${Math.max(4, Math.min(16, volume * 0.3))}px`;
        (bars[3] as HTMLElement).style.height = `${Math.max(6, Math.min(20, volume * 0.45))}px`;
      }
      const diagText = document.getElementById('diagVolumeText');
      if (diagText) diagText.textContent = `${volume}%`;
      const diagFill = document.getElementById('diagMeterFill');
      if (diagFill) diagFill.style.width = `${volume}%`;
    }
  }

  private async pushAudioChunk(chunk: number[]) {
    try {
      await tauriInvoke('push_audio', { chunk });
    } catch {
      // 容错
    }
  }

  private async loadConfigAndAutoStart() {
    try {
      const cfg = await tauriInvoke<FullAppConfig>('get_config');
      if (cfg) {
        this.appConfig = {
          ...this.appConfig,
          ...cfg,
          soniox: { ...this.appConfig.soniox, ...cfg.soniox },
          openrouter: { ...this.appConfig.openrouter, ...cfg.openrouter },
          jev: { ...this.appConfig.jev, ...cfg.jev },
          meeting: { ...this.appConfig.meeting, ...cfg.meeting },
        };
      }
    } catch {
      // 降级
    }

    // 默认直接开启实时同传！
    await this.startLiveStream();
  }

  private async initTauriListeners() {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 流式 Partial 事件监听（无损局部更新）
        const handlePartial = (event: any) => {
          const payload = event.payload;
          const segment = payload?.segment || payload;
          if (!segment) return;

          const speaker = segment.speaker?.role || segment.speaker || '说话人 1';
          const original = segment.text || '';
          const translated = segment.translated_text || '';

          if (!original.trim() && !translated.trim()) return;

          const item: SubtitleItem = {
            id: segment.id || 'current_partial',
            speaker,
            isTrackRemote: true,
            original: original || '...',
            translated: translated || '正在同传中...',
            timestamp: new Date().toLocaleTimeString(),
            isPartial: true,
          };

          const last = this.hudState.subtitles[this.hudState.subtitles.length - 1];
          if (last && last.isPartial) {
            last.original = item.original;
            last.translated = item.translated;
            last.speaker = item.speaker;
          } else {
            this.hudState.subtitles.push(item);
          }

          this.streamManager.updateOrAppendPartial(item, this.hudState.displayMode);
        };

        // 终态 Final 事件监听
        const handleFinal = (event: any) => {
          const payload = event.payload;
          const segment = payload?.segment || payload;
          if (!segment) return;

          const speaker = segment.speaker?.role || segment.speaker || '说话人 1';
          const original = segment.text || '';
          const translated = segment.translated_text || '';

          if (!original.trim() && !translated.trim()) return;

          const item: SubtitleItem = {
            id: segment.id || Date.now().toString(),
            speaker,
            isTrackRemote: true,
            original,
            translated: translated || '正在同传中...',
            timestamp: new Date().toLocaleTimeString(),
            isPartial: false,
          };

          const lastIndex = this.hudState.subtitles.length - 1;
          const last = this.hudState.subtitles[lastIndex];

          if (last && last.isPartial) {
            this.hudState.subtitles[lastIndex] = item;
          } else {
            this.hudState.subtitles.push(item);
          }

          this.streamManager.finalizeLastCard(item, this.hudState.displayMode);

          // 呈现智能决策建议
          if (payload.suggestions && payload.suggestions.length > 0) {
            this.hudState.suggestions = payload.suggestions;
            this.hudState.hasPredictSuggestion = true;
            this.hudState.intentCategory = payload.intent;
            const container = document.getElementById('predictDrawerContainer');
            if (container) {
              container.innerHTML = renderSuggestionsHtml(payload.suggestions, payload.intent);
            }
          }
        };

        await listen('asr-partial', handlePartial);
        await listen('soniox-partial', handlePartial);
        await listen('asr-final', handleFinal);
        await listen('soniox-final', handleFinal);
        console.log('✅ Tauri 实时同传双向通道已激活');
      } catch (e) {
        console.warn('初始化 Tauri 事件监听失败:', e);
      }
    }
  }

  private bindGlobalHandlers() {
    (window as any).__livehear_action = (action: string, payload?: any) => {
      this.handleAction(action, payload);
    };

    // 监听全局用户点击手势以激活处于 suspended 状态的 Web AudioContext
    window.addEventListener(
      'click',
      () => {
        this.audioRecorder.resumeIfSuspended();
      },
      { capture: true }
    );
  }

  private bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        this.handleAction('toggleTopmost');
      } else if (isCmd && e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        this.handleAction('clearSubtitles');
      } else if (isCmd && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        this.handleAction('exportTranscript');
      } else if (isCmd && e.key === ',') {
        e.preventDefault();
        this.handleAction('toggleSettings');
      } else if (isCmd && ['1', '2', '3'].includes(e.key)) {
        const id = parseInt(e.key, 10);
        const item = this.hudState.suggestions.find((s) => s.id === id);
        if (item) {
          e.preventDefault();
          this.handleAction('copySuggestion', id);
        }
      }
    });
  }

  private async handleAction(action: string, payload?: any) {
    switch (action) {
      case 'toggleLiveStream':
        if (this.hudState.isStreaming) {
          await this.stopLiveStream();
        } else {
          await this.startLiveStream();
        }
        break;

      case 'requestMicPermission':
        await this.startLiveStream();
        if (this.hudState.hasMicPermission) {
          this.showToast('✅ 麦克风已授权并开始实时收音！');
          this.streamManager.clear(this.hudState.isStreaming, true);
        } else {
          this.showToast('⚠️ 未能获得权限，请在「系统设置 -> 隐私与安全性 -> 麦克风」中允许 LiveHear 或当前终端');
        }
        break;

      case 'toggleSettings':
        this.hudState.isSettingsOpen = !this.hudState.isSettingsOpen;
        const overlayContainer = document.getElementById('settingsOverlayContainer');
        const btnToggleSettings = document.getElementById('btnToggleSettings');
        if (btnToggleSettings) {
          if (this.hudState.isSettingsOpen) btnToggleSettings.classList.add('active');
          else btnToggleSettings.classList.remove('active');
        }
        if (overlayContainer) {
          overlayContainer.innerHTML = this.hudState.isSettingsOpen
            ? renderSettingsModalHtml(this.appConfig, this.hudState)
            : '';
        }
        break;

      case 'copyText':
        if (payload) {
          navigator.clipboard.writeText(payload);
          this.showToast('已复制内容到剪贴板 📋');
        }
        break;

      case 'copySuggestion':
        const item = this.hudState.suggestions.find((s) => s.id === payload);
        if (item) {
          navigator.clipboard.writeText(item.detail);
          this.showToast(`已复制: "${item.title}"`);
        }
        break;

      case 'setSubtitleMode':
        this.hudState.displayMode = payload as SubtitleDisplayMode;
        document.querySelectorAll('.hud-mode-pill .mode-btn').forEach((btn) => btn.classList.remove('active'));
        if (payload === 'bilingual') document.getElementById('modeBtnBilingual')?.classList.add('active');
        if (payload === 'target_only') document.getElementById('modeBtnTarget')?.classList.add('active');
        if (payload === 'source_only') document.getElementById('modeBtnSource')?.classList.add('active');
        this.streamManager.refreshDisplayMode(this.hudState.subtitles, this.hudState.displayMode);
        break;

      case 'clearSubtitles':
        this.hudState.subtitles = [];
        this.hudState.suggestions = [];
        this.hudState.hasPredictSuggestion = false;
        this.streamManager.clear(this.hudState.isStreaming, this.hudState.hasMicPermission);
        const pred = document.getElementById('predictDrawerContainer');
        if (pred) pred.innerHTML = '';
        this.showToast('已清空字幕流');
        break;

      case 'toggleTopmost':
        this.hudState.isAlwaysOnTop = !this.hudState.isAlwaysOnTop;
        const pinBtn = document.getElementById('btnTogglePin');
        if (pinBtn) {
          if (this.hudState.isAlwaysOnTop) pinBtn.classList.add('active');
          else pinBtn.classList.remove('active');
        }
        try {
          const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          await getCurrentWebviewWindow().setAlwaysOnTop(this.hudState.isAlwaysOnTop);
        } catch {}
        this.showToast(this.hudState.isAlwaysOnTop ? '窗口已置顶固定 📌' : '已取消置顶');
        break;

      case 'exportTranscript':
        this.exportMeetingTranscript();
        break;

      case 'testSonioxConnection':
        const keyInput = document.getElementById('cfgSonioxApiKey') as HTMLInputElement;
        const key = keyInput ? keyInput.value.trim() : this.appConfig.soniox.api_key;
        this.showToast('正在向 Soniox 发起 WebSocket 实时识别握手...');
        try {
          const res = await tauriInvoke<string>('test_soniox', { apiKey: key });
          this.showToast(`✅ ${res}`);
        } catch (err: any) {
          this.showToast(`❌ 连接失败: ${err?.message || err}`);
        }
        break;

      case 'simulateSpeech':
        this.showToast('🎙️ 正在推送 8.5 秒真实语音测试流...');
        try {
          if (!this.hudState.isStreaming) {
            await this.startLiveStream();
          }
          const simRes = await tauriInvoke<string>('simulate_test_speech');
          this.showToast(`✅ ${simRes}`);
          this.handleAction('toggleSettings'); // 关闭设置窗口让用户观察字幕
        } catch (err: any) {
          this.showToast(`❌ 模拟失败: ${err?.message || err}`);
        }
        break;

      case 'saveAllConfig':
        const sonioxInput = document.getElementById('cfgSonioxApiKey') as HTMLInputElement;
        if (sonioxInput) this.appConfig.soniox.api_key = sonioxInput.value.trim();
        const targetLang = document.getElementById('cfgSonioxTargetLang') as HTMLSelectElement;
        if (targetLang) this.appConfig.soniox.target_language = targetLang.value;
        const openrouterUrl = document.getElementById('cfgOpenRouterBaseUrl') as HTMLInputElement;
        if (openrouterUrl) this.appConfig.openrouter.base_url = openrouterUrl.value.trim();

        try {
          await tauriInvoke('save_config', { newConfig: this.appConfig });
          this.showToast('✅ 配置已成功保存！');
          this.handleAction('toggleSettings');
        } catch (e: any) {
          this.showToast(`⚠️ 保存失败: ${e?.message || e}`);
        }
        break;
    }
  }

  private exportMeetingTranscript() {
    if (this.hudState.subtitles.length === 0) {
      this.showToast('当前暂无字幕记录可导出');
      return;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString();
    const timeStr = now.toLocaleTimeString();

    const distinctSpeakers = Array.from(
      new Set(this.hudState.subtitles.map((s) => s.speaker))
    ).join(', ');

    let md = `# LiveHear 会议速记与同传纪要\n\n`;
    md += `- **记录时间**: ${dateStr} ${timeStr}\n`;
    md += `- **会议主题**: ${this.appConfig.meeting.context}\n`;
    md += `- **同传引擎**: Soniox v5 (全语种原生识别 + 说话人声纹分离)\n`;
    md += `- **参会发言人**: ${distinctSpeakers || '未知'}\n\n`;
    md += `---\n\n## 逐字记录与双语同传\n\n`;
    md += `| 时间 | 发言人 | 原生发言 | 中文同传 |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;

    for (const item of this.hudState.subtitles) {
      const orig = (item.original || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const trans = (item.translated || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      md += `| ${item.timestamp} | ${item.speaker} | ${orig} | ${trans} |\n`;
    }

    if (this.hudState.suggestions.length > 0) {
      md += `\n---\n\n## 智能决策与策略提炼\n\n`;
      for (const sug of this.hudState.suggestions) {
        md += `- **[${sug.title}]**: ${sug.detail}\n`;
      }
    }

    // 触发 Markdown 文件下载
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LiveHear_会议纪要_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.md`;
    a.click();
    URL.revokeObjectURL(url);

    // 同步写入剪贴板
    navigator.clipboard.writeText(md);
    this.showToast('✅ 会议纪要已成功导出并复制到剪贴板！');
  }

  private async startLiveStream() {
    try {
      console.log('🚀 正在启动 Soniox 实时流与 Web Audio 麦克风采集...');
      const micOk = await this.audioRecorder.start();
      this.hudState.hasMicPermission = micOk;

      if (!micOk) {
        this.streamManager.clear(false, false);
        this.showToast('⚠️ 未能访问麦克风，请点击界面中间的「请求授权」按钮');
        return;
      }

      await tauriInvoke('start_soniox_live');
      this.hudState.isStreaming = true;

      const liveBtn = document.getElementById('btnToggleLive');
      if (liveBtn) {
        liveBtn.className = 'live-status-pill no-drag streaming';
        liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">正在同传</span>`;
      }

      // 如果当前列表为空，刷新占位符状态为“正在实时收音中”
      if (this.hudState.subtitles.length === 0) {
        this.streamManager.clear(true, true);
      }

      this.showToast('🟢 Soniox 全语种实时同传已就绪，请说话');
    } catch (err: any) {
      console.warn('启动实时流错误:', err);
      this.hudState.isStreaming = false;
    }
  }

  private async stopLiveStream() {
    this.audioRecorder.stop();
    try {
      await tauriInvoke('stop_soniox_live');
    } catch {}
    this.hudState.isStreaming = false;

    const liveBtn = document.getElementById('btnToggleLive');
    if (liveBtn) {
      liveBtn.className = 'live-status-pill no-drag paused';
      liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">开始同传</span>`;
    }

    this.showToast('已暂停实时语音同传');
  }

  private showToast(msg: string) {
    const existing = document.querySelector('.livehear-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'livehear-toast';
    toast.innerText = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }
}

// 初始化应用
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    new LiveHearApp();
  });
}
