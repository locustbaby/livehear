// 前端统一领域实体模型与配置规范 (与 Rust 后端 100% 对齐)

export interface FullAppConfig {
  soniox: {
    api_key: string;
    ws_url: string;
    model: string;
    sample_rate: number;
    enable_speaker_diarization: boolean;
    enable_endpoint_detection?: boolean;
    language_hints: string[];
    language_hints_strict?: boolean;
    enable_translation?: boolean;
    translation_type?: 'one_way' | 'two_way' | string;
    target_language?: string;
    language_a?: string;
    language_b?: string;
    max_endpoint_delay_ms?: number;
    endpoint_sensitivity?: number;
    custom_terms?: string[];
    enable_vad?: boolean;
    vad_threshold?: number;
    input_device?: string | null;
  };
  openrouter: {
    api_key: string;
    base_url: string;
    translate_model: string;
    predict_model: string;
    enable_polish?: boolean;
  };
  jev: {
    enabled: boolean;
    api_key: string;
    base_url: string;
    model: string;
    confidence_threshold: number;
  };
  meeting: {
    auto_predict: boolean;
    context: string;
  };
  storage?: {
    auto_save: boolean;
    save_dir: string;
    file_format: string;
  };
}

export interface Speaker {
  id: number;
  role: 'LocalUser' | { RemoteParticipant: number } | 'Unknown';
  display_name: string;
}

export interface TranscriptSegment {
  id: string;
  speaker: Speaker;
  text: string;
  translated_text?: string;
  confirmed_text?: string;
  provisional_text?: string;
  confirmed_translated_text?: string;
  provisional_translated_text?: string;
  low_confidence_words?: string[];
  detected_language?: string;
  is_final: boolean;
  start_ms?: number;
  duration_ms?: number;
  timestamp_ms: number;
}

export type MeetingIntent =
  | 'ProgressCheck'
  | 'TechnicalBlocker'
  | 'ActionItemAssignment'
  | 'Clarification'
  | 'Objection'
  | 'GeneralDiscussion';

export type ReplyStrategy =
  | 'ConservativePushback'
  | 'OptimisticCommit'
  | 'BlockerClarification'
  | 'General';

export interface ReplySuggestion {
  id: number;
  shortcut: string;
  strategy: ReplyStrategy;
  title: string;
  detail: string;
}

export interface OrchestratedEventPayload {
  segment: TranscriptSegment;
  intent?: string;
  suggestions?: ReplySuggestion[];
}
