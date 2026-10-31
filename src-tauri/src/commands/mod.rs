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
    let mut conf = container.config.write().await;
    new_config.save().map_err(|e| e.to_string())?;
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
    let adapter = SonioxLiveAdapter::new(cfg, None);
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
    let mut orchestrator_slot = container.orchestrator.write().await;
    if let Some(old_orch) = orchestrator_slot.take() {
        if !old_orch.stop().await { return Err("本地识别收尾超时，部分字幕可能未完成".into()); }
    }

    let conf = {
        let guard = container.config.read().await;
        guard.clone()
    };

    let asr: Arc<dyn ASRService> = match conf.asr_backend.provider.as_str() {
        "soniox" => Arc::new(SonioxLiveAdapter::new(conf.soniox.clone(), Some(app.clone()))
            .with_meeting_context(conf.meeting.context.clone())),
        "ollama" => Arc::new(crate::services::asr::ollama::OllamaAsr::new(conf.asr_backend.clone(), app.clone())),
        other => return Err(format!("未知识别引擎: {}", other)),
    };
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
        conf.soniox.language_a,
        conf.soniox.target_language,
        conf.asr_backend.provider == "ollama",
        !conf.openrouter.api_key.trim().is_empty(),
        conf.soniox.enable_vad,
        conf.soniox.vad_threshold,
        conf.soniox.input_device,
    ));

    orchestrator.start(app).await.map_err(|e| e.to_string())?;

    *orchestrator_slot = Some(orchestrator);

    Ok(())
}

