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
struct SonioxStartPayload {
    api_key: String,
    model: String,
    audio_format: String,
    sample_rate: u32,
    num_audio_channels: u16,
    enable_speaker_diarization: bool,
    language_hints: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxToken {
    text: String,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    spk: Option<u32>,
    #[serde(default)]
    start_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxStreamResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
}

pub struct SonioxLiveAdapter {
    config: SonioxConfig,
}

impl SonioxLiveAdapter {
    pub fn new(config: SonioxConfig) -> Self {
        Self { config }
    }
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
            api_key: api_key.to_string(),
            model: self.config.model.clone(),
            audio_format: "pcm_s16le".to_string(),
            sample_rate: self.config.sample_rate,
            num_audio_channels: 1,
            enable_speaker_diarization: self.config.enable_speaker_diarization,
            language_hints: self.config.language_hints.clone(),
        };

        let json = serde_json::to_string(&init_payload)
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        ws_stream
            .send(Message::Text(json.into()))
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("发送初始化指令失败: {}", e)))?;

        let _ = ws_stream.close(None).await;
        Ok("Soniox WebSocket 握手连通成功！".to_string())
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

        let init_payload = SonioxStartPayload {
            api_key: api_key.to_string(),
            model: self.config.model.clone(),
            audio_format: "pcm_s16le".to_string(),
            sample_rate: self.config.sample_rate,
            num_audio_channels: 1,
            enable_speaker_diarization: self.config.enable_speaker_diarization,
            language_hints: self.config.language_hints.clone(),
        };

        let init_json = serde_json::to_string(&init_payload)
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        write
            .send(Message::Text(init_json.into()))
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("发送初始化配置失败: {}", e)))?;

        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(128);
        let (event_tx, event_rx) = broadcast::channel::<TranscriptSegment>(256);

        // 异步写任务
        tokio::spawn(async move {
            while let Some(chunk) = audio_rx.recv().await {
                if write.send(Message::Binary(chunk.into())).await.is_err() {
                    break;
                }
            }
            let _ = write.close().await;
        });

        // 异步读任务
        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                if let Message::Text(text) = msg {
                    if let Ok(resp) = serde_json::from_str::<SonioxStreamResponse>(&text) {
                        let mut final_text = String::new();
                        let mut partial_text = String::new();
                        let mut speaker_id = 1;
                        let mut start_ms = None;
                        let mut duration_ms = None;

                        for token in resp.tokens {
                            if let Some(spk) = token.spk {
                                speaker_id = spk + 1;
                            }
                            if start_ms.is_none() {
                                start_ms = token.start_ms;
                            }
                            duration_ms = token.duration_ms;

                            if token.is_final {
                                final_text.push_str(&token.text);
                            } else {
                                partial_text.push_str(&token.text);
                            }
                        }

                        let speaker = Speaker::remote(speaker_id);

                        if !partial_text.is_empty() {
                            let _ = event_tx.send(TranscriptSegment::new_partial(
                                speaker.clone(),
                                partial_text,
                            ));
                        }

                        if !final_text.is_empty() {
                            let _ = event_tx.send(TranscriptSegment::new_final(
                                speaker,
                                final_text,
                                start_ms,
                                duration_ms,
                            ));
                        }
                    }
                }
            }
        });

        Ok((audio_tx, event_rx))
    }
}
