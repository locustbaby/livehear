use serde::{Deserialize, Serialize};

/// 结构化会议意图枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum MeetingIntent {
    /// 进度核对 / 排期交付问询
    ProgressCheck,
    /// 技术难点 / 阻塞卡点排查
    TechnicalBlocker,
    /// Action Item 任务指派
    ActionItemAssignment,
    /// 澄清与反问
    Clarification,
    /// 方案异议与折中探讨
    Objection,
    /// 一般性交谈 / 闲聊
    #[default]
    GeneralDiscussion,
}

impl MeetingIntent {
    pub fn display_name(&self) -> &'static str {
        match self {
            MeetingIntent::ProgressCheck => "排期与进度核对",
            MeetingIntent::TechnicalBlocker => "技术阻塞卡点",
            MeetingIntent::ActionItemAssignment => "Action Item 指派",
            MeetingIntent::Clarification => "细节澄清反问",
            MeetingIntent::Objection => "方案异议探讨",
            MeetingIntent::GeneralDiscussion => "常规会议交流",
        }
    }
}

/// Jev System 1 结构化决策输出实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JevDecision {
    /// 是否需要我回应（向我提问或派工）
    pub is_question: bool,
    /// 判定置信度 (0.0 ~ 1.0)
    pub confidence: f32,
    /// 细粒度意图
    pub intent: MeetingIntent,
}
