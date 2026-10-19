pub mod commands;
pub mod config;
pub mod domain;
pub mod orchestrator;
pub mod services;

use commands::AppContainer;
use config::AppConfig;
use std::sync::Arc;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_config = AppConfig::load();
    let container = Arc::new(AppContainer {
        config: RwLock::new(initial_config),
        orchestrator: RwLock::new(None),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(container)
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::test_soniox,
            commands::translate,
            commands::evaluate_and_predict,
            commands::start_soniox_live,
            commands::stop_soniox_live,
        ])
        .run(tauri::generate_context!())
        .expect("运行 LiveHear Tauri 应用发生错误");
}
