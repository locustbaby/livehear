use crate::config::{SONIOX_REALTIME_MODEL, SonioxConfig};
use crate::domain::{LiveHearError, Speaker, TranscriptSegment};
use crate::services::ASRService;
use crate::services::audio_capture::VAD_FINALIZE_SIGNAL;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header::AUTHORIZATION};

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const SONIOX_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const SONIOX_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const SONIOX_FINISH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SonioxTranslationPayload {
    #[serde(rename = "type")]
    translation_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_a: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_b: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SonioxContextGeneralItem {
    key: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SonioxTranslationTerm {
    source: String,
    target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SonioxContextPayload {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    general: Vec<SonioxContextGeneralItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    terms: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    translation_terms: Vec<SonioxTranslationTerm>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxStartPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    model: String,
    audio_format: String,
    sample_rate: u32,
    num_channels: u16,
    enable_speaker_diarization: bool,
    enable_endpoint_detection: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_endpoint_delay_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint_sensitivity: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_language_identification: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_hints: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_hints_strict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<SonioxContextPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation: Option<SonioxTranslationPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SonioxToken {
    text: String,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    confidence: Option<f32>,
    #[serde(default)]
    speaker: Option<serde_json::Value>,
    #[serde(default)]
    spk: Option<u32>,
    #[serde(default)]
    start_ms: Option<u64>,
    #[serde(default)]
    end_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    translation_status: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    source_language: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SonioxStreamResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
    #[serde(default)]
    final_audio_proc_ms: Option<u64>,
    #[serde(default)]
    total_audio_proc_ms: Option<u64>,
    #[serde(default)]
    finished: Option<bool>,
    #[serde(default)]
    error_code: Option<u32>,
    #[serde(default)]
    error_message: Option<String>,
}

pub struct SonioxLiveAdapter {
    config: SonioxConfig,
    meeting_context: Option<String>,
    app_handle: Option<AppHandle>,
}

impl SonioxLiveAdapter {
    pub fn new(config: SonioxConfig, app_handle: Option<AppHandle>) -> Self {
        Self {
            config,
            meeting_context: None,
            app_handle,
        }
    }

    pub fn with_meeting_context(mut self, meeting_context: String) -> Self {
        if !meeting_context.trim().is_empty() {
            self.meeting_context = Some(meeting_context);
        }
        self
    }

    fn build_context_payload(&self) -> Option<SonioxContextPayload> {
        let mut terms = Vec::new();
        let mut translation_terms = Vec::new();
        let mut seen_terms = HashSet::new();
        let mut seen_translations = HashSet::new();

        for raw in &self.config.custom_terms {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mapping = trimmed
                .split_once('=')
                .or_else(|| trimmed.split_once("->"))
                .or_else(|| trimmed.split_once('：'))
                .or_else(|| trimmed.split_once(':'))
                .map(|(source, target)| (source.trim(), target.trim()))
                .filter(|(source, target)| !source.is_empty() && !target.is_empty());
            let term = if let Some((source, target)) = mapping {
                if seen_translations.insert((source, target)) {
                    translation_terms.push(SonioxTranslationTerm {
                        source: source.to_string(),
                        target: target.to_string(),
                    });
                }
                source
            } else {
                trimmed
            };
            if seen_terms.insert(term) {
                terms.push(term.to_string());
            }
        }

        let mut general = Vec::new();
        let text = self.meeting_context.as_ref().and_then(|ctx| {
            let t = ctx.trim();
            if t.is_empty() {
                None
            } else {
                general.push(SonioxContextGeneralItem {
                    key: "topic".to_string(),
                    value: t.chars().take(120).collect(),
                });
                Some(t.to_string())
            }
        });

        if general.is_empty() && text.is_none() && terms.is_empty() && translation_terms.is_empty()
        {
            None
        } else {
            Some(SonioxContextPayload {
                general,
                text,
                terms,
                translation_terms,
            })
        }
    }

    fn build_translation_payload(&self) -> Option<SonioxTranslationPayload> {
        if !self.config.enable_translation {
            return None;
        }

        if self.config.translation_type == "two_way" {
            let lang_a = if !self.config.speak_target_language.trim().is_empty() {
                self.config.speak_target_language.trim().to_string()
            } else {
                self.config.language_a.clone()
            };
            let lang_b = if !self.config.target_language.trim().is_empty() {
                self.config.target_language.trim().to_string()
            } else {
                self.config.language_b.clone()
            };
            Some(SonioxTranslationPayload {
                translation_type: "two_way".to_string(),
                target_language: None,
                language_a: Some(lang_a),
                language_b: Some(lang_b),
            })
        } else {
            Some(SonioxTranslationPayload {
                translation_type: "one_way".to_string(),
                target_language: Some(self.config.target_language.clone()),
                language_a: None,
                language_b: None,
            })
        }
    }

    fn build_start_payload(&self) -> SonioxStartPayload {
        let delay_ms = self.config.max_endpoint_delay_ms.clamp(500, 3000);
        SonioxStartPayload {
            api_key: None,
            model: self.config.model.clone(),
            audio_format: "pcm_s16le".to_string(),
            sample_rate: 16000,
            num_channels: 1,
            enable_speaker_diarization: self.config.enable_speaker_diarization,
            enable_endpoint_detection: self.config.enable_endpoint_detection,
            max_endpoint_delay_ms: if self.config.enable_endpoint_detection {
                Some(delay_ms)
            } else {
                None
            },
            endpoint_sensitivity: (self.config.enable_endpoint_detection
                && self.config.model == SONIOX_REALTIME_MODEL)
                .then(|| self.config.endpoint_sensitivity.clamp(-1.0, 1.0)),
            enable_language_identification: Some(true),
            language_hints: if self.config.language_hints.is_empty() {
                None
            } else {
                Some(self.config.language_hints.clone())
            },
            language_hints_strict: if self.config.language_hints.is_empty() {
                None
            } else {
                Some(self.config.language_hints_strict)
            },
            context: self.build_context_payload(),
            translation: self.build_translation_payload(),
        }
    }
}

/// Soniox `speaker` 字段本身为 1-indexed 字符串（如 `"1"`, `"2"`），直接解析而不再额外 +1，杜绝幻影换人。
fn parse_speaker(token: &SonioxToken) -> Option<u32> {
    if let Some(ref val) = token.speaker {
        if let Some(n) = val.as_u64() {
            return Some(if n == 0 { 1 } else { n as u32 });
        }
        if let Some(s) = val.as_str() {
            let cleaned = s
                .trim()
                .trim_start_matches("speaker_")
                .trim_start_matches("Speaker ")
                .trim_start_matches("SPK");
            if let Ok(n) = cleaned.parse::<u32>() {
                return Some(if n == 0 { 1 } else { n });
            }
        }
    }
    if let Some(spk) = token.spk {
        return Some(if spk == 0 { 1 } else { spk });
    }
    None
}

fn contains_control_marker(text: &str) -> bool {
    text.contains("<end>") || text.contains("<fin>")
}

fn strip_control_markers(text: &str) -> String {
    if !contains_control_marker(text) {
        return text.to_string();
    }
    text.replace("<end>", "").replace("<fin>", "")
}

fn infer_text_language(text: &str) -> Option<&'static str> {
    let mut hanzi_count = 0usize;
    let mut latin_count = 0usize;
    let mut thai_count = 0usize;
    let mut ja_count = 0usize;

    for c in text.chars() {
        match c {
            '\u{4e00}'..='\u{9fff}' => hanzi_count += 1,
            'a'..='z' | 'A'..='Z' => latin_count += 1,
            '\u{0e00}'..='\u{0e7f}' => thai_count += 1,
            '\u{3040}'..='\u{30ff}' => ja_count += 1,
            _ => {}
        }
    }

    if hanzi_count > 0 && hanzi_count * 2 >= latin_count {
        Some("zh")
    } else if thai_count > 0 && thai_count >= latin_count {
        Some("th")
    } else if ja_count > 0 && ja_count >= latin_count {
        Some("ja")
    } else if latin_count > 0 {
        Some("en")
    } else {
        None
    }
}

fn resolve_effective_language(detected: Option<&str>, text: &str) -> Option<String> {
    let text_hint = infer_text_language(text);
    match (detected, text_hint) {
        (Some("zh"), Some("en")) => Some("en".to_string()),
        (Some("zh"), Some("th")) => Some("th".to_string()),
        (Some("zh"), Some("ja")) => Some("ja".to_string()),
        (Some("en"), Some("zh")) => Some("zh".to_string()),
        (Some(d), _) => Some(d.to_lowercase()),
        (None, Some(hint)) => Some(hint.to_string()),
        (None, None) => None,
    }
}

fn ends_with_sentence_terminal(s: &str) -> bool {
    let trimmed = s.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.ends_with('。') || trimmed.ends_with('？') || trimmed.ends_with('！') {
        return true;
    }
    if trimmed.ends_with('?') || trimmed.ends_with('!') {
        return true;
    }
    if let Some(without_dot) = trimmed.strip_suffix('.') {
        // 避免 Mr. / Dr. / v1. / e.g. 等缩写被误判为句末
        let last_word = without_dot.split_whitespace().last().unwrap_or("");
        let lower = last_word.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "mr" | "mrs" | "ms" | "dr" | "prof" | "sr" | "jr" | "vs" | "etc" | "eg" | "ie" | "st"
        ) {
            return false;
        }
        if last_word.len() == 1
            && last_word
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c.is_ascii_digit())
        {
            return false;
        }
        return true;
    }
    false
}

fn ends_with_clause_break(s: &str) -> bool {
    let trimmed = s.trim_end();
    trimmed.ends_with(',')
        || trimmed.ends_with(';')
        || trimmed.ends_with('，')
        || trimmed.ends_with('、')
        || trimmed.ends_with('；')
}

fn ends_with_dangling_connector(s: &str) -> bool {
    let trimmed = s.trim_end().trim_end_matches(|c: char| {
        c.is_ascii_punctuation() || matches!(c, '，' | '、' | '；' | '。')
    });
    if trimmed.is_empty() {
        return false;
    }

    let last_word = trimmed.split_whitespace().last().unwrap_or("");
    let lower = last_word.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "and"
            | "or"
            | "but"
            | "so"
            | "because"
            | "since"
            | "although"
            | "though"
            | "while"
            | "if"
            | "when"
            | "where"
            | "which"
            | "that"
            | "who"
            | "to"
            | "for"
            | "with"
            | "from"
            | "into"
            | "about"
            | "as"
            | "by"
            | "at"
            | "in"
            | "on"
            | "of"
            | "the"
            | "a"
            | "an"
    ) {
        return true;
    }

    for suffix in [
        "因为", "所以", "但是", "不过", "而且", "并且", "如果", "虽然", "关于", "对于", "至于",
        "通过", "由于", "以及", "或者", "还是", "就是", "比如", "例如",
    ] {
        if trimmed.ends_with(suffix) {
            return true;
        }
    }
    false
}

