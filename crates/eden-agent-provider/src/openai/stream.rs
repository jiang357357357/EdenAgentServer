use eden_agent_core::{
    AgentEvent, AssistantMessage, ContentBlock, EventEmitter, Message, ModelError, ModelOutput,
    ModelSpec,
};
use futures::StreamExt;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

use super::speaker::LeadingSpeakerPrefixFilter;
use super::usage::{normalized_openai_usage, normalized_responses_usage};

#[derive(Default)]
pub(super) struct StreamToolCall {
    id: String,
    name: String,
    arguments: String,
    provider_item_id: Option<String>,
}

#[derive(Default)]
pub(super) struct StreamAccumulator {
    text: String,
    reasoning: String,
    reasoning_signature: Option<String>,
    tool_calls: BTreeMap<usize, StreamToolCall>,
    usage: Option<Value>,
    finish_reason: Option<String>,
    started: bool,
    leading_speaker_prefix: LeadingSpeakerPrefixFilter,
}

pub(super) struct StreamFailure {
    pub(super) error: ModelError,
    pub(super) reset_message: Option<Box<AssistantMessage>>,
    pub(super) tool_calls_started: bool,
}

impl StreamAccumulator {
    fn with_speaker_names(names: &[String]) -> Self {
        Self {
            leading_speaker_prefix: LeadingSpeakerPrefixFilter::new(names),
            ..Self::default()
        }
    }

    fn append_text_delta(&mut self, fragment: &str) -> String {
        let filtered = self.leading_speaker_prefix.push(fragment);
        self.text.push_str(&filtered);
        filtered
    }

    fn finish_text_prefix(&mut self) -> String {
        let filtered = self.leading_speaker_prefix.finish();
        self.text.push_str(&filtered);
        filtered
    }

    pub(super) fn message(&self, model: &ModelSpec) -> AssistantMessage {
        let mut content = Vec::new();
        if !self.reasoning.is_empty() {
            let mut extra = Map::new();
            if let Some(signature) = &self.reasoning_signature {
                extra.insert(
                    "thinkingSignature".to_owned(),
                    Value::String(signature.clone()),
                );
            }
            content.push(ContentBlock::Thinking {
                thinking: self.reasoning.clone(),
                extra,
            });
        }
        if !self.text.is_empty() || self.tool_calls.is_empty() {
            content.push(ContentBlock::Text {
                text: self.text.clone(),
            });
        }
        content.extend(self.tool_calls.values().map(|call| {
            ContentBlock::ToolCall {
                id: if call.id.is_empty() {
                    "unknown_call".to_owned()
                } else {
                    call.id.clone()
                },
                name: if call.name.is_empty() {
                    "unknown_tool".to_owned()
                } else {
                    call.name.clone()
                },
                arguments: serde_json::from_str(&call.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.arguments})),
                provider_item_id: call.provider_item_id.clone(),
            }
        }));
        AssistantMessage {
            content,
            api: if model.api.is_empty() {
                "openai-completions".to_owned()
            } else {
                model.api.clone()
            },
            provider: model.provider.clone(),
            model: model.id.clone(),
            usage: self.usage.clone(),
            stop_reason: self
                .finish_reason
                .clone()
                .unwrap_or_else(|| "stop".to_owned()),
            error_message: None,
            timestamp: eden_agent_core::now_ms(),
            extra: Map::new(),
        }
    }

    pub(super) fn apply_chunk(&mut self, value: &Value) -> String {
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(normalized_openai_usage(usage));
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            return String::new();
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }
        let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
            return String::new();
        };
        let mut emitted = String::new();
        for key in ["reasoning_content", "reasoning", "reasoning_text"] {
            if let Some(fragment) = delta.get(key).and_then(Value::as_str) {
                self.reasoning.push_str(fragment);
                self.reasoning_signature
                    .get_or_insert_with(|| key.to_owned());
                emitted.push_str(fragment);
                break;
            }
        }
        if let Some(fragment) = delta.get("content").and_then(Value::as_str) {
            emitted.push_str(&self.append_text_delta(fragment));
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let accumulated = self.tool_calls.entry(index).or_default();
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                accumulated.id.push_str(id);
            }
            if let Some(function) = call.get("function").and_then(Value::as_object) {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    accumulated.name.push_str(name);
                }
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    accumulated.arguments.push_str(arguments);
                }
            }
        }
        emitted
    }

    fn failure(&self, model: &ModelSpec, error: ModelError) -> StreamFailure {
        let reset_message = self.started.then(|| {
            Box::new({
                let mut message = StreamAccumulator::default().message(model);
                message.stop_reason = "stream_reset".to_owned();
                message
                    .extra
                    .insert("streamReset".to_owned(), Value::Bool(true));
                message
            })
        });
        StreamFailure {
            error,
            reset_message,
            tool_calls_started: !self.tool_calls.is_empty(),
        }
    }
}

