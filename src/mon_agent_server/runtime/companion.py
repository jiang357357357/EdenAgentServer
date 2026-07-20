from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from ..ids import create_id
from ..llm.sync import call_openai_compatible
from ..logging import get_logger
from ..store.serializers import assistant_context_text
from .config import RuntimeModelConfig

logger = get_logger("MonAgent", "CompanionDirector")


@dataclass(frozen=True)
class DirectorBeat:
    assistant_id: int | str
    intent: str
    speech_act: str = "respond"
    address_to: str = "user"
    reply_to_beat: int | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "assistantID": self.assistant_id,
            "intent": self.intent,
            "speechAct": self.speech_act,
            "addressTo": self.address_to,
            "replyToBeat": self.reply_to_beat,
        }


@dataclass(frozen=True)
class DirectorScene:
    domain: str = "general"
    interaction_type: str = "conversation"
    confidence: float = 0.0
    summary: str = "当前对话"

    def to_payload(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "interactionType": self.interaction_type,
            "confidence": self.confidence,
            "summary": self.summary,
        }


@dataclass(frozen=True)
class DirectorExecution:
    mode: str = "solo"
    lead_assistant_id: int | str | None = None
    tool_owner_assistant_id: int | str | None = None
    observation_strategy: str = "on_demand"

    def to_payload(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "leadAssistantID": self.lead_assistant_id,
            "toolOwnerAssistantID": self.tool_owner_assistant_id,
            "observationStrategy": self.observation_strategy,
        }