#[tauri::command]
pub async fn stop_soniox_live(container: State<'_, Arc<AppContainer>>) -> Result<(), String> {
    let mut lock = container.orchestrator.write().await;
    if let Some(orch) = lock.as_ref() {
        let complete = orch.stop().await;
        *lock = None;
        if !complete { return Err("本地识别收尾超时，部分字幕可能未完成".into()); }
        return Ok(());
    }
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

#[tauri::command]
pub async fn save_meeting_transcript(
    content: String,
    filename: Option<String>,
    save_dir: Option<String>,
    container: State<'_, Arc<AppContainer>>,
) -> Result<String, String> {
    let conf = {
        let guard = container.config.read().await;
        guard.clone()
    };

    let dir_str = save_dir
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(conf.storage.save_dir);

    let resolved_dir = resolve_dir_path(&dir_str);
    if let Err(e) = std::fs::create_dir_all(&resolved_dir) {
        return Err(format!("创建会议纪要目录失败 ({}): {}", resolved_dir.display(), e));
    }

    let fname = filename.unwrap_or_else(|| {
        let now = chrono::Local::now();
        format!("Meeting_{}.{}", now.format("%Y%m%d_%H%M%S"), conf.storage.file_format)
    });

    let target_file = resolved_dir.join(&fname);
    std::fs::write(&target_file, content.as_bytes())
        .map_err(|e| format!("写入文件失败 ({}): {}", target_file.display(), e))?;

    println!("💾 [LiveHear] 会议纪要已成功保存至: {}", target_file.display());
    Ok(target_file.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_path_in_finder(path: String) -> Result<(), String> {
    let resolved = resolve_dir_path(&path);
    if !resolved.exists() {
        return Err(format!("路径不存在: {}", resolved.display()));
    }

    #[cfg(target_os = "macos")]
    {
        let is_dir = resolved.is_dir();
        let mut cmd = std::process::Command::new("open");
        if !is_dir {
            cmd.arg("-R");
        }
        cmd.arg(&resolved);
        cmd.spawn().map_err(|e| format!("无法打开路径: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = opener::open(&resolved);
    }

    Ok(())
}

#[tauri::command]
pub async fn polish_transcript(
    original: String,
    draft: String,
    recent_history: Option<String>,
    low_confidence_words: Option<Vec<String>>,
    target_lang: Option<String>,
    speak_mode: Option<bool>,
    container: State<'_, Arc<AppContainer>>,
) -> Result<crate::services::ai::openrouter::PolishResult, String> {
    let conf = {
        let guard = container.config.read().await;
        guard.clone()
    };

    let is_speak_foreign = speak_mode.unwrap_or(false);

    if !conf.openrouter.enable_polish && !is_speak_foreign {
        return Ok(crate::services::ai::openrouter::PolishResult {
            original,
            translated: draft,
            tone_tag: None,
        });
    }

    let adapter = crate::services::ai::OpenRouterAdapter::new(conf.openrouter);
    adapter
        .polish_and_connect(
            &original,
            &draft,
            recent_history.as_deref().unwrap_or(""),
            &low_confidence_words.unwrap_or_default(),
            &conf.meeting.context,
            &conf.soniox.custom_terms,
            target_lang.as_deref(),
            is_speak_foreign,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lookup_selection(
    selection: String,
    sentence_context: Option<String>,
    container: State<'_, Arc<AppContainer>>,
) -> Result<crate::services::ai::openrouter::LookupResult, String> {
    let (openrouter_cfg, meeting_ctx) = {
        let guard = container.config.read().await;
        (guard.openrouter.clone(), guard.meeting.context.clone())
    };
    let adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);
    adapter
        .lookup_selection(
            &selection,
            sentence_context.as_deref().unwrap_or(""),
            &meeting_ctx,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_copilot_prompts(
    recent_history: String,
    user_intent: Option<String>,
    target_lang: Option<String>,
    container: State<'_, Arc<AppContainer>>,
) -> Result<Vec<ReplySuggestion>, String> {
    let (openrouter_cfg, meeting_ctx, default_speak_lang) = {
        let guard = container.config.read().await;
        (
            guard.openrouter.clone(),
            guard.meeting.context.clone(),
            guard.soniox.speak_target_language.clone(),
        )
    };
    let eff_lang = target_lang
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_speak_lang);
    let adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);
    adapter
        .generate_copilot_prompts(
            &recent_history,
            user_intent.as_deref(),
            &meeting_ctx,
            Some(&eff_lang),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn quick_speak_translate(
    text: String,
    target_lang: Option<String>,
    recent_history: Option<String>,
    container: State<'_, Arc<AppContainer>>,
) -> Result<crate::services::ai::openrouter::QuickSpeakResult, String> {
    let (openrouter_cfg, meeting_ctx, custom_terms, default_speak_lang) = {
        let guard = container.config.read().await;
        (
            guard.openrouter.clone(),
            guard.meeting.context.clone(),
            guard.soniox.custom_terms.clone(),
            guard.soniox.speak_target_language.clone(),
        )
    };
    let eff_lang = target_lang
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_speak_lang);
    let adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);
    adapter
        .quick_speak_translate(
            &text,
            &eff_lang,
            recent_history.as_deref().unwrap_or(""),
            &meeting_ctx,
            &custom_terms,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_audio_devices() -> Result<Vec<String>, String> {
    Ok(crate::services::audio_capture::list_input_devices())
}

#[tauri::command]
pub async fn set_stealth_mode(
    enabled: bool,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    window
        .set_content_protected(enabled)
        .map_err(|e| format!("设置防截屏隐身模式失败: {}", e))?;
    Ok(enabled)
}

#[tauri::command]
pub async fn set_click_through(
    enabled: bool,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| format!("设置鼠标穿透失败: {}", e))?;
    Ok(enabled)
}

#[tauri::command]
pub async fn summarize_meeting_context(
    recent_history: String,
    container: State<'_, Arc<AppContainer>>,
) -> Result<Vec<ReplySuggestion>, String> {
    let (openrouter_cfg, meeting_ctx) = {
        let guard = container.config.read().await;
        (guard.openrouter.clone(), guard.meeting.context.clone())
    };
    let adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);
    adapter
        .summarize_recent_context(&recent_history, &meeting_ctx)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_ai_minutes(
    transcript: String,
    container: State<'_, Arc<AppContainer>>,
) -> Result<String, String> {
    let (openrouter_cfg, meeting_ctx) = {
        let guard = container.config.read().await;
        (guard.openrouter.clone(), guard.meeting.context.clone())
    };
    let adapter = crate::services::ai::OpenRouterAdapter::new(openrouter_cfg);
    adapter
        .generate_meeting_minutes(&transcript, &meeting_ctx)
        .await
        .map_err(|e| e.to_string())
}

fn resolve_dir_path(path_str: &str) -> std::path::PathBuf {
    let trimmed = path_str.trim();
    if trimmed.starts_with("~/") || trimmed == "~" {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        if trimmed == "~" {
            return home;
        } else {
            return home.join(&trimmed[2..]);
        }
    }
    std::path::PathBuf::from(trimmed)
}