#[derive(Default)]
pub(super) struct ResponsesAccumulator {
    stream: StreamAccumulator,
    completed: bool,
    native_sources: Vec<(String, String)>,
}

impl ResponsesAccumulator {
    fn message(&self, model: &ModelSpec) -> AssistantMessage {
        let mut message = self.stream.message(model);
        message.api = "openai-responses".to_owned();
        message.stop_reason = if !self.stream.tool_calls.is_empty() {
            "tool_calls".to_owned()
        } else {
            self.stream
                .finish_reason
                .clone()
                .unwrap_or_else(|| "stop".to_owned())
        };
        message
    }

    fn failure(&self, model: &ModelSpec, error: ModelError) -> StreamFailure {
        let reset_message = self.stream.started.then(|| {
            Box::new({
                let mut message = ResponsesAccumulator::default().message(model);
                message.stop_reason = "stream_reset".to_owned();
                message
                    .extra
                    .insert("streamReset".to_owned(), Value::Bool(true));
                message
            })
        });
        StreamFailure {
            error,
            reset_message,
            tool_calls_started: !self.stream.tool_calls.is_empty(),
        }
    }

    fn tool_call(&mut self, index: usize, item: Option<&Value>) -> &mut StreamToolCall {
        let call = self.stream.tool_calls.entry(index).or_default();
        if let Some(item) = item {
            if let Some(id) = item.get("call_id").and_then(Value::as_str) {
                call.id = id.to_owned();
            }
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                call.name = name.to_owned();
            }
            if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                call.arguments = arguments.to_owned();
            }
            if let Some(provider_item_id) = item.get("id").and_then(Value::as_str) {
                call.provider_item_id = Some(provider_item_id.to_owned());
            }
        }
        call
    }

    fn collect_native_sources(&mut self, item: &Value) {
        for annotation in item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|content| content.get("annotations").and_then(Value::as_array))
            .flatten()
        {
            if annotation.get("type").and_then(Value::as_str) != Some("url_citation") {
                continue;
            }
            let Some(url) = annotation
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
            else {
                continue;
            };
            if self
                .native_sources
                .iter()
                .any(|(_, existing_url)| existing_url == url)
            {
                continue;
            }
            let title = annotation
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(url);
            self.native_sources.push((title.to_owned(), url.to_owned()));
        }
    }

    fn append_missing_native_sources(&mut self) -> String {
        let missing = self
            .native_sources
            .iter()
            .filter(|(_, url)| !self.stream.text.contains(url))
            .map(|(title, url)| format!("- [{title}]({url})"))
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return String::new();
        }
        let suffix = format!("\n\n来源：\n{}", missing.join("\n"));
        self.stream.text.push_str(&suffix);
        suffix
    }

    fn apply_event(&mut self, value: &Value) -> Result<String, ModelError> {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "error" => {
                return Err(ModelError::new(
                    "provider_response_error",
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Responses API returned an error"),
                ));
            }
            "response.failed" => {
                return Err(ModelError::new(
                    "provider_response_failed",
                    value
                        .pointer("/response/error/message")
                        .or_else(|| value.pointer("/response/error/code"))
                        .and_then(Value::as_str)
                        .unwrap_or("Responses API request failed"),
                ));
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    self.stream.reasoning.push_str(delta);
                    self.stream.reasoning_signature = Some("reasoning_summary".to_owned());
                    return Ok(delta.to_owned());
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    return Ok(self.stream.append_text_delta(delta));
                }
            }
            "response.output_item.added" => {
                let index = value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if value.pointer("/item/type").and_then(Value::as_str) == Some("function_call") {
                    self.tool_call(index, value.get("item"));
                }
            }
            "response.function_call_arguments.delta" => {
                let index = value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    self.tool_call(index, None).arguments.push_str(delta);
                }
            }
            "response.output_item.done" => {
                let index = value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if value.pointer("/item/type").and_then(Value::as_str) == Some("function_call") {
                    self.tool_call(index, value.get("item"));
                } else if value.pointer("/item/type").and_then(Value::as_str) == Some("message")
                    && let Some(item) = value.get("item")
                {
                    self.collect_native_sources(item);
                }
            }
            "response.completed" => {
                self.completed = true;
                let status = value
                    .pointer("/response/status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                self.stream.finish_reason = Some(if status == "completed" {
                    "stop".to_owned()
                } else {
                    status.to_owned()
                });
                if let Some(usage) = value.pointer("/response/usage") {
                    self.stream.usage = Some(normalized_responses_usage(usage));
                }
                return Ok(self.append_missing_native_sources());
            }
            _ => {}
        }
        Ok(String::new())
    }
}

