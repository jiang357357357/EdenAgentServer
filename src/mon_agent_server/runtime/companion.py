from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from ..llm.sync import call_openai_compatible
from .config import RuntimeModelConfig


@dataclass(frozen=True)
class DirectorTurn:
    assistant_id: int | str
    intent: str


@dataclass(frozen=True)
class DirectorPlan:
    turns: tuple[DirectorTurn, ...]
    source: str


def _collective_request(text: str) -> bool:
    normalized = text.lower()
    return any(token in normalized for token in ("你们", "大家", "一起", "都说", "分别", "each of you", "both"))


def _mentioned_participants(text: str, participants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        participant
        for participant in participants
        if any(
            name and str(name).lower() in text.lower()
            for name in (participant.get("assistantName"), participant.get("characterName"))
        )
    ]


def _fallback_plan(
    user_text: str,
    participants: list[dict[str, Any]],
    max_speakers: int,
) -> DirectorPlan:
    mentioned = _mentioned_participants(user_text, participants)
    if mentioned:
        selected = mentioned[:max_speakers]
    elif _collective_request(user_text):
        selected = participants[:max_speakers]
    else:
        selected = participants[:1]
    return DirectorPlan(
        tuple(
            DirectorTurn(
                participant["assistantID"],
                "直接回应用户" if index == 0 else "结合前一位伙伴的回答自然补充，不重复内容",
            )
            for index, participant in enumerate(selected)
        ),
        "policy",
    )


def _json_object(text: str) -> dict[str, Any] | None:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


async def create_director_plan(
    *,
    user_text: str,
    participants: list[dict[str, Any]],
    director_config: RuntimeModelConfig,
    policy: dict[str, Any] | None = None,
) -> DirectorPlan:
    if not participants:
        raise RuntimeError("当前会话没有参与助手。")
    policy = policy or {}
    max_speakers = max(1, min(int(policy.get("maxSpeakersPerTurn") or 2), len(participants), 4))
    fallback = _fallback_plan(user_text, participants, max_speakers)
    if len(participants) == 1 or _mentioned_participants(user_text, participants) or _collective_request(user_text):
        return fallback
    roster = [
        {
            "assistantID": participant.get("assistantID"),
            "name": participant.get("assistantName") or participant.get("characterName"),
            "signature": participant.get("signature") or "",
        }
        for participant in participants
    ]
    system_prompt = (
        "你是多人陪伴会话的导演，只决定由谁发言，不直接回答用户，也不要输出思维过程。"
        f"每轮选择 1 到 {max_speakers} 位，避免无意义的全员重复。"
        "只输出 JSON：{\"turns\":[{\"assistantID\":数字或字符串,\"intent\":\"简短发言意图\"}]}。"
    )
    prompt = json.dumps({"participants": roster, "userMessage": user_text}, ensure_ascii=False)
    try:
        response = await asyncio.to_thread(
            call_openai_compatible,
            director_config.model,
            {
                "systemPrompt": system_prompt,
                "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            },
            {"apiKey": director_config.api_key, "maxTokens": 240},
        )
        content = (((response.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        parsed = _json_object(str(content))
        allowed = {str(participant.get("assistantID")): participant.get("assistantID") for participant in participants}
        turns: list[DirectorTurn] = []
        for item in (parsed or {}).get("turns", []):
            if not isinstance(item, dict):
                continue
            assistant_id = allowed.get(str(item.get("assistantID")))
            if assistant_id is None or any(str(turn.assistant_id) == str(assistant_id) for turn in turns):
                continue
            turns.append(DirectorTurn(assistant_id, str(item.get("intent") or "回应用户")[:160]))
            if len(turns) >= max_speakers:
                break
        if turns:
            return DirectorPlan(tuple(turns), "model")
    except Exception:
        pass
    return fallback


def actor_task_prompt(
    user_text: str,
    intent: str,
    previous_replies: list[tuple[str, str]],
    attachment_details: str = "",
) -> str:
    companion_context = "\n".join(f"{name}：{reply}" for name, reply in previous_replies if reply.strip())
    sections = [
        "你正在参与一个多人陪伴会话。请保持自己的角色身份，自然地直接对用户发言。",
        f"本轮导演意图：{intent}",
        f"用户消息：\n{user_text}",
    ]
    if companion_context:
        sections.append(f"本轮其他伙伴已经说过：\n{companion_context}\n请承接或补充，不要复述同样内容。")
    if attachment_details:
        sections.append(attachment_details)
    return "\n\n".join(sections)
