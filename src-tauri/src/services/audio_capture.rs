use cpal::Stream;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub const VAD_FINALIZE_SIGNAL: u8 = 1;

struct VadGate {
    enable_vad: bool,
    threshold: f32,
    is_active: bool,
    hangover_left: usize,
    hangover_max: usize,
    preroll_buf: VecDeque<Vec<u8>>,
    preroll_max: usize,
    silent_chunks_since_keepalive: usize,
}

impl VadGate {
    fn new(enable_vad: bool, threshold: f32) -> Self {
        Self {
            enable_vad,
            threshold: threshold.clamp(0.8, 50.0),
            is_active: false,
            hangover_left: 0,
            hangover_max: 38, // 38 * 100ms = 3800ms，保证多人会议句中思考停顿与换人间隙不断流
            preroll_buf: VecDeque::with_capacity(6),
            preroll_max: 5, // 5 * 100ms = 500ms 预卷缓冲，确保字首清辅音与轻声起音完整不吞字
            silent_chunks_since_keepalive: 0,
        }
    }

    fn process_chunk(&mut self, chunk: Vec<u8>, volume_f32: f32, audio_tx: &mpsc::Sender<Vec<u8>>) {
        if !self.enable_vad {
            let _ = audio_tx.try_send(chunk);
            return;
        }

        if volume_f32 >= self.threshold {
            if !self.is_active {
                self.is_active = true;
                while let Some(pre) = self.preroll_buf.pop_front() {
                    let _ = audio_tx.try_send(pre);
                }
            }
            self.hangover_left = self.hangover_max;
            self.silent_chunks_since_keepalive = 0;
            let _ = audio_tx.try_send(chunk);
        } else if self.is_active {
            if self.hangover_left > 0 {
                self.hangover_left -= 1;
                let _ = audio_tx.try_send(chunk);
            } else {
                self.is_active = false;
                self.silent_chunks_since_keepalive = 0;
                self.preroll_buf.clear();
                self.preroll_buf.push_back(chunk);
                // 通知 Soniox 推流协程发送 {"type": "finalize"}，立即结算挂起的非终态词与译文
                let _ = audio_tx.try_send(vec![VAD_FINALIZE_SIGNAL]);
            }
        } else {
            self.silent_chunks_since_keepalive += 1;
            if self.preroll_buf.len() >= self.preroll_max {
                self.preroll_buf.pop_front();
            }
            self.preroll_buf.push_back(chunk);
        }
    }
}

/// 抗混叠多相积分重采样 + 一阶高通去直流震动 + 远场自适应柔和增益 (Soft-AGC)
struct AudioDspPipeline {
    ratio: f64,
    phase: f64,
    accum_sum: f64,
    accum_weight: f64,
    hp_prev_in: f32,
    hp_prev_out: f32,
    agc_gain: f32,
    chunk_buffer: Vec<u8>,
    vad_gate: VadGate,
    last_emitted_vol: u8,
    last_emit_instant: std::time::Instant,
}

impl AudioDspPipeline {
    fn new(
        in_sample_rate: f64,
        target_sample_rate: f64,
        enable_vad: bool,
        vad_threshold: f32,
    ) -> Self {
        Self {
            ratio: (in_sample_rate / target_sample_rate).max(1.0),
            phase: 0.0,
            accum_sum: 0.0,
            accum_weight: 0.0,
            hp_prev_in: 0.0,
            hp_prev_out: 0.0,
            agc_gain: 1.35,
            chunk_buffer: Vec::with_capacity(3200),
            vad_gate: VadGate::new(enable_vad, vad_threshold),
            last_emitted_vol: 0,
            last_emit_instant: std::time::Instant::now(),
        }
    }

    #[inline]
    fn highpass_dc_block(&mut self, x: f32) -> f32 {
        // ~65Hz 截止频率的一阶高通滤波器，滤除麦克风直流偏置、桌面低频震动与空调轰鸣，防止掩盖高频清辅音
        let y = x - self.hp_prev_in + 0.991 * self.hp_prev_out;
        self.hp_prev_in = x;
        self.hp_prev_out = y;
        y.clamp(-1.0, 1.0)
    }

    #[inline]
    fn soft_clip(x: f32) -> f32 {
        if x.abs() <= 0.82 { x } else { x.tanh() }
    }

