// 前端统一领域实体模型与枚举规范 (与 Rust 后端 100% 对齐)

export type AudioTrackType = 'LocalMicrophone' | 'SystemSpeaker';

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
