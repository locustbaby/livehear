use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use std::collections::VecDeque;
use tokio::sync::mpsc;

pub const VAD_FINALIZE_SIGNAL: u8 = 1;

struct VadGate {
    enable_vad: bool,
    threshold: u8,
    is_active: bool,
    hangover_left: usize,
    hangover_max: usize,
    preroll_buf: VecDeque<Vec<u8>>,
    preroll_max: usize,
}

impl VadGate {
    fn new(enable_vad: bool, threshold: f32) -> Self {
        Self {
            enable_vad,
            threshold: threshold.clamp(1.0, 50.0) as u8,
            is_active: false,
            hangover_left: 0,
            hangover_max: 35, // 35 * 100ms = 3500ms，保证多人会议句中思考停顿与换人间隙不断流、不丢失声纹与语义上下文
            preroll_buf: VecDeque::with_capacity(5),
            preroll_max: 4, // 4 * 100ms = 400ms 预卷缓冲，确保字首辅音与轻声起音完整不吞字
        }
    }

    fn process_chunk(&mut self, chunk: Vec<u8>, volume: u8, audio_tx: &mpsc::Sender<Vec<u8>>) {
        if !self.enable_vad {
            let _ = audio_tx.try_send(chunk);
            return;
        }

        if volume >= self.threshold {
            if !self.is_active {
                self.is_active = true;
                while let Some(pre) = self.preroll_buf.pop_front() {
                    let _ = audio_tx.try_send(pre);
                }
            }
            self.hangover_left = self.hangover_max;
            let _ = audio_tx.try_send(chunk);
        } else if self.is_active {
            if self.hangover_left > 0 {
                self.hangover_left -= 1;
                let _ = audio_tx.try_send(chunk);
            } else {
                self.is_active = false;
                self.preroll_buf.clear();
                self.preroll_buf.push_back(chunk);
                // 通知 Soniox 推流协程发送 {"type": "finalize"}，立即结算挂起的非终态词与译文
                let _ = audio_tx.try_send(vec![VAD_FINALIZE_SIGNAL]);
            }
        } else {
            if self.preroll_buf.len() >= self.preroll_max {
                self.preroll_buf.pop_front();
            }
            self.preroll_buf.push_back(chunk);
        }
    }
}

pub struct NativeAudioCapture {
    stream: Option<Stream>,
    is_capturing: Arc<AtomicBool>,
    app_handle: Option<AppHandle>,
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

