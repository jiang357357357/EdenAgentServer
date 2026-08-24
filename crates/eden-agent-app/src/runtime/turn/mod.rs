mod execute;
mod finish;
mod prepare;

use self::execute::{ExecutionRequest, execute_director_plan};
use super::{RuntimeError, RuntimeInner};
use crate::{prompt, self_awake};
use eden_agent_core::{AgentError, LoopControl};
use eden_agent_store::InputRecord;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) type SelfAwakeState = (
    eden_agent_store::JobRecord,
    eden_agent_store::SelfAwakeRunRecord,
    self_awake::SelfAwakeRequest,
);

pub(in crate::runtime) async fn process_input(
    inner: Arc<RuntimeInner>,
    input: InputRecord,
    cancellation: CancellationToken,
    control: LoopControl,
) -> Result<(), RuntimeError> {
    let prepare::PrepareOutcome::Ready(prepared) =
        prepare::prepare_turn(&inner, &input, &cancellation).await?
    else {
        return Ok(());
    };
    let prepare::PreparedTurn {
        active_model_spec,
        session_participants,
        session_environment,
        session_events,
        runtime_participants,
        input_text,
        internal_handoff,
        prompt_profile,
        self_awake_state,
        effective_text,
        context,
        prompt,
        plan,
        directed,
    } = *prepared;
    let execution = execute_director_plan(ExecutionRequest {
        inner: &inner,
        input: &input,
        base_context: context,
        user_prompt: prompt,
        participants: &runtime_participants,
        session_events: &session_events,
        plan: &plan,
        user_text: &effective_text,
        session_environment: &session_environment,
        prompt_profile,
        model_spec: &active_model_spec,
        directed,
        cancellation: cancellation.clone(),
        control,
    });
    let run_result = if prompt_profile == prompt::PromptProfile::SelfAwake {
        let timeout_seconds = std::env::var("EDEN_AGENT_SELF_AWAKE_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(180)
            .clamp(10, 900);
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds), execution).await
        {
            Ok(result) => result,
            Err(_) => {
                cancellation.cancel();
                Err(
                    AgentError::Hook(format!("self-awake hard timeout after {timeout_seconds}s"))
                        .into(),
                )
            }
        }
    } else {
        execution.await
    };

    finish::finish_turn(
        finish::FinishContext {
            inner,
            input,
            cancellation,
            plan,
            directed,
            prompt_profile,
            internal_handoff,
            input_text,
            session_participants,
            self_awake_state,
            active_model_spec,
        },
        run_result,
    )
    .await
}
