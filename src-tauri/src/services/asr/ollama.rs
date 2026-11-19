use crate::config::AsrBackendConfig;
use crate::domain::speaker::{SpeakerId, SpeakerRole};
use crate::domain::{LiveHearError, Speaker, TranscriptSegment};
use crate::services::ASRService;
use crate::services::audio_capture::VAD_FINALIZE_SIGNAL;
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc};

const BYTES_PER_SECOND: usize = 32_000;
const MAX_CHUNK_BYTES: usize = BYTES_PER_SECOND * 8;
const MIN_CHUNK_BYTES: usize = BYTES_PER_SECOND;
const SILENCE_BYTES: usize = BYTES_PER_SECOND * 7 / 10;

#[derive(Default)]
struct AudioChunker {
    buffer: Vec<u8>,
    silence_bytes: usize,
    has_speech: bool,
}

impl AudioChunker {
    fn push(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        if chunk == [VAD_FINALIZE_SIGNAL] {
            return self.flush();
        }
        let (sum, count) =
            chunk
                .as_chunks::<2>()
                .0
                .iter()
                .fold((0u64, 0u64), |(sum, count), &pair| {
                    let value = i16::from_le_bytes(pair) as i64;
                    (sum + (value * value) as u64, count + 1)
                });
        let silent = count > 0 && sum / count < 350u64 * 350;
        self.has_speech |= !silent && count > 0;
        self.silence_bytes = if silent {
            self.silence_bytes + chunk.len()
        } else {
            0
        };
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() >= MAX_CHUNK_BYTES
            || (self.buffer.len() >= MIN_CHUNK_BYTES && self.silence_bytes >= SILENCE_BYTES)
        {
            return self.flush();
        }
        None
    }

    fn flush(&mut self) -> Option<Vec<u8>> {
        self.silence_bytes = 0;
        let speech = std::mem::replace(&mut self.has_speech, false);
        let audio = std::mem::take(&mut self.buffer);
        if audio.is_empty() || !speech {
            None
        } else {
            Some(audio)
        }
    }
}

pub struct OllamaAsr {
    config: AsrBackendConfig,
    app: AppHandle,
    client: reqwest::Client,
}

impl OllamaAsr {
    pub fn new(config: AsrBackendConfig, app: AppHandle) -> Self {
        Self {
            config,
            app,
            client: reqwest::Client::new(),
        }
    }
}

fn wav(pcm: &[u8]) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16000u32.to_le_bytes());
    out.extend_from_slice(&32000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

fn parse_output(content: &str) -> (Option<String>, String) {
    let (prefix, text) = content.split_once("<asr_text>").unwrap_or(("", content));
    let language = match prefix
        .trim()
        .strip_prefix("language ")
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "chinese" => Some("zh"),
        "english" => Some("en"),
        "thai" => Some("th"),
        _ => None,
    }
    .map(str::to_owned);
    (language, text.trim().to_owned())
}

