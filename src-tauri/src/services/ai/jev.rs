use crate::config::JevConfig;
use crate::domain::{JevDecision, LiveHearError, MeetingIntent};
use crate::services::DecisionGateService;
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
    temperature: Option<f32>,
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
struct RawJevOutput {
    is_question: bool,
    confidence: Option<f32>,
    intent: Option<String>,
}

pub struct JevAdapter {
    config: JevConfig,
    fallback_api_key: String,
    client: Client,
}

impl JevAdapter {
    pub fn new(config: JevConfig, fallback_api_key: String) -> Self {
        Self {
            config,
            fallback_api_key,
            client: super::openrouter::shared_http_client(),
        }
    }
}

#[async_trait]
impl DecisionGateService for JevAdapter {
    async fn evaluate(&self, utterance: &str, context: &str) -> Result<JevDecision, LiveHearError> {
        if !self.config.enabled {
            let is_q = utterance.contains('?')
                || utterance.contains('？')
                || utterance.to_lowercase().contains("can you");
            return Ok(JevDecision {
                is_question: is_q,
                confidence: if is_q { 0.9 } else { 0.1 },
                intent: MeetingIntent::GeneralDiscussion,
            });
        }

        let api_key = if !self.config.api_key.trim().is_empty() {
            &self.config.api_key
        } else {
            &self.fallback_api_key
        };

        if api_key.trim().is_empty() {
            // 无 Key 时规则降级
            let is_q = utterance.contains('?') || utterance.to_lowercase().contains("can we");
            return Ok(JevDecision {
                is_question: is_q,
                confidence: 0.85,
                intent: MeetingIntent::ProgressCheck,
            });
        }

        let prompt = format!(
            "【会议背景】: {}\n【对方最新发言】: \"{}\"\n\n\
            你是一个微秒级决策模型。请判断该发言是否为向用户提问、排期问询或派发任务。只输出 JSON：\n\
            {{\"is_question\": true, \"confidence\": 0.95, \"intent\": \"progress_check\"}}\n\
            intent 可选值: progress_check, technical_blocker, action_item, clarification, objection, general",
            context, utterance
        );

        let payload = ChatCompletionRequest {
            model: self.config.model.clone(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.0),
            max_tokens: Some(120),
        };

        let url = format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        );
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&payload)
            .send()
            .await
            .map_err(|e| LiveHearError::NetworkError(e.to_string()))?;

        if let Ok(data) = res.json::<ChatCompletionResponse>().await
            && let Some(choice) = data.choices.first()
        {
            let raw_content = &choice.message.content;
            let clean_json =
                if let (Some(start), Some(end)) = (raw_content.find('{'), raw_content.rfind('}')) {
                    if start <= end {
                        &raw_content[start..=end]
                    } else {
                        raw_content.as_str()
                    }
                } else {
                    raw_content.as_str()
                };

            if let Ok(raw) = serde_json::from_str::<RawJevOutput>(clean_json) {
                let intent = match raw.intent.as_deref() {
                    Some("progress_check") => MeetingIntent::ProgressCheck,
                    Some("technical_blocker") => MeetingIntent::TechnicalBlocker,
                    Some("action_item") => MeetingIntent::ActionItemAssignment,
                    Some("clarification") => MeetingIntent::Clarification,
                    Some("objection") => MeetingIntent::Objection,
                    _ => MeetingIntent::GeneralDiscussion,
                };
                return Ok(JevDecision {
                    is_question: raw.is_question,
                    confidence: raw.confidence.unwrap_or(0.9),
                    intent,
                });
            }
        }

        // 容错降级
        let is_q = utterance.contains('?')
            || utterance.to_lowercase().contains("can we")
            || utterance.to_lowercase().contains("could we");
        Ok(JevDecision {
            is_question: is_q,
            confidence: 0.8,
            intent: MeetingIntent::ProgressCheck,
        })
    }
}
