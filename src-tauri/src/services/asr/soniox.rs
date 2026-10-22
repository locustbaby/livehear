use crate::config::SonioxConfig;
use crate::domain::{LiveHearError, Speaker, TranscriptSegment};
use crate::services::ASRService;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Serialize, Deserialize)]
struct SonioxTranslationPayload {
    #[serde(rename = "type")]
    translation_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_a: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_b: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxStartPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    model: String,
    audio_format: String,
    sample_rate: u32,
    num_channels: u16,
    enable_speaker_diarization: bool,
    enable_endpoint_detection: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation: Option<SonioxTranslationPayload>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxToken {
    text: String,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    speaker: Option<serde_json::Value>,
    #[serde(default)]
    spk: Option<u32>,
    #[serde(default)]
    start_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    translation_status: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    source_language: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxStreamResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
    #[serde(default)]
    error_code: Option<u32>,
    #[serde(default)]
    error_message: Option<String>,
}

pub struct SonioxLiveAdapter {
    config: SonioxConfig,
}

impl SonioxLiveAdapter {
    pub fn new(config: SonioxConfig) -> Self {
        Self { config }
    }

    fn build_translation_payload(&self) -> Option<SonioxTranslationPayload> {
        if !self.config.enable_translation {
            return None;
        }

        if self.config.translation_type == "two_way" {
            Some(SonioxTranslationPayload {
                translation_type: "two_way".to_string(),
                target_language: None,
                language_a: Some(self.config.language_a.clone()),
                language_b: Some(self.config.language_b.clone()),
            })
        } else {
            Some(SonioxTranslationPayload {
                translation_type: "one_way".to_string(),
                target_language: Some(self.config.target_language.clone()),
                language_a: None,
                language_b: None,
            })
        }
    }
}

fn parse_speaker(token: &SonioxToken) -> Option<u32> {
    if let Some(spk) = token.spk {
        return Some(spk + 1);
    }
    if let Some(ref val) = token.speaker {
        if let Some(n) = val.as_u64() {
            return Some((n as u32) + 1);
        }
        if let Some(s) = val.as_str() {
            if let Ok(n) = s.parse::<u32>() {
                return Some(n + 1);
            }
        }
    }
    None
}

#[async_trait]
impl ASRService for SonioxLiveAdapter {
    async fn test_connection(&self) -> Result<String, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "Soniox API Key 尚未填写".to_string(),
            ));
        }

        let request = Request::builder()
            .uri(&self.config.ws_url)
            .header("Host", "stt-rt.soniox.com")
            .header("Upgrade", "websocket")
            .header("Connection", "Upgrade")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .header("Authorization", format!("Bearer {}", api_key))
            .body(())
            .map_err(|e| LiveHearError::NetworkError(format!("构建握手请求失败: {}", e)))?;

        let (mut ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("连接 Soniox 失败: {}", e)))?;

        let init_payload = SonioxStartPayload {
            api_key: None,
            model: self.config.model.clone(),
            audio_format: "pcm_s16le".to_string(),
            sample_rate: self.config.sample_rate,
            num_channels: 1,
            enable_speaker_diarization: self.config.enable_speaker_diarization,
            enable_endpoint_detection: true,
            translation: self.build_translation_payload(),
        };

        let json = serde_json::to_string(&init_payload)
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        ws_stream
            .send(Message::Text(json.into()))
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("发送初始化指令失败: {}", e)))?;

        // 读一次确认响应无报错
        if let Some(Ok(Message::Text(resp_text))) = ws_stream.next().await {
            if let Ok(resp) = serde_json::from_str::<SonioxStreamResponse>(&resp_text) {
                if let Some(err) = resp.error_message {
                    return Err(LiveHearError::NetworkError(format!("Soniox 错误: {}", err)));
                }
            }
        }

        let _ = ws_stream.close(None).await;
        Ok("Soniox WebSocket (语音识别+自动说话人识别+全语种同传翻译) 连通成功！".to_string())
    }

    async fn start_stream(
        &self,
    ) -> Result<(mpsc::Sender<Vec<u8>>, broadcast::Receiver<TranscriptSegment>), LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "Soniox API Key 不能为空".to_string(),
            ));
        }

        let request = Request::builder()
            .uri(&self.config.ws_url)
            .header("Host", "stt-rt.soniox.com")
            .header("Upgrade", "websocket")
            .header("Connection", "Upgrade")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .header("Authorization", format!("Bearer {}", api_key))
            .body(())
            .map_err(|e| LiveHearError::NetworkError(format!("构建握手失败: {}", e)))?;

        let (ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("连接 Soniox WebSocket 失败: {}", e)))?;

        let (mut write, mut read) = ws_stream.split();

        // 原生全语种自适应识别，不加任何人工限制！
        let init_payload = SonioxStartPayload {
            api_key: None,
            model: self.config.model.clone(),
            audio_format: "pcm_s16le".to_string(),
            sample_rate: self.config.sample_rate,
            num_channels: 1,
            enable_speaker_diarization: self.config.enable_speaker_diarization,
            enable_endpoint_detection: true,
            translation: self.build_translation_payload(),
        };

        let init_json = serde_json::to_string(&init_payload)
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        println!("🚀 [Soniox Live] 发送初始化配置: {}", init_json);

        write
            .send(Message::Text(init_json.into()))
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("发送初始化配置失败: {}", e)))?;

        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(128);
        let (event_tx, event_rx) = broadcast::channel::<TranscriptSegment>(256);

        // 异步写任务：向 Soniox WebSocket 传输 PCM 音频
        tokio::spawn(async move {
            while let Some(chunk) = audio_rx.recv().await {
                if write.send(Message::Binary(chunk.into())).await.is_err() {
                    break;
                }
            }
            let _ = write.close().await;
        });

        // 异步读任务：解析 Soniox 流式 Token（含自动说话人分离与双向同传）
        tokio::spawn(async move {
            let mut confirmed_original = String::new();
            let mut confirmed_translated = String::new();
            let mut current_speaker_id: u32 = 1;
            let mut sentence_start_ms: Option<u64> = None;
            let mut sentence_duration_ms: Option<u64> = None;

            while let Some(Ok(msg)) = read.next().await {
                if let Message::Text(text) = msg {
                    match serde_json::from_str::<SonioxStreamResponse>(&text) {
                        Ok(resp) => {
                            if let Some(err) = resp.error_message {
                                eprintln!("⚠️ [Soniox API Error] code {:?}: {}", resp.error_code, err);
                                continue;
                            }

                            if resp.tokens.is_empty() {
                                continue;
                            }

                            let mut provisional_original = String::new();
                            let mut provisional_translated = String::new();
                            let mut new_final_tokens = false;

                            for token in resp.tokens {
                                if let Some(spk) = parse_speaker(&token) {
                                    current_speaker_id = spk;
                                }
                                if sentence_start_ms.is_none() {
                                    sentence_start_ms = token.start_ms;
                                }
                                if token.duration_ms.is_some() {
                                    sentence_duration_ms = token.duration_ms;
                                }

                                let is_trans = token.translation_status.as_deref() == Some("translation");
                                if token.is_final {
                                    new_final_tokens = true;
                                    if is_trans {
                                        confirmed_translated.push_str(&token.text);
                                    } else {
                                        confirmed_original.push_str(&token.text);
                                    }
                                } else {
                                    if is_trans {
                                        provisional_translated.push_str(&token.text);
                                    } else {
                                        provisional_original.push_str(&token.text);
                                    }
                                }
                            }

                            // 1. 如果有在途临时词，实时刷新 Partial 流（超低延时同传上屏）
                            if !provisional_original.is_empty() || !provisional_translated.is_empty() {
                                let display_orig = format!("{}{}", confirmed_original, provisional_original);
                                let display_trans = format!("{}{}", confirmed_translated, provisional_translated);
                                let mut partial_seg = TranscriptSegment::new_partial(
                                    Speaker::remote(current_speaker_id),
                                    display_orig,
                                );
                                if !display_trans.is_empty() {
                                    partial_seg.translated_text = Some(display_trans);
                                }
                                let _ = event_tx.send(partial_seg);
                            } else if new_final_tokens && (!confirmed_original.trim().is_empty() || !confirmed_translated.trim().is_empty()) {
                                // 2. 没有临时词且结出了 final 词，说明当前句子断句完成
                                let mut final_seg = TranscriptSegment::new_final(
                                    Speaker::remote(current_speaker_id),
                                    confirmed_original.trim().to_string(),
                                    sentence_start_ms,
                                    sentence_duration_ms,
                                );
                                if !confirmed_translated.trim().is_empty() {
                                    final_seg.translated_text = Some(confirmed_translated.trim().to_string());
                                }
                                let _ = event_tx.send(final_seg);

                                // 重置当前句累加器，准备迎接下一句
                                confirmed_original.clear();
                                confirmed_translated.clear();
                                sentence_start_ms = None;
                                sentence_duration_ms = None;
                            }
                        }
                        Err(e) => {
                            eprintln!("⚠️ [Soniox 反序列化异常]: {} (原始报文: {})", e, text);
                        }
                    }
                }
            }
        });

        Ok((audio_tx, event_rx))
    }
}
