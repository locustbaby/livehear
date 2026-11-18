use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream};
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub const VAD_FINALIZE_SIGNAL: u8 = 1;
const LOOPBACK_PREFIX: &str = "wasapi-loopback:";

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

    fn push_interleaved<T: SizedSample>(
        &mut self,
        data: &cpal::Data,
        channels: usize,
        audio_tx: &mpsc::Sender<Vec<u8>>,
        app: &AppHandle,
    ) where
        f32: FromSample<T>,
    {
        if let Some(samples) = data.as_slice::<T>() {
            for frame in samples.chunks_exact(channels) {
                let sum: f32 = frame.iter().map(|sample| sample.to_sample::<f32>()).sum();
                self.push_mono_sample((sum / channels as f32).clamp(-1.0, 1.0), audio_tx, app);
            }
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

#[derive(Default, serde::Serialize)]
pub struct AudioDevices {
    inputs: Vec<String>,
    system_outputs: Vec<SystemOutput>,
}

#[derive(serde::Serialize)]
struct SystemOutput {
    id: String,
    name: String,
}

pub fn list_audio_devices() -> AudioDevices {
    let host = cpal::default_host();
    let mut sources = AudioDevices::default();
    if let Ok(devices) = host.input_devices() {
        for dev in devices {
            if let Ok(desc) = dev.description() {
                let name = desc.name().trim().to_string();
                if !name.is_empty() && !sources.inputs.contains(&name) {
                    sources.inputs.push(name);
                }
            }
        }
    }
    if cfg!(target_os = "windows") {
        sources.system_outputs.push(SystemOutput {
            id: format!("{LOOPBACK_PREFIX}default"),
            name: "系统默认播放设备".into(),
        });
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                if let (Ok(id), Ok(description)) = (device.id(), device.description()) {
                    sources.system_outputs.push(SystemOutput {
                        id: format!("{LOOPBACK_PREFIX}{id}"),
                        name: description.name().to_string(),
                    });
                }
            }
        }
    }
    sources
}

