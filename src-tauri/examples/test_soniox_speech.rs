use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::fs::File;
use std::io::Read;
use std::time::Duration;
use tauri_app_lib::config::SONIOX_REALTIME_MODEL;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::http::Request;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = std::env::var("SONIOX_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        eprintln!("请设置 SONIOX_API_KEY 环境变量后运行");
        return Ok(());
    }
    let ws_url = "wss://stt-rt.soniox.com/transcribe-websocket";

    println!("🔌 正在连接 Soniox WebSocket: {}", ws_url);
    let request = Request::builder()
        .uri(ws_url)
        .header("Host", "stt-rt.soniox.com")
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Sec-WebSocket-Version", "13")
        .header("Authorization", format!("Bearer {}", api_key))
        .body(())?;

    let (ws_stream, _) = connect_async(request).await?;
    println!("✅ WebSocket 握手成功！");

    let (mut write, mut read) = ws_stream.split();

    // 发送配置
    let config = json!({
        "model": SONIOX_REALTIME_MODEL,
        "audio_format": "pcm_s16le",
        "sample_rate": 16000,
        "num_channels": 1,
        "enable_speaker_diarization": true,
        "enable_endpoint_detection": true,
        "translation": {
            "type": "one_way",
            "target_language": "zh"
        }
    });

    write.send(Message::Text(config.to_string().into())).await?;
    println!("📤 配置已发送: {}", config);

    // 读任务
    let read_task = tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    println!("📥 [Soniox 响应]: {}", text);
                }
                Ok(Message::Close(cf)) => {
                    println!("🔒 WebSocket 已关闭: {:?}", cf);
                    break;
                }
                Err(e) => {
                    println!("❌ WebSocket 错误: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    // 读取 /tmp/long_speech.wav 并推流
    let mut file = File::open("/tmp/long_speech.wav")?;
    let mut wav_data = Vec::new();
    file.read_to_end(&mut wav_data)?;

    let pcm_data = if wav_data.len() > 44 {
        &wav_data[44..]
    } else {
        &wav_data[..]
    };
    println!(
        "🎙️ 准备发送 8.5 秒真实语音 PCM 数据，总字节数: {}",
        pcm_data.len()
    );

    for (i, chunk) in pcm_data.chunks(3200).enumerate() {
        write.send(Message::Binary(chunk.to_vec().into())).await?;
        if i % 10 == 0 {
            println!("  [已发送 {} / {} 块]", i, pcm_data.len() / 3200);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    write.send(Message::Text("".into())).await?;
    println!("📤 全部发送完毕 (已发送 EOF 空包)，等待服务端处理与返回...");

    tokio::time::sleep(Duration::from_millis(5000)).await;

    let _ = write.close().await;
    let _ = read_task.await;

    Ok(())
}
