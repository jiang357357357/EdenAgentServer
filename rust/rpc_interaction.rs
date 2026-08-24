use super::*;

pub(crate) async fn execute_interaction_rpc(
    state: &AppState,
    runtime_origin: RuntimeOrigin,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "permission.list" => {
            let params: PermissionListParams = parse_params(params)?;
            let records = state
                .approvals
                .list_pending(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut permissions = Vec::new();
            for record in records {
                if session_is_visible(state, runtime_origin, record.session_id).await {
                    permissions.push(permission_info(record));
                }
            }
            serde_json::to_value(permissions)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "permission.mode.get" => Ok(json!({"mode":state.approvals.mode().as_str()})),
        "permission.mode.set" => {
            let mode = params
                .get("mode")
                .and_then(Value::as_str)
                .and_then(SandboxPermissionMode::parse)
                .ok_or_else(|| {
                    RpcFailure::invalid_params("mode must be restricted, full_access, or takeover")
                })?;
            state
                .approvals
                .set_mode(mode)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            Ok(json!({"mode":mode.as_str()}))
        }
        "permission.resolve" => {
            let params: PermissionResolveParams = parse_params(params)?;
            let record = state
                .approvals
                .list_pending(None)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .find(|permission| permission.id == params.request_id);
            let Some(record) = record else {
                return Err(RpcFailure::application("permission is not pending"));
            };
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: permission is not available in this runtime",
                ));
            }
            let decision = match params.decision {
                PermissionDecision::Once => ApprovalDecision::Once,
                PermissionDecision::Always => ApprovalDecision::Always,
                PermissionDecision::Deny => ApprovalDecision::Deny,
            };
            let permission = state
                .approvals
                .resolve(params.request_id, decision, params.message)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(permission_info(permission))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "operation.list" => {
            let params: OperationListParams = parse_params(params)?;
            let records = state
                .store
                .list_operations(params.session_id, params.state.as_deref(), params.limit)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut operations = Vec::new();
            for record in records {
                if session_is_visible(state, runtime_origin, record.session_id).await {
                    operations.push(operation_info(record));
                }
            }
            serde_json::to_value(operations)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "operation.resolve" => {
            let params: OperationResolveParams = parse_params(params)?;
            let record = state
                .store
                .list_operations(None, Some("unknown"), 500)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .find(|operation| operation.operation_id == params.operation_id);
            let Some(record) = record else {
                return Err(RpcFailure::application("operation is not unresolved"));
            };
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: operation is not available in this runtime",
                ));
            }
            let operation = state
                .store
                .resolve_unknown_operation(
                    params.operation_id,
                    match params.decision {
                        OperationDecision::Retry => "retry",
                        OperationDecision::Abandon => "abandon",
                    },
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(operation_info(operation))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "question.list" => {
            let params: QuestionListParams = parse_params(params)?;
            let records = state
                .questions
                .list_pending(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut questions = Vec::new();
            for record in records {
                if session_is_visible(state, runtime_origin, record.session_id).await {
                    questions.push(question_info(record)?);
                }
            }
            serde_json::to_value(questions)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "question.resolve" => {
            let params: QuestionResolveParams = parse_params(params)?;
            let records = state
                .questions
                .list_pending(None)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let Some(record) = records
                .into_iter()
                .find(|question| question.id == params.request_id)
            else {
                return Err(RpcFailure::application("question is not pending"));
            };
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: question is not available in this runtime",
                ));
            }
            let question = state
                .questions
                .resolve(params.request_id, params.answers)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(question_info(question)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "question.reject" => {
            let params: QuestionRejectParams = parse_params(params)?;
            let records = state
                .questions
                .list_pending(None)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let Some(record) = records
                .into_iter()
                .find(|question| question.id == params.request_id)
            else {
                return Err(RpcFailure::application("question is not pending"));
            };
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: question is not available in this runtime",
                ));
            }
            let question = state
                .questions
                .reject(params.request_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(question_info(question)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "media.list" => {
            let params: MediaListParams = parse_params(params)?;
            let records = state
                .media
                .list_pending(params.kind.as_deref())
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut visible = Vec::new();
            for record in records {
                if session_is_visible(state, runtime_origin, record.session_id).await {
                    visible.push(media_info(record));
                }
            }
            serde_json::to_value(visible)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "media.resolve" => {
            let params: MediaResolveParams = parse_params(params)?;
            let id = Uuid::parse_str(&params.id)
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            let visible = state
                .media
                .list_pending(None)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .find(|record| record.id == id);
            let Some(record) = visible else {
                return Err(RpcFailure::application("media request is not pending"));
            };
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: media request is not available in this runtime",
                ));
            }
            let record = state
                .media
                .resolve(id, params.result, params.error)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(media_info(record))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        _ => Err(RpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
        }),
    }
}
