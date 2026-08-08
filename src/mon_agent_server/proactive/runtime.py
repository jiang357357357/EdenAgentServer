from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..app import AppState


def start_connector_turn(
    app: AppState,
    token: str,
    *,
    session_id: str,
    assistant_id: int | str,
    operation_id: str,
    connector_event_id: int | str,
    event: dict[str, Any],
) -> None:
    restored = app.core_client.get_agent_session(token, session_id)
    session = restored["info"]
    participant_ids = list(session.get("participantAssistantIDs") or [])
    if not any(str(item) == str(assistant_id) for item in participant_ids):
        participant_ids.append(assistant_id)
        app.core_client.update_agent_session_participants(token, session, participant_ids)
    # Always rehydrate: Core may contain messages created by another client or
    # an earlier proactive turn after this process first opened the session.
    app.hydrate(token, session_id)
    app.hydrate_permission_mode(token, session_id)
    prompt = "\n\n".join([
        "这是外部连接器触发的主动回合，不是用户发送的新消息。",
        "你正在绑定的真实聊天会话中继续行动；结合会话历史理解用户要求和关系语境，外部事实以本事件及领取到的最新事件为准。",
        "保持最近可见对话的连续性：若用户正在讨论这盘棋、提出指导方式或约定互动规则，就把本次局面和走棋自然接在该话题下，不要另起一段泛化的后台状态汇报。",
        "调用 claim_connector_events 领取事件，执行必要动作；成功后调用 finish_connector_events，失败则 retry=true。不得只用文字声称已经执行。",
        "处理完成后，以你自己的身份简洁说明实际发生的事情；不要输出自醒 JSON，也不要把内部任务说明复述给用户。",
        "当前触发事件：",
        json.dumps(event, ensure_ascii=False, indent=2),
    ])
    app.runtime.proactive_prompt_async(
        session_id,
        [{"type": "text", "text": prompt}],
        token,
        assistant_id=assistant_id,
        operation_id=operation_id,
        connector_event_id=connector_event_id,
    )
