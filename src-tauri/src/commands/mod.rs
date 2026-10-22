use crate::config::AppConfig;
use crate::domain::ReplySuggestion;
use crate::orchestrator::LiveHearOrchestrator;
use crate::services::asr::SonioxLiveAdapter;
use crate::services::{ASRService, DecisionGateService, PredictService, TranslationService};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

pub struct AppContainer {
    pub config: RwLock<AppConfig>,
    pub orchestrator: RwLock<Option<Arc<LiveHearOrchestrator>>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QuickPredictResult {
    pub is_question: bool,
    pub intent: String,
    pub suggestions: Vec<ReplySuggestion>,
}

#[tauri::command]
pub async fn get_config(container: State<'_, Arc<AppContainer>>) -> Result<AppConfig, String> {
    let conf = container.config.read().await;
    Ok(conf.clone())
}

#[tauri::command]
pub async fn save_config(
    new_config: AppConfig,
    container: State<'_, Arc<AppContainer>>,
) -> Result<(), String> {
    new_config.save().map_err(|e| e.to_string())?;
    let mut conf = container.config.write().await;
    *conf = new_config;
    Ok(())
}

#[tauri::command]
pub async fn test_soniox(
    api_key: String,
    container: State<'_, Arc<AppContainer>>,
) -> Result<String, String> {
    let mut cfg = {
        let conf = container.config.read().await;
        conf.soniox.clone()
    };
    if !api_key.trim().is_empty() {
        cfg.api_key = api_key;
    }
    let adapter = SonioxLiveAdapter::new(cfg);
    adapter.test_connection().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn translate(
    text: String,
    source_lang: String,
    target_lang: String,
    container: State<'_, Arc<AppContainer>>,
) -> Result<String, String> {
    let openrouter_cfg = {
        let conf = container.config.read().await;
        conf.openrouter.clone()
    };
    let adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);
    adapter
        .translate(&text, &source_lang, &target_lang)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn evaluate_and_predict(
    text: String,
    container: State<'_, Arc<AppContainer>>,
) -> Result<QuickPredictResult, String> {
    let (openrouter_cfg, jev_cfg, meeting_ctx) = {
        let conf = container.config.read().await;
        (conf.openrouter.clone(), conf.jev.clone(), conf.meeting.context.clone())
    };

    let jev_adapter = crate::services::ai::JevAdapter::new(jev_cfg, openrouter_cfg.api_key.clone());
    let predict_adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);

    let decision = jev_adapter
        .evaluate(&text, &meeting_ctx)
        .await
        .map_err(|e| e.to_string())?;

    let suggestions = if decision.is_question {
        predict_adapter
            .generate_suggestions(&text, &meeting_ctx)
            .await
            .unwrap_or_default()
    } else {
        vec![]
    };

    Ok(QuickPredictResult {
        is_question: decision.is_question,
        intent: decision.intent.display_name().to_string(),
        suggestions,
    })
}

#[tauri::command]
pub async fn start_soniox_live(
    app: AppHandle,
    container: State<'_, Arc<AppContainer>>,
) -> Result<(), String> {
    // 确保若已有运行中的协同实例，先安全停止，避免麦克风硬件资源争抢或重复连线
    {
        let mut lock = container.orchestrator.write().await;
        if let Some(old_orch) = lock.take() {
            old_orch.stop().await;
        }
    }

    let conf = {
        let guard = container.config.read().await;
        guard.clone()
    };

    let asr = Arc::new(SonioxLiveAdapter::new(conf.soniox.clone()));
    let translator = Arc::new(crate::services::ai::OpenRouterAdapter::new(conf.openrouter.clone()));
    let decision = Arc::new(crate::services::ai::JevAdapter::new(
        conf.jev.clone(),
        conf.openrouter.api_key.clone(),
    ));
    let predictor = Arc::new(crate::services::ai::OpenRouterAdapter::new(conf.openrouter.clone()));

    let orchestrator = Arc::new(LiveHearOrchestrator::new(
        asr,
        translator,
        decision,
        predictor,
        conf.meeting.context,
        conf.meeting.auto_predict,
    ));

    orchestrator.start(app).await.map_err(|e| e.to_string())?;

    let mut lock = container.orchestrator.write().await;
    *lock = Some(orchestrator);

    Ok(())
}

#[tauri::command]
pub async fn stop_soniox_live(container: State<'_, Arc<AppContainer>>) -> Result<(), String> {
    let mut lock = container.orchestrator.write().await;
    if let Some(orch) = lock.as_ref() {
        orch.stop().await;
    }
    *lock = None;
    Ok(())
}

#[tauri::command]
pub async fn push_audio(
    chunk: Vec<u8>,
    container: State<'_, Arc<AppContainer>>,
) -> Result<(), String> {
    let lock = container.orchestrator.read().await;
    if let Some(orch) = lock.as_ref() {
        orch.push_audio(chunk).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn simulate_test_speech(
    container: State<'_, Arc<AppContainer>>,
) -> Result<String, String> {
    let wav_path = std::path::Path::new("/tmp/long_speech.wav");
    if !wav_path.exists() {
        return Err("测试音频文件 /tmp/long_speech.wav 不存在".to_string());
    }

    let orch = {
        let lock = container.orchestrator.read().await;
        lock.clone()
    };

    let orch = orch.ok_or_else(|| "实时流尚未启动，请先启动实时同传".to_string())?;

    tokio::spawn(async move {
        if let Ok(wav_data) = std::fs::read("/tmp/long_speech.wav") {
            let pcm = if wav_data.len() > 44 { &wav_data[44..] } else { &wav_data[..] };
            println!("🎙️ [模拟测试音频] 开始推送真实语音流 (共 {} 字节)...", pcm.len());
            for chunk in pcm.chunks(3200) {
                let _ = orch.push_audio(chunk.to_vec()).await;
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
            println!("✅ [模拟测试音频] 推送完毕！");
        }
    });

    Ok("已启动 8.5 秒真实语音流模拟推送，请观察实时双语字幕".to_string())
}


