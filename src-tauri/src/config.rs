use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();
pub const SONIOX_REALTIME_MODEL: &str = "stt-rt-v6";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxConfig {
    pub api_key: String,
    pub ws_url: String,
    #[serde(deserialize_with = "deserialize_soniox_model")]
    pub model: String,
    pub sample_rate: u32,
    pub enable_speaker_diarization: bool,
    #[serde(default = "default_enable_endpoint_detection")]
    pub enable_endpoint_detection: bool,
    #[serde(default = "default_language_hints")]
    pub language_hints: Vec<String>,
    #[serde(default = "default_language_hints_strict")]
    pub language_hints_strict: bool,
    #[serde(default = "default_enable_translation")]
    pub enable_translation: bool,
    #[serde(default = "default_translation_type")]
    pub translation_type: String, // "one_way" (涉外会议同传) 或 "two_way" (跨国双向对话)
    #[serde(default = "default_target_language")]
    pub target_language: String, // "zh"
    #[serde(default = "default_speak_target_language")]
    pub speak_target_language: String, // "en"
    #[serde(default = "default_language_a")]
    pub language_a: String, // "en"
    #[serde(default = "default_language_b")]
    pub language_b: String, // "zh"
    #[serde(default = "default_max_endpoint_delay_ms")]
    pub max_endpoint_delay_ms: u32,
    #[serde(default = "default_endpoint_sensitivity")]
    pub endpoint_sensitivity: f32,
    #[serde(default)]
    pub custom_terms: Vec<String>,
    #[serde(default = "default_enable_vad")]
    pub enable_vad: bool, // 智能静音门禁，降低 60-70% Soniox Token 扣费
    #[serde(default = "default_vad_threshold")]
    pub vad_threshold: f32,
    #[serde(default)]
    pub input_device: Option<String>,
}

fn deserialize_soniox_model<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let model = String::deserialize(deserializer)?;
    Ok(match model.trim() {
        "" | "stt-rt-v3" | "stt-rt-v4" | "stt-rt-v5" => SONIOX_REALTIME_MODEL.to_string(),
        model => model.to_string(),
    })
}

fn default_enable_endpoint_detection() -> bool {
    true
}

fn default_language_hints() -> Vec<String> {
    vec!["en".to_string(), "zh".to_string()]
}

fn default_language_hints_strict() -> bool {
    true
}

fn default_enable_translation() -> bool {
    true
}

fn default_translation_type() -> String {
    "two_way".to_string()
}

fn default_target_language() -> String {
    "zh".to_string()
}

fn default_speak_target_language() -> String {
    "en".to_string()
}

fn default_language_a() -> String {
    "en".to_string()
}

fn default_language_b() -> String {
    "zh".to_string()
}

fn default_max_endpoint_delay_ms() -> u32 {
    2000
}

fn default_endpoint_sensitivity() -> f32 {
    -0.2
}

fn default_enable_vad() -> bool {
    true
}

fn default_vad_threshold() -> f32 {
    1.8
}

impl Default for SonioxConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            ws_url: "wss://stt-rt.soniox.com/transcribe-websocket".to_string(),
            model: SONIOX_REALTIME_MODEL.to_string(),
            sample_rate: 16000,
            enable_speaker_diarization: true,
            enable_endpoint_detection: true,
            language_hints: vec!["en".to_string(), "zh".to_string()],
            language_hints_strict: true,
            enable_translation: true,
            translation_type: default_translation_type(),
            target_language: "zh".to_string(),
            speak_target_language: "en".to_string(),
            language_a: "en".to_string(),
            language_b: "zh".to_string(),
            max_endpoint_delay_ms: 2000,
            endpoint_sensitivity: default_endpoint_sensitivity(),
            custom_terms: vec![],
            enable_vad: true,
            vad_threshold: 1.8,
            input_device: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenRouterConfig {
    pub api_key: String,
    pub base_url: String,
    pub translate_model: String,
    pub predict_model: String,
    #[serde(default = "default_enable_polish")]
    pub enable_polish: bool,
}

fn default_enable_polish() -> bool {
    true
}

impl Default for OpenRouterConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            translate_model: "deepseek/deepseek-chat".to_string(),
            predict_model: "deepseek/deepseek-chat".to_string(),
            enable_polish: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JevConfig {
    pub enabled: bool,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub confidence_threshold: f32,
}

