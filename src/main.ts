import {
  renderHudView,
  renderSubtitleTurnHtml,
  renderEmptyPlaceholder,
  renderSuggestionsHtml,
  renderSettingsModalHtml,
  renderQuickLangPopoverHtml,
  renderLookupPopoverHtml,
  formatTopbarLangBadgeText,
  type HudState,
  type SubtitleItem,
  type SubtitleDisplayMode,
  type SelectionLookupData,
} from './components/hud';
import type { FullAppConfig } from './types/domain';

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

// 高性能字幕流局部 DOM 管理器 (基于稳定 Turn ID 精确就地更新 + rAF 帧合并渲染 + 虚拟节点封顶保护)
class SubtitleStreamManager {
  private isUserScrolledUp = false;
  private maxDomNodes = 120;
  private pendingPartial: { item: SubtitleItem; displayMode: SubtitleDisplayMode } | null = null;
  private rafId: number | null = null;

  private getStreamEl(): HTMLElement | null {
    return document.getElementById('subtitlesStream');
  }

  private findTurnBlockById(streamEl: HTMLElement, id: string): HTMLElement | null {
    const blocks = streamEl.querySelectorAll('.stream-turn-block');
    for (let i = blocks.length - 1; i >= 0; i--) {
      const el = blocks[i] as HTMLElement;
      if (el.getAttribute('data-id') === id) {
        return el;
      }
    }
    return null;
  }

  public setupScrollListener() {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;
    streamEl.addEventListener('scroll', () => {
      const threshold = 80;
      const distanceFromBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
      const jumpBtn = document.getElementById('btnJumpToBottom');
      if (distanceFromBottom > threshold) {
        this.isUserScrolledUp = true;
        if (jumpBtn) jumpBtn.classList.remove('hide');
      } else {
        this.isUserScrolledUp = false;
        if (jumpBtn) jumpBtn.classList.add('hide');
      }
    }, { passive: true });
  }

  public updateOrAppendPartial(item: SubtitleItem, displayMode: SubtitleDisplayMode) {
    this.pendingPartial = { item: { ...item }, displayMode };
    if (this.rafId !== null) return;

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const pending = this.pendingPartial;
      this.pendingPartial = null;
      if (!pending) return;
      this.commitTurnDom(pending.item, pending.displayMode, true);
    });
  }

  public finalizeLastCard(item: SubtitleItem, displayMode: SubtitleDisplayMode) {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.pendingPartial = null;
    }
    this.commitTurnDom(item, displayMode, false);
  }

  public updateLastFinalTurn(item: SubtitleItem, displayMode: SubtitleDisplayMode) {
    this.commitTurnDom(item, displayMode, false);
  }

  private commitTurnDom(item: SubtitleItem, displayMode: SubtitleDisplayMode, isPartial: boolean) {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;

    const placeholder = streamEl.querySelector('.empty-stream-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.innerHTML = renderSubtitleTurnHtml(item, displayMode);
    const newEl = div.firstElementChild as HTMLElement | null;
    if (!newEl) return;

    const existingById = this.findTurnBlockById(streamEl, item.id);
    if (existingById) {
      // 已存在同 ID 节点：取消重复入场动画，实现零闪烁就地更新
      newEl.style.animation = 'none';
      existingById.replaceWith(newEl);
    } else {
      const activePartial = streamEl.querySelector('.stream-turn-block.is-partial') as HTMLElement | null;
      if (activePartial && !isPartial) {
        newEl.style.animation = 'none';
        activePartial.replaceWith(newEl);
      } else if (activePartial && isPartial) {
        newEl.style.animation = 'none';
        activePartial.replaceWith(newEl);
      } else {
        streamEl.appendChild(newEl);
        this.cullOldNodes();
      }
    }

    if (!this.isUserScrolledUp) {
      this.scrollToBottom();
    }
  }

  public removeTurnById(id: string) {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;
    const el = this.findTurnBlockById(streamEl, id);
    if (el) el.remove();
  }

  private cullOldNodes() {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;
    const nodes = streamEl.querySelectorAll('.stream-turn-block, .subtitle-card');
    if (nodes.length > this.maxDomNodes) {
      const excess = nodes.length - this.maxDomNodes;
      for (let i = 0; i < excess; i++) {
        nodes[i]?.remove();
      }
    }
  }

  public refreshDisplayMode(subtitles: SubtitleItem[], displayMode: SubtitleDisplayMode) {
    const streamEl = this.getStreamEl();
    if (!streamEl) return;
    if (subtitles.length === 0) return;

    streamEl.innerHTML = subtitles
      .slice(-this.maxDomNodes)
      .map((item) => renderSubtitleTurnHtml(item, displayMode))
      .join('');
    this.scrollToBottom(true);
  }

  public clear(isStreaming: boolean, hasPermission: boolean) {
    const streamEl = this.getStreamEl();
    if (streamEl) {
      streamEl.innerHTML = renderEmptyPlaceholder(isStreaming, hasPermission);
    }
  }

  public scrollToBottom(force = false) {
    const streamEl = this.getStreamEl();
    if (streamEl) {
      if (force) {
        this.isUserScrolledUp = false;
        const jumpBtn = document.getElementById('btnJumpToBottom');
        if (jumpBtn) jumpBtn.classList.add('hide');
        streamEl.scrollTo({ top: streamEl.scrollHeight, behavior: 'smooth' });
      } else if (!this.isUserScrolledUp) {
        streamEl.scrollTop = streamEl.scrollHeight;
      }
    }
  }
}

class LiveHearApp {
  private appConfig: FullAppConfig = {
    soniox: {
      api_key: '',
      ws_url: 'wss://stt-rt.soniox.com/transcribe-websocket',
      model: 'stt-rt-v5',
      sample_rate: 16000,
      enable_speaker_diarization: true,
      language_hints: ['en', 'zh'],
      language_hints_strict: true,
      enable_translation: true,
      translation_type: 'one_way',
      target_language: 'zh',
      language_a: 'en',
      language_b: 'zh',
      max_endpoint_delay_ms: 2000,
      custom_terms: [],
      enable_vad: true,
      vad_threshold: 1.8,
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

  private isStarting = false;

  private hudState: HudState = {
    isMicActive: true,
    isSpeakerActive: true,
    isClickThrough: false,
    isAlwaysOnTop: true,
    isStreaming: false,
    sonioxLatencyMs: 64,
    displayMode: 'bilingual',
    subtitles: [],
    hasPredictSuggestion: false,
    suggestions: [],
    micVolume: 0,
    hasMicPermission: true,
    isSettingsOpen: false,
  };

  private streamManager: SubtitleStreamManager;
  private polishTimer: any = null;

  constructor() {
    this.streamManager = new SubtitleStreamManager();

    this.detectPlatform();
    this.bindGlobalHandlers();
    this.bindKeyboardShortcuts();
    this.bindSelectionLookupListener();
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
    this.streamManager.setupScrollListener();
  }

  private updateMicVolume(volume: number) {
    if (this.hudState.micVolume === volume) return;
    if (volume === 0 && this.hudState.micVolume === 0) return;
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
      const s = Math.max(0.25, Math.min(1.0, volume / 60));
      (bars[0] as HTMLElement).style.transform = `scaleY(${Math.max(0.25, s * 0.7)}) translateZ(0)`;
      (bars[1] as HTMLElement).style.transform = `scaleY(${Math.max(0.25, s * 1.0)}) translateZ(0)`;
      (bars[2] as HTMLElement).style.transform = `scaleY(${Math.max(0.25, s * 0.6)}) translateZ(0)`;
      (bars[3] as HTMLElement).style.transform = `scaleY(${Math.max(0.25, s * 0.85)}) translateZ(0)`;
    }

    if (this.hudState.isSettingsOpen) {
      const diagText = document.getElementById('diagVolumeText');
      if (diagText) diagText.textContent = `${volume}%`;
      const diagFill = document.getElementById('diagMeterFill');
      if (diagFill) diagFill.style.width = `${volume}%`;
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
        this.refreshTopbarBadges();
      }
    } catch (e) {
      console.warn('读取配置失败:', e);
    }

    if (!this.appConfig.soniox.api_key.trim()) {
      this.showToast('⚠️ 请先在设置中填写 Soniox API Key');
      if (!this.hudState.isSettingsOpen) await this.handleAction('toggleSettings');
      return;
    }

    await this.startLiveStream();
  }

