use super::*;

pub(crate) async fn execute_conversation_rpc(
    state: &AppState,
    runtime_origin: RuntimeOrigin,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "session.create" => {
            let params: SessionCreateParams = parse_params(params)?;
            let environment = params
                .environment
                .map(serde_json::to_value)
                .transpose()
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?
                .unwrap_or_else(|| json!({}));
            let session = state
                .store
                .create_session_with_runtime_origin(
                    params.title.trim(),
                    params
                        .participants
                        .into_iter()
                        .map(|participant| serde_json::to_value(participant).unwrap_or(Value::Null))
                        .collect(),
                    environment,
                    store_origin(runtime_origin),
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.list" => {
            let params: SessionListParams = parse_params(params)?;
            let mut sessions = state
                .store
                .list_sessions_for_runtime_origin(
                    store_origin(runtime_origin),
                    params.include_closed,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            sessions.truncate(params.limit.clamp(1, 500) as usize);
            serde_json::to_value(
                sessions
                    .into_iter()
                    .map(session_summary)
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.read" => {
            let params: SessionReadParams = parse_params(params)?;
            let session = state
                .store
                .get_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.rename" => {
            let params: SessionTitleParams = parse_params(params)?;
            let session = state
                .store
                .set_session_title(params.session_id, &params.title, "user")
                .await
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            if runtime_origin == RuntimeOrigin::Mon {
                state
                    .core_sync
                    .enqueue_session_snapshot(params.session_id)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.set_participants" => {
            let params: SessionParticipantsParams = parse_params(params)?;
            let session_id = params.session_id;
            ensure_session_model_mutable(state, session_id).await?;
            let session = state
                .store
                .set_session_participants(
                    session_id,
                    params
                        .participants
                        .into_iter()
                        .map(|participant| serde_json::to_value(participant).unwrap_or(Value::Null))
                        .collect(),
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            state.models.remove_session(&session_id.to_string()).await;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.close" => {
            let params: SessionReadParams = parse_params(params)?;
            state
                .store
                .close_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if runtime_origin == RuntimeOrigin::Mon {
                state
                    .core_sync
                    .enqueue_session_snapshot(params.session_id)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            state
                .models
                .remove_session(&params.session_id.to_string())
                .await;
            Ok(json!({"sessionId": params.session_id, "closed": true}))
        }
        "session.delete" => {
            let params: SessionReadParams = parse_params(params)?;
            let restore_active = state
                .store
                .begin_session_deletion(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if runtime_origin == RuntimeOrigin::Mon
                && let Err(error) = state
                    .core_sync
                    .delete_session_projection(params.session_id)
                    .await
            {
                if restore_active {
                    let _ = state
                        .store
                        .restore_session_after_failed_delete(params.session_id)
                        .await;
                }
                return Err(RpcFailure::application(error.to_string()));
            }
            state.runtime.forget_session(params.session_id).await;
            let deleted = match state.store.delete_session(params.session_id).await {
                Ok(deleted) => deleted,
                Err(error) => {
                    if restore_active {
                        let _ = state
                            .store
                            .restore_session_after_failed_delete(params.session_id)
                            .await;
                    }
                    if runtime_origin == RuntimeOrigin::Mon {
                        // The remote projection may already have been deleted. Re-enqueueing
                        // the restored local snapshot makes this compensating path convergent.
                        let _ = state
                            .core_sync
                            .enqueue_session_snapshot(params.session_id)
                            .await;
                    }
                    return Err(RpcFailure::application(error.to_string()));
                }
            };
            state
                .models
                .remove_session(&params.session_id.to_string())
                .await;
            state
                .host_services
                .unbind_session_core_credentials(&params.session_id.to_string())
                .await;
            Ok(json!({"sessionId":params.session_id,"deleted":deleted}))
        }
        "session.compact" => {
            let params: SessionCompactParams = parse_params(params)?;
            let enqueued = state
                .runtime
                .compact(params.session_id, params.instructions)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(TurnAccepted {
                session_id: params.session_id,
                turn_id: enqueued.input.turn_id,
                input_id: enqueued.input.id,
                state: "queued".to_owned(),
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "turn.start" => {
            let params: TurnStartParams = parse_params(params)?;
            if params.text.trim().is_empty() && params.attachments.is_empty() {
                return Err(RpcFailure::invalid_params(
                    "turn requires text or at least one attachment",
                ));
            }
            if let Some(environment) = params.environment {
                state
                    .store
                    .set_session_environment(
                        params.session_id,
                        serde_json::to_value(environment)
                            .map_err(|error| RpcFailure::invalid_params(error.to_string()))?,
                    )
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            let enqueued = state
                .runtime
                .submit_turn(
                    params.session_id,
                    params.text,
                    serde_json::to_value(params.attachments)
                        .map_err(|error| RpcFailure::application(error.to_string()))?,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(TurnAccepted {
                session_id: params.session_id,
                turn_id: enqueued.input.turn_id,
                input_id: enqueued.input.id,
                state: "queued".to_owned(),
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "turn.steer" | "turn.follow_up" => {
            let params: TurnQueueParams = parse_params(params)?;
            let text = params.text.trim();
            if text.is_empty() {
                return Err(RpcFailure::invalid_params("text is required"));
            }
            let update = if method == "turn.steer" {
                state
                    .runtime
                    .steer(params.session_id, text.to_owned())
                    .await
            } else {
                state
                    .runtime
                    .follow_up(params.session_id, text.to_owned())
                    .await
            }
            .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(TurnQueueResult {
                session_id: params.session_id,
                state: update.state.to_owned(),
                turn_id: update.input.as_ref().map(|input| input.input.turn_id),
                input_id: update.input.map(|input| input.input.id),
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "turn.cancel" => {
            let params: SessionReadParams = parse_params(params)?;
            state
                .runtime
                .cancel(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            Ok(json!({"sessionId": params.session_id, "cancellationRequested": true}))
        }
        "event.list" => {
            let params: EventListParams = parse_params(params)?;
            let page = state
                .store
                .list_event_page(params.session_id, params.after_seq, params.limit)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(EventPage {
                items: page
                    .items
                    .into_iter()
                    .map(session_event)
                    .collect::<Vec<_>>(),
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "message.list" => {
            let params: MessageListParams = parse_params(params)?;
            let page = state
                .store
                .list_message_event_page(params.session_id, params.before.as_deref(), params.limit)
                .await
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            serde_json::to_value(EventPage {
                items: page
                    .items
                    .into_iter()
                    .map(session_event)
                    .collect::<Vec<_>>(),
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "director.list" => {
            let params: DirectorListParams = parse_params(params)?;
            let events = state
                .store
                .list_director_events(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(project_director_runs(events))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        _ => Err(RpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
        }),
    }
}
