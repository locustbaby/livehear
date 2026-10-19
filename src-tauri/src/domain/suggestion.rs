use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReplyStrategy {
    /// 稳妥推迟 / 强调风险以争取排期缓冲
    ConservativePushback,
    /// 积极承诺 / 在前置条件满足时给出明确交付
    OptimisticCommit,
    /// 依赖卡点澄清 / 抛出外部前置阻塞
    BlockerClarification,
    /// 通用专业回答
    General,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplySuggestion {
    pub id: usize,
    pub shortcut: String,
    pub strategy: ReplyStrategy,
    pub title: String,
    pub detail: String,
}