    fn push_mono_sample(
        &mut self,
        raw_mono: f32,
        audio_tx: &mpsc::Sender<Vec<u8>>,
        app: &AppHandle,
    ) {
        let filtered = self.highpass_dc_block(raw_mono);
        let mut remaining = 1.0f64;

        // 抗混叠积分均值下采样（Boxcar Anti-Aliasing Low-Pass Filter）：
        // 将每个 16kHz 目标采样周期内的所有原始采样点按精确时间权重积分求均值，
        // 彻底消除直接抽点造成的高频折叠混叠噪声（保护 s/sh/th/z/c/zh/ch 等清辅音可懂度）。
        while remaining > 0.0 {
            let space = self.ratio - self.phase;
            if remaining < space {
                self.accum_sum += (filtered as f64) * remaining;
                self.accum_weight += remaining;
                self.phase += remaining;
                remaining = 0.0;
            } else {
                self.accum_sum += (filtered as f64) * space;
                self.accum_weight += space;
                remaining -= space;
                self.phase = 0.0;

                let avg = if self.accum_weight > 0.0 {
                    (self.accum_sum / self.accum_weight) as f32
                } else {
                    filtered
                };
                self.accum_sum = 0.0;
                self.accum_weight = 0.0;

                let boosted = Self::soft_clip(avg * self.agc_gain);
                let pcm_val = if boosted < 0.0 {
                    (boosted * 32768.0) as i16
                } else {
                    (boosted * 32767.0) as i16
                };
                self.chunk_buffer.extend_from_slice(&pcm_val.to_le_bytes());

                if self.chunk_buffer.len() >= 3200 {
                    self.flush_chunk(audio_tx, app);
                }
            }
        }
    }

    fn flush_chunk(&mut self, audio_tx: &mpsc::Sender<Vec<u8>>, app: &AppHandle) {
        let chunk = std::mem::replace(&mut self.chunk_buffer, Vec::with_capacity(3200));

        let mut sum_sq: i64 = 0;
        for &c in chunk.as_chunks::<2>().0 {
            let v = i16::from_le_bytes(c) as i64;
            sum_sq += v * v;
        }
        let mean_sq = (sum_sq as f64) / 1600.0;
        let rms = (mean_sq.sqrt() / 32768.0) as f32;

        // 远场/扬声器外录自适应增益 (Soft-AGC)：当检测到有效语音但音量偏小时平滑拉升至最佳识别动态范围
        if rms > 0.008 && rms < 0.14 {
            let target_gain = (0.13 / rms).clamp(1.0, 2.8);
            self.agc_gain = self.agc_gain * 0.90 + target_gain * 0.10;
        } else if rms >= 0.22 {
            self.agc_gain = (self.agc_gain * 0.85 + 1.0 * 0.15).max(1.0);
        }

        let volume_f32 = (rms * 280.0).clamp(0.0, 100.0);
        let volume = volume_f32.round() as u8;

        let now = std::time::Instant::now();
        if now.duration_since(self.last_emit_instant) >= std::time::Duration::from_millis(200) {
            let diff = (volume as i16 - self.last_emitted_vol as i16).abs();
            if diff >= 3
                || (volume == 0 && self.last_emitted_vol > 0)
                || (volume > 0 && self.last_emitted_vol == 0)
            {
                self.last_emitted_vol = volume;
                self.last_emit_instant = now;
                let _ = app.emit("audio-level", serde_json::json!({ "volume": volume }));
            }
        }

        self.vad_gate.process_chunk(chunk, volume_f32, audio_tx);
    }
}

pub struct NativeAudioCapture {
    stream: Option<Stream>,
    is_capturing: Arc<AtomicBool>,
    app_handle: Option<AppHandle>,
}

pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let mut names = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for dev in devices {
            if let Ok(desc) = dev.description() {
                let name = desc.name().trim().to_string();
                if !name.is_empty() && !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    names
}

impl Default for NativeAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeAudioCapture {
    pub fn new() -> Self {
        Self {
            stream: None,
            is_capturing: Arc::new(AtomicBool::new(false)),
            app_handle: None,
        }
    }

    /// 启动系统麦克风或指定音频输入设备（如 BlackHole / Loopback 系统内录）的高保真采集
    pub fn start(
        &mut self,
        audio_tx: mpsc::Sender<Vec<u8>>,
        app: AppHandle,
        enable_vad: bool,
        vad_threshold: f32,
        preferred_device: Option<&str>,
    ) -> Result<(), String> {
        let host = cpal::default_host();
        let device = preferred_device
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "default")
            .and_then(|target_name| {
                host.input_devices().ok().and_then(|mut devs| {
                    devs.find(|d| {
                        d.description()
                            .map(|desc| {
                                desc.name() == target_name || desc.name().contains(target_name)
                            })
                            .unwrap_or(false)
                    })
                })
            })
            .or_else(|| host.default_input_device())
            .ok_or_else(|| {
                "未检测到可用的系统音频输入设备，请检查麦克风或内录设备连接".to_string()
            })?;

        let device_name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "默认输入设备".to_string());
        println!(
            "🎙️ [LiveHear] 已连接音频输入源: 「{}」 (智能静音门禁: {})",
            device_name, enable_vad
        );

        let default_config = device
            .default_input_config()
            .map_err(|e| format!("获取麦克风配置失败: {}", e))?;

        let in_channels = default_config.channels() as usize;
        let in_sample_rate = default_config.sample_rate() as f64;
        let target_sample_rate = 16000.0f64;

        let is_running = Arc::new(AtomicBool::new(true));
        let is_running_clone = is_running.clone();

        let err_fn = move |err| {
            eprintln!("⚠️ [LiveHear] 麦克风音频流错误: {}", err);
        };

        let sample_format = default_config.sample_format();
        let stream_config: cpal::StreamConfig = default_config.into();

        let app_clone = app.clone();
        let mut dsp = AudioDspPipeline::new(
            in_sample_rate,
            target_sample_rate,
            enable_vad,
            vad_threshold,
        );

        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !is_running_clone.load(Ordering::Relaxed) {
                        return;
                    }

                    for frame in data.chunks(in_channels) {
                        let mut sum = 0.0f32;
                        for &s in frame {
                            sum += s;
                        }
                        let mono = (sum / in_channels as f32).clamp(-1.0, 1.0);
                        dsp.push_mono_sample(mono, &audio_tx, &app_clone);
                    }
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !is_running_clone.load(Ordering::Relaxed) {
                        return;
                    }

                    for frame in data.chunks(in_channels) {
                        let mut sum = 0i32;
                        for &s in frame {
                            sum += s as i32;
                        }
                        let mono = ((sum / in_channels as i32) as f32 / 32768.0).clamp(-1.0, 1.0);
                        dsp.push_mono_sample(mono, &audio_tx, &app_clone);
                    }
                },
                err_fn,
                None,
            ),
            _ => return Err("暂不支持该音频设备的采样格式，仅支持 F32 或 I16".to_string()),
        }
        .map_err(|e| format!("构建麦克风音频流失败: {}。请检查系统麦克风隐私授权。", e))?;

        stream
            .play()
            .map_err(|e| format!("启动麦克风录制失败: {}", e))?;

        self.stream = Some(stream);
        self.is_capturing = is_running;
        self.app_handle = Some(app);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.is_capturing.store(false, Ordering::Relaxed);
        if let Some(stream) = self.stream.take() {
            let _ = stream.pause();
        }
        if let Some(app) = self.app_handle.take() {
            let _ = app.emit("audio-level", serde_json::json!({ "volume": 0 }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::finish_audio_stream;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn closed_asr_releases_capture_and_sender_even_when_draining() {
        for draining in [false, true] {
            let capture_active = Arc::new(AtomicBool::new(true));
            let capture = Mutex::new(NativeAudioCapture {
                stream: None,
                is_capturing: capture_active.clone(),
                app_handle: None,
            });
            let (tx, mut rx) = mpsc::channel(1);
            let sender = Mutex::new(Some(tx));
            let running = AtomicBool::new(true);
            let draining_flag = AtomicBool::new(draining);
            assert_eq!(
                finish_audio_stream(&capture, &sender, &running, &draining_flag).await,
                !draining
            );
            assert!(!capture_active.load(Ordering::Relaxed));
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(running.load(Ordering::SeqCst), draining);
            assert!(!finish_audio_stream(&capture, &sender, &running, &draining_flag).await);
        }
    }
}
