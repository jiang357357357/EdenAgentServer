use super::*;

pub(crate) async fn execute_voice_rpc(
    state: &AppState,
    runtime_origin: RuntimeOrigin,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "voice.config.read" => serde_json::to_value(read_voice_runtime_config(state).await?)
            .map_err(|error| RpcFailure::application(error.to_string())),
        "voice.tts.config.update" => {
            let config = normalize_gsv_tts_config(parse_params(params)?)?;
            require_gsv_tts_selection(&config)?;
            state
                .store
                .set_config(
                    GSV_TTS_CONFIG_KEY,
                    serde_json::to_value(config)
                        .map_err(|error| RpcFailure::application(error.to_string()))?,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(read_voice_runtime_config(state).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.stt.config.update" => {
            let config = normalize_gsv_stt_config(parse_params(params)?)?;
            state
                .store
                .set_config(
                    GSV_STT_CONFIG_KEY,
                    serde_json::to_value(config)
                        .map_err(|error| RpcFailure::application(error.to_string()))?,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(read_voice_runtime_config(state).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.gsv.discover" => {
            let params: GsvDiscoveryParams = parse_params(params)?;
            serde_json::to_value(discover_gsv(params).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.gsv.preview" => {
            let params: GsvPreviewParams = parse_params(params)?;
            let config = normalize_gsv_tts_config(params.config)?;
            require_gsv_tts_selection(&config)?;
            let text = params.text.trim();
            if text.is_empty() {
                return Err(RpcFailure::invalid_params("请输入试听文本"));
            }
            if text.chars().count() > 500 {
                return Err(RpcFailure::invalid_params("试听文本不能超过 500 个字符"));
            }
            let started = Instant::now();
            let audio = synthesize_gsv_audio(state, &config, text).await?;
            serde_json::to_value(GsvPreviewResult {
                ok: true,
                audio_blob_id: audio.blob_id,
                mime: audio.mime,
                duration_ms: audio.duration_ms,
                latency_ms: elapsed_millis(started),
                role_id: audio.role_id,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.stt.test" => {
            let params: GsvSttTestParams = parse_params(params)?;
            serde_json::to_value(test_gsv_stt(params.config).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.tts.synthesize" => {
            let params: VoiceTtsSynthesizeParams = parse_params(params)?;
            if params.text.trim().is_empty() {
                return Err(RpcFailure::invalid_params("text is required"));
            }
            state
                .store
                .get_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if runtime_origin == RuntimeOrigin::Local {
                let mut response = synthesize_local_gsv(state, &params).await?;
                persist_synthesized_segment(state, &params, &mut response).await?;
                return serde_json::to_value(response)
                    .map_err(|error| RpcFailure::application(error.to_string()));
            }
            let session_id = params.session_id.to_string();
            let message_id = params.message_id.clone();
            state
                .core_sync
                .ensure_session_projection(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let response = state
                .host_services
                .synthesize_speech(
                    &session_id,
                    json!({
                        "external_session_id": session_id,
                        "external_message_id": params.message_id,
                        "segment_group_id": params.segment_group_id,
                        "group_index": params.group_index,
                        "sequence": params.sequence,
                        "text": params.text,
                        "config_id": params.config_id,
                        "mode": params.mode,
                    }),
                )
                .await
                .map_err(|error| {
                    warn!(
                        %error,
                        %session_id,
                        %message_id,
                        "Mon Core TTS synthesis request failed"
                    );
                    RpcFailure::application(error)
                })?;
            let mut response: VoiceTtsSynthesizeResult =
                serde_json::from_value(response).map_err(|error| {
                    RpcFailure::application(format!("invalid Mon Core TTS response: {error}"))
                })?;
            if let Some(source) = response.audio_url.as_deref() {
                response.audio_blob_id = Some(
                    cache_core_audio(state, &session_id, source)
                        .await
                        .inspect_err(|error| {
                            warn!(
                                error = %error.message,
                                %session_id,
                                %message_id,
                                "failed to cache Mon Core TTS audio"
                            );
                        })?,
                );
                response.audio_url = None;
            }
            persist_synthesized_segment(state, &params, &mut response).await?;
            serde_json::to_value(response)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.tts.list_segments" => {
            let params: VoiceSpeechSegmentListParams = parse_params(params)?;
            let session_id = params.session_id.to_string();
            let mut persisted = state
                .store
                .list_voice_speech_segments(params.session_id, params.message_id.as_deref())
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;

            if runtime_origin == RuntimeOrigin::Mon && persisted.is_empty() {
                match backfill_core_speech_segments(
                    state,
                    params.session_id,
                    &session_id,
                    params.message_id.as_deref(),
                )
                .await
                {
                    Ok(()) => {
                        persisted = state
                            .store
                            .list_voice_speech_segments(
                                params.session_id,
                                params.message_id.as_deref(),
                            )
                            .await
                            .map_err(|error| RpcFailure::application(error.to_string()))?;
                    }
                    Err(error) => warn!(
                        error = %error.message,
                        %session_id,
                        "Mon Core speech segment backfill unavailable; using Agent persistence"
                    ),
                }
            }

            serde_json::to_value(
                persisted
                    .into_iter()
                    .map(persisted_segment_info)
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        _ => Err(RpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
        }),
    }
}

async fn persist_synthesized_segment(
    state: &AppState,
    params: &VoiceTtsSynthesizeParams,
    response: &mut VoiceTtsSynthesizeResult,
) -> Result<(), RpcFailure> {
    if !response.success {
        return Ok(());
    }
    let Some(audio_blob_id) = response.audio_blob_id else {
        return Ok(());
    };
    let text = params.text.trim();
    state
        .store
        .upsert_voice_speech_segment(VoiceSpeechSegmentUpsert {
            session_id: params.session_id,
            external_message_id: params.message_id.clone(),
            external_audio_asset_id: None,
            audio_blob_id,
            duration_ms: response.duration_ms,
            audio_format: response
                .audio_format
                .clone()
                .unwrap_or_else(|| "wav".to_owned()),
            segment_group_id: params.segment_group_id.clone(),
            group_index: i64::from(params.group_index),
            sequence: i64::from(params.sequence),
            text_hash: speech_text_hash(text),
            text_length: i64::try_from(text.encode_utf16().count()).unwrap_or(i64::MAX),
        })
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    Ok(())
}

async fn backfill_core_speech_segments(
    state: &AppState,
    session_id: SessionId,
    external_session_id: &str,
    message_id: Option<&str>,
) -> Result<(), RpcFailure> {
    let response = state
        .host_services
        .list_speech_segments(external_session_id, message_id)
        .await
        .map_err(RpcFailure::application)?;
    let response: Vec<VoiceSpeechSegmentInfo> =
        serde_json::from_value(response).map_err(|error| {
            RpcFailure::application(format!("invalid Mon Core speech segment response: {error}"))
        })?;
    for segment in response {
        let audio_blob_id =
            cache_core_audio(state, external_session_id, &segment.audio_url).await?;
        state
            .store
            .upsert_voice_speech_segment(VoiceSpeechSegmentUpsert {
                session_id,
                external_message_id: segment.external_message_id,
                external_audio_asset_id: Some(segment.audio_asset_id),
                audio_blob_id,
                duration_ms: segment.duration_ms,
                audio_format: segment.audio_format,
                segment_group_id: segment.segment_group_id,
                group_index: i64::from(segment.group_index),
                sequence: i64::from(segment.sequence),
                text_hash: segment.text_hash,
                text_length: i64::from(segment.text_length),
            })
            .await
            .map_err(|error| RpcFailure::application(error.to_string()))?;
    }
    Ok(())
}

fn persisted_segment_info(segment: VoiceSpeechSegmentRecord) -> VoiceSpeechSegmentInfo {
    VoiceSpeechSegmentInfo {
        id: segment.id,
        external_message_id: segment.external_message_id,
        audio_asset_id: segment.external_audio_asset_id.unwrap_or(segment.id),
        audio_url: String::new(),
        audio_blob_id: Some(segment.audio_blob_id),
        duration_ms: segment.duration_ms,
        audio_format: segment.audio_format,
        segment_group_id: segment.segment_group_id,
        group_index: u32::try_from(segment.group_index).unwrap_or(u32::MAX),
        sequence: u32::try_from(segment.sequence).unwrap_or(u32::MAX),
        text_hash: segment.text_hash,
        text_length: u32::try_from(segment.text_length).unwrap_or(u32::MAX),
    }
}

pub(crate) fn speech_text_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
