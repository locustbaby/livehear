pub mod commands;
pub mod config;
pub mod domain;
pub mod orchestrator;
pub mod services;
mod transcript_archive;

use commands::AppContainer;
use config::AppConfig;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            std::thread::spawn(transcript_archive::TranscriptArchive::sweep_stale);
            if let Ok(dir) = app.path().app_config_dir() {
                AppConfig::init_path(dir);
            }
            let initial_config = AppConfig::load();
            println!(
                "📁 [LiveHear] 配置文件: {}",
                AppConfig::config_path().display()
            );
            app.manage(Arc::new(AppContainer {
                config: RwLock::new(initial_config),
                transcript_archive: tokio::sync::Mutex::new(Default::default()),
                orchestrator: RwLock::new(None),
                lifecycle: tokio::sync::Mutex::new(()),
            }));
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::archive_subtitles,
            commands::read_archived_subtitles,
            commands::clear_archived_subtitles,
            commands::save_config,
            commands::test_soniox,
            commands::translate,
            commands::evaluate_and_predict,
            commands::start_soniox_live,
            commands::stop_soniox_live,
            commands::push_audio,
            commands::simulate_test_speech,
            commands::save_meeting_transcript,
            commands::open_path_in_finder,
            commands::open_mic_privacy_settings,
            commands::minimize_window,
            commands::close_window,
            commands::polish_transcript,
            commands::lookup_selection,
            commands::generate_copilot_prompts,
            commands::quick_speak_translate,
            commands::list_audio_devices,
            commands::set_stealth_mode,
            commands::set_click_through,
            commands::summarize_meeting_context,
            commands::generate_ai_minutes,
        ])
        .build(tauri::generate_context!())
        .expect("运行 LiveHear Tauri 应用发生错误")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event
                && let Some(container) = app.try_state::<Arc<AppContainer>>()
                && let Ok(mut archive) = container.transcript_archive.try_lock()
            {
                archive.discard();
            }
        });
}