pub(super) async fn parse_responses_stream(
    model: &ModelSpec,
    response: reqwest::Response,
    events: EventEmitter,
    cancellation: CancellationToken,
    speaker_names: &[String],
) -> Result<ModelOutput, StreamFailure> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut accumulator = ResponsesAccumulator {
        stream: StreamAccumulator::with_speaker_names(speaker_names),
        ..ResponsesAccumulator::default()
    };
    let mut done_seen = false;
    'stream: loop {
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Err(accumulator.failure(model, ModelError::new("cancelled", "model request cancelled"))),
            chunk = stream.next() => chunk,
        };
        let eof = chunk.is_none();
        if let Some(chunk) = chunk {
            let chunk = chunk.map_err(|error| {
                accumulator.failure(
                    model,
                    ModelError {
                        code: "provider_stream".to_owned(),
                        message: format!("model stream interrupted: {error}"),
                        retryable: true,
                    },
                )
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
        } else if !buffer.is_empty() {
            buffer.push('\n');
        }
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim_end_matches('\r').to_owned();
            buffer.drain(..=newline);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                done_seen = true;
                break 'stream;
            }
            if data.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(data).map_err(|error| {
                accumulator.failure(
                    model,
                    ModelError {
                        code: "provider_stream_json".to_owned(),
                        message: format!("invalid Responses API stream chunk: {error}"),
                        retryable: true,
                    },
                )
            })?;
            let delta = accumulator
                .apply_event(&value)
                .map_err(|error| accumulator.failure(model, error))?;
            if !accumulator.stream.started {
                accumulator.stream.started = true;
                events
                    .emit(AgentEvent::MessageStart {
                        message: Message::Assistant(accumulator.message(model)),
                    })
                    .await
                    .map_err(|error| {
                        accumulator.failure(model, ModelError::new("event_sink", error.to_string()))
                    })?;
            }
            if !delta.is_empty()
                || matches!(
                    value.get("type").and_then(Value::as_str),
                    Some(
                        "response.output_item.added"
                            | "response.function_call_arguments.delta"
                            | "response.output_item.done"
                    )
                )
            {
                events
                    .emit(AgentEvent::MessageUpdate {
                        message: accumulator.message(model),
                        delta,
                        assistant_message_event: Some(value),
                    })
                    .await
                    .map_err(|error| {
                        accumulator.failure(model, ModelError::new("event_sink", error.to_string()))
                    })?;
            }
        }
        if eof {
            break;
        }
    }
    if !accumulator.stream.started {
        return Err(accumulator.failure(
            model,
            ModelError {
                code: "provider_stream_empty".to_owned(),
                message: "Responses API stream ended without a response".to_owned(),
                retryable: true,
            },
        ));
    }
    if !done_seen && !accumulator.completed {
        return Err(accumulator.failure(
            model,
            ModelError {
                code: "provider_stream_incomplete".to_owned(),
                message: "Responses API stream ended before response.completed".to_owned(),
                retryable: true,
            },
        ));
    }
    let final_delta = accumulator.stream.finish_text_prefix();
    if !final_delta.is_empty() {
        events
            .emit(AgentEvent::MessageUpdate {
                message: accumulator.message(model),
                delta: final_delta,
                assistant_message_event: None,
            })
            .await
            .map_err(|error| {
                accumulator.failure(model, ModelError::new("event_sink", error.to_string()))
            })?;
    }
    Ok(ModelOutput {
        message: accumulator.message(model),
        message_started: true,
    })
}

