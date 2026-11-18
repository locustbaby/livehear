use crate::config::AppConfig;
use crate::domain::{LiveHearError, ReplySuggestion, TranscriptSegment};
use crate::services::audio_capture::NativeAudioCapture;
use crate::services::{ASRService, DecisionGateService, PredictService, TranslationService};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, mpsc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratedEventPayload {
    pub segment: TranscriptSegment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<ReplySuggestion>>,
    #[serde(default)]
    pub sequence_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestionsEventPayload {
    pub segment_id: String,
    pub speaker_id: u32,
    pub intent: String,
    pub suggestions: Vec<ReplySuggestion>,
}

fn should_evaluate_for_prediction(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let char_count = trimmed.chars().count();
    if char_count < 4 {
        return false;
    }
    if trimmed.contains('?') || trimmed.contains('？') {
        return true;
    }
    let word_count = trimmed.split_whitespace().count();
    word_count >= 3 || char_count >= 8
}

async fn translate_local(
    service: &dyn TranslationService,
    text: &str,
    source: &str,
    target: &str,
) -> Result<String, LiveHearError> {
    tokio::time::timeout(
        std::time::Duration::from_secs(25),
        service.translate(text, source, target),
    )
    .await
    .map_err(|_| LiveHearError::LlmError("字幕翻译超时".into()))?
}

async fn stop_audio_input(
    capture: &tokio::sync::Mutex<NativeAudioCapture>,
    sender: &tokio::sync::Mutex<Option<mpsc::Sender<Vec<u8>>>>,
) {
    capture.lock().await.stop();
    *sender.lock().await = None;
}

pub(crate) async fn finish_audio_stream(
    capture: &tokio::sync::Mutex<NativeAudioCapture>,
    sender: &tokio::sync::Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    running: &AtomicBool,
    draining: &AtomicBool,
) -> bool {
    stop_audio_input(capture, sender).await;
    !draining.load(Ordering::SeqCst) && running.swap(false, Ordering::SeqCst)
}

pub struct LiveHearOrchestrator {
    asr_service: Arc<dyn ASRService>,
    translation_service: Arc<dyn TranslationService>,
    decision_service: Arc<dyn DecisionGateService>,
    predict_service: Arc<dyn PredictService>,
    meeting_context: String,
    auto_predict: bool,
    source_language: String,
    target_language: String,
    local_asr: bool,
    native_speak_language: Option<String>,
    can_translate: bool,
    enable_vad: bool,
    vad_threshold: f32,
    input_device: Option<String>,
    is_running: Arc<AtomicBool>,
    stop_notify: Arc<Notify>,
    draining: Arc<AtomicBool>,
    stream_task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    final_task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    sequence_counter: Arc<AtomicU64>,
    audio_tx: Arc<tokio::sync::Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    audio_capture: Arc<tokio::sync::Mutex<NativeAudioCapture>>,
}

impl LiveHearOrchestrator {
    pub fn new(
        asr_service: Arc<dyn ASRService>,
        translation_service: Arc<dyn TranslationService>,
        decision_service: Arc<dyn DecisionGateService>,
        predict_service: Arc<dyn PredictService>,
        config: AppConfig,
    ) -> Self {
        Self {
            asr_service,
            translation_service,
            decision_service,
            predict_service,
            meeting_context: config.meeting.context,
            auto_predict: config.meeting.auto_predict,
            source_language: config.soniox.language_a,
            target_language: config.soniox.target_language,
            local_asr: config.asr_backend.provider == "ollama",
            native_speak_language: (config.soniox.enable_translation
                && config.soniox.translation_type == "two_way")
                .then_some(config.soniox.speak_target_language),
            can_translate: !config.openrouter.api_key.trim().is_empty(),
            enable_vad: config.soniox.enable_vad,
            vad_threshold: config.soniox.vad_threshold,
            input_device: config.soniox.input_device,
            is_running: Arc::new(AtomicBool::new(false)),
            stop_notify: Arc::new(Notify::new()),
            draining: Arc::new(AtomicBool::new(false)),
            stream_task: tokio::sync::Mutex::new(None),
            final_task: tokio::sync::Mutex::new(None),
            sequence_counter: Arc::new(AtomicU64::new(1)),
            audio_tx: Arc::new(tokio::sync::Mutex::new(None)),
            audio_capture: Arc::new(tokio::sync::Mutex::new(NativeAudioCapture::new())),
        }
    }

    /// 启动全链路协同流：原生音频录入 -> ASR -> 并发翻译 -> Jev 问句门禁 -> 策略预测
    pub async fn start(&self, app: AppHandle) -> Result<(), LiveHearError> {
        if self.is_running.load(Ordering::SeqCst) {
            return Ok(());
        }

        let _ = app.emit("asr-status", "connecting");

        // 1. 建立 ASR 流式识别通道
        let (audio_sender, mut transcript_rx) = match self.asr_service.start_stream().await {
            Ok(pair) => pair,
            Err(e) => {
                let _ = app.emit("asr-status", "error");
                let _ = app.emit("asr-error", e.to_string());
                return Err(e);
            }
        };

        {
            let mut lock = self.audio_tx.lock().await;
            *lock = Some(audio_sender.clone());
        }

        // 2. 启动选定音频源的实时采集
        {
            let mut cap = self.audio_capture.lock().await;
            if let Err(e) = cap.start(
                audio_sender,
                app.clone(),
                self.enable_vad,
                self.vad_threshold,
                self.input_device.as_deref(),
            ) {
                *self.audio_tx.lock().await = None;
                eprintln!("⚠️ [LiveHear] {}", e);
                let _ = app.emit("asr-status", "error");
                let _ = app.emit("asr-error", e.clone());
                return Err(LiveHearError::AudioCaptureError(e));
            }
        }

        self.is_running.store(true, Ordering::SeqCst);
        let _ = app.emit("asr-status", "connected");

        let is_running_clone = self.is_running.clone();
        let stop_notify = self.stop_notify.clone();
        let translation_svc = self.translation_service.clone();
        let decision_svc = self.decision_service.clone();
        let predict_svc = self.predict_service.clone();
        let context = self.meeting_context.clone();
        let auto_predict = self.auto_predict;
        let src_lang = self.source_language.clone();
        let tgt_lang = self.target_language.clone();
        let local_asr = self.local_asr;
        let can_translate = self.can_translate;
        let native_speak_language = self.native_speak_language.clone();
        let seq_counter_final = self.sequence_counter.clone();
        let seq_counter_stream = self.sequence_counter.clone();

        // 3. 建立严格 FIFO 有序队列处理终态句子，杜绝并发乱序
        let (final_tx, mut final_rx) = mpsc::channel::<TranscriptSegment>(64);
        let app_final = app.clone();
        let is_running_final = self.is_running.clone();

        let final_task = tokio::spawn(async move {
            let mut translations = tokio::task::JoinSet::new();
            let translation_slots = Arc::new(tokio::sync::Semaphore::new(4));
            while let Some(mut segment) = final_rx.recv().await {
                let original_text = segment.text.clone();

                let source_language = segment
                    .detected_language
                    .clone()
                    .unwrap_or_else(|| src_lang.clone());
                let native_translation = if local_asr {
                    None
                } else {
                    segment
                        .translated_text
                        .take()
                        .filter(|text| !text.trim().is_empty())
                };
                let has_native_translation = native_translation.is_some();
                let is_speak_covered = native_speak_language
                    .as_ref()
                    .is_some_and(|speak| source_language == *speak);
                let needs_async_translation = !original_text.trim().is_empty()
                    && source_language != tgt_lang
                    && (local_asr || (!has_native_translation && !is_speak_covered));
                let translated = native_translation.unwrap_or_else(|| original_text.clone());
                if needs_async_translation {
                    segment.translation_status = Some(
                        if can_translate {
                            "pending"
                        } else {
                            "unavailable"
                        }
                        .into(),
                    );
                }
                segment.translated_text = Some(translated);

                // 立即派发 asr-final 终态字幕事件，绝不因后台 LLM 问句判定与策略生成阻塞字幕上屏
                let segment_id = segment.id.clone();
                let speaker_id = segment.speaker.id.0;
                let seq = seq_counter_final.fetch_add(1, Ordering::SeqCst);
                let _ = app_final.emit(
                    "asr-final",
                    OrchestratedEventPayload {
                        segment,
                        intent: None,
                        suggestions: None,
                        sequence_id: seq,
                    },
                );

                if needs_async_translation && can_translate {
                    let svc = translation_svc.clone();
                    let target = tgt_lang.clone();
                    let text = original_text.clone();
                    let segment_id = segment_id.clone();
                    let app = app_final.clone();
                    let slots = translation_slots.clone();
                    translations.spawn(async move {
                        let Ok(_permit) = slots.acquire().await else {
                            return;
                        };
                        let result =
                            translate_local(svc.as_ref(), &text, &source_language, &target).await;
                        match result {
                            Ok(translated) if !translated.trim().is_empty() => {
                                let _ = app.emit(
                                    "asr-translation",
                                    serde_json::json!({"segment_id": segment_id, "original": text, "translated": translated}),
                                );
                            }
                            _ => {
                                let _ = app.emit(
                                    "asr-translation",
                                    serde_json::json!({"segment_id": segment_id, "original": text, "translated": "", "error": true}),
                                );
                                let _ = app.emit("asr-error", "字幕翻译失败或超时，已保留原文");
                            }
                        }
                    });
                }
                while translations.try_join_next().is_some() {}

                // 后台非阻塞并发执行 Jev 问句决策与应答策略生成，完成后通过独立事件通知前端
                if auto_predict && should_evaluate_for_prediction(&original_text) {
                    let dec_svc = decision_svc.clone();
                    let pred_svc = predict_svc.clone();
                    let ctx = context.clone();
                    let app_sug = app_final.clone();
                    let orig_for_eval = original_text;
                    let active = is_running_final.clone();

                    tokio::spawn(async move {
                        let dec_fut = dec_svc.evaluate(&orig_for_eval, &ctx);
                        if let Ok(Ok(decision)) =
                            tokio::time::timeout(tokio::time::Duration::from_secs(3), dec_fut).await
                            && decision.is_question
                        {
                            let intent_str = decision.intent.display_name().to_string();
                            let pred_fut = pred_svc.generate_suggestions(&orig_for_eval, &ctx);
                            if let Ok(Ok(sugs)) =
                                tokio::time::timeout(tokio::time::Duration::from_secs(5), pred_fut)
                                    .await
                                && active.load(Ordering::SeqCst)
                                && !sugs.is_empty()
                            {
                                let _ = app_sug.emit(
                                    "asr-suggestions",
                                    SuggestionsEventPayload {
                                        segment_id,
                                        speaker_id,
                                        intent: intent_str,
                                        suggestions: sugs,
                                    },
                                );
                            }
                        }
                    });
                }
            }
            while translations.join_next().await.is_some() {}
        });

        // 4. ASR 流监听派发主循环
        let app_stream = app.clone();
        let draining_stream = self.draining.clone();
        let capture = self.audio_capture.clone();
        let audio_tx = self.audio_tx.clone();
        let stream_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop_notify.notified() => {
                        break;
                    }
                    recv_res = transcript_rx.recv() => {
                        match recv_res {
                            Ok(segment) => {
                                if !is_running_clone.load(Ordering::SeqCst) {
                                    break;
                                }
                                if !segment.is_final {
                                    let seq = seq_counter_stream.load(Ordering::Relaxed);
                                    let _ = app_stream.emit(
                                        "asr-partial",
                                        OrchestratedEventPayload {
                                            segment,
                                            intent: None,
                                            suggestions: None,
                                            sequence_id: seq,
                                        },
                                    );
                                } else {
                                    let _ = final_tx.send(segment).await;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                println!("ℹ️ [LiveHear] ASR 流接收通道已关闭");
                                if finish_audio_stream(&capture, &audio_tx, &is_running_clone, &draining_stream).await {
                                    let _ = app_stream.emit("asr-status", "stopped");
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });

        *self.stream_task.lock().await = Some(stream_task);
        *self.final_task.lock().await = Some(final_task);
        Ok(())
    }

    /// 推送 PCM 音频流（测试/模拟音频通道）
    pub async fn push_audio(&self, pcm_chunk: Vec<u8>) -> Result<(), LiveHearError> {
        let lock = self.audio_tx.lock().await;
        if let Some(tx) = lock.as_ref() {
            let _ = tx.try_send(pcm_chunk);
        }
        Ok(())
    }

    pub async fn stop(&self) -> bool {
        let mut complete = true;
        let should_drain = self.asr_service.drain_on_stop();
        self.draining.store(should_drain, Ordering::SeqCst);
        if !should_drain {
            self.is_running.store(false, Ordering::SeqCst);
            self.stop_notify.notify_waiters();
        }
        stop_audio_input(&self.audio_capture, &self.audio_tx).await;
        let mut stream_task = self.stream_task.lock().await.take();
        let mut final_task = self.final_task.lock().await.take();
        if should_drain {
            let drained = tokio::time::timeout(std::time::Duration::from_secs(90), async {
                if let Some(task) = stream_task.as_mut() {
                    let _ = task.await;
                }
                if let Some(task) = final_task.as_mut() {
                    let _ = task.await;
                }
            })
            .await;
            if drained.is_err() {
                complete = false;
                self.is_running.store(false, Ordering::SeqCst);
                self.stop_notify.notify_waiters();
                if let Some(task) = stream_task {
                    task.abort();
                    let _ = task.await;
                }
                if let Some(task) = final_task {
                    task.abort();
                    let _ = task.await;
                }
            }
        } else {
            if let Some(task) = stream_task {
                task.abort();
                let _ = task.await;
            }
            if let Some(task) = final_task {
                task.abort();
                let _ = task.await;
            }
        }
        self.is_running.store(false, Ordering::SeqCst);
        self.draining.store(false, Ordering::SeqCst);
        complete
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct SlowTranslator;

    #[async_trait::async_trait]
    impl TranslationService for SlowTranslator {
        async fn translate(
            &self,
            text: &str,
            source: &str,
            target: &str,
        ) -> Result<String, LiveHearError> {
            tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
            Ok(format!("{source}:{target}:{text}"))
        }
    }

    #[tokio::test]
    async fn local_translation_allows_more_than_two_seconds() {
        assert_eq!(
            translate_local(&SlowTranslator, "hello", "en", "zh")
                .await
                .unwrap(),
            "en:zh:hello"
        );
    }
}
