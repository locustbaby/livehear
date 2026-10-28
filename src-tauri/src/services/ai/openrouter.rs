use crate::config::OpenRouterConfig;
use crate::domain::{LiveHearError, ReplyStrategy, ReplySuggestion};
use crate::services::{PredictService, TranslationService};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

static SHARED_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

pub fn shared_http_client() -> Client {
    SHARED_HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .pool_max_idle_per_host(16)
                .pool_idle_timeout(std::time::Duration::from_secs(90))
                .tcp_nodelay(true)
                .connect_timeout(std::time::Duration::from_secs(3))
                .timeout(std::time::Duration::from_secs(18))
                .build()
                .unwrap_or_else(|_| Client::new())
        })
        .clone()
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolishResult {
    pub original: String,
    pub translated: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupResult {
    pub text: String,
    pub phonetic_or_type: String,
    pub meaning: String,
    pub context_explanation: String,
    pub term_pair: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickSpeakResult {
    pub spoken: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip: Option<String>,
    #[serde(default)]
    pub target_lang: String,
}

fn lang_code_to_display_name(code: &str) -> &'static str {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => "英语 (English)",
        "ja" => "日语 (日本語)",
        "th" => "泰语 (ไทย)",
        "ko" => "韩语 (한국어)",
        "fr" => "法语 (Français)",
        "de" => "德语 (Deutsch)",
        "es" => "西班牙语 (Español)",
        "zh" => "中文",
        _ => "英语 (English)",
    }
}

pub struct OpenRouterAdapter {
    config: OpenRouterConfig,
    client: Client,
}

impl OpenRouterAdapter {
    pub fn new(config: OpenRouterConfig) -> Self {
        Self {
            config,
            client: shared_http_client(),
        }
    }

