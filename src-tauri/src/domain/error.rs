use thiserror::Error;

#[derive(Error, Debug)]
pub enum LiveHearError {
    #[error("配置错误: {0}")]
    ConfigError(String),

    #[error("音频驱动异常: {0}")]
    AudioCaptureError(String),

    #[error("ASR 语音服务异常: {0}")]
    AsrError(String),

    #[error("Jev 决策门禁异常: {0}")]
    DecisionError(String),

    #[error("LLM 翻译与推测异常: {0}")]
    LlmError(String),

    #[error("网络传输/WebSocket 异常: {0}")]
    NetworkError(String),

    #[error("序列化/反序列化失败: {0}")]
    SerializationError(String),
}

impl From<LiveHearError> for String {
    fn from(err: LiveHearError) -> Self {
        err.to_string()
    }
}