pub(super) async fn parse_chat_stream(
    model: &ModelSpec,
    response: reqwest::Response,
    events: EventEmitter,
    cancellation: CancellationToken,
    speaker_names: &[String],
) -> Result<ModelOutput, StreamFailure> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut accumulator = StreamAccumulator::with_speaker_names(speaker_names);
    let mut completion_seen = false;
    'stream: loop {
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Err(accumulator.failure(model, ModelError::new("cancelled", "model request cancelled"))),
            chunk = stream.next() => chunk,
        };
        let eof = chunk.is_none();
        if let Some(chunk) = chunk {
            let chunk = chunk.map_err(|error| {
                accumulator.failure(
                    model,
                    ModelError {
                        code: "provider_stream".to_owned(),
                        message: format!("model stream interrupted: {error}"),
                        retryable: true,
                    },
                )
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
        } else if !buffer.is_empty() {
            buffer.push('\n');
        }
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim_end_matches('\r').to_owned();
            buffer.drain(..=newline);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                completion_seen = true;
                break 'stream;
            }
            if data.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(data).map_err(|error| {
                accumulator.failure(
                    model,
                    ModelError {
                        code: "provider_stream_json".to_owned(),
                        message: format!("invalid model stream chunk: {error}"),
                        retryable: true,
                    },
                )
            })?;
            let delta = accumulator.apply_chunk(&value);
            if !accumulator.started {
                accumulator.started = true;
                events
                    .emit(AgentEvent::MessageStart {
                        message: Message::Assistant(accumulator.message(model)),
                    })
                    .await
                    .map_err(|error| {
                        accumulator.failure(model, ModelError::new("event_sink", error.to_string()))
                    })?;
            }
            if !delta.is_empty() || value["choices"][0]["delta"].get("tool_calls").is_some() {
                events
                    .emit(AgentEvent::MessageUpdate {
                        message: accumulator.message(model),
                        delta,
                        assistant_message_event: Some(value),
                    })
                    .await
                    .map_err(|error| {
                        accumulator.failure(model, ModelError::new("event_sink", error.to_string()))
                    })?;
            }
        }
        if eof {
            break;
        }
    }
    if !accumulator.started {
        return Err(accumulator.failure(
            model,
            ModelError {
                code: "provider_stream_empty".to_owned(),
                message: "model stream ended without a response".to_owned(),
                retryable: true,
            },
        ));
    }
    if !completion_seen && accumulator.finish_reason.is_none() {
        return Err(accumulator.failure(
            model,
            ModelError {
                code: "provider_stream_incomplete".to_owned(),
                message: "model stream ended before a completion marker".to_owned(),
                retryable: true,
            },
        ));
    }
    let final_delta = accumulator.finish_text_prefix();
    if !final_delta.is_empty() {
        events
            .emit(AgentEvent::MessageUpdate {
                message: accumulator.message(model),
                delta: final_delta,
                assistant_message_event: None,
            })
            .await
            .map_err(|error| {
                accumulator.failure(model, ModelError::new("event_sink", error.to_string()))
            })?;
    }
    Ok(ModelOutput {
        message: accumulator.message(model),
        message_started: true,
    })
}

#[cfg(test)]
pub(super) fn parse_chat_response(
    model: &ModelSpec,
    value: Value,
) -> Result<AssistantMessage, ModelError> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| ModelError::new("provider_response", "response contains no choices"))?;
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| ModelError::new("provider_response", "choice contains no message"))?;
    let mut content = Vec::new();
    for key in ["reasoning_content", "reasoning", "reasoning_text"] {
        if let Some(reasoning) = message.get(key).and_then(Value::as_str)
            && !reasoning.is_empty()
        {
            let mut extra = Map::new();
            extra.insert(
                "thinkingSignature".to_owned(),
                Value::String(key.to_owned()),
            );
            content.push(ContentBlock::Thinking {
                thinking: reasoning.to_owned(),
                extra,
            });
            break;
        }
    }
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        content.push(ContentBlock::Text {
            text: text.to_owned(),
        });
    }
    for call in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let function = call.get("function").and_then(Value::as_object);
        let raw_arguments = function
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        content.push(ContentBlock::ToolCall {
            id: call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown_call")
                .to_owned(),
            name: function
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("unknown_tool")
                .to_owned(),
            arguments: serde_json::from_str(raw_arguments)
                .unwrap_or_else(|_| json!({"raw": raw_arguments})),
            provider_item_id: None,
        });
    }
    if content.is_empty() {
        content.push(ContentBlock::Text {
            text: String::new(),
        });
    }
    Ok(AssistantMessage {
        content,
        api: if model.api.is_empty() {
            "openai-completions".to_owned()
        } else {
            model.api.clone()
        },
        provider: model.provider.clone(),
        model: model.id.clone(),
        usage: value.get("usage").map(normalized_openai_usage),
        stop_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("stop")
            .to_owned(),
        error_message: None,
        timestamp: eden_agent_core::now_ms(),
        extra: Map::new(),
    })
}
