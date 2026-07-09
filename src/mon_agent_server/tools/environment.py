from __future__ import annotations

import asyncio
from typing import Any

from mon_agent_core import AgentTool

from ..calendar_context import EnvironmentAwarenessService, build_calendar_context, calendar_context_summary
from .context import MonToolContext
from .result import text_result


def create_environment_tools(context: MonToolContext) -> list[AgentTool]:
    async def get_calendar_context_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        env = context.environment if isinstance(context.environment, dict) else {}
        timezone_name = str(params.get("timezone") or env.get("timezone") or "").strip() or None
        locale = str(params.get("locale") or env.get("locale") or "zh-CN")
        nearby_days = min(max(int(float(params.get("nearby_days") or 30)), 1), 90)
        calendar = build_calendar_context(params.get("date"), timezone_name, locale, nearby_days)
        return text_result(calendar_context_summary(calendar), calendar)

    async def get_weather_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        env = context.environment if isinstance(context.environment, dict) else {}
        weather = await asyncio.to_thread(EnvironmentAwarenessService.weather_context, params, env)
        return text_result(
            EnvironmentAwarenessService.weather_summary(weather),
            weather,
        )

    return [
        AgentTool(
            name="get_calendar_context",
            label="查询日历节日",
            description="查询指定日期的本地日历上下文，包括星期、周末、农历、当天节日和近期节日；不包含年度法定调休表。",
            parameters={
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "要查询的日期，ISO 格式；为空时使用本轮环境时区的今天。"},
                    "timezone": {"type": "string", "description": "时区，例如 Asia/Shanghai；为空时使用本轮环境时区。"},
                    "locale": {"type": "string", "description": "语言区域，默认 zh-CN。"},
                    "nearby_days": {"type": "number", "description": "向后查找近期节日的天数，默认 30，最大 90。"},
                },
            },
            execute=get_calendar_context_execute,
        ),
        AgentTool(
            name="get_weather",
            label="查询天气",
            description="按城市或经纬度查询当前天气和未来几天天气；city 为空时使用本轮环境位置。",
            parameters={
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "城市名；为空时使用环境配置。"},
                    "country": {"type": "string", "description": "国家/地区，可选。"},
                    "latitude": {"type": "number", "description": "纬度，可选。"},
                    "longitude": {"type": "number", "description": "经度，可选。"},
                    "days": {"type": "number", "description": "预报天数，默认 1，最大 7。"},
                },
            },
            execute=get_weather_execute,
        ),
    ]
