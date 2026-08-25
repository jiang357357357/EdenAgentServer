use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct RealtimeSttQuery {
    session_id: SessionId,
}

pub(crate) async fn realtime_stt_upgrade(
    State(state): State<AppState>,
    Query(query): Query<RealtimeSttQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&state, &headers) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    if !token_matches(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            "missing or invalid capability token",
        )
            .into_response();
    }
    let session = match state.store.get_session(query.session_id).await {
        Ok(session) => session,
        Err(error) => return (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    if session_origin(&session) != state.runtime_origin {
        return (
            StatusCode::FORBIDDEN,
            "runtime_origin_mismatch: session is not available in this runtime",
        )
            .into_response();
    }
    match state.runtime_origin {
        RuntimeOrigin::Local => {
            let persisted = match read_voice_runtime_config(&state).await {
                Ok(config) => config.stt,
                Err(error) => {
                    return (StatusCode::SERVICE_UNAVAILABLE, error.message).into_response();
                }
            };
            let config = match LocalGsvSttConfig::from_config(&persisted) {
                Ok(config) => config,
                Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
            };
            return upgrade
                .max_message_size(2 * 1024 * 1024)
                .protocols([WEBSOCKET_PROTOCOL])
                .on_upgrade(move |socket| local_realtime_stt(socket, config))
                .into_response();
        }
        RuntimeOrigin::Mon => {}
    }
    let upstream_url = match state
        .host_services
        .realtime_stt_url(&query.session_id.to_string())
        .await
    {
        Ok(url) => url,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    upgrade
        .max_message_size(2 * 1024 * 1024)
        .protocols([WEBSOCKET_PROTOCOL])
        .on_upgrade(move |socket| proxy_realtime_stt(socket, upstream_url))
        .into_response()
}

pub(crate) const MAX_LOCAL_STT_AUDIO_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn pcm16_wav(audio: &[u8]) -> Result<Vec<u8>, String> {
    let data_size = u32::try_from(audio.len()).map_err(|_| "录音过长，无法生成 WAV".to_owned())?;
    let riff_size = 36_u32
        .checked_add(data_size)
        .ok_or_else(|| "录音过长，无法生成 WAV".to_owned())?;
    let mut wav = Vec::with_capacity(44 + audio.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_size.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&16_000_u32.to_le_bytes());
    wav.extend_from_slice(&32_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(audio);
    Ok(wav)
}

pub(crate) async fn connect_local_gsv_stt(
    config: &LocalGsvSttConfig,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let upstream_url = config.upstream_url()?;
    let attempts = config.retry_count.saturating_add(1);
    let mut last_error = "未知错误".to_owned();
    for attempt in 0..attempts {
        match tokio::time::timeout(Duration::from_millis(1_250), connect_async(&upstream_url)).await
        {
            Ok(Ok((socket, _))) => return Ok(socket),
            Ok(Err(error)) => last_error = error.to_string(),
            Err(_) => last_error = "连接超时".to_owned(),
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt + 1))).await;
        }
    }
    Err(format!("无法连接 GSV 实时转录服务：{last_error}"))
}

pub(crate) async fn transcribe_local_gsv_audio(
    config: &LocalGsvSttConfig,
    pcm_audio: &[u8],
) -> Result<String, String> {
    if pcm_audio.is_empty() {
        return Ok(String::new());
    }
    let wav = pcm16_wav(pcm_audio)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(config.timeout)
        .build()
        .map_err(|error| format!("初始化 GSV 转录客户端失败：{error}"))?;
    let endpoint = format!("{}/inference/transcribe", config.service_url);
    let attempts = config.retry_count.saturating_add(1);
    let mut last_error = "未知错误".to_owned();
    for attempt in 0..attempts {
        let audio_part = reqwest::multipart::Part::bytes(wav.clone())
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|error| format!("构造 GSV 转录音频失败：{error}"))?;
        let form = reqwest::multipart::Form::new()
            .text("language", config.language.clone())
            .text("model_type", config.model_type.clone())
            .text("model_size", config.model_size.clone())
            .text("precision", config.precision.clone())
            .part("audio_file", audio_part);
        match client.post(&endpoint).multipart(form).send().await {
            Ok(response) => {
                let status = response.status();
                match response.json::<Value>().await {
                    Ok(payload) if status.is_success() => {
                        if payload.get("success").and_then(Value::as_bool) == Some(false) {
                            return Err(payload
                                .get("detail")
                                .or_else(|| payload.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("GSV 转录失败")
                                .to_owned());
                        }
                        return Ok(payload
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim()
                            .to_owned());
                    }
                    Ok(payload) => {
                        last_error = format!(
                            "HTTP {status}: {}",
                            payload
                                .get("detail")
                                .or_else(|| payload.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("未知错误")
                        );
                        if !status.is_server_error() {
                            break;
                        }
                    }
                    Err(error) => {
                        last_error = format!("HTTP {status} 返回了无效数据：{error}");
                        if !status.is_server_error() {
                            break;
                        }
                    }
                }
            }
            Err(error) => last_error = error.to_string(),
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt + 1))).await;
        }
    }
    Err(format!("GSV 完整音频转录失败：{last_error}"))
}

