use eden_agent_core::{AssistantMessage, Message, ModelRequest};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn current_speaker_names(request: &ModelRequest) -> Vec<String> {
    let mut names = request
        .metadata
        .get("currentSpeakerNames")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(speaker) = request.metadata.get("speaker") {
        for key in ["characterName", "assistantName"] {
            if let Some(name) = speaker
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                && !names.iter().any(|existing| existing == name)
            {
                names.push(name.to_owned());
            }
        }
    }
    names
}

pub(super) fn historical_speaker_instruction(
    request: &ModelRequest,
    active_assistant_id: Option<&str>,
) -> Option<String> {
    let mut speakers = BTreeMap::new();
    for message in &request.messages {
        let Message::Assistant(message) = message else {
            continue;
        };
        let Some((speaker_id, names)) = assistant_speaker(message) else {
            continue;
        };
        if active_assistant_id.is_some_and(|active| active == speaker_id) {
            continue;
        }
        let structured_name = structured_speaker_name(&speaker_id);
        let label = names
            .first()
            .cloned()
            .unwrap_or_else(|| format!("助手#{speaker_id}"));
        speakers.insert(structured_name, label);
    }
    if speakers.is_empty() {
        return None;
    }
    let mapping = speakers
        .iter()
        .map(|(name, label)| format!("- {name} = {label}"))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "# 历史说话者元数据\n以下 assistant 消息的 name 字段只标识历史发言来源：\n{mapping}\n这些 name 与显示名称不是回答格式。不要在正文中复述或模仿说话者标签。"
    ))
}

pub(super) fn assistant_speaker(message: &AssistantMessage) -> Option<(String, Vec<String>)> {
    let speaker = message.extra.get("speaker")?.as_object()?;
    let speaker_id = speaker.get("assistantID").and_then(scalar_string)?;
    let mut names = Vec::new();
    for key in ["characterName", "assistantName"] {
        if let Some(name) = speaker
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            && !names.iter().any(|existing| existing == name)
        {
            names.push(name.to_owned());
        }
    }
    Some((speaker_id, names))
}

pub(super) fn scalar_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

pub(super) fn structured_speaker_name(speaker_id: &str) -> String {
    let mut normalized = speaker_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        normalized.push_str("unknown");
    }
    format!("assistant_{normalized}")
}

pub(super) fn strip_redundant_speaker_prefix(text: &str, names: &[String]) -> String {
    let mut filter = LeadingSpeakerPrefixFilter::new(names);
    let mut output = filter.push(text);
    output.push_str(&filter.finish());
    output
}

#[derive(Default)]
pub(super) struct LeadingSpeakerPrefixFilter {
    candidates: Vec<String>,
    pending: String,
    state: LeadingSpeakerPrefixState,
}

#[derive(Default)]
pub(super) enum LeadingSpeakerPrefixState {
    #[default]
    Pending,
    DroppingWhitespace,
    PassThrough,
}

impl LeadingSpeakerPrefixFilter {
    pub(super) fn new(names: &[String]) -> Self {
        let mut candidates = Vec::new();
        for name in names
            .iter()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
        {
            for candidate in [
                format!("[{name}]"),
                format!("【{name}】"),
                format!("{name}:"),
                format!("{name}："),
            ] {
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
        }
        Self {
            candidates,
            ..Self::default()
        }
    }

    pub(super) fn push(&mut self, fragment: &str) -> String {
        match self.state {
            LeadingSpeakerPrefixState::PassThrough => return fragment.to_owned(),
            LeadingSpeakerPrefixState::DroppingWhitespace => {
                let content = fragment.trim_start_matches(char::is_whitespace);
                if content.is_empty() {
                    return String::new();
                }
                self.state = LeadingSpeakerPrefixState::PassThrough;
                return content.to_owned();
            }
            LeadingSpeakerPrefixState::Pending => {}
        }
        if self.candidates.is_empty() {
            self.state = LeadingSpeakerPrefixState::PassThrough;
            return fragment.to_owned();
        }

        self.pending.push_str(fragment);
        let probe = self.pending.trim_start_matches(char::is_whitespace);
        if probe.is_empty() {
            return String::new();
        }
        if let Some(candidate) = self
            .candidates
            .iter()
            .find(|candidate| probe.starts_with(candidate.as_str()))
        {
            let remainder = probe[candidate.len()..]
                .trim_start_matches(char::is_whitespace)
                .to_owned();
            self.pending.clear();
            if remainder.is_empty() {
                self.state = LeadingSpeakerPrefixState::DroppingWhitespace;
                String::new()
            } else {
                self.state = LeadingSpeakerPrefixState::PassThrough;
                remainder
            }
        } else if self
            .candidates
            .iter()
            .any(|candidate| candidate.starts_with(probe))
        {
            String::new()
        } else {
            self.state = LeadingSpeakerPrefixState::PassThrough;
            std::mem::take(&mut self.pending)
        }
    }

    pub(super) fn finish(&mut self) -> String {
        if matches!(self.state, LeadingSpeakerPrefixState::Pending) {
            self.state = LeadingSpeakerPrefixState::PassThrough;
            return std::mem::take(&mut self.pending);
        }
        String::new()
    }
}
