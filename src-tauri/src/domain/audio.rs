use serde::{Deserialize, Serialize};

/// 声音物理来源分类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioTrack {
    /// 本地物理麦克风 (自己说话)
    LocalMicrophone,
    /// 操作系统扬声器 Loopback (远端会议与会者说话)
    SystemSpeaker,
}

impl AudioTrack {
    pub fn is_remote(&self) -> bool {
        matches!(self, AudioTrack::SystemSpeaker)
    }
}

/// 归一化音频帧，内部采用小端 16-bit 线性 PCM
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub track: AudioTrack,
    pub pcm_bytes: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u16,
    pub timestamp_ms: u64,
}

impl AudioFrame {
    pub fn new(track: AudioTrack, pcm_bytes: Vec<u8>, sample_rate: u32) -> Self {
        Self {
            track,
            pcm_bytes,
            sample_rate,
            channels: 1,
            timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }
}