pub(crate) async fn local_realtime_stt(socket: WebSocket, config: LocalGsvSttConfig) {
    let (mut client_sender, mut client_receiver) = socket.split();
    let connection = json!({
        "type": "connection",
        "status": "connected",
        "message": "Eden Agent 本地 GSV 实时 STT 已就绪",
    });
    if client_sender
        .send(Message::Text(connection.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let start_payload = loop {
        let Some(Ok(message)) = client_receiver.next().await else {
            return;
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<Value>(&text) else {
            let error = json!({"type": "error", "message": "WebSocket 消息必须是 JSON"});
            let _ = client_sender
                .send(Message::Text(error.to_string().into()))
                .await;
            continue;
        };
        if payload.get("command").and_then(Value::as_str) == Some("start") {
            break payload;
        }
        let error = json!({"type": "error", "message": "请先发送 start 命令"});
        let _ = client_sender
            .send(Message::Text(error.to_string().into()))
            .await;
    };

    let upstream = match connect_local_gsv_stt(&config).await {
        Ok(socket) => socket,
        Err(message) => {
            let error = json!({"type": "error", "message": message});
            let _ = client_sender
                .send(Message::Text(error.to_string().into()))
                .await;
            return;
        }
    };
    let (mut upstream_sender, mut upstream_receiver) = upstream.split();
    let requested_end_silence = start_payload
        .get("end_silence_ms")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .map(|value| value.clamp(300, 5000))
        .unwrap_or(config.end_silence_ms);
    let upstream_start = json!({
        "command": "start",
        "language": config.language,
        "model_type": config.model_type,
        "model_size": config.model_size,
        "precision": config.precision,
        "end_silence_ms": requested_end_silence,
        "vad": {
            "chunk_ms": config.chunk_ms,
            "min_speech_duration_ms": config.min_speech_duration_ms,
            "preroll_ms": config.preroll_ms,
            "speech_noise_threshold": config.speech_noise_threshold,
        },
    });
    if upstream_sender
        .send(UpstreamMessage::Text(upstream_start.to_string().into()))
        .await
        .is_err()
    {
        let error = json!({"type": "error", "message": "GSV 实时转录启动失败"});
        let _ = client_sender
            .send(Message::Text(error.to_string().into()))
            .await;
        return;
    }
    let started = json!({
        "type": "status",
        "status": "started",
        "message": "GSV 实时转录已启动",
        "config_id": 0,
        "realtime_vad": {
            "end_silence_ms": requested_end_silence,
            "chunk_ms": config.chunk_ms,
            "min_speech_duration_ms": config.min_speech_duration_ms,
            "preroll_ms": config.preroll_ms,
            "speech_noise_threshold": config.speech_noise_threshold,
        },
        "input_behavior": {
            "session_end_silence_ms": config.session_end_silence_ms,
            "auto_finish": config.auto_finish,
            "auto_send": config.auto_send,
        },
    });
    if client_sender
        .send(Message::Text(started.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let mut audio = Vec::new();
    let mut stopped = false;
    loop {
        tokio::select! {
            client = client_receiver.next() => {
                let Some(Ok(message)) = client else { break };
                match message {
                    Message::Binary(bytes) => {
                        if audio.len().saturating_add(bytes.len()) > MAX_LOCAL_STT_AUDIO_BYTES {
                            let error = json!({"type": "error", "message": "录音超过本地转录大小限制"});
                            let _ = client_sender.send(Message::Text(error.to_string().into())).await;
                            break;
                        }
                        audio.extend_from_slice(&bytes);
                        if upstream_sender.send(UpstreamMessage::Binary(bytes.to_vec().into())).await.is_err() {
                            let error = json!({"type": "error", "message": "GSV 实时转录连接已关闭"});
                            let _ = client_sender.send(Message::Text(error.to_string().into())).await;
                            break;
                        }
                    }
                    Message::Text(text) => {
                        let command = serde_json::from_str::<Value>(&text).ok()
                            .and_then(|payload| payload.get("command").and_then(Value::as_str).map(str::to_owned));
                        if command.as_deref() == Some("stop") {
                            let _ = upstream_sender.send(UpstreamMessage::Text(json!({"command": "stop"}).to_string().into())).await;
                            stopped = true;
                            break;
                        }
                    }
                    Message::Ping(bytes) => { let _ = upstream_sender.send(UpstreamMessage::Ping(bytes.to_vec().into())).await; }
                    Message::Pong(bytes) => { let _ = upstream_sender.send(UpstreamMessage::Pong(bytes.to_vec().into())).await; }
                    Message::Close(_) => break,
                }
            }
            upstream = upstream_receiver.next() => {
                let Some(Ok(message)) = upstream else {
                    let error = json!({"type": "error", "message": "GSV 实时转录连接已关闭"});
                    let _ = client_sender.send(Message::Text(error.to_string().into())).await;
                    break;
                };
                let outgoing = match message {
                    UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                    UpstreamMessage::Binary(bytes) => Message::Binary(bytes.to_vec().into()),
                    UpstreamMessage::Ping(bytes) => Message::Ping(bytes.to_vec().into()),
                    UpstreamMessage::Pong(bytes) => Message::Pong(bytes.to_vec().into()),
                    UpstreamMessage::Close(_) => break,
                    UpstreamMessage::Frame(_) => continue,
                };
                if client_sender.send(outgoing).await.is_err() { break; }
            }
        }
    }
    let _ = upstream_sender.close().await;
    if stopped {
        match transcribe_local_gsv_audio(&config, &audio).await {
            Ok(final_text) => {
                let result = json!({
                    "type": "final_result",
                    "status": "stopped",
                    "final_text": final_text,
                    "source": "offline-complete-audio",
                });
                let _ = client_sender
                    .send(Message::Text(result.to_string().into()))
                    .await;
            }
            Err(message) => {
                let error = json!({"type": "error", "message": message});
                let _ = client_sender
                    .send(Message::Text(error.to_string().into()))
                    .await;
            }
        }
    }
    let _ = client_sender.close().await;
}

pub(crate) async fn proxy_realtime_stt(socket: WebSocket, upstream_url: String) {
    let (upstream, _) = match connect_async(&upstream_url).await {
        Ok(connected) => connected,
        Err(error) => {
            let (mut sender, _) = socket.split();
            let payload = json!({
                "type": "error",
                "message": format!("Mon Core realtime STT connection failed: {error}"),
            });
            let _ = sender.send(Message::Text(payload.to_string().into())).await;
            return;
        }
    };
    let (mut client_sender, mut client_receiver) = socket.split();
    let (mut upstream_sender, mut upstream_receiver) = upstream.split();

    loop {
        tokio::select! {
            client = client_receiver.next() => {
                let Some(Ok(message)) = client else { break };
                let message = match message {
                    Message::Text(text) => UpstreamMessage::Text(text.to_string().into()),
                    Message::Binary(bytes) => UpstreamMessage::Binary(bytes.to_vec().into()),
                    Message::Ping(bytes) => UpstreamMessage::Ping(bytes.to_vec().into()),
                    Message::Pong(bytes) => UpstreamMessage::Pong(bytes.to_vec().into()),
                    Message::Close(_) => break,
                };
                if upstream_sender.send(message).await.is_err() { break; }
            }
            upstream = upstream_receiver.next() => {
                let Some(Ok(message)) = upstream else { break };
                let message = match message {
                    UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                    UpstreamMessage::Binary(bytes) => Message::Binary(bytes.to_vec().into()),
                    UpstreamMessage::Ping(bytes) => Message::Ping(bytes.to_vec().into()),
                    UpstreamMessage::Pong(bytes) => Message::Pong(bytes.to_vec().into()),
                    UpstreamMessage::Close(_) => break,
                    UpstreamMessage::Frame(_) => continue,
                };
                if client_sender.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = upstream_sender.close().await;
    let _ = client_sender.close().await;
}

pub(crate) async fn cache_core_audio(
    state: &AppState,
    session_id: &str,
    source: &str,
) -> Result<eden_agent_core::BlobId, RpcFailure> {
    let (mime, bytes) = state
        .host_services
        .fetch_core_audio(session_id, source)
        .await
        .map_err(RpcFailure::application)?;
    state
        .blobs
        .put(mime, &bytes)
        .await
        .map(|record| record.id)
        .map_err(|error| RpcFailure::application(error.to_string()))
}
