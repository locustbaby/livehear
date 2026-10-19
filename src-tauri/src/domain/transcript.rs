use super::speaker::Speaker;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub speaker: Speaker,
    pub text: String,
    pub translated_text: Option<String>,
    pub is_final: bool,
    pub start_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub timestamp_ms: u64,
}

impl TranscriptSegment {
    pub fn new_partial(speaker: Speaker, text: String) -> Self {
        Self {
            id: format!("partial-{}", chrono::Utc::now().timestamp_micros()),
            speaker,
            text,
            translated_text: None,
            is_final: false,
            start_ms: None,
            duration_ms: None,
            timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }

    pub fn new_final(
        speaker: Speaker,
        text: String,
        start_ms: Option<u64>,
        duration_ms: Option<u64>,
    ) -> Self {
        Self {
            id: format!("final-{}", chrono::Utc::now().timestamp_micros()),
            speaker,
            text,
            translated_text: None,
            is_final: true,
            start_ms,
            duration_ms,
            timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }
}
