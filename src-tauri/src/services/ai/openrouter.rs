use crate::config::OpenRouterConfig;
use crate::domain::{LiveHearError, ReplyStrategy, ReplySuggestion};
use crate::services::{PredictService, TranslationService};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RawSuggestionJson {
    id: usize,
    shortcut: String,
    strategy: Option<String>,
    title: String,
    detail: String,
}

pub struct OpenRouterAdapter {
    config: OpenRouterConfig,
    client: Client,
}

impl OpenRouterAdapter {
    pub fn new(config: OpenRouterConfig) -> Self {
        Self {
            config,
            client: Client::builder()
                .pool_max_idle_per_host(10)
                .tcp_nodelay(true)
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }
}

#[async_trait]
impl TranslationService for OpenRouterAdapter {
    async fn translate(
        &self,
        text: &str,
        source_lang: &str,
        target_lang: &str,
    ) -> Result<String, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "OpenRouter API Key 尚未配置".to_string(),
            ));
        }

        let system_prompt = format!(
            "你是一个精通跨国企业技术与商务沟通的专业同传翻译引擎。请将用户输入的文字从 {} 翻译为 {}。\n\
            要求：保留专业术语，语句通顺流畅，仅输出翻译结果，不要包含任何多余问候或解释。",
            source_lang, target_lang
        );

        let payload = ChatCompletionRequest {
            model: self.config.translate_model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: text.to_string(),
                },
            ],
            temperature: Some(0.2),
            max_tokens: Some(1024),
        };

        let url = format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'));
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("HTTP-Referer", "https://github.com/livehear/livehear")
            .header("X-Title", "LiveHear Professional Translation")
            .json(&payload)
            .send()
            .await
            .map_err(|e| LiveHearError::NetworkError(e.to_string()))?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!(
                "OpenRouter 接口错误 ({}): {}",
                status, body
            )));
        }

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        let translated = data
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_else(|| text.to_string());

        Ok(translated)
    }
}

#[async_trait]
impl PredictService for OpenRouterAdapter {
    async fn generate_suggestions(
        &self,
        question: &str,
        context: &str,
    ) -> Result<Vec<ReplySuggestion>, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "OpenRouter API Key 未配置".to_string(),
            ));
        }

        let prompt = format!(
            "你是一个高级架构师兼项目负责人的会议现场实时应答智囊。\n\
            【当前会议背景】: {}\n\
            【对方刚才问的问题】: \"{}\"\n\n\
            请从三种不同的业务策略视角（稳妥推迟/积极承诺/依赖澄清），给出 3 条极简的回答要点，每条英文回答控制在一句话内：\n\
            输出必须为纯 JSON 数组：\n\
            [\n\
              {{\"id\": 1, \"shortcut\": \"Cmd+1\", \"strategy\": \"conservative\", \"title\": \"稳妥推迟\", \"detail\": \"英文表态\"}},\n\
              {{\"id\": 2, \"shortcut\": \"Cmd+2\", \"strategy\": \"optimistic\", \"title\": \"积极承诺\", \"detail\": \"英文表态\"}},\n\
              {{\"id\": 3, \"shortcut\": \"Cmd+3\", \"strategy\": \"blocker\", \"title\": \"依赖澄清\", \"detail\": \"英文表态\"}}\n\
            ]",
            context, question
        );

        let payload = ChatCompletionRequest {
            model: self.config.predict_model.clone(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.3),
            max_tokens: Some(512),
        };

        let url = format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'));
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&payload)
            .send()
            .await
            .map_err(|e| LiveHearError::NetworkError(e.to_string()))?;

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        if let Some(choice) = data.choices.first() {
            let raw_text = choice.message.content.trim();
            let json_str = if let Some(start) = raw_text.find('[') {
                if let Some(end) = raw_text.rfind(']') {
                    &raw_text[start..=end]
                } else {
                    raw_text
                }
            } else {
                raw_text
            };

            if let Ok(raw_list) = serde_json::from_str::<Vec<RawSuggestionJson>>(json_str) {
                let suggestions = raw_list
                    .into_iter()
                    .map(|r| {
                        let strategy = match r.strategy.as_deref() {
                            Some("conservative") => ReplyStrategy::ConservativePushback,
                            Some("optimistic") => ReplyStrategy::OptimisticCommit,
                            Some("blocker") => ReplyStrategy::BlockerClarification,
                            _ => ReplyStrategy::General,
                        };
                        ReplySuggestion {
                            id: r.id,
                            shortcut: r.shortcut,
                            strategy,
                            title: r.title,
                            detail: r.detail,
                        }
                    })
                    .collect();
                return Ok(suggestions);
            }
        }

        // 保底建议
        Ok(vec![
            ReplySuggestion {
                id: 1,
                shortcut: "Cmd+1".to_string(),
                strategy: ReplyStrategy::ConservativePushback,
                title: "稳妥推迟".to_string(),
                detail: "I suggest pushing to early next week to allow sufficient testing buffer."
                    .to_string(),
            },
            ReplySuggestion {
                id: 2,
                shortcut: "Cmd+2".to_string(),
                strategy: ReplyStrategy::OptimisticCommit,
                title: "积极确认".to_string(),
                detail: "The core service is fully verified, Friday release is on schedule."
                    .to_string(),
            },
            ReplySuggestion {
                id: 3,
                shortcut: "Cmd+3".to_string(),
                strategy: ReplyStrategy::BlockerClarification,
                title: "指出依赖".to_string(),
                detail: "Implementation is done, but still pending partner authorization."
                    .to_string(),
            },
        ])
    }
}
