pub mod commands;
pub mod config;
pub mod domain;
pub mod orchestrator;
pub mod services;

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
            if let Ok(dir) = app.path().app_config_dir() {
                AppConfig::init_path(dir);
            }
            let initial_config = AppConfig::load();
            println!("📁 [LiveHear] 配置文件: {}", AppConfig::config_path().display());
            app.manage(Arc::new(AppContainer {
                config: RwLock::new(initial_config),
                orchestrator: RwLock::new(None),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
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
            commands::polish_transcript,
        ])
        .run(tauri::generate_context!())
        .expect("运行 LiveHear Tauri 应用发生错误");
}