impl Default for JevConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key: String::new(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            model: "deepseek/deepseek-chat".to_string(),
            confidence_threshold: 0.8,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MeetingConfig {
    pub auto_predict: bool,
    pub context: String,
}

impl Default for MeetingConfig {
    fn default() -> Self {
        Self {
            auto_predict: true,
            context: "跨国远程团队日常同步与架构评审周会".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StorageConfig {
    #[serde(default = "default_auto_save")]
    pub auto_save: bool,
    #[serde(default = "default_save_dir")]
    pub save_dir: String,
    #[serde(default = "default_file_format")]
    pub file_format: String,
}

fn default_auto_save() -> bool {
    true
}

fn default_save_dir() -> String {
    "~/Documents/livehear".to_string()
}

fn default_file_format() -> String {
    "txt".to_string()
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            auto_save: true,
            save_dir: default_save_dir(),
            file_format: default_file_format(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AsrBackendConfig {
    pub provider: String,
    pub ollama_url: String,
    pub ollama_model: String,
}

impl Default for AsrBackendConfig {
    fn default() -> Self {
        Self {
            provider: "soniox".into(),
            ollama_url: "http://127.0.0.1:11434".into(),
            ollama_model: "livehear-qwen3-asr:1.7b".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    #[serde(default)]
    pub asr_backend: AsrBackendConfig,
    pub soniox: SonioxConfig,
    pub openrouter: OpenRouterConfig,
    pub jev: JevConfig,
    pub meeting: MeetingConfig,
    #[serde(default)]
    pub storage: StorageConfig,
}

impl AppConfig {
    /// 绑定配置文件的固定落点（应用配置目录）。打包后进程 cwd 为 `/`，不能依赖相对路径。
    pub fn init_path(dir: PathBuf) {
        let _ = CONFIG_PATH.set(dir.join("config.json"));
    }

    pub fn config_path() -> PathBuf {
        if let Ok(p) = std::env::var("LIVEHEAR_CONFIG") {
            return PathBuf::from(p);
        }
        CONFIG_PATH
            .get()
            .cloned()
            .unwrap_or_else(|| PathBuf::from("livehear.config.json"))
    }

    /// 仅用于首次启动时从开发期遗留位置导入，之后以应用配置目录为准。
    fn legacy_candidates() -> Vec<PathBuf> {
        let mut v = vec![
            PathBuf::from("../livehear.config.json"),
            PathBuf::from("livehear.config.json"),
        ];
        if let Some(home) = dirs_home() {
            v.push(home.join(".config").join("livehear").join("config.json"));
        }
        v
    }

    fn read(path: &Path) -> Option<AppConfig> {
        let content = fs::read_to_string(path).ok()?;
        match serde_json::from_str::<AppConfig>(&content) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("⚠️ [LiveHear] 配置文件解析失败 {}: {}", path.display(), e);
                None
            }
        }
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            if let Some(c) = Self::read(&path) {
                return c;
            }
            // Never overwrite a config we failed to parse: it holds the user's API keys.
            let backup = path.with_extension("json.bak");
            match fs::rename(&path, &backup) {
                Ok(()) => eprintln!("⚠️ [LiveHear] 无法解析的配置已备份到 {}", backup.display()),
                Err(e) => {
                    eprintln!(
                        "⚠️ [LiveHear] 备份损坏配置失败，本次使用默认配置且不写盘: {}",
                        e
                    );
                    return Self::default();
                }
            }
        }
        let seeded = Self::legacy_candidates()
            .iter()
            .filter(|p| p.exists())
            .find_map(|p| Self::read(p))
            .unwrap_or_default();
        if let Err(e) = seeded.save_to(&path) {
            eprintln!("⚠️ [LiveHear] 无法写入初始配置: {}", e);
        }
        seeded
    }

    /// 原子写入：先写同目录临时文件并 fsync，再 rename 覆盖，避免崩溃/断电留下空文件。
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
            && !parent.exists()
        {
            fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
        }
        let content =
            serde_json::to_string_pretty(self).map_err(|e| format!("序列化配置失败: {}", e))?;
        let tmp = path.with_extension("json.tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let write_result = (|| -> Result<(), String> {
            let mut file = options
                .open(&tmp)
                .map_err(|e| format!("打开配置文件失败: {}", e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|e| format!("设置配置文件权限失败: {}", e))?;
            }
            file.write_all(content.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| format!("写入配置文件失败: {}", e))?;
            fs::rename(&tmp, path).map_err(|e| format!("替换配置文件失败: {}", e))
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        write_result
    }

    pub fn save(&self) -> Result<(), String> {
        self.save_to(&Self::config_path())
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_config_preserves_user_settings_and_restricts_permissions() {
        let path = std::env::temp_dir().join(format!(
            "livehear-config-test-{}-{}.json",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let mut config = AppConfig::default();
        config.soniox.max_endpoint_delay_ms = 1500;
        config.soniox.vad_threshold = 3.0;
        config.save_to(&path).unwrap();
        let loaded = AppConfig::read(&path).unwrap();
        assert_eq!(loaded.soniox.max_endpoint_delay_ms, 1500);
        assert_eq!(loaded.soniox.vad_threshold, 3.0);
        assert_eq!(loaded.asr_backend.provider, "soniox");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn partial_config_fills_missing_sections_with_defaults() {
        let parsed: AppConfig =
            serde_json::from_str(r#"{"soniox":{"api_key":"k"},"openrouter":{"api_key":"o"}}"#)
                .unwrap();
        assert_eq!(parsed.soniox.api_key, "k");
        assert_eq!(parsed.soniox.model, "stt-rt-v6");
        assert_eq!(parsed.soniox.sample_rate, 16000);
        assert_eq!(parsed.openrouter.api_key, "o");
        assert_eq!(parsed.jev.model, JevConfig::default().model);
        assert!(parsed.meeting.auto_predict);
    }

    #[test]
    fn legacy_soniox_models_upgrade_when_config_is_loaded() {
        for model in ["", "stt-rt-v3", "stt-rt-v4", "stt-rt-v5", "stt-rt-v6"] {
            let config: AppConfig =
                serde_json::from_value(serde_json::json!({"soniox": {"model": model}})).unwrap();
            assert_eq!(config.soniox.model, "stt-rt-v6");
        }
        let config: AppConfig =
            serde_json::from_str(r#"{"soniox":{"model":"custom-soniox"}}"#).unwrap();
        assert_eq!(config.soniox.model, "custom-soniox");
    }
}
