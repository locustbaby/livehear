pub mod ai;
pub mod asr;
pub mod audio_capture;

use crate::domain::{JevDecision, LiveHearError, ReplySuggestion, TranscriptSegment};
use async_trait::async_trait;
use tokio::sync::{broadcast, mpsc};

/// 实时 ASR 语音识别服务抽象 (Strategy Pattern)
#[async_trait]
pub trait ASRService: Send + Sync {
    /// 建立流式识别管道：返回用于写入 PCM 音频的 Sender，以及订阅转录结果的 Receiver
    async fn start_stream(
        &self,
    ) -> Result<(mpsc::Sender<Vec<u8>>, broadcast::Receiver<TranscriptSegment>), LiveHearError>;

    /// 连通性握手测试
    async fn test_connection(&self) -> Result<String, LiveHearError>;
}

/// 机器翻译服务抽象 (Strategy Pattern)
#[async_trait]
pub trait TranslationService: Send + Sync {
    async fn translate(
        &self,
        text: &str,
        source_lang: &str,
        target_lang: &str,
    ) -> Result<String, LiveHearError>;
}

/// Jev System 1 结构化决策门禁服务抽象 (Strategy Pattern)
#[async_trait]
pub trait DecisionGateService: Send + Sync {
    async fn evaluate(
        &self,
        utterance: &str,
        context: &str,
    ) -> Result<JevDecision, LiveHearError>;
}

/// 智能会议应答建议生成服务抽象 (Strategy Pattern)
#[async_trait]
pub trait PredictService: Send + Sync {
    async fn generate_suggestions(
        &self,
        question: &str,
        context: &str,
    ) -> Result<Vec<ReplySuggestion>, LiveHearError>;
}