/// 判断当前累积的原声文本是否已构成语义完整的句子，避免在多人会议思考停顿时将半句话切碎
fn is_semantically_complete_utterance(orig: &str) -> bool {
    let trimmed = orig.trim();
    if trimmed.is_empty() {
        return false;
    }

    let char_count = trimmed.chars().count();
    let word_count = trimmed.split_whitespace().count();
    let is_cjk =
        infer_text_language(trimmed) == Some("zh") || infer_text_language(trimmed) == Some("ja");

    // 若已达到完整段落长度，则即便处于分句边界也允许结句
    if is_cjk && char_count >= 56 {
        return true;
    }
    if !is_cjk && (word_count >= 24 || char_count >= 140) {
        return true;
    }

    if !ends_with_sentence_terminal(trimmed) {
        return false;
    }

    if ends_with_dangling_connector(trimmed) {
        return false;
    }

    // 问句（以 ? 或 ？ 结尾）只要具备基本长度即可视为完整提问
    if trimmed.ends_with('?') || trimmed.ends_with('？') {
        return if is_cjk {
            char_count >= 6
        } else {
            word_count >= 3 && char_count >= 12
        };
    }

    // 普通陈述句：要求达到自然完整句长度，避免 "Yeah, I agree." / "其实我觉得。" 等短起手式被立刻切碎
    if is_cjk {
        char_count >= 18
    } else {
        word_count >= 9 && char_count >= 45
    }
}

fn append_smart_text(buf: &mut String, piece: &str) {
    if piece.is_empty() {
        return;
    }
    if buf.is_empty() {
        buf.push_str(piece);
        return;
    }
    let last_char = buf.chars().last().unwrap_or(' ');
    let first_char = piece.chars().next().unwrap_or(' ');
    let need_space = !last_char.is_whitespace()
        && !first_char.is_whitespace()
        && (last_char.is_ascii_alphanumeric()
            || matches!(last_char, '.' | ',' | '?' | '!' | ';' | ':'))
        && first_char.is_ascii_alphanumeric();
    if need_space {
        buf.push(' ');
    }
    buf.push_str(piece);
}

fn is_long_enough_for_punct_split(orig: &str) -> bool {
    let trimmed = orig.trim();
    let char_count = trimmed.chars().count();
    let word_count = trimmed.split_whitespace().count();
    let is_cjk =
        infer_text_language(trimmed) == Some("zh") || infer_text_language(trimmed) == Some("ja");
    if is_cjk {
        char_count >= 48
    } else {
        word_count >= 20 || char_count >= 120
    }
}

fn is_long_enough_for_clause_split(orig: &str) -> bool {
    let trimmed = orig.trim();
    let char_count = trimmed.chars().count();
    let word_count = trimmed.split_whitespace().count();
    let is_cjk =
        infer_text_language(trimmed) == Some("zh") || infer_text_language(trimmed) == Some("ja");
    if is_cjk {
        char_count >= 80
    } else {
        word_count >= 35 || char_count >= 190
    }
}

struct UtteranceState {
    session_id: u64,
    utterance_seq: u64,
    pending_final_orig: String,
    pending_final_trans: String,
    last_prov_orig: String,
    last_prov_trans: String,
    current_speaker_id: Option<u32>,
    prov_speaker_id: Option<u32>,
    /// 说话人切换防抖状态：(候选说话人 ID, 连续已确认字符数, 连续已确认 Token 数)
    candidate_speaker: Option<(u32, usize, usize)>,
    sentence_start_ms: Option<u64>,
    sentence_end_ms: Option<u64>,
    detected_lang: Option<String>,
    endpoint_pending_since: Option<tokio::time::Instant>,
    /// 当 <end> 触发但当前文本尚不构成完整语义句时，开启续航保持窗口（允许同一人停顿思考后继续把话说完）
    incomplete_hold_since: Option<tokio::time::Instant>,
    low_confidence_words: Vec<String>,
    enable_translation: bool,
    translation_type: String,
    target_lang: String,
}