  private async initTauriListeners() {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 1. 原生麦克风电平事件监听
        await listen('audio-level', (event: any) => {
          const vol = event.payload?.volume ?? 0;
          this.updateMicVolume(vol);
        });

        // 2. 实时流式往返延迟事件监听 (⚡ Soniox Latency)
        await listen('soniox-latency', (event: any) => {
          const ms = event.payload?.latency_ms ?? 64;
          this.hudState.sonioxLatencyMs = ms;
          const badge = document.getElementById('hudLatencyBadge');
          if (badge) {
            badge.textContent = `⚡ ${ms}ms`;
          }
        });

        // 3. ASR 运行状态机监听
        await listen('asr-status', (event: any) => {
          const status = event.payload;
          console.log('📡 [ASR Status]', status);
          const liveBtn = document.getElementById('btnToggleLive');
          if (status === 'connected') {
            this.hudState.isStreaming = true;
            if (liveBtn) {
              liveBtn.className = 'live-status-pill no-drag streaming';
              liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">正在同传</span>`;
            }
          } else if (status === 'connecting') {
            if (liveBtn) {
              liveBtn.className = 'live-status-pill no-drag paused';
              liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">连接中...</span>`;
            }
          } else if (status === 'stopped' || status === 'error') {
            this.hudState.isStreaming = false;
            if (liveBtn) {
              liveBtn.className = 'live-status-pill no-drag paused';
              liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">开始同传</span>`;
            }
            this.updateMicVolume(0);
          }
        });

        // 4. ASR 错误事件监听
        await listen('asr-error', (event: any) => {
          const err = event.payload;
          console.error('❌ [ASR Error]', err);
          this.showToast(`⚠️ ${err}`);
        });

        const parseSpeakerName = (spk: any): string => {
          if (!spk) return '说话人 1';
          if (typeof spk === 'string') return spk;
          if (spk.display_name) return String(spk.display_name);
          if (spk.role) {
            if (typeof spk.role === 'string') return spk.role;
            if (spk.role.RemoteParticipant) return `Speaker ${spk.role.RemoteParticipant}`;
            if (spk.role.LocalUser !== undefined) return '我 (Microphone)';
          }
          return '说话人 1';
        };

        const stripControl = (s?: string): string =>
          (s || '').replace(/<end>/g, '').replace(/<fin>/g, '');

        const joinText = (a: string, b: string) => {
          if (!a) return b;
          if (!b) return a;
          if (/[\s\n]$/.test(a) || /^[\s\n]/.test(b)) return `${a}${b}`;
          const isEndZh = /[\u4e00-\u9fa5，。？！、；：]$/.test(a);
          const isStartZh = /^[\u4e00-\u9fa5，。？！、；：]/.test(b);
          return isEndZh && isStartZh ? `${a}${b}` : `${a} ${b}`;
        };

        const isParagraphFull = (text: string): boolean => {
          const trimmed = (text || '').trim();
          if (!trimmed) return false;
          let zhCount = 0;
          for (let i = 0; i < trimmed.length; i++) {
            const c = trimmed.charCodeAt(i);
            if (c >= 0x4e00 && c <= 0x9fff) zhCount++;
          }
          if (zhCount > trimmed.length * 0.3) {
            return trimmed.length >= 85;
          }
          const words = trimmed.split(/\s+/).length;
          return words >= 36 || trimmed.length >= 190;
        };

        // 记录当前流式 Turn 合并到哪一张同发言人既有卡片：{ targetId, baseOrig, baseTrans }
        const coalesceMap = new Map<
          string,
          { targetId: string; baseOrig: string; baseTrans: string }
        >();

        const resolveCoalesceBinding = (
          turnId: string,
          speaker: string,
          nowMs: number
        ): { targetId: string; baseOrig: string; baseTrans: string } | null => {
          const existing = coalesceMap.get(turnId);
          if (existing) return existing;

          const lastIdx = this.hudState.subtitles.length - 1;
          if (lastIdx < 0) return null;
          const last = this.hudState.subtitles[lastIdx];
          if (last.id === turnId) return null;

          // 若上一张卡片属于同一说话人、间隔在 6.5 秒内且尚未写满一整段，则直接在原卡片内无缝续写，
          // 既杜绝“新建临时卡片又删除”的闪烁，又将同一人的多句发言自然聚合成完整语义段落！
          const elapsed = last.lastUpdatedMs ? nowMs - last.lastUpdatedMs : 0;
          if (
            !last.isPartial &&
            last.speaker === speaker &&
            elapsed < 6500 &&
            !isParagraphFull(last.original)
          ) {
            const binding = {
              targetId: last.id,
              baseOrig: last.original,
              baseTrans: last.translated,
            };
            coalesceMap.set(turnId, binding);
            return binding;
          }
          return null;
        };

        const computeContinuation = (speaker: string, excludeId?: string, nowMs = Date.now()): boolean => {
          for (let i = this.hudState.subtitles.length - 1; i >= 0; i--) {
            const sub = this.hudState.subtitles[i];
            if (excludeId && sub.id === excludeId) continue;
            return (
              sub.speaker === speaker &&
              (sub.lastUpdatedMs ? nowMs - sub.lastUpdatedMs < 60000 : true)
            );
          }
          return false;
        };

        // 5. 流式 Partial 事件监听（同发言人段落内无缝原地续写 + 确认词/临时词分层）
        const handlePartial = (event: any) => {
          const payload = event.payload;
          const segment = payload?.segment || payload;
          if (!segment) return;

          const speaker = parseSpeakerName(segment.speaker);
          const original = stripControl(segment.text).trim();
          const translated = stripControl(segment.translated_text).trim();
          const detectedLanguage = segment.detected_language;

          if (!original && !translated) return;

          const rawTurnId = segment.id || 'current_partial';
          const nowMs = Date.now();
          const binding = resolveCoalesceBinding(rawTurnId, speaker, nowMs);

          if (binding) {
            const targetIdx = this.hudState.subtitles.findIndex((s) => s.id === binding.targetId);
            if (targetIdx >= 0) {
              const target = this.hudState.subtitles[targetIdx];
              const segConfOrig = segment.confirmed_text ? stripControl(segment.confirmed_text) : '';
              const segProvOrig = segment.provisional_text
                ? stripControl(segment.provisional_text)
                : !segConfOrig
                ? original
                : '';
              const segConfTrans = segment.confirmed_translated_text
                ? stripControl(segment.confirmed_translated_text)
                : '';
              const segProvTrans = segment.provisional_translated_text
                ? stripControl(segment.provisional_translated_text)
                : !segConfTrans
                ? translated
                : '';

              target.original = joinText(binding.baseOrig, original);
              target.translated = joinText(binding.baseTrans, translated);
              target.confirmedOriginal = joinText(binding.baseOrig, segConfOrig);
              target.provisionalOriginal = segProvOrig ? ` ${segProvOrig.trimStart()}` : undefined;
              target.confirmedTranslated = joinText(binding.baseTrans, segConfTrans);
              target.provisionalTranslated = segProvTrans || undefined;
              target.isPartial = true;
              target.lastUpdatedMs = nowMs;

              this.streamManager.updateOrAppendPartial(target, this.hudState.displayMode);
              return;
            }
          }

          const existingIdx = this.hudState.subtitles.findIndex((s) => s.id === rawTurnId);
          const existingItem = existingIdx >= 0 ? this.hudState.subtitles[existingIdx] : null;

          const item: SubtitleItem = {
            id: rawTurnId,
            speaker,
            isTrackRemote: true,
            original: original || '...',
            translated: translated || '正在同传中...',
            confirmedOriginal: segment.confirmed_text ? stripControl(segment.confirmed_text) : undefined,
            provisionalOriginal: segment.provisional_text ? stripControl(segment.provisional_text) : undefined,
            confirmedTranslated: segment.confirmed_translated_text
              ? stripControl(segment.confirmed_translated_text)
              : undefined,
            provisionalTranslated: segment.provisional_translated_text
              ? stripControl(segment.provisional_translated_text)
              : undefined,
            detectedLanguage,
            timestamp: existingItem?.timestamp || new Date().toLocaleTimeString(),
            isPartial: true,
            isContinuation: computeContinuation(speaker, rawTurnId, nowMs),
            lastUpdatedMs: nowMs,
          };

          if (existingIdx >= 0) {
            this.hudState.subtitles[existingIdx] = item;
          } else {
            const lastIdx = this.hudState.subtitles.length - 1;
            if (lastIdx >= 0 && this.hudState.subtitles[lastIdx].isPartial) {
              this.hudState.subtitles[lastIdx] = item;
            } else {
              this.hudState.subtitles.push(item);
            }
          }

          this.streamManager.updateOrAppendPartial(item, this.hudState.displayMode);
        };

        // 6. 终态 Final 事件监听 (零阻塞即时锁定 + 同发言人段落聚合与全段 AI 语义纠偏润色)
        const handleFinal = (event: any) => {
          const payload = event.payload;
          const segment = payload?.segment || payload;
          if (!segment) return;

          const speaker = parseSpeakerName(segment.speaker);
          const original = stripControl(segment.text).trim();
          const translated = stripControl(segment.translated_text).trim();
          const detectedLanguage = segment.detected_language;
          const lowConfidenceWords: string[] = Array.isArray(segment.low_confidence_words)
            ? segment.low_confidence_words
            : [];

          if (!original && !translated) return;

          const nowMs = Date.now();
          const rawTurnId = segment.id || `final-${nowMs}`;
          const binding = resolveCoalesceBinding(rawTurnId, speaker, nowMs);
          coalesceMap.delete(rawTurnId);

          if (binding) {
            const targetIdx = this.hudState.subtitles.findIndex((s) => s.id === binding.targetId);
            if (targetIdx >= 0) {
              const target = this.hudState.subtitles[targetIdx];
              target.original = joinText(binding.baseOrig, original);
              target.translated = joinText(binding.baseTrans, translated || original);
              target.confirmedOriginal = target.original;
              target.confirmedTranslated = target.translated;
              target.provisionalOriginal = undefined;
              target.provisionalTranslated = undefined;
              target.isPartial = false;
              target.isPolished = false;
              target.lastUpdatedMs = nowMs;
              if (lowConfidenceWords.length > 0) {
                target.lowConfidenceWords = Array.from(
                  new Set([...(target.lowConfidenceWords || []), ...lowConfidenceWords])
                );
              }

              this.streamManager.finalizeLastCard(target, this.hudState.displayMode);
              this.scheduleTurnPolish(target);

              if (payload.suggestions && payload.suggestions.length > 0) {
                this.renderSuggestionDrawer(payload.suggestions, payload.intent);
              }
              return;
            }
          }

          const existingIdx = this.hudState.subtitles.findIndex((s) => s.id === rawTurnId);
          const existingTime =
            existingIdx >= 0 ? this.hudState.subtitles[existingIdx].timestamp : new Date().toLocaleTimeString();

          const item: SubtitleItem = {
            id: rawTurnId,
            speaker,
            isTrackRemote: true,
            original,
            translated: translated || original,
            confirmedOriginal: original,
            confirmedTranslated: translated || original,
            detectedLanguage,
            timestamp: existingTime,
            isPartial: false,
            isContinuation: computeContinuation(speaker, rawTurnId, nowMs),
            lastUpdatedMs: nowMs,
            lowConfidenceWords,
          };

          if (existingIdx >= 0) {
            this.hudState.subtitles[existingIdx] = item;
          } else {
            const lastIdx = this.hudState.subtitles.length - 1;
            if (lastIdx >= 0 && this.hudState.subtitles[lastIdx].isPartial) {
              this.hudState.subtitles[lastIdx] = item;
            } else {
              this.hudState.subtitles.push(item);
            }
          }

          this.streamManager.finalizeLastCard(item, this.hudState.displayMode);
          this.scheduleTurnPolish(item);

          if (payload.suggestions && payload.suggestions.length > 0) {
            this.renderSuggestionDrawer(payload.suggestions, payload.intent);
          }
        };

        // 7. 后台非阻塞智能应答建议事件监听
        await listen('asr-suggestions', (event: any) => {
          const payload = event.payload;
          if (payload?.suggestions && payload.suggestions.length > 0) {
            this.renderSuggestionDrawer(payload.suggestions, payload.intent);
          }
        });

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
    (window as any).__livehear_action = (action: string, payload?: any, extra?: any) => {
      this.handleAction(action, payload, extra);
    };
  }