@dataclass(frozen=True)
class DirectorPlan:
    plan_id: str
    beats: tuple[DirectorBeat, ...]
    source: str
    diagnostic: str | None = None
    scene: DirectorScene = DirectorScene()
    execution: DirectorExecution = DirectorExecution()


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
    source: str = "fallback",
) -> DirectorPlan:
    mentioned = _mentioned_participants(user_text, participants)
    participant = mentioned[0] if mentioned else participants[0]
    assistant_id = participant["assistantID"]
    return DirectorPlan(
        create_id("plan"),
        (DirectorBeat(assistant_id, "直接回应用户"),),
        source,
        scene=DirectorScene(),
        execution=DirectorExecution(lead_assistant_id=assistant_id),
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


def _normalize_address_to(value: Any, previous_assistant_id: int | str | None) -> str:
    raw = str(value or "").strip()
    if raw == "user" or raw.startswith("assistant:"):
        return raw
    if previous_assistant_id is not None:
        return f"assistant:{previous_assistant_id}"
    return "user"


async def create_director_plan(
    *,
    user_text: str,
    participants: list[dict[str, Any]],
    director_config: RuntimeModelConfig,
    policy: dict[str, Any] | None = None,
    conversation_context: str = "",
    attachment_context: str = "",
) -> DirectorPlan:
    if not participants:
        raise RuntimeError("当前会话没有参与助手。")
    policy = policy or {}
    max_beats_value = policy.get("maxBeatsPerTurn")
    max_beats = max(1, min(int(3 if max_beats_value is None else max_beats_value), 5))
    max_returns_value = policy.get("maxReturnsPerAssistant")
    max_returns = max(0, min(int(1 if max_returns_value is None else max_returns_value), 2))
    max_tokens_value = policy.get("directorMaxTokens")
    director_max_tokens = max(512, min(int(2000 if max_tokens_value is None else max_tokens_value), 8192))
    max_appearances = 1 + max_returns
    allow_inter_assistant_replies = policy.get("allowInterAssistantReplies") is not False
    fallback = _fallback_plan(user_text, participants, "single" if len(participants) == 1 else "fallback")
    if len(participants) == 1:
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
        "你是多人智能体会话的隐藏导演，负责判断场景、制定协作策略并编排发言节拍；不直接回答用户，也不要输出思维过程。"
        "先综合当前消息、最近公开对话和附件摘要判断场景，不能只按关键词分类。"
        "scene.domain 使用 social、coding、game、daily、research、mixed 或 general；"
        "scene.interactionType 使用 conversation、task 或 mixed；confidence 是 0 到 1；summary 用简短中文说明本轮场景。"
        "execution.mode 使用 solo、lead_support 或 ensemble；leadAssistantID 是主要负责人；"
        "仅当本轮存在写入、命令、发送、提醒等可能产生副作用的任务时设置 toolOwnerAssistantID，否则为 null。"
        "execution.observationStrategy 使用 none、on_demand、shared 或 independent。"
        "on_demand 表示各角色自行判断是否观察；independent 表示允许不同角色分别截图复核，不代表必须截图。"
        "执行型任务通常需要明确负责人，社交互动才适合多人自然接话；不要为了展示角色而增加无意义节拍。"
        "根据用户意图、角色个性与真实交谈所需，从完整参与者列表中动态决定发言人数、顺序和是否回场；"
        f"每轮安排 1 到 {max_beats} 个节拍，每位助手最多出现 {max_appearances} 次。"
        "允许同一助手在其他助手发言后再次接话，但禁止连续占用两个节拍，也不要为了凑人数制造无意义回复。"
        f"角色间直接接话当前{'允许' if allow_inter_assistant_replies else '禁止'}。"
        "addressTo 使用 user 或 assistant:<assistantID>，replyToBeat 只能引用更早的节拍；"
        "若用户要求多人互动，应让后续发言实际承接公开对话，而不是让每位助手各自重复回答。"
        "speechAct 使用 respond、react、support、challenge、continue 或 close。"
        "只输出 JSON：{\"scene\":{\"domain\":\"social\",\"interactionType\":\"conversation\","
        "\"confidence\":0.9,\"summary\":\"轻松闲聊\"},\"execution\":{\"mode\":\"ensemble\","
        "\"leadAssistantID\":数字或字符串,\"toolOwnerAssistantID\":null,\"observationStrategy\":\"on_demand\"},"
        "\"beats\":[{\"assistantID\":数字或字符串,\"intent\":\"简短意图\","
        "\"speechAct\":\"respond\",\"addressTo\":\"user\",\"replyToBeat\":null}]}。"
    )
    prompt = json.dumps(
        {
            "participants": roster,
            "recentConversation": conversation_context,
            "userMessage": user_text,
            "attachmentContext": attachment_context,
        },
        ensure_ascii=False,
    )
    try:
        response = await asyncio.to_thread(
            call_openai_compatible,
            director_config.model,
            {
                "systemPrompt": system_prompt,
                "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            },
            {
                "apiKey": director_config.api_key,
                "maxTokens": director_max_tokens,
                # The director is a fast structured router, not a reasoning actor.
                # Do not retry without this option: an incompatible provider must
                # use the deterministic fallback rather than silently reasoning.
                "thinking": {"type": "disabled"},
            },
        )
        choice = (response.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = message.get("content") or ""
        reasoning_content = str(message.get("reasoning_content") or "").strip()
        if str(content).strip() and reasoning_content:
            logger.warning(
                f"导演模型忽略了禁用推理参数，使用安全回退: model={director_config.label}, "
                f"reasoning_chars={len(reasoning_content)}"
            )
            return DirectorPlan(
                fallback.plan_id,
                fallback.beats,
                fallback.source,
                "director_reasoning_not_disabled",
            )
        if not str(content).strip():
            diagnostic = "director_output_truncated" if choice.get("finish_reason") == "length" else "director_output_empty"
            logger.warning(
                f"导演没有返回公开内容: model={director_config.label}, finish_reason={choice.get('finish_reason')}, "
                f"reasoning_chars={len(reasoning_content)}, max_tokens={director_max_tokens}"
            )
            return DirectorPlan(fallback.plan_id, fallback.beats, fallback.source, diagnostic)
        parsed = _json_object(str(content))
        if parsed is None:
            logger.warning(
                f"导演返回内容不是有效 JSON: model={director_config.label}, finish_reason={choice.get('finish_reason')}, "
                f"content_chars={len(str(content))}"
            )
            return DirectorPlan(fallback.plan_id, fallback.beats, fallback.source, "director_output_invalid_json")
        allowed: dict[str, int | str] = {}
        for participant in participants:
            assistant_id = participant.get("assistantID")
            for identity in (
                assistant_id,
                participant.get("assistantName"),
                participant.get("characterName"),
            ):
                if identity not in (None, ""):
                    allowed[str(identity).strip().lower()] = assistant_id
        raw_beats = (parsed or {}).get("beats")
        if not isinstance(raw_beats, list):
            raw_beats = (parsed or {}).get("turns", [])
        beats: list[DirectorBeat] = []
        appearances: dict[str, int] = {}
        allowed_acts = {"respond", "react", "support", "challenge", "continue", "close"}
        for item in raw_beats:
            if not isinstance(item, dict):
                continue
            raw_assistant = (
                item.get("assistantID")
                if item.get("assistantID") is not None
                else item.get("assistant_id", item.get("assistant", item.get("name")))
            )
            assistant_id = allowed.get(str(raw_assistant).strip().lower())
            if assistant_id is None:
                continue
            if beats and str(beats[-1].assistant_id) == str(assistant_id):
                continue
            key = str(assistant_id)
            if appearances.get(key, 0) >= max_appearances:
                continue
            reply_to = item.get("replyToBeat", item.get("reply_to_beat"))
            if not isinstance(reply_to, int) or reply_to < 0 or reply_to >= len(beats):
                reply_to = len(beats) - 1 if beats else None
            speech_act = str(item.get("speechAct") or item.get("speech_act") or ("respond" if not beats else "react"))
            if speech_act not in allowed_acts:
                speech_act = "react" if beats else "respond"
            previous_id = beats[-1].assistant_id if beats and allow_inter_assistant_replies else None
            address_to = (
                _normalize_address_to(item.get("addressTo", item.get("address_to")), previous_id)
                if allow_inter_assistant_replies
                else "user"
            )
            beats.append(
                DirectorBeat(
                    assistant_id,
                    str(item.get("intent") or "自然参与当前对话")[:160],
                    speech_act,
                    address_to,
                    reply_to if allow_inter_assistant_replies else None,
                )
            )
            appearances[key] = appearances.get(key, 0) + 1
            if len(beats) >= max_beats:
                break
        if beats:
            raw_scene = parsed.get("scene") if isinstance(parsed.get("scene"), dict) else {}
            domain = str(raw_scene.get("domain") or "general").strip().lower()
            if domain not in {"social", "coding", "game", "daily", "research", "mixed", "general"}:
                domain = "general"
            interaction_type = str(
                raw_scene.get("interactionType", raw_scene.get("interaction_type")) or "conversation"
            ).strip().lower()
            if interaction_type not in {"conversation", "task", "mixed"}:
                interaction_type = "conversation"
            try:
                confidence = max(0.0, min(float(raw_scene.get("confidence", 0.0)), 1.0))
            except (TypeError, ValueError):
                confidence = 0.0
            scene = DirectorScene(
                domain=domain,
                interaction_type=interaction_type,
                confidence=round(confidence, 3),
                summary=str(raw_scene.get("summary") or "当前对话")[:120],
            )

            raw_execution = parsed.get("execution") if isinstance(parsed.get("execution"), dict) else {}
            execution_mode = str(raw_execution.get("mode") or "solo").strip().lower()
            if execution_mode not in {"solo", "lead_support", "ensemble"}:
                execution_mode = "solo"
            beat_assistant_ids = {str(beat.assistant_id) for beat in beats}
            lead_assistant_id = allowed.get(
                str(raw_execution.get("leadAssistantID", raw_execution.get("lead_assistant_id")) or "")
                .strip()
                .lower()
            )
            if lead_assistant_id is None or str(lead_assistant_id) not in beat_assistant_ids:
                lead_assistant_id = beats[0].assistant_id
            raw_tool_owner = raw_execution.get(
                "toolOwnerAssistantID", raw_execution.get("tool_owner_assistant_id")
            )
            tool_owner_assistant_id = None
            if raw_tool_owner not in (None, ""):
                tool_owner_assistant_id = allowed.get(str(raw_tool_owner).strip().lower())
                if tool_owner_assistant_id is not None and str(tool_owner_assistant_id) not in beat_assistant_ids:
                    tool_owner_assistant_id = None
            if len(beat_assistant_ids) == 1:
                execution_mode = "solo"
            elif execution_mode == "solo":
                execution_mode = "lead_support"
            observation_strategy = str(
                raw_execution.get("observationStrategy", raw_execution.get("observation_strategy")) or "on_demand"
            ).strip().lower()
            if observation_strategy not in {"none", "on_demand", "shared", "independent"}:
                observation_strategy = "on_demand"
            execution = DirectorExecution(
                mode=execution_mode,
                lead_assistant_id=lead_assistant_id,
                tool_owner_assistant_id=tool_owner_assistant_id,
                observation_strategy=observation_strategy,
            )
            return DirectorPlan(
                create_id("plan"),
                tuple(beats),
                "model",
                scene=scene,
                execution=execution,
            )
        logger.warning(
            f"导演 JSON 中没有合法节拍: model={director_config.label}, participant_count={len(participants)}, "
            f"raw_beat_count={len(raw_beats) if isinstance(raw_beats, list) else 0}"
        )
        return DirectorPlan(fallback.plan_id, fallback.beats, fallback.source, "director_output_no_valid_beats")
    except Exception as error:
        logger.warning(f"导演请求失败，使用安全回退: model={director_config.label}, error={error}")
        return DirectorPlan(fallback.plan_id, fallback.beats, fallback.source, "director_request_failed")


def actor_task_prompt(
    user_text: str,
    beat: DirectorBeat,
    previous_replies: list[dict[str, Any]],
    attachment_details: str = "",
    scene: DirectorScene | None = None,
    execution: DirectorExecution | None = None,
) -> str:
    companion_context = "\n".join(
        assistant_context_text(
            str(item.get("reply") or ""),
            str(item.get("assistantName") or "助手"),
            beat_index=item.get("beatIndex") if isinstance(item.get("beatIndex"), int) else None,
        )
        for item in previous_replies
        if str(item.get("reply") or "").strip()
    )
    addressed_name = "用户"
    if beat.address_to.startswith("assistant:"):
        addressed_id = beat.address_to.split(":", 1)[1]
        addressed_name = next(
            (
                str(item.get("assistantName") or "伙伴")
                for item in reversed(previous_replies)
                if str(item.get("assistantID")) == addressed_id
            ),
            "上一位伙伴",
        )
    has_spoken = any(str(item.get("assistantID")) == str(beat.assistant_id) for item in previous_replies)
    if scene is None or execution is None:
        sections = [
            "你正在进行单助手用户会话。直接理解并完成用户当前请求，不需要进行多人编排或角色报幕。",
            "前端已经单独显示你的头像和名字；正文直接开始说话，禁止以自己的姓名、角色名或“助手：”作为开头。",
            f"用户消息：\n{user_text}",
        ]
    else:
        sections = [
            "你正在参与一个多人智能体会话。请保持自己的角色身份，并根据导演判断在自然互动与任务执行之间采用合适表达。",
            "前端已经单独显示你的头像和名字；正文直接开始说话，禁止以自己的姓名、角色名或“助手：”作为开头，禁止报幕。",
            f"当前节拍行为：{beat.speech_act}",
            f"主要回应对象：{addressed_name}",
            f"导演意图：{beat.intent}",
            f"用户最初的消息：\n{user_text}",
        ]
    if scene is not None:
        sections.append(
            f"导演场景判断：domain={scene.domain}，interactionType={scene.interaction_type}，说明={scene.summary}。"
        )
    if execution is not None:
        responsibility = "你是本轮主要负责人。" if str(beat.assistant_id) == str(execution.lead_assistant_id) else "你是本轮协作参与者。"
        tool_rule = ""
        if execution.tool_owner_assistant_id is not None:
            if str(beat.assistant_id) == str(execution.tool_owner_assistant_id):
                tool_rule = "你是本轮可能产生副作用的工具操作负责人。"
            else:
                tool_rule = "本轮另有工具操作负责人；不要重复执行写入、命令、发送或提醒等副作用操作。"
        sections.append(
            f"导演执行策略：mode={execution.mode}，observationStrategy={execution.observation_strategy}。"
            f"{responsibility}{tool_rule}是否读取屏幕仍由你根据任务需要自行判断。"
        )
    if companion_context:
        sections.append(
            f"本轮已经发生的公开对话：\n{companion_context}\n"
            "请回应最新对话关系，不要复述已有内容，也不要重复执行已经产生副作用的工具操作。"
        )
    if has_spoken:
        sections.append("你本轮已经发言过；这次是再次接话，应回应伙伴刚才的新内容并推进或收束互动，不能重新回答用户一遍。")
    if beat.reply_to_beat is not None:
        sections.append(f"本次发言承接节拍 {beat.reply_to_beat}。")
    if attachment_details:
        sections.append(attachment_details)
    return "\n\n".join(sections)
