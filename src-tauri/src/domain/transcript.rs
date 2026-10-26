use super::speaker::Speaker;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub speaker: Speaker,
    pub text: String,
    pub translated_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisional_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_translated_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisional_translated_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub low_confidence_words: Vec<String>,
    pub detected_language: Option<String>,
    pub is_final: bool,
    pub start_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub timestamp_ms: u64,
}

impl TranscriptSegment {
    pub fn new_partial(speaker: Speaker, text: String) -> Self {
        Self::new_partial_with_id(
            format!("partial-{}", chrono::Utc::now().timestamp_micros()),
            speaker,
            text,
        )
    }

    pub fn new_partial_with_id(id: String, speaker: Speaker, text: String) -> Self {
        Self {
            id,
            speaker,
            text,
            translated_text: None,
            confirmed_text: None,
            provisional_text: None,
            confirmed_translated_text: None,
            provisional_translated_text: None,
            low_confidence_words: Vec::new(),
            detected_language: None,
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
        Self::new_final_with_id(
            format!("final-{}", chrono::Utc::now().timestamp_micros()),
            speaker,
            text,
            start_ms,
            duration_ms,
        )
    }

    pub fn new_final_with_id(
        id: String,
        speaker: Speaker,
        text: String,
        start_ms: Option<u64>,
        duration_ms: Option<u64>,
    ) -> Self {
        Self {
            id,
            speaker,
            text,
            translated_text: None,
            confirmed_text: None,
            provisional_text: None,
            confirmed_translated_text: None,
            provisional_translated_text: None,
            low_confidence_words: Vec::new(),
            detected_language: None,
            is_final: true,
            start_ms,
            duration_ms,
            timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }
}
