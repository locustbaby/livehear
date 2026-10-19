use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SpeakerId(pub u32);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpeakerRole {
    LocalUser,
    RemoteParticipant(u32),
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Speaker {
    pub id: SpeakerId,
    pub role: SpeakerRole,
    pub display_name: String,
}

impl Speaker {
    pub fn local() -> Self {
        Self {
            id: SpeakerId(0),
            role: SpeakerRole::LocalUser,
            display_name: "我 (Microphone)".to_string(),
        }
    }

    pub fn remote(speaker_num: u32) -> Self {
        Self {
            id: SpeakerId(speaker_num),
            role: SpeakerRole::RemoteParticipant(speaker_num),
            display_name: format!("Speaker {}", speaker_num),
        }
    }
}
