from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from ..logging import get_logger
from .config import SelfAwakeRuntimeConfig

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")

ACTION_LABELS = {
    "observe_only": "仅观察",
    "write_diary": "写工作日记",
    "remind_user": "提醒用户",
    "create_task": "创建任务",
    "ask_user": "询问用户",
    "run_safe_check": "安全检查",
    "sync_context": "同步上下文",
}


def truncate_display_text(value: Any, limit: int = 5000) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [已截断，总长度: {len(text)}]"


def render_self_awake_request(
    app: AppState,
    session_id: str,
    context: dict[str, Any],
    runtime_config: SelfAwakeRuntimeConfig,
    character: dict[str, Any],
    system_prompt: str,
    user_prompt: str,
    tool_names: list[str],
) -> None:
    if not getattr(app.config, "display_enabled", True):
        return
    try:
        from ..display import render_decision_table

        render_decision_table(
            {
                "步骤类型": "model_request",
                "使用工具": "自醒",
                "工具参数": {
                    "会话 ID": session_id,
                    "模型": runtime_config.label,
                    "配置来源": "Core" if runtime_config.source == "core" else "环境变量",
                    "思考级别": runtime_config.thinking_level,
                    "支持图片": runtime_config.supports_images,
                    "工具数量": len(tool_names),
                    "工具列表": tool_names,
                },
                "内容": {
                    "上下文字段": list(context.keys()),
                    "上下文 JSON 字符数": len(json.dumps(context, ensure_ascii=False)),
                    "系统提示词字符数": len(system_prompt),
                    "用户提示词字符数": len(user_prompt),
                    "系统提示词": truncate_display_text(system_prompt, 4000),
                    "用户提示词": truncate_display_text(user_prompt, 6000),
                },
            },
            character_name=str(character.get("name") or "MonAgent"),
            stage_name="[AGENT-SELFAWAKE] 自醒请求",
            width=100,
        )
    except Exception as error:
        logger.warning(f"自醒请求表渲染失败：{error}")


def render_self_awake_decision(
    app: AppState,
    decision: dict[str, Any],
    runtime_config: SelfAwakeRuntimeConfig,
    duration_ms: int,
    character: dict[str, Any],
    usage: dict[str, Any] | None = None,
) -> None:
    if not getattr(app.config, "display_enabled", True):
        return
    try:
        from ..display import render_decision_table

        action = decision.get("action") if isinstance(decision.get("action"), dict) else {}
        next_wake = decision.get("next_wake") if isinstance(decision.get("next_wake"), dict) else {}
        diary = decision.get("diary") if isinstance(decision.get("diary"), dict) else {}
        usage = usage if isinstance(usage, dict) else decision.get("usage") if isinstance(decision.get("usage"), dict) else {}
        render_decision_table(
            {
                "决策类型": ACTION_LABELS.get(str(action.get("type") or ""), action.get("type") or ""),
                "使用工具": "自醒",
                "工具参数": {
                    "模型": runtime_config.label,
                    "配置来源": "Core" if runtime_config.source == "core" else "环境变量",
                    "耗时毫秒": duration_ms,
                    "缓存命中 Tokens": usage.get("cacheRead") or 0,
                    "缓存未命中 Tokens": usage.get("cacheMiss") or 0,
                    "输出 Tokens": usage.get("output") or 0,
                    "总 Tokens": usage.get("totalTokens") or 0,
                },
                "内容": {
                    "情绪": decision.get("mood") or "",
                    "当前想法": decision.get("current_desire") or "",
                    "是否主动通知用户": decision.get("should_interrupt_user"),
                    "观察事实": decision.get("observations") or [],
                    "动作说明": action.get("message") or "",
                    "下次自醒间隔分钟": next_wake.get("after_minutes") or "",
                    "下次自醒原因": next_wake.get("reason") or "",
                    "日记标题": diary.get("title") or "",
                    "日记内容": diary.get("content") or "",
                    "来源": decision.get("source") or "",
                    "错误": decision.get("error") or "",
                },
            },
            character_name=str(character.get("name") or "MonAgent"),
            stage_name="[AGENT-SELFAWAKE] 自醒决策",
            width=100,
        )
    except Exception as error:
        logger.warning(f"自醒决策表渲染失败：{error}")