fn is_microphone_access_denied(error: &cpal::Error) -> bool {
    // CPAL's WASAPI backend leaves E_ACCESSDENIED in the formatted OS error.
    error.kind() == cpal::ErrorKind::PermissionDenied
        || error
            .message()
            .is_some_and(|msg| msg.contains("(os error -2147024891)"))
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

    /// 启动选定音频源的采集流。
    pub fn start(
        &mut self,
        audio_tx: mpsc::Sender<Vec<u8>>,
        app: AppHandle,
        enable_vad: bool,
        vad_threshold: f32,
        preferred_device: Option<&str>,
    ) -> Result<(), String> {
        let host = cpal::default_host();
        let preferred_device = preferred_device.map(str::trim);
        let output_id = preferred_device.and_then(|name| name.strip_prefix(LOOPBACK_PREFIX));
        let source = if output_id.is_some() {
            "系统声音"
        } else {
            "麦克风"
        };
        let device = if let Some(id) = output_id {
            if !cfg!(target_os = "windows") {
                return Err("此系统不支持 Windows 系统声音采集，请重新选择音频源".into());
            }
            let output = if id == "default" {
                host.default_output_device()
            } else {
                id.parse::<cpal::DeviceId>()
                    .ok()
                    .and_then(|id| host.device_by_id(&id))
                    .filter(DeviceTrait::supports_output)
            };
            output.ok_or("所选播放设备不可用，请在设置中重新选择会议使用的播放设备")?
        } else {
            preferred_device
                .filter(|s| !s.is_empty() && *s != "default")
                .and_then(|target_name| {
                    let devs: Vec<_> = host.input_devices().ok()?.collect();
                    let name_of = |d: &cpal::Device| {
                        d.description()
                            .map(|desc| desc.name().trim().to_string())
                            .ok()
                    };
                    // Exact match first: "Microphone" must not pick "Microphone Array" just because it enumerates earlier.
                    let exact = devs
                        .iter()
                        .position(|d| name_of(d).as_deref() == Some(target_name));
                    let idx = exact.or_else(|| {
                        devs.iter()
                            .position(|d| name_of(d).is_some_and(|n| n.contains(target_name)))
                    })?;
                    devs.into_iter().nth(idx)
                })
                .or_else(|| host.default_input_device())
                .ok_or("未检测到可用的音频输入设备，请检查麦克风或内录设备连接")?
        };

        let capture_error = |action: &str, error: cpal::Error| {
            if output_id.is_none() && is_microphone_access_denied(&error) {
                format!("麦克风访问被拒绝，请在系统隐私设置中允许访问后重试（{error}）")
            } else {
                format!("{source}{action}失败: {error}")
            }
        };

        let device_name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| source.to_string());
        println!(
            "🎙️ [LiveHear] 已连接音频输入源: 「{}」 (智能静音门禁: {})",
            device_name, enable_vad
        );

        // WASAPI enables loopback when an input stream is opened on a playback device.
        let default_config = if output_id.is_some() {
            device.default_output_config()
        } else {
            device.default_input_config()
        }
        .map_err(|e| capture_error("配置", e))?;

        let in_channels = default_config.channels() as usize;
        let in_sample_rate = default_config.sample_rate() as f64;
        let target_sample_rate = 16000.0f64;

        let is_running = Arc::new(AtomicBool::new(true));
        let is_running_clone = is_running.clone();

        let err_app = app.clone();
        let err_reported = Arc::new(AtomicBool::new(false));
        let err_fn = move |err: cpal::Error| {
            if err.kind() == cpal::ErrorKind::DeviceChanged {
                return;
            }
            eprintln!("⚠️ [LiveHear] {source}采集错误: {err}");
            if !err_reported.swap(true, Ordering::Relaxed) {
                let msg = match err.kind() {
                    cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::StreamInvalidated => {
                        let _ = err_app.emit("audio-level", serde_json::json!({ "volume": 0 }));
                        format!("{source}设备已断开或不可用，请重新连接设备后重启同传")
                    }
                    _ => format!("{source}采集错误: {err}"),
                };
                let _ = err_app.emit("asr-error", msg);
            }
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

        let push_samples = match sample_format {
            SampleFormat::I16 => AudioDspPipeline::push_interleaved::<i16>,
            SampleFormat::I24 => AudioDspPipeline::push_interleaved::<cpal::I24>,
            SampleFormat::I32 => AudioDspPipeline::push_interleaved::<i32>,
            SampleFormat::I64 => AudioDspPipeline::push_interleaved::<i64>,
            SampleFormat::U8 => AudioDspPipeline::push_interleaved::<u8>,
            SampleFormat::F32 => AudioDspPipeline::push_interleaved::<f32>,
            SampleFormat::F64 => AudioDspPipeline::push_interleaved::<f64>,
            _ => return Err(format!("{source}使用了暂不支持的采样格式: {sample_format}")),
        };

        let stream = device
            .build_input_stream_raw(
                stream_config,
                sample_format,
                move |data, _| {
                    if is_running_clone.load(Ordering::Relaxed) {
                        push_samples(&mut dsp, data, in_channels, &audio_tx, &app_clone);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| capture_error("采集流创建", e))?;

        stream.play().map_err(|e| capture_error("启动", e))?;

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

    #[test]
    fn identifies_microphone_permission_errors() {
        use cpal::{Error, ErrorKind};

        assert!(is_microphone_access_denied(
            &ErrorKind::PermissionDenied.into()
        ));
        assert!(is_microphone_access_denied(&Error::with_message(
            ErrorKind::BackendError,
            "Failed to initialize audio client: 拒绝访问。 (os error -2147024891)",
        )));
        assert!(!is_microphone_access_denied(
            &ErrorKind::DeviceNotAvailable.into()
        ));
    }

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
