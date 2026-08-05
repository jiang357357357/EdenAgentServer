from __future__ import annotations

from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .result import text_result


def create_skill_creation_tools(context: MonToolContext) -> list[AgentTool]:
    async def list_skills(
        _tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        if context.list_skills is None:
            raise RuntimeError("当前运行环境未提供技能清单能力。")
        skills = context.list_skills(params)
        lines = [f"共找到 {len(skills)} 个符合条件的技能："]
        for item in skills:
            source_type = str(item.get("sourceType") or "")
            if item.get("builtin"):
                kind = "基础"
            elif source_type == "generated":
                kind = "自编写"
            else:
                kind = "外部安装"
            status = "已启用" if item.get("enabled") else "已禁用"
            shadowed = "，已被项目同名技能覆盖" if item.get("shadowed") else ""
            version = f"，版本 {item.get('version')}" if item.get("version") else ""
            lines.append(
                "- "
                f"{item.get('skillName')}（{item.get('displayName') or item.get('skillName')}）："
                f"{kind}，范围 {item.get('scope') or '未知'}，{status}{version}{shadowed}。"
                f"{item.get('description') or ''}"
            )
        return text_result(
            "\n".join(lines),
            {"skills": skills, "count": len(skills)},
        )

    async def create_skill(
        _tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        if context.create_skill is None:
            raise RuntimeError("当前运行环境未提供技能创建能力。")
        installed = context.create_skill(params)
        return text_result(
            (
                f"技能 {installed.get('displayName') or installed.get('skillName')} 已创建并生效。"
                f"技能包包含 {installed.get('fileCount') or 1} 个文件。"
            ),
            installed,
        )

    return [
        AgentTool(
            name="list_skills",
            label="查看技能",
            description="列出技能管理系统中的基础技能与自编写技能，并返回范围、来源、启用状态、覆盖状态和版本。",
            parameters={
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["all", "builtin", "generated", "installed"],
                        "default": "all",
                        "description": "按技能类型筛选；generated 是智能体自编写技能。",
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["all", "system", "user", "project"],
                        "default": "all",
                    },
                    "enabled": {
                        "type": "string",
                        "enum": ["all", "enabled", "disabled"],
                        "default": "all",
                    },
                },
            },
            execute=list_skills,
            execution_mode="parallel",
        ),
        AgentTool(
            name="create_skill",
            label="创建技能",
            description=(
                "创建或更新一个完整的可复用技能包，支持 SKILL.md 说明以及 scripts、references、assets、agents 资源，"
                "完成路径、大小、结构与工具校验后原子安装并立即生效。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "小写连字符技能名。"},
                    "display_name": {"type": "string", "description": "用户可见名称。"},
                    "description": {"type": "string", "description": "说明技能做什么以及何时触发。"},
                    "instructions": {"type": "string", "description": "简洁、可执行的技能正文。"},
                    "default_prompt": {"type": "string", "description": "技能列表中的建议调用提示；省略时自动生成。"},
                    "files": {
                        "type": "array",
                        "description": (
                            "技能附属文件。路径必须位于 scripts/、references/、assets/ 或 agents/ 下；"
                            "文本使用 utf-8，二进制资源使用 base64。"
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "相对技能目录的安全路径。"},
                                "content": {"type": "string", "description": "文本内容或 Base64 数据。"},
                                "encoding": {"type": "string", "enum": ["utf-8", "base64"], "default": "utf-8"},
                                "executable": {"type": "boolean", "default": False},
                            },
                            "required": ["path", "content"],
                        },
                    },
                    "tools": {"type": "array", "items": {"type": "string"}, "description": "需要绑定的现有工具名称。"},
                    "profiles": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["user_chat", "self_awake"]},
                        "default": ["user_chat"],
                    },
                    "scope": {"type": "string", "enum": ["user", "project"], "default": "user"},
                    "version": {"type": "string", "default": "1.0.0"},
                },
                "required": ["name", "display_name", "description", "instructions", "tools"],
            },
            execute=create_skill,
            execution_mode="sequential",
        ),
    ]
