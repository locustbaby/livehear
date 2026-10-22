use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SonioxConfig {
    pub api_key: String,
    pub ws_url: String,
    pub model: String,
    pub sample_rate: u32,
    pub enable_speaker_diarization: bool,
    pub language_hints: Vec<String>,
    #[serde(default = "default_enable_translation")]
    pub enable_translation: bool,
    #[serde(default = "default_translation_type")]
    pub translation_type: String, // "two_way" or "one_way"
    #[serde(default = "default_target_language")]
    pub target_language: String, // "zh"
    #[serde(default = "default_language_a")]
    pub language_a: String, // "en"
    #[serde(default = "default_language_b")]
    pub language_b: String, // "zh"
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

fn default_language_a() -> String {
    "en".to_string()
}

fn default_language_b() -> String {
    "zh".to_string()
}

impl Default for SonioxConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            ws_url: "wss://stt-rt.soniox.com/transcribe-websocket".to_string(),
            model: "stt-rt-v5".to_string(),
            sample_rate: 16000,
            enable_speaker_diarization: true,
            language_hints: vec!["en".to_string(), "zh".to_string()],
            enable_translation: true,
            translation_type: "two_way".to_string(),
            target_language: "zh".to_string(),
            language_a: "en".to_string(),
            language_b: "zh".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenRouterConfig {
    pub api_key: String,
    pub base_url: String,
    pub translate_model: String,
    pub predict_model: String,
}

impl Default for OpenRouterConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            translate_model: "deepseek/deepseek-chat".to_string(),
            predict_model: "anthropic/claude-3.5-haiku".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
            model: "typesafe/jev-1.13".to_string(),
            confidence_threshold: 0.8,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub soniox: SonioxConfig,
    pub openrouter: OpenRouterConfig,
    pub jev: JevConfig,
    pub meeting: MeetingConfig,
}

impl AppConfig {
    /// 获取配置文件路径：优先读取当前目录或用户配置目录下的 livehear.config.json
    pub fn config_path() -> PathBuf {
        let parent_root = PathBuf::from("../livehear.config.json");
        if parent_root.exists() {
            return parent_root;
        }

        let local_path = PathBuf::from("livehear.config.json");
        if local_path.exists() {
            return local_path;
        }

        if let Some(home) = dirs_home() {
            let user_config = home.join(".config").join("livehear").join("config.json");
            if user_config.exists() {
                return user_config;
            }
        }

        local_path
    }

    /// 从文件加载配置，若不存在则创建默认配置
    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                    return config;
                }
            }
        }
        let default_config = Self::default();
        let _ = default_config.save_to(&path);
        default_config
    }

    /// 保存配置到指定路径
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                let _ = fs::create_dir_all(parent);
            }
        }
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("序列化配置失败: {}", e))?;
        fs::write(path, content).map_err(|e| format!("写入配置文件失败: {}", e))
    }

    pub fn save(&self) -> Result<(), String> {
        self.save_to(&Self::config_path())
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