  private bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        this.closeSelectionLookup();
        if (this.hudState.isQuickLangOpen) {
          this.handleAction('toggleQuickLangPopover');
        }
        return;
      }
      if (isCmd && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        this.handleAction('toggleTopmost');
      } else if (isCmd && e.shiftKey && e.code === 'KeyH') {
        e.preventDefault();
        this.handleAction('toggleStealthMode');
      } else if (isCmd && e.shiftKey && e.code === 'KeyX') {
        e.preventDefault();
        this.handleAction('toggleClickThrough');
      } else if (isCmd && e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        this.handleAction('clearSubtitles');
      } else if (isCmd && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        this.handleAction('exportTranscript');
      } else if (isCmd && e.code === 'KeyK') {
        e.preventDefault();
        this.handleAction('openCopilotDrawer');
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

  private bindSelectionLookupListener() {
    let lookupDebounce: any = null;

    const handleTriggerLookup = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('#selectionLookupPopover') ||
        target.closest('#quickLangPopover') ||
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea')
      ) {
        return;
      }

      const streamEl = document.getElementById('subtitlesStream');
      if (!streamEl || !streamEl.contains(target)) {
        this.closeSelectionLookup();
        return;
      }

      if (lookupDebounce) clearTimeout(lookupDebounce);
      lookupDebounce = setTimeout(async () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const selectedText = sel.toString().trim();
        if (selectedText.length < 2 || selectedText.length > 180) return;

        let rect: DOMRect | null = null;
        try {
          rect = sel.getRangeAt(0).getBoundingClientRect();
        } catch {
          return;
        }
        if (!rect || (rect.width === 0 && rect.height === 0)) return;

        const turnBlock = target.closest('.stream-turn-block') as HTMLElement | null;
        const turnId = turnBlock?.getAttribute('data-id');
        const subItem = turnId ? this.hudState.subtitles.find((s) => s.id === turnId) : undefined;
        const sentenceContext = subItem
          ? `原声: ${subItem.original || ''} | 译文: ${subItem.translated || ''}`
          : turnBlock?.innerText || '';

        const popX = Math.max(14, Math.min(window.innerWidth - 340, rect.left));
        const popY =
          rect.bottom + 150 > window.innerHeight
            ? Math.max(46, rect.top - 135)
            : rect.bottom + 8;

        this.renderSelectionLookup({
          text: selectedText,
          phonetic_or_type: '',
          meaning: '',
          context_explanation: '',
          loading: true,
          x: popX,
          y: popY,
        });

        try {
          const result = await tauriInvoke<{
            text: string;
            phonetic_or_type: string;
            meaning: string;
            context_explanation: string;
            term_pair?: string | null;
          }>('lookup_selection', {
            selection: selectedText,
            sentenceContext,
          });
          this.renderSelectionLookup({
            ...result,
            loading: false,
            x: popX,
            y: popY,
          });
        } catch (err: any) {
          this.renderSelectionLookup({
            text: selectedText,
            phonetic_or_type: '查词提示',
            meaning: err?.message || '请先在设置中配置 AI 智囊 API Key',
            context_explanation: '',
            loading: false,
            x: popX,
            y: popY,
          });
        }
      }, 140);
    };

    document.addEventListener('mouseup', handleTriggerLookup);
    document.addEventListener('dblclick', handleTriggerLookup);
    document.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('#selectionLookupPopover')) {
        const container = document.getElementById('selectionLookupContainer');
        if (container && container.innerHTML) {
          this.closeSelectionLookup();
        }
      }
      if (
        this.hudState.isQuickLangOpen &&
        target &&
        !target.closest('#quickLangPopover') &&
        !target.closest('#btnQuickLangPill')
      ) {
        this.hudState.isQuickLangOpen = false;
        const qlContainer = document.getElementById('quickLangPopoverContainer');
        if (qlContainer) qlContainer.innerHTML = '';
      }
    });
  }

  private renderSelectionLookup(data: SelectionLookupData) {
    const container = document.getElementById('selectionLookupContainer');
    if (container) {
      container.innerHTML = renderLookupPopoverHtml(data);
    }
  }

  private closeSelectionLookup() {
    const container = document.getElementById('selectionLookupContainer');
    if (container) {
      container.innerHTML = '';
    }
  }

  private renderSuggestionDrawer(
    suggestions: any[],
    intent?: string,
    isLoading = false,
    customIntent = ''
  ) {
    this.hudState.suggestions = suggestions;
    this.hudState.hasPredictSuggestion = true;
    this.hudState.intentCategory = intent;
    this.hudState.isCopilotLoading = isLoading;
    const container = document.getElementById('predictDrawerContainer');
    if (container) {
      container.innerHTML = renderSuggestionsHtml(suggestions, intent, isLoading, customIntent);
    }
    document.getElementById('btnOpenCopilot')?.classList.add('active');
  }

  private async requestCopilotPrompts(customIntent?: string, focusTurnId?: string) {
    const label = customIntent
      ? `自定义意图: ${customIntent.slice(0, 12)}`
      : focusTurnId
      ? '针对单句回应'
      : '结合上文提词';

    this.renderSuggestionDrawer(this.hudState.suggestions, label, true, customIntent || '');

    let contextSlice = this.hudState.subtitles.filter(
      (s) => s.original || s.translated
    );
    if (focusTurnId) {
      const idx = contextSlice.findIndex((s) => s.id === focusTurnId);
      if (idx >= 0) {
        contextSlice = contextSlice.slice(Math.max(0, idx - 4), idx + 1);
      }
    } else {
      contextSlice = contextSlice.slice(-6);
    }

    const recentHistory = contextSlice
      .map((s) => {
        const o = (s.original || '').trim();
        const t = (s.translated || '').trim();
        const mark = focusTurnId && s.id === focusTurnId ? '【对方刚说·需回应】' : '';
        return t && t !== o
          ? `${mark}[${s.speaker}] 原声: ${o} | 译文: ${t}`
          : `${mark}[${s.speaker}]: ${o}`;
      })
      .join('\n');

    try {
      const suggestions = await tauriInvoke<any[]>('generate_copilot_prompts', {
        recentHistory,
        userIntent: customIntent && customIntent.trim() ? customIntent.trim() : null,
      });
      this.renderSuggestionDrawer(suggestions, label, false, customIntent || '');
    } catch (err: any) {
      this.renderSuggestionDrawer(
        this.hudState.suggestions,
        label,
        false,
        customIntent || ''
      );
      this.showToast(`⚠️ 生成提词失败: ${err?.message || err}`);
    }
  }

  private scheduleTurnPolish(item: SubtitleItem) {
    if (this.appConfig.openrouter?.enable_polish === false) return;
    if (!item.original || !item.translated || item.isPartial) return;
    if (!this.appConfig.openrouter?.api_key?.trim()) return;

    const origTrimmed = item.original.trim();
    const wordCount = origTrimmed.split(/\s+/).filter(Boolean).length;
    const cjkCount = (origTrimmed.match(/[\u4e00-\u9fff]/g) || []).length;
    const hasLowConf = Boolean(item.lowConfidenceWords && item.lowConfidenceWords.length > 0);
    // 若包含声学低置信度词，则放宽长度门限（外语 >= 2 词或中文 >= 4 字即触发纠偏）；否则常规门限（>= 4 词或 >= 8 字）
    if (hasLowConf) {
      if (wordCount < 2 && cjkCount < 4) return;
    } else if (wordCount < 4 && cjkCount < 8) {
      return;
    }

    if (this.polishTimer) {
      clearTimeout(this.polishTimer);
      this.polishTimer = null;
    }

    const targetTurnId = item.id;
    this.polishTimer = setTimeout(async () => {
      try {
        const curIdx = this.hudState.subtitles.findIndex((s) => s.id === targetTurnId);
        const curItem = curIdx >= 0 ? this.hudState.subtitles[curIdx] : item;
        const prevTurns =
          curIdx > 0
            ? this.hudState.subtitles
                .slice(Math.max(0, curIdx - 4), curIdx)
                .filter((s) => !s.isPartial && (s.original || s.translated))
                .map((s) => {
                  const o = (s.original || '').trim();
                  const t = (s.translated || '').trim();
                  return t && t !== o ? `[${s.speaker}] 原声: ${o} | 译文: ${t}` : `[${s.speaker}]: ${o}`;
                })
                .join('\n')
            : '';

        const res = await tauriInvoke<
          { original?: string; translated?: string; tone_tag?: string | null } | string
        >('polish_transcript', {
          original: curItem.original,
          draft: curItem.translated,
          recentHistory: prevTurns,
          lowConfidenceWords: curItem.lowConfidenceWords || [],
        });

        const cur = this.hudState.subtitles.find((s) => s.id === targetTurnId);
        if (!cur) return;

        let nextOrig = cur.original;
        let nextTrans = cur.translated;
        let nextTone = cur.toneTag;
        if (typeof res === 'string') {
          if (res.trim()) nextTrans = res.trim();
        } else if (res && typeof res === 'object') {
          if (res.original && res.original.trim()) nextOrig = res.original.trim();
          if (res.translated && res.translated.trim()) nextTrans = res.translated.trim();
          if (res.tone_tag && res.tone_tag.trim()) nextTone = res.tone_tag.trim();
        }

        if (nextOrig !== cur.original || nextTrans !== cur.translated || nextTone !== cur.toneTag) {
          cur.original = nextOrig;
          cur.confirmedOriginal = nextOrig;
          cur.translated = nextTrans;
          cur.confirmedTranslated = nextTrans;
          cur.toneTag = nextTone;
          cur.isPolished = true;
          this.streamManager.updateLastFinalTurn(cur, this.hudState.displayMode);
        }
      } catch (err) {
        console.warn('AI 润色串联跳过或失败:', err);
      }
    }, 750);
  }

  private async handleAction(action: string, payload?: any, extra?: any) {
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
          this.showToast('⚠️ 未能获得权限，请在「系统设置 -> 隐私与安全性 -> 麦克风」中允许 LiveHear');
        }
        break;

      case 'toggleSettings':
        this.hudState.isSettingsOpen = !this.hudState.isSettingsOpen;
        if (this.hudState.isSettingsOpen) {
          try {
            const devices = await tauriInvoke<string[]>('list_audio_devices');
            if (Array.isArray(devices)) {
              this.hudState.audioDevices = devices;
            }
          } catch {}
        }
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
          this.showToast('✓ 已复制内容到剪贴板 📋');

          // 为触发该动作的按钮添加即时高亮反馈
          if (extra && extra instanceof HTMLElement) {
            extra.classList.add('copied');
            const lbl = extra.querySelector('.copy-label');
            const ico = extra.querySelector('.copy-icon');
            if (lbl) lbl.textContent = '已复制';
            if (ico) ico.textContent = '✓';
            setTimeout(() => {
              extra.classList.remove('copied');
              if (lbl) lbl.textContent = '复制';
              if (ico) ico.textContent = '📋';
            }, 1200);
          }
        }
        break;

      case 'jumpToBottom':
        this.streamManager.scrollToBottom(true);
        break;

      case 'copySuggestion':
        const item = this.hudState.suggestions.find((s) => s.id === payload);
        if (item) {
          const cleanSpoken = item.detail.replace(/\s*[\(（][^\)）]+[\)）]\s*$/, '').trim();
          navigator.clipboard.writeText(cleanSpoken || item.detail);
          this.showToast(`✅ 已复制发言词: "${cleanSpoken || item.title}"`);
        }
        break;

      case 'toggleQuickLangPopover':
        this.hudState.isQuickLangOpen = !this.hudState.isQuickLangOpen;
        const qlContainer = document.getElementById('quickLangPopoverContainer');
        if (qlContainer) {
          qlContainer.innerHTML = this.hudState.isQuickLangOpen
            ? renderQuickLangPopoverHtml(this.appConfig)
            : '';
        }
        break;

      case 'selectLangPreset':
        if (typeof payload === 'string') {
          this.appConfig.soniox.language_hints = payload
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const qlEl = document.getElementById('quickLangPopoverContainer');
          if (qlEl) qlEl.innerHTML = renderQuickLangPopoverHtml(this.appConfig);
        }
        break;

      case 'quickSetTransMode':
        if (payload === 'one_way' || payload === 'two_way') {
          const hintsBox = document.getElementById('quickHintsInput') as HTMLInputElement | null;
          if (hintsBox) {
            this.appConfig.soniox.language_hints = hintsBox.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          }
          const strictBox = document.getElementById('quickStrictCheckbox') as HTMLInputElement | null;
          if (strictBox) {
            this.appConfig.soniox.language_hints_strict = strictBox.checked;
          }
          this.appConfig.soniox.translation_type = payload;
          const qlEl = document.getElementById('quickLangPopoverContainer');
          if (qlEl) qlEl.innerHTML = renderQuickLangPopoverHtml(this.appConfig);
        }
        break;

      case 'quickSetTargetLang':
        if (typeof payload === 'string') {
          const hintsBox = document.getElementById('quickHintsInput') as HTMLInputElement | null;
          if (hintsBox) {
            this.appConfig.soniox.language_hints = hintsBox.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          }
          const strictBox = document.getElementById('quickStrictCheckbox') as HTMLInputElement | null;
          if (strictBox) {
            this.appConfig.soniox.language_hints_strict = strictBox.checked;
          }
          this.appConfig.soniox.target_language = payload;
          const qlEl = document.getElementById('quickLangPopoverContainer');
          if (qlEl) qlEl.innerHTML = renderQuickLangPopoverHtml(this.appConfig);
        }
        break;

      case 'applyQuickLangConfig': {
        const hintsBox = document.getElementById('quickHintsInput') as HTMLInputElement | null;
        if (hintsBox) {
          this.appConfig.soniox.language_hints = hintsBox.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
        const strictBox = document.getElementById('quickStrictCheckbox') as HTMLInputElement | null;
        if (strictBox) {
          this.appConfig.soniox.language_hints_strict = strictBox.checked;
        }
        this.hudState.isQuickLangOpen = false;
        const qlEl = document.getElementById('quickLangPopoverContainer');
        if (qlEl) qlEl.innerHTML = '';

        try {
          await tauriInvoke('save_config', { newConfig: this.appConfig });
          this.refreshTopbarBadges();
          if (this.hudState.isStreaming) {
            await this.stopLiveStream(false);
            await this.startLiveStream();
            this.showToast('⚡ 已应用语种配置并热切同传流！');
          } else {
            this.showToast('✅ 语种与目标语言配置已更新');
          }
        } catch (err: any) {
          this.showToast(`⚠️ 更新失败: ${err?.message || err}`);
        }
        break;
      }

      case 'closeSelectionLookup':
        this.closeSelectionLookup();
        break;

      case 'addTermFromLookup':
        if (typeof payload === 'string' && payload.trim()) {
          const term = payload.trim();
          const existing = this.appConfig.soniox.custom_terms || [];
          if (!existing.includes(term)) {
            this.appConfig.soniox.custom_terms = [...existing, term];
            try {
              await tauriInvoke('save_config', { newConfig: this.appConfig });
            } catch {}
          }
          this.closeSelectionLookup();
          this.showToast(`✅ 已将「${term}」加入会议术语表`);
        }
        break;

      case 'openCopilotDrawer':
      case 'refreshCopilotPrompts':
        await this.requestCopilotPrompts();
        break;

      case 'summarizeRecentContext': {
        this.renderSuggestionDrawer(this.hudState.suggestions, '📝 3秒浓缩前文 (TL;DR)', true);
        const recentSlice = this.hudState.subtitles
          .filter((s) => s.original || s.translated)
          .slice(-14)
          .map((s) => {
            const o = (s.original || '').trim();
            const t = (s.translated || '').trim();
            return t && t !== o ? `[${s.speaker}] 原声: ${o} | 译文: ${t}` : `[${s.speaker}]: ${o}`;
          })
          .join('\n');

        try {
          const cards = await tauriInvoke<any[]>('summarize_meeting_context', {
            recentHistory: recentSlice,
          });
          this.renderSuggestionDrawer(cards, '📝 3秒浓缩前文 (TL;DR)', false);
        } catch (err: any) {
          this.renderSuggestionDrawer(this.hudState.suggestions, '📝 3秒浓缩前文 (TL;DR)', false);
          this.showToast(`⚠️ 浓缩前文失败: ${err?.message || err}`);
        }
        break;
      }

      case 'toggleStealthMode': {
        this.hudState.isStealthMode = !this.hudState.isStealthMode;
        const stealthBtn = document.getElementById('btnToggleStealth');
        if (stealthBtn) {
          if (this.hudState.isStealthMode) {
            stealthBtn.classList.add('active', 'stealth-active');
          } else {
            stealthBtn.classList.remove('active', 'stealth-active');
          }
        }
        try {
          await tauriInvoke('set_stealth_mode', { enabled: Boolean(this.hudState.isStealthMode) });
          this.showToast(
            this.hudState.isStealthMode
              ? '🕶️ 投屏隐身已开启：共享屏幕/截图时此窗口完全隐形'
              : '已关闭投屏隐身模式'
          );
        } catch (err: any) {
          this.showToast(`⚠️ 设置投屏隐身失败: ${err?.message || err}`);
        }
        break;
      }

      case 'toggleClickThrough': {
        this.hudState.isClickThrough = !this.hudState.isClickThrough;
        const ctBtn = document.getElementById('btnToggleClickThrough');
        const hudWin = document.querySelector('.hud-window');
        if (ctBtn) {
          if (this.hudState.isClickThrough) ctBtn.classList.add('active');
          else ctBtn.classList.remove('active');
        }
        if (hudWin) {
          if (this.hudState.isClickThrough) hudWin.classList.add('is-click-through');
          else hudWin.classList.remove('is-click-through');
        }
        try {
          await tauriInvoke('set_click_through', { enabled: Boolean(this.hudState.isClickThrough) });
          this.showToast(
            this.hudState.isClickThrough
              ? '👻 鼠标穿透已开启 (按 ⌘+Shift+X 随时恢复交互)'
              : '已退出鼠标穿透，恢复窗口点击交互'
          );
        } catch (err: any) {
          this.showToast(`⚠️ 设置鼠标穿透失败: ${err?.message || err}`);
        }
        break;
      }

      case 'promptReplyForTurn':
        if (typeof payload === 'string') {
          await this.requestCopilotPrompts(undefined, payload);
        }
        break;

      case 'submitCopilotIntent': {
        const inputEl = document.getElementById('copilotIntentInput') as HTMLInputElement | null;
        const val = inputEl ? inputEl.value.trim() : '';
        await this.requestCopilotPrompts(val || undefined);
        break;
      }

      case 'insertQuickNote': {
        const inputEl = document.getElementById('copilotIntentInput') as HTMLInputElement | null;
        const noteText = inputEl ? inputEl.value.trim() : '';
        if (!noteText) {
          this.showToast('💡 请先在输入框填写要记录的会议笔记内容');
          return;
        }
        const nowMs = Date.now();
        const noteItem: SubtitleItem = {
          id: `note-${nowMs}`,
          speaker: '📝 会议备忘',
          isTrackRemote: false,
          original: noteText,
          translated: noteText,
          confirmedOriginal: noteText,
          confirmedTranslated: noteText,
          detectedLanguage: 'zh',
          timestamp: new Date().toLocaleTimeString(),
          isPartial: false,
          toneTag: '📌 重点笔记',
          lastUpdatedMs: nowMs,
        };
        this.hudState.subtitles.push(noteItem);
        this.streamManager.finalizeLastCard(noteItem, this.hudState.displayMode);
        if (inputEl) inputEl.value = '';
        this.showToast('📌 已将笔记插入会议时间轴（导出纪要时将自动合并）');
        break;
      }

      case 'closeCopilotDrawer': {
        this.hudState.hasPredictSuggestion = false;
        const pred = document.getElementById('predictDrawerContainer');
        if (pred) pred.innerHTML = '';
        document.getElementById('btnOpenCopilot')?.classList.remove('active');
        break;
      }

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

      case 'openPath':
        if (payload) {
          try {
            await tauriInvoke('open_path_in_finder', { path: payload });
          } catch (e: any) {
            this.showToast(`打开失败: ${e?.message || e}`);
          }
        }
        break;

      case 'openSaveDir':
        const dirInput = document.getElementById('cfgSaveDir') as HTMLInputElement;
        const dir = (dirInput ? dirInput.value.trim() : '') || this.appConfig.storage?.save_dir || '~/Documents/livehear';
        try {
          await tauriInvoke('open_path_in_finder', { path: dir });
        } catch (e: any) {
          this.showToast(`打开目录失败: ${e?.message || e}`);
        }
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
          this.handleAction('toggleSettings');
        } catch (err: any) {
          this.showToast(`❌ 模拟失败: ${err?.message || err}`);
        }
        break;

      case 'saveAllConfig':
        const sonioxInput = document.getElementById('cfgSonioxApiKey') as HTMLInputElement;
        if (sonioxInput) this.appConfig.soniox.api_key = sonioxInput.value.trim();

        const typeRadios = document.getElementsByName('cfgTranslationType') as NodeListOf<HTMLInputElement>;
        for (const r of typeRadios) {
          if (r.checked) {
            this.appConfig.soniox.translation_type = r.value;
            break;
          }
        }

        const targetLang = document.getElementById('cfgSonioxTargetLang') as HTMLSelectElement;
        if (targetLang) this.appConfig.soniox.target_language = targetLang.value;

        const hintsInput = document.getElementById('cfgLanguageHints') as HTMLInputElement;
        if (hintsInput) {
          this.appConfig.soniox.language_hints = hintsInput.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }

        const strictHintsCb = document.getElementById('cfgLanguageHintsStrict') as HTMLInputElement;
        if (strictHintsCb) {
          this.appConfig.soniox.language_hints_strict = strictHintsCb.checked;
        }

        const endpointDelaySelect = document.getElementById('cfgEndpointDelay') as HTMLSelectElement;
        if (endpointDelaySelect) {
          const parsedDelay = parseInt(endpointDelaySelect.value, 10);
          if (!isNaN(parsedDelay)) {
            this.appConfig.soniox.max_endpoint_delay_ms = parsedDelay;
          }
        }

        const diarizationCheckbox = document.getElementById('cfgSpeakerDiarization') as HTMLInputElement;
        if (diarizationCheckbox) {
          this.appConfig.soniox.enable_speaker_diarization = diarizationCheckbox.checked;
        }

        const vadCheckbox = document.getElementById('cfgEnableVad') as HTMLInputElement;
        if (vadCheckbox) {
          this.appConfig.soniox.enable_vad = vadCheckbox.checked;
        }

        const inputDeviceSelect = document.getElementById('cfgInputDevice') as HTMLSelectElement;
        if (inputDeviceSelect) {
          const devVal = inputDeviceSelect.value.trim();
          this.appConfig.soniox.input_device = devVal ? devVal : null;
        }

        const termsArea = document.getElementById('cfgCustomTerms') as HTMLTextAreaElement;
        if (termsArea) {
          this.appConfig.soniox.custom_terms = termsArea.value
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
        }

        const openrouterKey = document.getElementById('cfgOpenRouterApiKey') as HTMLInputElement;
        if (openrouterKey) {
          const val = openrouterKey.value.trim();
          this.appConfig.openrouter.api_key = val;
          this.appConfig.jev.api_key = val;
        }

        const openrouterUrl = document.getElementById('cfgOpenRouterBaseUrl') as HTMLInputElement;
        if (openrouterUrl) {
          const val = openrouterUrl.value.trim();
          this.appConfig.openrouter.base_url = val;
          this.appConfig.jev.base_url = val;
        }

        const modelInput = document.getElementById('cfgOpenRouterModel') as HTMLInputElement;
        if (modelInput && modelInput.value.trim()) {
          this.appConfig.openrouter.translate_model = modelInput.value.trim();
        }

        const polishCb = document.getElementById('cfgEnablePolish') as HTMLInputElement;
        if (polishCb) {
          this.appConfig.openrouter.enable_polish = polishCb.checked;
        }

        const autoSaveCb = document.getElementById('cfgAutoSave') as HTMLInputElement;
        const saveDirInput = document.getElementById('cfgSaveDir') as HTMLInputElement;
        const formatRadios = document.getElementsByName('cfgFileFormat') as NodeListOf<HTMLInputElement>;
        let fileFormat = 'txt';
        for (const r of formatRadios) {
          if (r.checked) {
            fileFormat = r.value;
            break;
          }
        }

        this.appConfig.storage = {
          auto_save: autoSaveCb ? autoSaveCb.checked : true,
          save_dir: (saveDirInput ? saveDirInput.value.trim() : '') || '~/Documents/livehear',
          file_format: fileFormat,
        };

        try {
          await tauriInvoke('save_config', { newConfig: this.appConfig });
          this.refreshTopbarBadges();
          this.handleAction('toggleSettings');

          if (this.hudState.isStreaming) {
            await this.stopLiveStream(false);
            await this.startLiveStream();
            this.showToast('✅ 配置已保存并热重载实时同传流！');
          } else {
            this.showToast('✅ 配置已成功保存！');
          }
        } catch (e: any) {
          this.showToast(`⚠️ 保存失败: ${e?.message || e}`);
        }
        break;
    }
  }

  private refreshTopbarBadges() {
    const isOneWay = this.appConfig.soniox.translation_type !== 'two_way';
    const langBadge = document.querySelector('.lang-auto-badge');
    if (langBadge) {
      langBadge.setAttribute(
        'title',
        isOneWay
          ? '点击快速切换收听语种范围 (Language Hints) 与目标翻译语言'
          : '双向对谈：点击快速切换收听语种与翻译模式'
      );
      langBadge.innerHTML = `<span class="globe-icon">🌐</span><span id="topbarLangBadgeText">${escapeHtml(
        formatTopbarLangBadgeText(this.appConfig)
      )}</span>`;
    }
  }

  private async fetchAiExecutiveSummary(): Promise<string> {
    if (!this.appConfig.openrouter?.api_key?.trim() || this.hudState.subtitles.length < 2) {
      return '';
    }
    const rawLines = this.hudState.subtitles
      .map((s) => {
        const o = (s.original || '').trim();
        const t = (s.translated || '').trim();
        return t && t !== o
          ? `[${s.timestamp}] ${s.speaker}: ${o} (同传: ${t})`
          : `[${s.timestamp}] ${s.speaker}: ${o}`;
      })
      .join('\n');
    try {
      const summary = await tauriInvoke<string>('generate_ai_minutes', {
        transcript: rawLines,
      });
      return summary ? summary.trim() : '';
    } catch (e) {
      console.warn('AI 结构化纪要提炼跳过:', e);
      return '';
    }
  }

  private generateTranscriptText(aiSummary = ''): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString();
    const timeStr = now.toLocaleTimeString();

    const distinctSpeakers = Array.from(
      new Set(this.hudState.subtitles.map((s) => s.speaker))
    ).join(', ');

    let lines: string[] = [];
    lines.push('================================================================================');
    lines.push('LiveHear 会议速记与双语同传纪要');
    lines.push(`记录时间: ${dateStr} ${timeStr}`);
    lines.push(`会议主题: ${this.appConfig.meeting.context || '日常同步'}`);
    lines.push(`参会发言人: ${distinctSpeakers || '未知'}`);
    lines.push('================================================================================\n');

    if (aiSummary) {
      lines.push('【AI 结构化高管纪要 · 核心决议与待办】\n');
      lines.push(aiSummary);
      lines.push('\n--------------------------------------------------------------------------------\n');
    }

    lines.push('【逐字记录与双语同传】\n');
    for (const item of this.hudState.subtitles) {
      const orig = (item.original || '').trim();
      const trans = (item.translated || '').trim();
      const lang = item.detectedLanguage ? item.detectedLanguage.toUpperCase() : '';
      const langTag = lang ? ` [${lang}]` : '';

      lines.push(`[${item.timestamp}] ${item.speaker}${langTag}: ${orig}`);
      if (trans && trans !== orig) {
        lines.push(`            [同传]: ${trans}`);
      }
      lines.push('');
    }

    if (this.hudState.suggestions.length > 0) {
      lines.push('--------------------------------------------------------------------------------');
      lines.push('【智能决策与策略提炼】\n');
      for (const sug of this.hudState.suggestions) {
        lines.push(`* [${sug.title}]: ${sug.detail}`);
      }
      lines.push('');
    }

    lines.push('================================================================================');
    return lines.join('\n');
  }

  private generateTranscriptMarkdown(aiSummary = ''): string {
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

    if (aiSummary) {
      md += `---\n\n## ✨ AI 高管纪要与待办提炼\n\n${aiSummary}\n\n`;
    }

    md += `---\n\n## 逐字记录与双语同传\n\n`;
    md += `| 时间 | 发言人 | 语种 | 原生发言 | 中文同传 |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- |\n`;

    for (const item of this.hudState.subtitles) {
      const orig = (item.original || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const trans = (item.translated || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const lang = item.detectedLanguage ? item.detectedLanguage.toUpperCase() : '-';
      md += `| ${item.timestamp} | ${item.speaker} | ${lang} | ${orig} | ${trans} |\n`;
    }

    if (this.hudState.suggestions.length > 0) {
      md += `\n---\n\n## 智能决策与策略提炼\n\n`;
      for (const sug of this.hudState.suggestions) {
        md += `- **[${sug.title}]**: ${sug.detail}\n`;
      }
    }
    return md;
  }

  private async autoSaveMeetingTranscript() {
    if (this.hudState.subtitles.length === 0) return;

    const saveDir = this.appConfig.storage?.save_dir || '~/Documents/livehear';
    const fileFormat = this.appConfig.storage?.file_format || 'txt';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `Meeting_${ts}.${fileFormat}`;

    const aiSummary = await this.fetchAiExecutiveSummary();
    const content = fileFormat === 'md'
      ? this.generateTranscriptMarkdown(aiSummary)
      : this.generateTranscriptText(aiSummary);

    try {
      const savedPath = await tauriInvoke<string>('save_meeting_transcript', {
        content,
        filename,
        saveDir,
      });
      console.log('✅ 会议纪要已自动保存:', savedPath);
      this.showToast(
        `💾 会议纪要已自动保存至 ${filename}`,
        `<button class="toast-btn-action no-drag" onclick="window.__livehear_action('openPath', '${escapeJs(savedPath)}')">打开</button>`
      );
    } catch (err: any) {
      console.error('自动保存会议纪要失败:', err);
      this.showToast(`⚠️ 自动保存纪要失败: ${err?.message || err}`);
    }
  }

  private async exportMeetingTranscript() {
    if (this.hudState.subtitles.length === 0) {
      this.showToast('当前暂无字幕记录可导出');
      return;
    }

    this.showToast('✨ 正在提炼 AI 结构化纪要并导出...');
    const saveDir = this.appConfig.storage?.save_dir || '~/Documents/livehear';
    const fileFormat = this.appConfig.storage?.file_format || 'txt';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `Meeting_${ts}.${fileFormat}`;

    const aiSummary = await this.fetchAiExecutiveSummary();
    const content = fileFormat === 'md'
      ? this.generateTranscriptMarkdown(aiSummary)
      : this.generateTranscriptText(aiSummary);

    try {
      const savedPath = await tauriInvoke<string>('save_meeting_transcript', {
        content,
        filename,
        saveDir,
      });
      await navigator.clipboard.writeText(content);
      this.showToast(
        `✅ 纪要已保存至 ${filename} (已复制)`,
        `<button class="toast-btn-action no-drag" onclick="window.__livehear_action('openPath', '${escapeJs(savedPath)}')">查看</button>`
      );
    } catch (e: any) {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      navigator.clipboard.writeText(content);
      this.showToast('✅ 会议纪要已成功导出并复制到剪贴板！');
    }
  }

  private async startLiveStream() {
    if (this.isStarting || this.hudState.isStreaming) return;
    this.isStarting = true;

    const liveBtn = document.getElementById('btnToggleLive');
    if (liveBtn) {
      liveBtn.className = 'live-status-pill no-drag paused';
      liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">连接中...</span>`;
    }

    try {
      await tauriInvoke('start_soniox_live');
      this.hudState.isStreaming = true;
      this.hudState.hasMicPermission = true;
      if (liveBtn) {
        liveBtn.className = 'live-status-pill no-drag streaming';
        liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">正在同传</span>`;
      }
      if (this.hudState.subtitles.length === 0) {
        this.streamManager.clear(true, true);
      }
      this.showToast('🟢 原生高保真实时同传已就绪，请说话');
    } catch (err: any) {
      console.warn('启动实时流错误:', err);
      this.hudState.isStreaming = false;
      if (liveBtn) {
        liveBtn.className = 'live-status-pill no-drag paused';
        liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">开始同传</span>`;
      }
      this.showToast(`❌ 启动失败: ${err?.message || err}`);
    } finally {
      this.isStarting = false;
    }
  }

  private async stopLiveStream(triggerAutoSave = true) {
    try {
      await tauriInvoke('stop_soniox_live');
    } catch {}
    this.hudState.isStreaming = false;
    this.updateMicVolume(0);

    const liveBtn = document.getElementById('btnToggleLive');
    if (liveBtn) {
      liveBtn.className = 'live-status-pill no-drag paused';
      liveBtn.innerHTML = `<span class="live-dot-pulse"></span><span class="live-text">开始同传</span>`;
    }

    if (!triggerAutoSave) {
      return;
    }

    // 会议停止时，若开启了自动保存且有字幕记录，立即自动落盘
    if (this.appConfig.storage?.auto_save !== false && this.hudState.subtitles.length > 0) {
      await this.autoSaveMeetingTranscript();
    } else {
      this.showToast('已暂停实时语音同传');
    }
  }

  private showToast(msg: string, actionHtml?: string) {
    const existing = document.querySelector('.livehear-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'livehear-toast';
    if (actionHtml) {
      toast.innerHTML = `<span>${escapeHtml(msg)}</span>${actionHtml}`;
    } else {
      toast.innerText = msg;
    }
    document.body.appendChild(toast);

    const duration = actionHtml ? 4500 : 2800;
    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }
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

// 初始化应用
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    new LiveHearApp();
  });
}