impl UtteranceState {
    fn new(enable_translation: bool, translation_type: String, target_lang: String) -> Self {
        Self {
            session_id: (chrono::Utc::now().timestamp_millis() as u64) % 1_000_000,
            utterance_seq: 1,
            pending_final_orig: String::new(),
            pending_final_trans: String::new(),
            last_prov_orig: String::new(),
            last_prov_trans: String::new(),
            current_speaker_id: None,
            prov_speaker_id: None,
            candidate_speaker: None,
            sentence_start_ms: None,
            sentence_end_ms: None,
            detected_lang: None,
            endpoint_pending_since: None,
            incomplete_hold_since: None,
            low_confidence_words: Vec::new(),
            enable_translation,
            translation_type,
            target_lang,
        }
    }

    fn current_turn_id(&self) -> String {
        format!("turn-{}-{}", self.session_id, self.utterance_seq)
    }

    fn effective_speaker_id(&self) -> u32 {
        self.current_speaker_id
            .or(self.prov_speaker_id)
            .unwrap_or(1)
    }

    fn has_final_content(&self) -> bool {
        !self.pending_final_orig.trim().is_empty() || !self.pending_final_trans.trim().is_empty()
    }

    fn is_same_as_target(&self, eff_lang: Option<&str>) -> bool {
        if !self.enable_translation {
            return true;
        }
        if self.translation_type == "two_way" {
            // 双向互译模式下，中英互译均会产生目标语言译文
            return false;
        }
        eff_lang == Some(self.target_lang.as_str())
    }

    fn commit_current_utterance(
        &mut self,
        _reason: &str,
        event_tx: &broadcast::Sender<TranscriptSegment>,
    ) {
        let orig = if !self.pending_final_orig.trim().is_empty() {
            self.pending_final_orig.trim().to_string()
        } else {
            self.last_prov_orig.trim().to_string()
        };

        let mut trans = if !self.pending_final_trans.trim().is_empty() {
            self.pending_final_trans.trim().to_string()
        } else {
            self.last_prov_trans.trim().to_string()
        };

        let asr_translation = if trans.is_empty() {
            None
        } else {
            Some(trans.clone())
        };
        let eff_lang = resolve_effective_language(self.detected_lang.as_deref(), &orig);
        let is_same = self.is_same_as_target(eff_lang.as_deref());
        if trans.is_empty() && is_same {
            trans = orig.clone();
        }

        if !orig.is_empty() || !trans.is_empty() {
            let spk_id = self.effective_speaker_id();
            let duration_ms = match (self.sentence_start_ms, self.sentence_end_ms) {
                (Some(s), Some(e)) if e >= s => Some(e - s),
                _ => None,
            };
            let turn_id = self.current_turn_id();

            let mut final_seg = TranscriptSegment::new_final_with_id(
                turn_id,
                Speaker::remote(spk_id),
                orig.clone(),
                self.sentence_start_ms,
                duration_ms,
            );
            final_seg.asr_translation = asr_translation;
            final_seg.confirmed_text = Some(orig);
            final_seg.detected_language = eff_lang;
            final_seg.low_confidence_words = self.low_confidence_words.clone();
            if !trans.is_empty() {
                final_seg.confirmed_translated_text = Some(trans.clone());
                final_seg.translated_text = Some(trans);
            }
            let _ = event_tx.send(final_seg);
        }

        self.utterance_seq += 1;
        self.pending_final_orig.clear();
        self.pending_final_trans.clear();
        self.last_prov_orig.clear();
        self.last_prov_trans.clear();
        self.candidate_speaker = None;
        self.sentence_start_ms = None;
        self.sentence_end_ms = None;
        self.endpoint_pending_since = None;
        self.incomplete_hold_since = None;
        self.low_confidence_words.clear();
    }

    fn emit_partial(
        &self,
        prov_orig: &str,
        prov_trans: &str,
        event_tx: &broadcast::Sender<TranscriptSegment>,
    ) {
        let confirmed_orig = self.pending_final_orig.clone();
        let confirmed_trans = self.pending_final_trans.clone();

        let full_orig = format!("{}{}", confirmed_orig, prov_orig)
            .trim()
            .to_string();
        let full_trans = format!("{}{}", confirmed_trans, prov_trans)
            .trim()
            .to_string();

        if full_orig.is_empty() && full_trans.is_empty() {
            return;
        }

        let eff_lang = resolve_effective_language(self.detected_lang.as_deref(), &full_orig);
        let is_same = self.is_same_as_target(eff_lang.as_deref());

        let effective_trans = if full_trans.is_empty() && is_same {
            full_orig.clone()
        } else {
            full_trans
        };

        let spk_id = self.effective_speaker_id();
        let mut partial_seg = TranscriptSegment::new_partial_with_id(
            self.current_turn_id(),
            Speaker::remote(spk_id),
            full_orig,
        );
        partial_seg.detected_language = eff_lang;

        if !confirmed_orig.trim().is_empty() {
            partial_seg.confirmed_text = Some(confirmed_orig);
        }
        if !prov_orig.trim().is_empty() {
            partial_seg.provisional_text = Some(prov_orig.to_string());
        }
        if !confirmed_trans.trim().is_empty() {
            partial_seg.confirmed_translated_text = Some(confirmed_trans);
        }
        if !prov_trans.trim().is_empty() {
            partial_seg.provisional_translated_text = Some(prov_trans.to_string());
        }
        if !effective_trans.is_empty() {
            partial_seg.translated_text = Some(effective_trans);
        }

        let _ = event_tx.send(partial_seg);
    }
}