    pub async fn polish_and_connect(
        &self,
        original_chunk: &str,
        draft_translation: &str,
        recent_history: &str,
        low_confidence_words: &[String],
        meeting_context: &str,
        custom_terms: &[String],
        target_lang: Option<&str>,
    ) -> Result<PolishResult, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError("API Key 尚未配置".to_string()));
        }

        let terms_hint = if custom_terms.is_empty() {
            String::new()
        } else {
            format!("\n【专有术语与译名约束】：{}", custom_terms.join(", "))
        };

        let ctx_hint = if meeting_context.trim().is_empty() {
            String::new()
        } else {
            format!("\n【当前会议背景】：{}", meeting_context.trim())
        };

        let history_hint = if recent_history.trim().is_empty() {
            String::new()
        } else {
            format!("\n【前序对话上下文 (仅供指代消解与语境参考)】：\n{}", recent_history.trim())
        };

        let low_conf_hint = if low_confidence_words.is_empty() {
            String::new()
        } else {
            format!(
                "\n【声学模型低置信度疑似听错词】：{}（请重点结合前后文核对这些词是否为同音误识或专有名词吞音）",
                low_confidence_words.join(", ")
            )
        };

        let eff_target = target_lang.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("zh");
        let is_speak_foreign = !eff_target.eq_ignore_ascii_case("zh");
        let target_lang_name = lang_code_to_display_name(eff_target);

        let system_prompt = if is_speak_foreign {
            format!(
                "你是一个精通跨国技术会议、架构评审与商务沟通的首席同传译员、口语辅助智囊兼语音识别(ASR)纠偏专家。\n\
用户当前正在发言（可能说了中文或中英夹杂），需要将这句话翻译并润色为可直接照念的地道【{}】口语表达。\n\
请同时完成以下三项任务：\n\
1. 【原声 ASR 听写纠偏 (original)】：结合前后文语境、会议背景、专有术语表与低置信度词提示，修复原声识别中因同音字、吞音或技术缩略词导致的听写错误，保持说话人原本的语种。\n\
2. 【目标外语口语翻译与润色 (translated)】：基于纠偏后的原声，结合前序对话语境，将其翻译并润色为自然地道、专业得体、适合在会议现场直接脱口而出的【{}】口语表达（不要输出中文解释，仅输出纯净的目标语言句子）。\n\
3. 【话语语气与态度标签 (tone_tag)】：给出一个 4~6 字的极简标签（例如：\"🗣️ 英文提词\"、\"✅ 明确表态\"、\"❓ 追问确认\"、\"💡 方案建议\"）；若平铺直叙可填 \"🗣️ 口语辅助\"。\n\
严禁输出任何解释或 Markdown 代码块包裹，必须且仅输出如下纯 JSON 对象：\n\
{{\"original\": \"纠偏后的原声文本\", \"translated\": \"地道自然的{}口语译文\", \"tone_tag\": \"🗣️ 口语辅助\"}}",
                target_lang_name, target_lang_name, target_lang_name
            )
        } else {
            "你是一个精通跨国技术会议、架构评审与商务沟通的首席同传译员兼语音识别(ASR)纠偏专家。\n\
用户会提供前序对话上下文、当前发言的实时语音识别【原声段落】、声学低置信度词提示及其【流式初步直译】。\n\
请同时完成以下三项任务：\n\
1. 【原声 ASR 听写纠偏 (original)】：结合前后文语境、会议背景、专有术语表与低置信度词提示，精准修复原声识别中因同音字、吞音、口音或技术缩略词导致的听写错误，但必须保持说话人原本的语种与原意。\n\
2. 【译文语义与语气调优 (translated)】：基于纠偏后的原声，结合前序对话中的指代关系（如 it/they/this 指向的具体议题），将初步直译重组为自然地道、术语精准的同传表达，并保留说话人的真实语气（如委婉试探、强烈关切、明确承诺等）。若原声与初步直译同为中文，则将纠偏后的流畅中文同时填入 original 与 translated。\n\
3. 【话语语气与态度标签 (tone_tag)】：若该句带有明显的沟通态度或会议动作信号，给出一个 4~6 字的极简标签（例如：\"⚠️ 委婉异议\"、\"❓ 追问细节\"、\"✅ 明确承诺\"、\"⏳ 排期风险\"、\"💡 方案建议\"）；若只是普通平铺直叙，则填 null。\n\
严禁输出任何解释或 Markdown 代码块包裹，必须且仅输出如下纯 JSON 对象：\n\
{\"original\": \"纠偏后的原声文本\", \"translated\": \"结合前后文调优后的译文\", \"tone_tag\": null}".to_string()
        };

        let user_content = format!(
            "{}{}{}{}\n【当前原声段落】：{}\n【流式初步直译】：{}",
            ctx_hint, terms_hint, history_hint, low_conf_hint, original_chunk, draft_translation
        );

        let payload = ChatCompletionRequest {
            model: self.config.translate_model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_content,
                },
            ],
            temperature: Some(0.2),
            max_tokens: Some(640),
        };

        let url = format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'));
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("HTTP-Referer", "https://github.com/livehear/livehear")
            .header("X-Title", "LiveHear Context Polish")
            .json(&payload)
            .send()
            .await
            .map_err(|e| LiveHearError::NetworkError(e.to_string()))?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!("LLM 接口错误 ({}): {}", status, body)));
        }

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        let raw = data
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if let Some(start) = raw.find('{') {
            if let Some(end) = raw.rfind('}') {
                if let Ok(parsed) = serde_json::from_str::<PolishResult>(&raw[start..=end]) {
                    return Ok(PolishResult {
                        original: if parsed.original.trim().is_empty() {
                            original_chunk.to_string()
                        } else {
                            parsed.original.trim().to_string()
                        },
                        translated: if parsed.translated.trim().is_empty() {
                            draft_translation.to_string()
                        } else {
                            parsed.translated.trim().to_string()
                        },
                        tone_tag: parsed
                            .tone_tag
                            .map(|t| t.trim().to_string())
                            .filter(|t| !t.is_empty() && t != "null"),
                    });
                }
            }
        }

        Ok(PolishResult {
            original: original_chunk.to_string(),
            translated: if raw.is_empty() {
                draft_translation.to_string()
            } else {
                raw
            },
            tone_tag: None,
        })
    }

    pub async fn lookup_selection(
        &self,
        selection: &str,
        sentence_context: &str,
        meeting_context: &str,
    ) -> Result<LookupResult, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError("请先配置 AI 智囊 API Key".to_string()));
        }

        let prompt = format!(
            "你是一个跨国会议实时同传词典与语境解析助手。\n\
            【会议背景】：{}\n\
            【所在原句】：{}\n\
            【用户划选/点击的词句】：\"{}\"\n\n\
            请结合所在原句与会议语境，对用户选中的词或句子进行精准解析。\n\
            必须且仅输出如下纯 JSON 对象（不要包裹 Markdown 代码块）：\n\
            {{\n\
              \"text\": \"被选中的词或短语\",\n\
              \"phonetic_or_type\": \"若是单词/术语给出音标与词性（如 /aɪˈdempətənt/ · adj. 技术术语），若是长句给出句型标签（如 会议高频表态 / 条件从句）\",\n\
              \"meaning\": \"最地道精准的中文直译/核心释义（简明扼要）\",\n\
              \"context_explanation\": \"结合当前所在原句与会议背景的一句话语境解读（说明发言人此处想表达的具体潜台词或技术含义）\",\n\
              \"term_pair\": \"若是值得加入术语库的专有名词/缩写/高频词，输出 原词=中文标准译名（如 idempotent=幂等）；若是普通长句则填 null\"\n\
            }}",
            meeting_context, sentence_context, selection
        );

        let payload = ChatCompletionRequest {
            model: self.config.translate_model.clone(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.2),
            max_tokens: Some(420),
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

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!("LLM 接口错误 ({}): {}", status, body)));
        }

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        let raw = data
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if let Some(start) = raw.find('{') {
            if let Some(end) = raw.rfind('}') {
                if let Ok(parsed) = serde_json::from_str::<LookupResult>(&raw[start..=end]) {
                    return Ok(parsed);
                }
            }
        }

        Ok(LookupResult {
            text: selection.to_string(),
            phonetic_or_type: "语境释义".to_string(),
            meaning: if raw.is_empty() { selection.to_string() } else { raw },
            context_explanation: String::new(),
            term_pair: None,
        })
    }

    pub async fn generate_copilot_prompts(
        &self,
        recent_history: &str,
        user_intent: Option<&str>,
        meeting_context: &str,
        target_lang: Option<&str>,
    ) -> Result<Vec<ReplySuggestion>, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "请先在设置中配置 AI 智囊 API Key".to_string(),
            ));
        }

        let eff_lang = target_lang.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("en");
        let lang_name = lang_code_to_display_name(eff_lang);

        let intent_clause = match user_intent.map(str::trim).filter(|s| !s.is_empty()) {
            Some(intent) => format!(
                "【我方想要表达的核心想法 / 意图】：\"{}\"\n请围绕我方这一想法，结合前序对话语境，生成 3 种不同语气/角度（如：专业得体直述 / 委婉协商推进 / 简明确认细节）的【{}】会议发言提词（附简短中文对照）。",
                intent, lang_name
            ),
            None => format!(
                "【请求类型】：我方准备接话发言。\n请紧密结合最近几句对话上下文，从 3 个最实用的会议接话角度（1. 赞同并补充推进 / 2. 追问关键技术或排期细节 / 3. 同步我方进展或稳妥表态），生成 3 条可直接照念的地道【{}】发言提词（附简短中文对照）。",
                lang_name
            ),
        };

        let prompt = format!(
            "你是一个跨国会议现场的实时发言提词智囊（Speaking Co-Pilot）。\n\
            【当前会议背景】：{}\n\
            【最近对话上下文】：\n{}\n\
            {}\n\n\
            要求：每条 `detail` 采用「地道口语{}原句 (对应中文大意)」格式，简练自然，适合在会议中直接脱口而出。\n\
            输出必须为纯 JSON 数组：\n\
            [\n\
              {{\"id\": 1, \"shortcut\": \"Cmd+1\", \"strategy\": \"optimistic\", \"title\": \"场景标签(4-6字)\", \"detail\": \"Spoken sentence in target language. (对应的中文意思)\"}},\n\
              {{\"id\": 2, \"shortcut\": \"Cmd+2\", \"strategy\": \"conservative\", \"title\": \"场景标签(4-6字)\", \"detail\": \"Spoken sentence in target language. (对应的中文意思)\"}},\n\
              {{\"id\": 3, \"shortcut\": \"Cmd+3\", \"strategy\": \"blocker\", \"title\": \"场景标签(4-6字)\", \"detail\": \"Spoken sentence in target language. (对应的中文意思)\"}}\n\
            ]",
            meeting_context,
            if recent_history.trim().is_empty() { "（会议刚开始，暂无前序记录）" } else { recent_history.trim() },
            intent_clause,
            lang_name
        );

        let model_to_use = if !self.config.translate_model.trim().is_empty() {
            self.config.translate_model.clone()
        } else {
            self.config.predict_model.clone()
        };

        let payload = ChatCompletionRequest {
            model: model_to_use,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.35),
            max_tokens: Some(600),
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

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!("LLM 接口错误 ({}): {}", status, body)));
        }

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

        Err(LiveHearError::LlmError("未能解析提词结果".to_string()))
    }

    pub async fn quick_speak_translate(
        &self,
        text: &str,
        target_lang: &str,
        recent_history: &str,
        meeting_context: &str,
        custom_terms: &[String],
    ) -> Result<QuickSpeakResult, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "请先在设置中配置 AI 智囊 API Key".to_string(),
            ));
        }

        let eff_lang = if target_lang.trim().is_empty() {
            "en"
        } else {
            target_lang.trim()
        };
        let lang_name = lang_code_to_display_name(eff_lang);

        let terms_hint = if custom_terms.is_empty() {
            String::new()
        } else {
            format!("\n【专有术语表】：{}", custom_terms.join(", "))
        };

        let history_hint = if recent_history.trim().is_empty() {
            String::new()
        } else {
            format!("\n【最近对话上下文】：\n{}", recent_history.trim())
        };

        let prompt = format!(
            "你是一个跨国会议现场的实时口语翻译与表达助手。\n\
            【当前会议背景】：{}{}{}\n\
            【我方准备开口说的原意（中文或中英夹杂）】：\"{}\"\n\n\
            请将其转化为最地道、自然、适合在跨国会议现场直接脱口而出的【{}】口语表达。\n\
            严禁输出任何多余解释或 Markdown 代码块，必须且仅输出如下纯 JSON 对象：\n\
            {{\n\
              \"spoken\": \"最自然得体、可直接照念的{}口语完整句\",\n\
              \"alt\": \"更简短干练的口语替代表达（适合快节奏插话）\",\n\
              \"tip\": \"核心词汇发音/重音提示或地道用法点拨（15字以内，如无可填 null）\"\n\
            }}",
            meeting_context, terms_hint, history_hint, text, lang_name, lang_name
        );

        let model_to_use = if !self.config.translate_model.trim().is_empty() {
            self.config.translate_model.clone()
        } else {
            self.config.predict_model.clone()
        };

        let payload = ChatCompletionRequest {
            model: model_to_use,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.2),
            max_tokens: Some(420),
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

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!("LLM 接口错误 ({}): {}", status, body)));
        }

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        let raw = data
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if let Some(start) = raw.find('{') {
            if let Some(end) = raw.rfind('}') {
                if let Ok(mut parsed) = serde_json::from_str::<QuickSpeakResult>(&raw[start..=end]) {
                    parsed.target_lang = eff_lang.to_string();
                    parsed.alt = parsed.alt.filter(|s| !s.trim().is_empty() && s != "null");
                    parsed.tip = parsed.tip.filter(|s| !s.trim().is_empty() && s != "null");
                    if !parsed.spoken.trim().is_empty() {
                        return Ok(parsed);
                    }
                }
            }
        }

        Ok(QuickSpeakResult {
            spoken: if raw.is_empty() { text.to_string() } else { raw },
            alt: None,
            tip: None,
            target_lang: eff_lang.to_string(),
        })
    }

    pub async fn summarize_recent_context(
        &self,
        recent_history: &str,
        meeting_context: &str,
    ) -> Result<Vec<ReplySuggestion>, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "请先在设置中配置 AI 智囊 API Key".to_string(),
            ));
        }

        let prompt = format!(
            "你是一个实时会议的高效脉络总结官（3秒走神救星 TL;DR）。\n\
            【当前会议背景】：{}\n\
            【最近对话记录】：\n{}\n\n\
            请将上述对话浓缩为 3 条极简、高信息密度的中文卡片：\n\
            1. 📌 刚才讨论焦点（谁提出了什么核心议题/诉求）\n\
            2. ⚖️ 已达成共识或核心分歧（目前的技术/业务判断）\n\
            3. 🎯 当前等待确认的问题（接下来需要谁拍板或回应什么）\n\
            输出必须为纯 JSON 数组（不要包裹 Markdown 代码块）：\n\
            [\n\
              {{\"id\": 1, \"shortcut\": \"Cmd+1\", \"strategy\": \"optimistic\", \"title\": \"📌 讨论焦点\", \"detail\": \"一句话精炼概括核心议题\"}},\n\
              {{\"id\": 2, \"shortcut\": \"Cmd+2\", \"strategy\": \"conservative\", \"title\": \"⚖️ 共识与分歧\", \"detail\": \"一句话概括当前结论或争议点\"}},\n\
              {{\"id\": 3, \"shortcut\": \"Cmd+3\", \"strategy\": \"blocker\", \"title\": \"🎯 待拍板事项\", \"detail\": \"一句话点明当下最需要回应的问题\"}}\n\
            ]",
            meeting_context,
            if recent_history.trim().is_empty() {
                "（当前暂无足够对话记录）"
            } else {
                recent_history.trim()
            }
        );

        let model_to_use = if !self.config.translate_model.trim().is_empty() {
            self.config.translate_model.clone()
        } else {
            self.config.predict_model.clone()
        };

        let payload = ChatCompletionRequest {
            model: model_to_use,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.25),
            max_tokens: Some(500),
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

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!("LLM 接口错误 ({}): {}", status, body)));
        }

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
                let items = raw_list
                    .into_iter()
                    .map(|r| ReplySuggestion {
                        id: r.id,
                        shortcut: r.shortcut,
                        strategy: ReplyStrategy::General,
                        title: r.title,
                        detail: r.detail,
                    })
                    .collect();
                return Ok(items);
            }
        }

        Err(LiveHearError::LlmError("未能解析前文脉络摘要".to_string()))
    }

    pub async fn generate_meeting_minutes(
        &self,
        full_transcript: &str,
        meeting_context: &str,
    ) -> Result<String, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError("API Key 未配置".to_string()));
        }

        let prompt = format!(
            "你是一个专业的跨国会议首席纪要官。请根据以下会议背景与实时同传记录，提炼一份结构清晰、精炼高价值的中文会议高管纪要（Executive Summary）。\n\
            【会议背景】：{}\n\
            【会议记录】：\n{}\n\n\
            请严格按以下三个模块输出简洁的 Markdown 列表（不要输出多余寒暄）：\n\
            ### 📌 核心结论与决议 (Key Decisions)\n\
            - ...\n\n\
            ### ✅ 待办事项 (Action Items · 标注涉及的 Speaker)\n\
            - [ ] ...\n\n\
            ### ⚠️ 风险与待澄清问题 (Open Questions & Risks)\n\
            - ...",
            meeting_context, full_transcript
        );

        let model_to_use = if !self.config.translate_model.trim().is_empty() {
            self.config.translate_model.clone()
        } else {
            self.config.predict_model.clone()
        };

        let payload = ChatCompletionRequest {
            model: model_to_use,
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: prompt,
            }],
            temperature: Some(0.25),
            max_tokens: Some(900),
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

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(LiveHearError::LlmError(format!("LLM 接口错误 ({}): {}", status, body)));
        }

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        Ok(data
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default())
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
