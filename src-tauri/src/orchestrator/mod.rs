use crate::domain::{LiveHearError, ReplySuggestion, TranscriptSegment};
use crate::services::audio_capture::NativeAudioCapture;
use crate::services::{ASRService, DecisionGateService, PredictService, TranslationService};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratedEventPayload {
    pub segment: TranscriptSegment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<ReplySuggestion>>,
}

pub struct LiveHearOrchestrator {
    asr_service: Arc<dyn ASRService>,
    translation_service: Arc<dyn TranslationService>,
    decision_service: Arc<dyn DecisionGateService>,
    predict_service: Arc<dyn PredictService>,
    meeting_context: String,
    auto_predict: bool,
    is_running: Arc<AtomicBool>,
    has_stopped_native: Arc<AtomicBool>,
    audio_tx: tokio::sync::Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    audio_capture: tokio::sync::Mutex<NativeAudioCapture>,
}

impl LiveHearOrchestrator {
    pub fn new(
        asr_service: Arc<dyn ASRService>,
        translation_service: Arc<dyn TranslationService>,
        decision_service: Arc<dyn DecisionGateService>,
        predict_service: Arc<dyn PredictService>,
        meeting_context: String,
        auto_predict: bool,
    ) -> Self {
        Self {
            asr_service,
            translation_service,
            decision_service,
            predict_service,
            meeting_context,
            auto_predict,
            is_running: Arc::new(AtomicBool::new(false)),
            has_stopped_native: Arc::new(AtomicBool::new(false)),
            audio_tx: tokio::sync::Mutex::new(None),
            audio_capture: tokio::sync::Mutex::new(NativeAudioCapture::new()),
        }
    }

    /// 启动全链路协同流：原生音频录入 -> ASR -> 并发翻译 -> Jev 问句门禁 -> 策略预测
    pub async fn start(&self, app: AppHandle) -> Result<(), LiveHearError> {
        if self.is_running.load(Ordering::SeqCst) {
            return Ok(());
        }

        let (audio_sender, mut transcript_rx) = self.asr_service.start_stream().await?;
        {
            let mut lock = self.audio_tx.lock().await;
            *lock = Some(audio_sender.clone());
        }

        // 启动系统原生麦克风实时高保真采集 (cpal)
        {
            let mut cap = self.audio_capture.lock().await;
            if let Err(e) = cap.start(audio_sender) {
                eprintln!("⚠️ [LiveHear] 原生麦克风启动警告 (将回退至 IPC 输入): {}", e);
            }
        }

        self.is_running.store(true, Ordering::SeqCst);
        let is_running_clone = self.is_running.clone();

        let translation_svc = self.translation_service.clone();
        let decision_svc = self.decision_service.clone();
        let predict_svc = self.predict_service.clone();
        let context = self.meeting_context.clone();
        let auto_predict = self.auto_predict;

        tokio::spawn(async move {
            while is_running_clone.load(Ordering::SeqCst) {
                match transcript_rx.recv().await {
                    Ok(mut segment) => {
                        let app_emit = app.clone();
                        let trans_svc = translation_svc.clone();
                        let dec_svc = decision_svc.clone();
                        let pred_svc = predict_svc.clone();
                        let ctx = context.clone();

                        if !segment.is_final {
                            // 临时 Partial 词流快速上屏
                            let _ = app_emit.emit(
                                "asr-partial",
                                OrchestratedEventPayload {
                                    segment,
                                    intent: None,
                                    suggestions: None,
                                },
                            );
                        } else {
                            // 终态 Final 句：并发启动翻译与推测
                            tokio::spawn(async move {
                                let original_text = segment.text.clone();

                                // 并发任务 1: 机器翻译（优先复用 Soniox 原生流式同传翻译，无额外 LLM 网络耗时）
                                let translated = if let Some(soniox_trans) = segment.translated_text.take() {
                                    if !soniox_trans.trim().is_empty() {
                                        soniox_trans
                                    } else if !original_text.trim().is_empty() {
                                        trans_svc
                                            .translate(&original_text, "en", "zh")
                                            .await
                                            .unwrap_or_else(|_| "翻译中...".to_string())
                                    } else {
                                        String::new()
                                    }
                                } else if !original_text.trim().is_empty() {
                                    trans_svc
                                        .translate(&original_text, "en", "zh")
                                        .await
                                        .unwrap_or_else(|_| "翻译中...".to_string())
                                } else {
                                    String::new()
                                };
                                segment.translated_text = Some(translated);

                                let mut detected_intent = None;
                                let mut generated_suggestions = None;

                                // 并发任务 2: Jev 问句决策拦截
                                if auto_predict {
                                    if let Ok(decision) = dec_svc.evaluate(&original_text, &ctx).await {
                                        detected_intent = Some(decision.intent.display_name().to_string());
                                        if decision.is_question {
                                            // 并发任务 3: 生成策略应答
                                            if let Ok(sugs) = pred_svc.generate_suggestions(&original_text, &ctx).await {
                                                generated_suggestions = Some(sugs);
                                            }
                                        }
                                    }
                                }

                                // 派发完整丰富的领域事件
                                let _ = app_emit.emit(
                                    "asr-final",
                                    OrchestratedEventPayload {
                                        segment,
                                        intent: detected_intent,
                                        suggestions: generated_suggestions,
                                    },
                                );
                            });
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        Ok(())
    }

    /// 推送 PCM 音频流（前端 Web Audio 优先采集流）
    pub async fn push_audio(&self, pcm_chunk: Vec<u8>) -> Result<(), LiveHearError> {
        // 若前端 Web Audio 已激活并推送音频，仅在首次调用时暂停后台 cpal 原生麦克风，避免双重采集
        if !self.has_stopped_native.swap(true, Ordering::Relaxed) {
            let mut cap = self.audio_capture.lock().await;
            cap.stop();
        }
        let lock = self.audio_tx.lock().await;
        if let Some(tx) = lock.as_ref() {
            let _ = tx.send(pcm_chunk).await;
        }
        Ok(())
    }

    pub async fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        {
            let mut cap = self.audio_capture.lock().await;
            cap.stop();
        }
        let mut lock = self.audio_tx.lock().await;
        *lock = None;
    }
}