#[async_trait]
impl ASRService for SonioxLiveAdapter {
    fn stop_drain_timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs(8))
    }

    async fn test_connection(&self) -> Result<String, LiveHearError> {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "Soniox API Key 尚未填写".to_string(),
            ));
        }

        let mut request = self
            .config
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| LiveHearError::NetworkError(format!("构建握手失败: {}", e)))?;
        let auth = HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|e| LiveHearError::ConfigError(format!("无效 API Key: {}", e)))?;
        request.headers_mut().insert(AUTHORIZATION, auth);

        let (mut ws_stream, _) =
            tokio::time::timeout(SONIOX_CONNECT_TIMEOUT, connect_async(request))
                .await
                .map_err(|_| {
                    LiveHearError::NetworkError("连接 Soniox 超时，请检查网络/代理".into())
                })?
                .map_err(|e| LiveHearError::NetworkError(format!("连接 Soniox 失败: {}", e)))?;

        let init_payload = self.build_start_payload();
        let json = serde_json::to_string(&init_payload)
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        // Soniox rejects streams with no audio. Probe with 100 ms of synthetic PCM silence.
        let silence = vec![0; init_payload.sample_rate as usize / 10 * 2];
        tokio::time::timeout(SONIOX_CONNECT_TIMEOUT, async {
            for message in [
                Message::Text(json.into()),
                Message::Binary(silence.into()),
                Message::Text("".into()),
            ] {
                ws_stream.send(message).await.map_err(|e| {
                    LiveHearError::NetworkError(format!("发送 Soniox 测试请求失败: {e}"))
                })?;
            }

            while let Some(frame) = ws_stream.next().await {
                let frame = frame.map_err(|e| {
                    LiveHearError::NetworkError(format!("读取 Soniox 测试响应失败: {e}"))
                })?;
                match frame {
                    Message::Text(text) => {
                        let response: SonioxStreamResponse =
                            serde_json::from_str(&text).map_err(|e| {
                                LiveHearError::SerializationError(format!(
                                    "无效的 Soniox 测试响应: {e}"
                                ))
                            })?;
                        if let Some(error) = response.error_message {
                            return Err(LiveHearError::NetworkError(format!(
                                "Soniox 错误: {error}"
                            )));
                        }
                        if let Some(code) = response.error_code {
                            return Err(LiveHearError::NetworkError(format!("Soniox 错误 {code}")));
                        }
                        if response.finished == Some(true) {
                            return Ok(format!("Soniox {} 连通成功", init_payload.model));
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            Err(LiveHearError::NetworkError(
                "Soniox 在确认测试完成前关闭了连接".into(),
            ))
        })
        .await
        .map_err(|_| LiveHearError::NetworkError("等待 Soniox 确认测试完成超时".into()))?
    }

    async fn start_stream(
        &self,
    ) -> Result<
        (
            mpsc::Sender<Vec<u8>>,
            broadcast::Receiver<TranscriptSegment>,
        ),
        LiveHearError,
    > {
        let api_key = self.config.api_key.trim();
        if api_key.is_empty() {
            return Err(LiveHearError::ConfigError(
                "Soniox API Key 不能为空".to_string(),
            ));
        }

        let mut request = self
            .config
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| LiveHearError::NetworkError(format!("构建握手失败: {}", e)))?;
        let auth = HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|e| LiveHearError::ConfigError(format!("无效 API Key: {}", e)))?;
        request.headers_mut().insert(AUTHORIZATION, auth);

        let (ws_stream, _) = tokio::time::timeout(SONIOX_CONNECT_TIMEOUT, connect_async(request))
            .await
            .map_err(|_| {
                LiveHearError::NetworkError("连接 Soniox WebSocket 超时，请检查网络/代理".into())
            })?
            .map_err(|e| {
                LiveHearError::NetworkError(format!("连接 Soniox WebSocket 失败: {}", e))
            })?;

        let (mut write, mut read) = ws_stream.split();

        let init_payload = self.build_start_payload();
        let init_json = serde_json::to_string(&init_payload)
            .map_err(|e| LiveHearError::SerializationError(e.to_string()))?;

        write
            .send(Message::Text(init_json.into()))
            .await
            .map_err(|e| LiveHearError::NetworkError(format!("发送初始化配置失败: {}", e)))?;

        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(128);
        let (event_tx, event_rx) = broadcast::channel::<TranscriptSegment>(256);
        let (input_finished, input_finished_rx) = oneshot::channel();

        let last_chunk_sent = Arc::new(Mutex::new(tokio::time::Instant::now()));
        let last_chunk_sent_write = last_chunk_sent.clone();
        let last_chunk_sent_read = last_chunk_sent.clone();

        // 异步写任务：向 Soniox 传输 PCM 音频、VAD 静默手动 Finalize 指令，以及 8 秒周期的官方 JSON keepalive
        let writer_task = tokio::spawn(async move {
            let mut keepalive_interval = tokio::time::interval(std::time::Duration::from_secs(8));
            keepalive_interval.tick().await;

            loop {
                let message = tokio::select! {
                    chunk_opt = audio_rx.recv() => {
                        match chunk_opt {
                            Some(chunk) if chunk.as_slice() == [VAD_FINALIZE_SIGNAL] => {
                                Message::Text(r#"{"type":"finalize","trailing_silence_ms":300}"#.into())
                            }
                            Some(chunk) => {
                                if let Ok(mut l) = last_chunk_sent_write.lock() {
                                    *l = tokio::time::Instant::now();
                                }
                                Message::Binary(chunk.into())
                            }
                            None => break,
                        }
                    }
                    _ = keepalive_interval.tick() => {
                        Message::Text(r#"{"type":"keepalive"}"#.into())
                    }
                };
                if !matches!(
                    tokio::time::timeout(SONIOX_SEND_TIMEOUT, write.send(message)).await,
                    Ok(Ok(()))
                ) {
                    return;
                }
            }

            // Soniox treats empty binary frames as audio; an empty text frame ends input.
            if matches!(
                tokio::time::timeout(SONIOX_SEND_TIMEOUT, write.send(Message::Text("".into())))
                    .await,
                Ok(Ok(()))
            ) {
                let _ = input_finished.send(());
            }
        });

        let enable_translation = self.config.enable_translation;
        let translation_type = self.config.translation_type.clone();
        let target_lang = self.config.target_language.clone();
        let app_handle_read = self.app_handle.clone();

        // 异步读任务：解析 Soniox 流式 Token（对齐双语时间窗、抗抖动说话人分离与语义断句）
        tokio::spawn(async move {
            let mut state = UtteranceState::new(enable_translation, translation_type, target_lang);
            let mut last_latency_emit = tokio::time::Instant::now();
            let mut smoothed_latency_ms: u64 = 65;
            let mut check_receiver = tokio::time::interval(std::time::Duration::from_secs(1));
            let finish_deadline = async {
                if input_finished_rx.await.is_ok() {
                    tokio::time::sleep(SONIOX_FINISH_TIMEOUT).await;
                }
            };
            tokio::pin!(finish_deadline);

            loop {
                let endpoint_timeout = state.endpoint_pending_since.map(|since| {
                    let elapsed = since.elapsed();
                    let grace = tokio::time::Duration::from_millis(320);
                    if elapsed >= grace {
                        tokio::time::Duration::from_millis(1)
                    } else {
                        grace - elapsed
                    }
                });

                let hold_timeout = state.incomplete_hold_since.map(|since| {
                    let elapsed = since.elapsed();
                    let hold_dur = tokio::time::Duration::from_millis(2400);
                    if elapsed >= hold_dur {
                        tokio::time::Duration::from_millis(1)
                    } else {
                        hold_dur - elapsed
                    }
                });

                tokio::select! {
                    _ = &mut finish_deadline => {
                        if let Some(ref app) = app_handle_read {
                            let _ = app.emit("asr-error", "Soniox 收尾未完成，已保留收到的字幕");
                        }
                        break;
                    }
                    _ = check_receiver.tick() => {
                        if event_tx.receiver_count() == 0 {
                            break;
                        }
                    }
                    _ = async {
                        if let Some(wait_dur) = endpoint_timeout {
                            tokio::time::sleep(wait_dur).await;
                        } else {
                            futures_util::future::pending::<()>().await;
                        }
                    } => {
                        // <end>/<fin> 触发后等待译文窗口到期：检查是否构成完整语义句
                        state.endpoint_pending_since = None;
                        if state.has_final_content() || !state.last_prov_orig.trim().is_empty() {
                            if is_semantically_complete_utterance(&state.pending_final_orig) {
                                state.commit_current_utterance("端点结句(超时保底)", &event_tx);
                            } else {
                                state.incomplete_hold_since = Some(tokio::time::Instant::now());
                            }
                        }
                    }

                    _ = async {
                        if let Some(wait_dur) = hold_timeout {
                            tokio::time::sleep(wait_dur).await;
                        } else {
                            futures_util::future::pending::<()>().await;
                        }
                    } => {
                        // 短句/未完分句等待 2.4s 后说话人未再继续补充，正式结算上屏
                        if state.has_final_content() || !state.last_prov_orig.trim().is_empty() {
                            state.commit_current_utterance("静默延续结句", &event_tx);
                        } else {
                            state.incomplete_hold_since = None;
                        }
                    }

                    msg_opt = read.next() => {
                        let msg = match msg_opt {
                            Some(Ok(m)) => m,
                            Some(Err(e)) => {
                                eprintln!("⚠️ [Soniox WebSocket 读取异常]: {}", e);
                                if let Some(ref app) = app_handle_read {
                                    let _ = app.emit("asr-error", format!("Soniox 连接中断: {}", e));
                                }
                                break;
                            }
                            None => break,
                        };

                        let text = match msg {
                            Message::Text(t) => t,
                            Message::Close(_) => break,
                            _ => continue,
                        };

                        if last_latency_emit.elapsed() >= tokio::time::Duration::from_millis(1000)
                            && let Ok(l) = last_chunk_sent_read.lock() {
                                let raw_elapsed = l.elapsed().as_millis() as u64;
                                // 仅在近期有活跃推流时更新延迟测算，避免 VAD 静音期数值虚高
                                if raw_elapsed <= 450 {
                                    let sample = raw_elapsed.clamp(35, 380);
                                    smoothed_latency_ms = (smoothed_latency_ms * 3 + sample) / 4;
                                    last_latency_emit = tokio::time::Instant::now();
                                    if let Some(ref app) = app_handle_read {
                                        let _ = app.emit(
                                            "soniox-latency",
                                            serde_json::json!({ "latency_ms": smoothed_latency_ms }),
                                        );
                                    }
                                }
                            }

                        let resp = match serde_json::from_str::<SonioxStreamResponse>(&text) {
                            Ok(r) => r,
                            Err(e) => {
                                eprintln!("⚠️ [Soniox 反序列化异常]: {}", e);
                                continue;
                            }
                        };

                        if let Some(err) = resp.error_message {
                            eprintln!("⚠️ [Soniox API Error] code {:?}: {}", resp.error_code, err);
                            if let Some(ref app) = app_handle_read {
                                let _ = app.emit(
                                    "asr-error",
                                    format!("Soniox 服务端返回错误 ({:?}): {}", resp.error_code.unwrap_or(0), err),
                                );
                            }
                            continue;
                        }

                        let finished = resp.finished.unwrap_or(false);
                        if resp.tokens.is_empty() {
                            if finished { break; }
                            continue;
                        }

                        // 若上一帧已触发 <end>/<fin> 正在等待终态译文，先吸收本帧归属上一句的终态译文
                        if state.endpoint_pending_since.is_some() {
                            let mut consumed_indices = vec![false; resp.tokens.len()];
                            let mut has_new_orig_speech = false;
                            let mut new_orig_speaker: Option<u32> = None;

                            for (idx, token) in resp.tokens.iter().enumerate() {
                                let is_trans = token.translation_status.as_deref() == Some("translation");
                                let clean = strip_control_markers(&token.text);
                                if is_trans && token.is_final {
                                    let spk = parse_speaker(token);
                                    if spk.is_none() || spk == state.current_speaker_id {
                                        state.pending_final_trans.push_str(&clean);
                                        if let Some(ref sl) = token.source_language {
                                            state.detected_lang = Some(sl.to_lowercase());
                                        }
                                        consumed_indices[idx] = true;
                                    }
                                } else if !is_trans && !clean.trim().is_empty() {
                                    has_new_orig_speech = true;
                                    if new_orig_speaker.is_none() && token.is_final {
                                        new_orig_speaker = parse_speaker(token);
                                    }
                                }
                            }

                            let is_complete = is_semantically_complete_utterance(&state.pending_final_orig);
                            let speaker_changed = match (state.current_speaker_id, new_orig_speaker) {
                                (Some(curr), Some(next)) => curr != next,
                                _ => false,
                            };

                            if !state.pending_final_trans.trim().is_empty() || has_new_orig_speech {
                                state.endpoint_pending_since = None;
                                if is_complete || speaker_changed {
                                    state.commit_current_utterance("端点对齐结句", &event_tx);
                                } else if !has_new_orig_speech {
                                    // 虽已拿到阶段译文，但原句尚属未完短句且暂无新词，进入 2.4s 续航保持窗
                                    state.incomplete_hold_since = Some(tokio::time::Instant::now());
                                }
                            }

                            // 过滤掉已被吸收的译文 Token，继续处理剩余 Token
                            let remaining_tokens: Vec<SonioxToken> = resp
                                .tokens
                                .into_iter()
                                .enumerate()
                                .filter_map(|(i, t)| if consumed_indices[i] { None } else { Some(t) })
                                .collect();

                            if remaining_tokens.is_empty() {
                                state.emit_partial("", "", &event_tx);
                                if finished { break; }
                                continue;
                            }
                            process_token_batch(&mut state, remaining_tokens, &event_tx);
                        } else {
                            process_token_batch(&mut state, resp.tokens, &event_tx);
                        }
                        if finished { break; }
                    }
                }
            }

            writer_task.abort();
            if state.has_final_content() || !state.last_prov_orig.trim().is_empty() {
                state.commit_current_utterance("流关闭尾部结句", &event_tx);
            }
        });

        Ok((audio_tx, event_rx))
    }
}

fn process_token_batch(
    state: &mut UtteranceState,
    tokens: Vec<SonioxToken>,
    event_tx: &broadcast::Sender<TranscriptSegment>,
) {
    let mut prov_orig = String::new();
    let mut prov_trans = String::new();
    let mut has_endpoint = false;
    let total_len = tokens.len();
    let mut consumed = vec![false; total_len];

    for i in 0..total_len {
        if consumed[i] {
            continue;
        }
        let token = &tokens[i];
        let is_trans = token.translation_status.as_deref() == Some("translation");

        if contains_control_marker(&token.text) {
            has_endpoint = true;
        }
        let clean_text = strip_control_markers(&token.text);

        // 说话人分离核心准则：仅由【已确认且声学置信度合格的原声 Token (token.is_final && !is_trans && conf >= 0.62)】驱动说话人切换，
        // 并引入声纹防抖迟滞门限 (Hysteresis)，防止多人会议中呼吸杂音、1~2 词的声纹跳变或附和词 ("嗯"/"Yeah") 将长句切碎。
        let tok_conf = token.confidence.unwrap_or(1.0);
        if !is_trans && token.is_final && !clean_text.trim().is_empty() && tok_conf >= 0.62 {
            if let Some(spk) = parse_speaker(token) {
                match state.current_speaker_id {
                    None => {
                        state.current_speaker_id = Some(spk);
                        state.candidate_speaker = None;
                    }
                    Some(prev_spk) if prev_spk == spk => {
                        state.candidate_speaker = None;
                    }
                    Some(prev_spk) => {
                        let (mut cand_chars, mut cand_tokens) = match state.candidate_speaker {
                            Some((cand_id, c_chars, c_toks)) if cand_id == spk => (c_chars, c_toks),
                            _ => (0usize, 0usize),
                        };

                        // 统计当前批次内后续同属该新说话人的已确认原声词量
                        let mut batch_spk_chars = 0usize;
                        let mut batch_spk_tokens = 0usize;
                        for future_tok in &tokens[i..total_len] {
                            let f_is_trans =
                                future_tok.translation_status.as_deref() == Some("translation");
                            if !f_is_trans && future_tok.is_final {
                                if parse_speaker(future_tok) == Some(spk) {
                                    let fc = strip_control_markers(&future_tok.text);
                                    let trimmed_len = fc.trim().chars().count();
                                    if trimmed_len > 0 {
                                        batch_spk_chars += trimmed_len;
                                        batch_spk_tokens += 1;
                                    }
                                } else {
                                    break;
                                }
                            }
                        }

                        let total_cand_chars = cand_chars + batch_spk_chars;
                        let total_cand_tokens = cand_tokens + batch_spk_tokens;

                        let at_boundary = ends_with_sentence_terminal(&state.pending_final_orig)
                            || state.incomplete_hold_since.is_some()
                            || has_endpoint;

                        // 若前一句已处于句末边界，新说话人有 >= 4 字符或 >= 2 个词即确认换人；
                        // 若前一句正处于半句中间（无句末标点且未触发端点），则要求新说话人持续 >= 15 字符或 >= 4 个词才允许切句，
                        // 从而彻底吸收句中 1~3 词的声纹抖动与短促插话！
                        let should_switch_speaker = if !state.has_final_content() {
                            true
                        } else if at_boundary {
                            total_cand_chars >= 4 || total_cand_tokens >= 2
                        } else {
                            total_cand_chars >= 15 || total_cand_tokens >= 4
                        };

                        if should_switch_speaker {
                            // 在结算前一位说话人之前，先扫描当前批次后续是否还有属于前一位说话人的终态译文 Token
                            for j in (i + 1)..total_len {
                                if consumed[j] {
                                    continue;
                                }
                                let future_tok = &tokens[j];
                                let future_is_trans =
                                    future_tok.translation_status.as_deref() == Some("translation");
                                if future_is_trans && future_tok.is_final {
                                    let future_spk = parse_speaker(future_tok);
                                    if future_spk.is_none() || future_spk == Some(prev_spk) {
                                        let c = strip_control_markers(&future_tok.text);
                                        state.pending_final_trans.push_str(&c);
                                        consumed[j] = true;
                                    }
                                }
                            }

                            if state.has_final_content() {
                                state.commit_current_utterance("换人结句", event_tx);
                            }
                            state.current_speaker_id = Some(spk);
                            state.candidate_speaker = None;
                        } else {
                            cand_chars += clean_text.trim().chars().count();
                            cand_tokens += 1;
                            state.candidate_speaker = Some((spk, cand_chars, cand_tokens));
                        }
                    }
                }
            }
        } else if !is_trans
            && !token.is_final
            && let Some(spk) = parse_speaker(token)
        {
            state.prov_speaker_id = Some(spk);
        }

        if !is_trans {
            if state.sentence_start_ms.is_none() && token.start_ms.is_some() {
                state.sentence_start_ms = token.start_ms;
            }
            if let Some(end_ms) = token.end_ms {
                state.sentence_end_ms = Some(end_ms);
            } else if let (Some(s), Some(d)) = (token.start_ms, token.duration_ms) {
                state.sentence_end_ms = Some(s + d);
            }
            if let Some(ref l) = token.language {
                state.detected_lang = Some(l.to_lowercase());
            }
        } else if let Some(ref sl) = token.source_language {
            state.detected_lang = Some(sl.to_lowercase());
        }

        if clean_text.is_empty() {
            continue;
        }

        if !is_trans && !clean_text.trim().is_empty() {
            // 同一说话人有新原声词进入，重置未完句等待计时器，让句子无缝延续
            state.incomplete_hold_since = None;
        }

        if token.is_final {
            if is_trans {
                state.pending_final_trans.push_str(&clean_text);
            } else {
                if tok_conf < 0.78 {
                    let w = clean_text.trim();
                    let has_cjk = w.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
                    if (w.chars().count() >= 2 || has_cjk) && state.low_confidence_words.len() < 8 {
                        let entry = format!("{}({:.2})", w, tok_conf);
                        if !state.low_confidence_words.contains(&entry) {
                            state.low_confidence_words.push(entry);
                        }
                    }
                }
                append_smart_text(&mut state.pending_final_orig, &clean_text);
            }
        } else if is_trans {
            prov_trans.push_str(&clean_text);
        } else {
            prov_orig.push_str(&clean_text);
        }
    }

    if !prov_orig.trim().is_empty() {
        state.last_prov_orig = prov_orig.clone();
    }
    if !prov_trans.trim().is_empty() {
        state.last_prov_trans = prov_trans.clone();
    }

    let sample_text = if !state.pending_final_orig.trim().is_empty() {
        state.pending_final_orig.trim()
    } else {
        prov_orig.trim()
    };
    let eff_lang = resolve_effective_language(state.detected_lang.as_deref(), sample_text);
    let is_same_as_target = state.is_same_as_target(eff_lang.as_deref());
    let needs_translation = state.enable_translation && !is_same_as_target;

    // 译文就绪判定：无需翻译，或已收到终态译文且当前无悬挂的半截临时译文
    let translation_complete = if needs_translation {
        !state.pending_final_trans.trim().is_empty() && prov_trans.trim().is_empty()
    } else {
        true
    };

    if has_endpoint && state.has_final_content() {
        if translation_complete {
            if is_semantically_complete_utterance(&state.pending_final_orig) {
                state.commit_current_utterance("语义端点结句", event_tx);
                prov_orig.clear();
                prov_trans.clear();
            } else {
                // 虽然遇到了停顿端点 <end>，但当前仅是半句话或过短起手式（如 "其实我觉得，" / "Regarding the API"），
                // 保持在当前缓冲中开启 2.4s 续航窗口，等待说话人继续把话说完！
                if state.incomplete_hold_since.is_none() {
                    state.incomplete_hold_since = Some(tokio::time::Instant::now());
                }
            }
        } else {
            // 原声已到达 <end>/<fin> 端点，但 Soniox 流式终态译文将在下一帧 (约 50~200ms) 抵达，开启短窗等待
            if state.endpoint_pending_since.is_none() {
                state.endpoint_pending_since = Some(tokio::time::Instant::now());
            }
        }
    } else if state.has_final_content() && translation_complete && prov_orig.trim().is_empty() {
        // 针对连续不间断长篇发言的防超长保护：仅当句子达到足够长度且出现完整句末标点且双语均已稳定时优雅分段
        let is_long_punct = ends_with_sentence_terminal(&state.pending_final_orig)
            && is_long_enough_for_punct_split(&state.pending_final_orig);
        let is_long_clause = ends_with_clause_break(&state.pending_final_orig)
            && is_long_enough_for_clause_split(&state.pending_final_orig);

        if is_long_punct || is_long_clause {
            state.commit_current_utterance("长句语义分段", event_tx);
            prov_orig.clear();
            prov_trans.clear();
        }
    }

    // 实时流式 Partial 派发：展示当前未结句的完整语句（包含已锁定词与临时词）
    state.emit_partial(&prov_orig, &prov_trans, event_tx);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connection_test_requires_provider_completion() {
        for (response, expected) in [
            (
                Some(r#"{"finished":true}"#),
                Ok("Soniox stt-rt-v6 连通成功"),
            ),
            (
                Some(r#"{"error_code":400,"error_message":"Model unavailable"}"#),
                Err("Model unavailable"),
            ),
            (None, Err("确认测试完成前关闭")),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let Message::Text(init) = socket.next().await.unwrap().unwrap() else {
                    panic!("expected a Soniox configuration frame");
                };
                let payload: SonioxStartPayload = serde_json::from_str(&init).unwrap();
                assert_eq!(payload.model, "stt-rt-v6");
                assert!(matches!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Binary(pcm) if pcm.len() == 3200 && pcm.iter().all(|&byte| byte == 0)
                ));
                assert!(matches!(
                    socket.next().await.unwrap().unwrap(), Message::Text(end) if end.is_empty()
                ));
                socket
                    .send(Message::Text(r#"{"tokens":[]}"#.into()))
                    .await
                    .unwrap();
                if let Some(response) = response {
                    socket.send(Message::Text(response.into())).await.unwrap();
                } else {
                    socket.close(None).await.unwrap();
                }
            });
            let adapter = SonioxLiveAdapter::new(
                SonioxConfig {
                    api_key: "test".into(),
                    ws_url: url,
                    ..SonioxConfig::default()
                },
                None,
            );
            let result = adapter.test_connection().await;
            server.await.unwrap();
            match expected {
                Ok(message) => assert_eq!(result.unwrap(), message),
                Err(message) => assert!(result.unwrap_err().to_string().contains(message)),
            }
        }
    }

    #[tokio::test]
    async fn stopping_sends_an_empty_text_frame_and_flushed_tail_even_without_ack() {
        for acknowledge in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                assert!(
                    matches!(socket.next().await.unwrap().unwrap(), Message::Text(init) if !init.is_empty())
                );
                assert!(
                    matches!(socket.next().await.unwrap().unwrap(), Message::Binary(audio) if !audio.is_empty())
                );
                assert!(
                    matches!(socket.next().await.unwrap().unwrap(), Message::Text(end) if end.is_empty())
                );
                let response = serde_json::json!({
                    "tokens": [{"text": "Tail", "is_final": acknowledge, "speaker": "1"}],
                    "finished": acknowledge,
                });
                socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .unwrap();
                let _ = socket.next().await;
            });
            let adapter = SonioxLiveAdapter::new(
                SonioxConfig {
                    api_key: "test".into(),
                    ws_url: url,
                    enable_translation: false,
                    ..SonioxConfig::default()
                },
                None,
            );
            let (audio, mut segments) = adapter.start_stream().await.unwrap();
            audio.send(vec![0, 0]).await.unwrap();
            drop(audio);
            let deadline = std::time::Duration::from_secs(2)
                + if acknowledge {
                    std::time::Duration::ZERO
                } else {
                    SONIOX_FINISH_TIMEOUT
                };
            tokio::time::timeout(deadline, async {
                let mut final_text = None;
                while let Ok(segment) = segments.recv().await {
                    if segment.is_final {
                        final_text = Some(segment.text);
                    }
                }
                assert_eq!(final_text.as_deref(), Some("Tail"));
                server.await.unwrap();
            })
            .await
            .unwrap();
        }
    }

    #[test]
    fn default_stream_requests_native_english_chinese_translation() {
        let adapter = SonioxLiveAdapter::new(SonioxConfig::default(), None);
        let payload = adapter.build_start_payload();
        assert_eq!(payload.model, "stt-rt-v6");
        assert_eq!(payload.endpoint_sensitivity, Some(-0.2));
        let translation = payload.translation.unwrap();
        assert_eq!(translation.translation_type, "two_way");
        assert_eq!(translation.language_a.as_deref(), Some("en"));
        assert_eq!(translation.language_b.as_deref(), Some("zh"));
        assert!(translation.target_language.is_none());
    }

    #[test]
    fn stream_bounds_endpoint_sensitivity_and_omits_it_without_endpoint_detection() {
        let mut config = SonioxConfig {
            endpoint_sensitivity: 2.0,
            ..SonioxConfig::default()
        };
        let adapter = SonioxLiveAdapter::new(config.clone(), None);
        assert_eq!(
            adapter.build_start_payload().endpoint_sensitivity,
            Some(1.0)
        );

        config.enable_endpoint_detection = false;
        let adapter = SonioxLiveAdapter::new(config, None);
        let payload = serde_json::to_value(adapter.build_start_payload()).unwrap();
        assert!(payload.get("endpoint_sensitivity").is_none());
        assert!(payload.get("max_endpoint_delay_ms").is_none());
    }

    #[test]
    fn glossary_deduplicates_terms_and_mappings_without_folding_case() {
        let adapter = SonioxLiveAdapter::new(
            SonioxConfig {
                custom_terms: [
                    " SLA ",
                    "SLA=服务级别协议",
                    "SLA -> 服务级别协议",
                    "sla",
                    "",
                ]
                .map(String::from)
                .to_vec(),
                ..SonioxConfig::default()
            },
            None,
        );
        let context = adapter.build_start_payload().context.unwrap();
        assert_eq!(context.terms, ["SLA", "sla"]);
        assert_eq!(context.translation_terms.len(), 1);
        assert_eq!(context.translation_terms[0].source, "SLA");
        assert_eq!(context.translation_terms[0].target, "服务级别协议");
    }

    fn make_token(
        text: &str,
        is_final: bool,
        status: Option<&str>,
        speaker: Option<&str>,
    ) -> SonioxToken {
        SonioxToken {
            text: text.to_string(),
            is_final,
            confidence: Some(0.95),
            speaker: speaker.map(|s| serde_json::Value::String(s.to_string())),
            spk: None,
            start_ms: Some(100),
            end_ms: Some(300),
            duration_ms: Some(200),
            translation_status: status.map(|s| s.to_string()),
            language: Some("en".to_string()),
            source_language: Some("en".to_string()),
        }
    }

    #[test]
    fn test_speaker_parsing_preserves_one_indexed_labels() {
        let tok1 = make_token("Hello", true, Some("original"), Some("1"));
        let tok2 = make_token("World", true, Some("original"), Some("2"));
        assert_eq!(parse_speaker(&tok1), Some(1));
        assert_eq!(parse_speaker(&tok2), Some(2));
    }

    #[test]
    fn test_provisional_speaker_flicker_does_not_split_sentence() {
        let (tx, mut rx) = broadcast::channel(32);
        let mut state = UtteranceState::new(true, "one_way".to_string(), "zh".to_string());

        process_token_batch(
            &mut state,
            vec![
                make_token("We are ", true, Some("original"), Some("1")),
                make_token("migrating", false, Some("original"), Some("2")),
            ],
            &tx,
        );

        assert_eq!(state.current_speaker_id, Some(1));
        assert_eq!(state.pending_final_orig, "We are ");
        let seg = rx.try_recv().expect("should emit partial");
        assert!(!seg.is_final);
        assert_eq!(seg.confirmed_text.as_deref(), Some("We are "));
        assert_eq!(seg.provisional_text.as_deref(), Some("migrating"));
    }

    #[test]
    fn test_endpoint_waits_for_lagging_translation_without_leaking() {
        let (tx, mut rx) = broadcast::channel(32);
        let mut state = UtteranceState::new(true, "one_way".to_string(), "zh".to_string());

        // Frame 1: 原声已 finalized 并触发 <end>，但译文尚处于 is_final: false
        process_token_batch(
            &mut state,
            vec![
                make_token(
                    "How is the release going?",
                    true,
                    Some("original"),
                    Some("1"),
                ),
                make_token("<end>", true, Some("original"), Some("1")),
                make_token("发布进展如何？", false, Some("translation"), Some("1")),
            ],
            &tx,
        );

        assert!(state.endpoint_pending_since.is_some());
        let partial_seg = rx
            .try_recv()
            .expect("should emit partial while waiting for final trans");
        assert!(!partial_seg.is_final);
        assert_eq!(
            partial_seg.translated_text.as_deref(),
            Some("发布进展如何？")
        );

        // Frame 2: 下一帧终态译文抵达，同时下一句新发言开始
        let frame2 = vec![
            make_token("发布进展如何？", true, Some("translation"), Some("1")),
            make_token("Everything ", true, Some("original"), Some("1")),
        ];

        let mut consumed_indices = vec![false; frame2.len()];
        for (idx, token) in frame2.iter().enumerate() {
            if token.translation_status.as_deref() == Some("translation") && token.is_final {
                state
                    .pending_final_trans
                    .push_str(&strip_control_markers(&token.text));
                consumed_indices[idx] = true;
            }
        }
        state.commit_current_utterance("端点对齐结句", &tx);
        let remaining: Vec<SonioxToken> = frame2
            .into_iter()
            .enumerate()
            .filter_map(|(i, t)| if consumed_indices[i] { None } else { Some(t) })
            .collect();
        process_token_batch(&mut state, remaining, &tx);

        let final_seg = rx
            .try_recv()
            .expect("should emit final segment for sentence 1");
        assert!(final_seg.is_final);
        assert_eq!(final_seg.text, "How is the release going?");
        assert_eq!(final_seg.translated_text.as_deref(), Some("发布进展如何？"));
        assert_eq!(final_seg.id, partial_seg.id);

        // 确认第一句的译文绝不会残留污染到第二句
        assert_eq!(state.pending_final_orig, "Everything ");
        assert_eq!(state.pending_final_trans, "");
    }

    #[test]
    fn test_abbreviations_do_not_trigger_terminal_punct() {
        assert!(!ends_with_sentence_terminal("Hello Mr."));
        assert!(!ends_with_sentence_terminal("See Dr."));
        assert!(ends_with_sentence_terminal("The service is ready."));
    }

    #[test]
    fn test_mid_sentence_speaker_jitter_is_absorbed() {
        let (tx, mut rx) = broadcast::channel(32);
        let mut state = UtteranceState::new(false, "one_way".to_string(), "zh".to_string());

        // Speaker 1 正在说半句话（尚未出现句号），中间 1~2 个词声纹跳变到 Speaker 2，随后回到 Speaker 1
        process_token_batch(
            &mut state,
            vec![
                make_token(
                    "Because the API gateway ",
                    true,
                    Some("original"),
                    Some("1"),
                ),
                make_token("needs ", true, Some("original"), Some("2")),
                make_token(
                    "to be rate limited before Friday release.",
                    true,
                    Some("original"),
                    Some("1"),
                ),
                make_token("<end>", true, Some("original"), Some("1")),
            ],
            &tx,
        );

        let final_seg = rx
            .try_recv()
            .expect("should emit single unbroken final sentence");
        assert!(final_seg.is_final);
        assert_eq!(
            final_seg.text,
            "Because the API gateway needs to be rate limited before Friday release."
        );
        assert_eq!(final_seg.speaker.id.0, 1);
    }

    #[test]
    fn test_incomplete_short_clause_holds_across_endpoint_until_complete() {
        let (tx, mut rx) = broadcast::channel(32);
        let mut state = UtteranceState::new(true, "one_way".to_string(), "zh".to_string());

        // 第一阶段：说话人仅说了起手词 "Actually," 后停顿触发 <end>
        process_token_batch(
            &mut state,
            vec![
                make_token("Actually,", true, Some("original"), Some("1")),
                make_token("<end>", true, Some("original"), Some("1")),
                make_token("实际上，", true, Some("translation"), Some("1")),
            ],
            &tx,
        );

        // 此时不应切成碎句，而是进入 incomplete_hold_since 保持窗，仅派发 partial 实时预览
        assert!(state.incomplete_hold_since.is_some());
        let first_msg = rx
            .try_recv()
            .expect("should only emit partial for short incomplete clause");
        assert!(!first_msg.is_final);

        // 第二阶段：说话人继续把整句话说完
        process_token_batch(
            &mut state,
            vec![
                make_token(
                    "we need to finish the database migration before the production rollout.",
                    true,
                    Some("original"),
                    Some("1"),
                ),
                make_token("<end>", true, Some("original"), Some("1")),
                make_token(
                    "我们需要在生产发布前完成数据库迁移。",
                    true,
                    Some("translation"),
                    Some("1"),
                ),
            ],
            &tx,
        );

        let second_msg = rx
            .try_recv()
            .expect("should emit merged complete final sentence");
        assert!(second_msg.is_final);
        assert_eq!(
            second_msg.text,
            "Actually, we need to finish the database migration before the production rollout."
        );
        assert_eq!(
            second_msg.translated_text.as_deref(),
            Some("实际上，我们需要在生产发布前完成数据库迁移。")
        );
    }

    #[test]
    fn test_single_cjk_low_confidence_token_is_captured_unlike_single_ascii() {
        let (tx, mut rx) = broadcast::channel(32);
        let mut state = UtteranceState::new(false, "one_way".to_string(), "zh".to_string());

        let mut cjk_tok = make_token("幂", true, Some("original"), Some("1"));
        cjk_tok.confidence = Some(0.55);
        cjk_tok.language = Some("zh".to_string());

        let mut ascii_tok = make_token("a", true, Some("original"), Some("1"));
        ascii_tok.confidence = Some(0.55);
        ascii_tok.language = Some("en".to_string());

        let mut long_tok = make_token(
            "等性需要保证在架构评审里面确认清楚。",
            true,
            Some("original"),
            Some("1"),
        );
        long_tok.confidence = Some(0.95);
        long_tok.language = Some("zh".to_string());

        process_token_batch(
            &mut state,
            vec![
                ascii_tok,
                cjk_tok,
                long_tok,
                make_token("<end>", true, Some("original"), Some("1")),
            ],
            &tx,
        );

        let final_seg = rx.try_recv().expect("should emit final segment");
        assert!(final_seg.is_final);
        assert_eq!(final_seg.low_confidence_words, vec!["幂(0.55)".to_string()]);
    }
}