#[async_trait]
impl ASRService for OllamaAsr {
    fn stop_drain_timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs(90))
    }

    async fn test_connection(&self) -> Result<String, LiveHearError> {
        let response = self
            .client
            .post(format!(
                "{}/api/show",
                self.config.ollama_url.trim_end_matches('/')
            ))
            .json(&json!({"model": self.config.ollama_model}))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("无法连接 Ollama: {e}")))?;
        if !response.status().is_success() {
            return Err(LiveHearError::AsrError(format!(
                "Ollama 模型不可用 ({}): {}",
                response.status(),
                self.config.ollama_model
            )));
        }
        Ok("Ollama 模型可用".into())
    }

    async fn start_stream(
        &self,
    ) -> Result<
        (
            mpsc::Sender<Vec<u8>>,
            broadcast::Receiver<TranscriptSegment>,
        ),
        LiveHearError,
    > {
        self.test_connection().await?;
        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(256);
        let (jobs_tx, mut jobs_rx) = mpsc::channel::<(Vec<u8>, u64)>(12);
        let (result_tx, result_rx) = broadcast::channel(128);
        let app = self.app.clone();
        tokio::spawn(async move {
            let mut chunker = AudioChunker::default();
            let mut started_at = None;
            while let Some(chunk) = audio_rx.recv().await {
                if chunk.as_slice() != [VAD_FINALIZE_SIGNAL] && chunker.buffer.is_empty() {
                    started_at = Some(
                        (chrono::Utc::now().timestamp_millis() as u64)
                            .saturating_sub((chunk.len() * 1000 / BYTES_PER_SECOND) as u64),
                    );
                }
                if let Some(audio) = chunker.push(&chunk) {
                    let timestamp = started_at
                        .take()
                        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64);
                    if jobs_tx.try_send((audio, timestamp)).is_err() {
                        let _ = app.emit("asr-error", "本地识别处理速度跟不上音频，部分音频已丢失；请切换 Soniox 或较小的模型");
                    }
                }
            }
            if let Some(audio) = chunker.flush() {
                let timestamp =
                    started_at.unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64);
                let _ = jobs_tx.send((audio, timestamp)).await;
            }
        });
        let client = self.client.clone();
        let config = self.config.clone();
        let app = self.app.clone();
        tokio::spawn(async move {
            while let Some((pcm, timestamp)) = jobs_rx.recv().await {
                if result_tx.receiver_count() == 0 {
                    break;
                }
                let payload = json!({"model":config.ollama_model,"stream":false,"messages":[{"role":"user","content":"","images":[STANDARD.encode(wav(&pcm))]}]});
                let response = client
                    .post(format!(
                        "{}/api/chat",
                        config.ollama_url.trim_end_matches('/')
                    ))
                    .json(&payload)
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await;
                let result: Result<serde_json::Value, String> = match response {
                    Ok(res) if res.status().is_success() => {
                        res.json().await.map_err(|e| e.to_string())
                    }
                    Ok(res) => Err(format!("Ollama HTTP {}", res.status())),
                    Err(e) => Err(e.to_string()),
                };
                match result {
                    Ok(value) => {
                        let (lang, text) =
                            parse_output(value["message"]["content"].as_str().unwrap_or(""));
                        if !text.is_empty() {
                            let speaker = Speaker {
                                id: SpeakerId(0),
                                role: SpeakerRole::Unknown,
                                display_name: "本地音频（未区分说话人）".into(),
                            };
                            let mut segment = TranscriptSegment::new_final(
                                speaker,
                                text,
                                None,
                                Some((pcm.len() * 1000 / BYTES_PER_SECOND) as u64),
                            );
                            segment.detected_language = lang;
                            segment.timestamp_ms = timestamp;
                            let _ = result_tx.send(segment);
                        }
                    }
                    Err(e) => {
                        if result_tx.receiver_count() == 0 {
                            break;
                        }
                        let _ = app.emit("asr-error", format!("Ollama 识别失败: {e}"));
                    }
                }
            }
        });
        Ok((audio_tx, result_rx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_pcm_wav_and_parses_language() {
        let audio = wav(&[1, 2, 3, 4]);
        assert_eq!(&audio[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(audio[40..44].try_into().unwrap()), 4);
        assert_eq!(&audio[44..], &[1, 2, 3, 4]);
        assert_eq!(
            parse_output("language Thai<asr_text> สวัสดี "),
            (Some("th".into()), "สวัสดี".into())
        );
    }
    #[test]
    fn chunks_at_silence_without_losing_audio_and_flushes_short_tail() {
        let mut chunker = AudioChunker::default();
        let speech = [0x10, 0x27].repeat(1600);
        let silence = vec![0u8; 3200];
        let mut input = Vec::new();
        let mut output = Vec::new();
        for _ in 0..10 {
            input.extend_from_slice(&speech);
            assert!(chunker.push(&speech).is_none());
        }
        for _ in 0..7 {
            input.extend_from_slice(&silence);
            if let Some(chunk) = chunker.push(&silence) {
                output.extend(chunk);
            }
        }
        assert_eq!(output, input);
        input.extend_from_slice(&speech);
        assert!(chunker.push(&speech).is_none());
        output.extend(chunker.flush().unwrap());
        assert_eq!(output, input);
        assert!(chunker.flush().is_none());
    }

    #[test]
    fn long_speech_is_bounded_without_overlapping_or_losing_audio() {
        let mut chunker = AudioChunker::default();
        let speech = [0x10, 0x27].repeat(1600);
        let mut output = Vec::new();
        for _ in 0..83 {
            if let Some(chunk) = chunker.push(&speech) {
                output.extend(chunk);
            }
        }
        output.extend(chunker.flush().unwrap());
        assert_eq!(output, speech.repeat(83));
    }

    #[test]
    fn ignores_silence_and_resets_voice_state() {
        let mut chunker = AudioChunker::default();
        let silence = vec![0u8; 3200];
        for _ in 0..30 {
            assert!(chunker.push(&silence).is_none());
        }
        assert!(chunker.flush().is_none());
        let speech = [0x10, 0x27].repeat(1600);
        chunker.push(&speech);
        assert!(chunker.flush().is_some());
        assert!(chunker.push(&silence).is_none());
        assert!(chunker.flush().is_none());
    }
}