    /// 启动系统默认麦克风的原生高保真采集，自适应多声道混音并重采样为 Soniox 标准的 16kHz Mono PCM16
    pub fn start(
        &mut self,
        audio_tx: mpsc::Sender<Vec<u8>>,
        app: AppHandle,
        enable_vad: bool,
        vad_threshold: f32,
    ) -> Result<(), String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "未检测到可用的系统麦克风设备，请检查音频输入连接".to_string())?;

        println!("🎙️ [LiveHear] 成功连接系统默认麦克风输入设备 (智能静音降费门禁: {})", enable_vad);

        let default_config = device
            .default_input_config()
            .map_err(|e| format!("获取麦克风配置失败: {}", e))?;

        let in_channels = default_config.channels() as usize;
        let in_sample_rate = default_config.sample_rate() as f64;
        let target_sample_rate = 16000.0f64;
        let ratio = in_sample_rate / target_sample_rate;

        let is_running = Arc::new(AtomicBool::new(true));
        let is_running_clone = is_running.clone();

        let err_fn = move |err| {
            eprintln!("⚠️ [LiveHear] 麦克风音频流错误: {}", err);
        };

        let sample_format = default_config.sample_format();
        let stream_config: cpal::StreamConfig = default_config.into();

        let app_clone = app.clone();
        let mut phase = 0.0f64;
        let mut last_sample = 0.0f32;
        let mut chunk_buffer = Vec::with_capacity(3200);
        let mut vad_gate = VadGate::new(enable_vad, vad_threshold);

        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let mut last_emitted_vol: u8 = 0;
                let mut last_emit_instant = std::time::Instant::now();
                device.build_input_stream(
                    stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !is_running_clone.load(Ordering::Relaxed) {
                            return;
                        }

                        let frames = data.chunks(in_channels);
                        for frame in frames {
                            let mut sum = 0.0f32;
                            for &s in frame {
                                sum += s;
                            }
                            let s1 = (sum / in_channels as f32).clamp(-1.0, 1.0);

                            phase += 1.0;
                            while phase >= ratio {
                                phase -= ratio;
                                let frac = (phase / ratio).clamp(0.0, 1.0) as f32;
                                let sample = (last_sample * (1.0 - frac) + s1 * frac).clamp(-1.0, 1.0);
                                let pcm_val = if sample < 0.0 {
                                    (sample * 32768.0) as i16
                                } else {
                                    (sample * 32767.0) as i16
                                };
                                chunk_buffer.extend_from_slice(&pcm_val.to_le_bytes());

                                // 3200 字节 = 1600 个 16kHz 样本 = 100ms
                                if chunk_buffer.len() >= 3200 {
                                    let chunk = std::mem::replace(
                                        &mut chunk_buffer,
                                        Vec::with_capacity(3200),
                                    );

                                    // 优化 RMS 计算：使用 i64 整数乘加，避免 1600 次 float64 转换
                                    let mut sum_sq: i64 = 0;
                                    for c in chunk.chunks_exact(2) {
                                        let v = i16::from_le_bytes([c[0], c[1]]) as i64;
                                        sum_sq += v * v;
                                    }
                                    let mean_sq = (sum_sq as f64) / 1600.0;
                                    let rms = mean_sq.sqrt() / 32768.0;
                                    let volume = ((rms * 280.0).clamp(0.0, 100.0)) as u8;

                                    let now = std::time::Instant::now();
                                    if now.duration_since(last_emit_instant) >= std::time::Duration::from_millis(200) {
                                        let diff = (volume as i16 - last_emitted_vol as i16).abs();
                                        if diff >= 3 || (volume == 0 && last_emitted_vol > 0) || (volume > 0 && last_emitted_vol == 0) {
                                            last_emitted_vol = volume;
                                            last_emit_instant = now;
                                            let _ = app_clone.emit("audio-level", serde_json::json!({ "volume": volume }));
                                        }
                                    }
                                    vad_gate.process_chunk(chunk, volume, &audio_tx);
                                }
                            }
                            last_sample = s1;
                        }
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let mut vad_gate_i16 = VadGate::new(enable_vad, vad_threshold);
                let mut last_emitted_vol: u8 = 0;
                let mut last_emit_instant = std::time::Instant::now();
                device.build_input_stream(
                    stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if !is_running_clone.load(Ordering::Relaxed) {
                            return;
                        }

                        let frames = data.chunks(in_channels);
                        for frame in frames {
                            let mut sum = 0i32;
                            for &s in frame {
                                sum += s as i32;
                            }
                            let s1 = ((sum / in_channels as i32) as f32 / 32768.0).clamp(-1.0, 1.0);

                            phase += 1.0;
                            while phase >= ratio {
                                phase -= ratio;
                                let frac = (phase / ratio).clamp(0.0, 1.0) as f32;
                                let sample = (last_sample * (1.0 - frac) + s1 * frac).clamp(-1.0, 1.0);
                                let pcm_val = if sample < 0.0 {
                                    (sample * 32768.0) as i16
                                } else {
                                    (sample * 32767.0) as i16
                                };
                                chunk_buffer.extend_from_slice(&pcm_val.to_le_bytes());

                                if chunk_buffer.len() >= 3200 {
                                    let chunk = std::mem::replace(
                                        &mut chunk_buffer,
                                        Vec::with_capacity(3200),
                                    );

                                    let mut sum_sq: i64 = 0;
                                    for c in chunk.chunks_exact(2) {
                                        let v = i16::from_le_bytes([c[0], c[1]]) as i64;
                                        sum_sq += v * v;
                                    }
                                    let mean_sq = (sum_sq as f64) / 1600.0;
                                    let rms = mean_sq.sqrt() / 32768.0;
                                    let volume = ((rms * 280.0).clamp(0.0, 100.0)) as u8;

                                    let now = std::time::Instant::now();
                                    if now.duration_since(last_emit_instant) >= std::time::Duration::from_millis(200) {
                                        let diff = (volume as i16 - last_emitted_vol as i16).abs();
                                        if diff >= 3 || (volume == 0 && last_emitted_vol > 0) || (volume > 0 && last_emitted_vol == 0) {
                                            last_emitted_vol = volume;
                                            last_emit_instant = now;
                                            let _ = app_clone.emit("audio-level", serde_json::json!({ "volume": volume }));
                                        }
                                    }
                                    vad_gate_i16.process_chunk(chunk, volume, &audio_tx);
                                }
                            }
                            last_sample = s1;
                        }
                    },
                    err_fn,
                    None,
                )
            }
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
