use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct NativeAudioCapture {
    stream: Option<Stream>,
    is_capturing: Arc<AtomicBool>,
}

impl NativeAudioCapture {
    pub fn new() -> Self {
        Self {
            stream: None,
            is_capturing: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动系统默认麦克风的原生高保真采集，并自适应重采样为 Soniox 标准的 16kHz Mono PCM16
    pub fn start(&mut self, audio_tx: mpsc::Sender<Vec<u8>>) -> Result<(), String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "未检测到可用的系统麦克风设备".to_string())?;

        println!("🎙️ [LiveHear] 成功连接系统默认麦克风输入设备");

        let default_config = device
            .default_input_config()
            .map_err(|e| format!("获取麦克风配置失败: {}", e))?;

        let in_channels = default_config.channels() as usize;
        let in_sample_rate = default_config.sample_rate();
        let target_sample_rate = 16000.0f64;
        let step = (in_sample_rate as f64) / target_sample_rate;

        let is_running = Arc::new(AtomicBool::new(true));
        let is_running_clone = is_running.clone();

        let err_fn = |err| {
            eprintln!("⚠️ [LiveHear] 麦克风音频流错误: {}", err);
        };

        let sample_format = default_config.sample_format();
        let stream_config: cpal::StreamConfig = default_config.into();

        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let mut accum = 0.0f64;
                let mut chunk_buffer = Vec::with_capacity(3200);

                device.build_input_stream(
                    stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !is_running_clone.load(Ordering::Relaxed) {
                            return;
                        }

                        let frames = data.chunks(in_channels);
                        for frame in frames {
                            accum += 1.0;
                            if accum >= step {
                                accum -= step;
                                let sample = frame[0].clamp(-1.0, 1.0);
                                let pcm_val = if sample < 0.0 {
                                    (sample * 32768.0) as i16
                                } else {
                                    (sample * 32767.0) as i16
                                };
                                chunk_buffer.extend_from_slice(&pcm_val.to_le_bytes());

                                // 每 1600 个样本 (100ms) 向 Soniox WebSocket 推送一块
                                if chunk_buffer.len() >= 3200 {
                                    let chunk = std::mem::replace(
                                        &mut chunk_buffer,
                                        Vec::with_capacity(3200),
                                    );
                                    let _ = audio_tx.try_send(chunk);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let mut accum = 0.0f64;
                let mut chunk_buffer = Vec::with_capacity(3200);

                device.build_input_stream(
                    stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if !is_running_clone.load(Ordering::Relaxed) {
                            return;
                        }

                        let frames = data.chunks(in_channels);
                        for frame in frames {
                            accum += 1.0;
                            if accum >= step {
                                accum -= step;
                                let sample = frame[0];
                                chunk_buffer.extend_from_slice(&sample.to_le_bytes());

                                if chunk_buffer.len() >= 3200 {
                                    let chunk = std::mem::replace(
                                        &mut chunk_buffer,
                                        Vec::with_capacity(3200),
                                    );
                                    let _ = audio_tx.try_send(chunk);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
            }
            _ => return Err("不支持的麦克风音频采样格式".to_string()),
        }
        .map_err(|e| format!("构建麦克风音频流失败: {}", e))?;

        stream
            .play()
            .map_err(|e| format!("启动麦克风录制失败: {}", e))?;

        self.stream = Some(stream);
        self.is_capturing = is_running;
        Ok(())
    }

    pub fn stop(&mut self) {
        self.is_capturing.store(false, Ordering::Relaxed);
        if let Some(stream) = self.stream.take() {
            let _ = stream.pause();
        }
    }
}
