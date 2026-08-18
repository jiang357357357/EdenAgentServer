from __future__ import annotations

from typing import Any

from ..agent_api import AgentTool

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
            content_hash = (
                f"，内容哈希 {item.get('contentHash')}"
                if source_type == "generated" and item.get("contentHash")
                else ""
            )
            lines.append(
                "- "
                f"{item.get('skillName')}（{item.get('displayName') or item.get('skillName')}）："
                f"{kind}，范围 {item.get('scope') or '未知'}，{status}{version}{content_hash}{shadowed}。"
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

    async def update_skill(
        _tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        if context.update_skill is None:
            raise RuntimeError("当前运行环境未提供技能更新能力。")
        action = str(params.get("action") or "").strip()
        result = context.update_skill(params)
        if action == "preview":
            changes = result.get("changes") if isinstance(result.get("changes"), dict) else {}
            added = [str(item) for item in changes.get("added") or []]
            modified = [str(item) for item in changes.get("modified") or []]
            deleted = [str(item) for item in changes.get("deleted") or []]

            def render_paths(label: str, paths: list[str]) -> str:
                return f"{label}：{', '.join(paths) if paths else '无'}"

            lines = [
                f"技能 {result.get('displayName') or result.get('skillName')} 的更新预览已生成，尚未修改已安装技能。",
                f"预览 ID：{result.get('previewID')}",
                f"基准内容哈希：{result.get('baseContentHash')}",
                f"更新后内容哈希：{result.get('contentHash')}",
                render_paths("新增", added),
                render_paths("修改", modified),
                render_paths("删除", deleted),
            ]
            diff = str(changes.get("diff") or "").strip()
            if diff:
                lines.extend(("差异：", "```diff", diff, "```"))
            if changes.get("diffTruncated"):
                lines.append("差异文本已截断；完整文件清单仍在结构化结果中。")
            lines.append(
                "核对以上增删改符合预期后，再调用 update_skill，设置 action=apply 并原样传入 preview_id。"
            )
            return text_result("\n".join(lines), result)
        return text_result(
            (
                f"技能 {result.get('displayName') or result.get('skillName')} 已按预览更新并生效。"
                f"当前内容哈希：{result.get('contentHash')}。"
            ),
            result,
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
                "创建一个全新的可复用技能包，支持 SKILL.md、scripts、references、assets、agents，"
                "以及 tools/*.json 声明的代码工具；同名技能不会被覆盖，已有技能必须使用 update_skill。"
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
                            "技能附属文件。路径必须位于 scripts/、references/、assets/、agents/、tools/ 或 tests/ 下；"
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
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "需要绑定的宿主工具名称或本包 tools/*.json 声明的代码工具名称。",
                    },
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
        AgentTool(
            name="update_skill",
            label="更新技能",
            description=(
                "增量更新已有的自编写技能。必须先以 action=preview 和 list_skills 返回的内容哈希生成增删改预览，"
                "核对差异后再以 action=apply 和 preview_id 原子安装；未显式列出的资源文件会保留。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["preview", "apply"],
                        "description": "preview 只生成差异且不落盘；apply 安装已经核对的预览。",
                    },
                    "preview_id": {
                        "type": "string",
                        "description": "action=apply 时必填，由 preview 返回。",
                    },
                    "name": {"type": "string", "description": "action=preview 时必填的小写连字符技能名。"},
                    "scope": {
                        "type": "string",
                        "enum": ["user", "project"],
                        "description": "action=preview 时必填，必须与现有技能范围一致。",
                    },
                    "expected_content_hash": {
                        "type": "string",
                        "description": "action=preview 时必填，使用 list_skills 最新返回的 contentHash。",
                    },
                    "display_name": {"type": "string", "description": "新的用户可见名称；省略则保留。"},
                    "description": {"type": "string", "description": "新的触发说明；省略则保留。"},
                    "instructions": {"type": "string", "description": "新的 SKILL.md 正文；省略则保留。"},
                    "default_prompt": {"type": "string", "description": "新的建议调用提示；省略则保留。"},
                    "version": {"type": "string", "description": "新版本；省略则保留。"},
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "完整的新工具名称列表；省略则保留。",
                    },
                    "profiles": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["user_chat", "self_awake"]},
                        "description": "完整的新运行档案列表；省略则保留。",
                    },
                    "files": {
                        "type": "array",
                        "description": "仅列出要变更的资源文件；operation=delete 才会删除，未列出的文件保持不变。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "相对技能目录的安全路径。"},
                                "operation": {
                                    "type": "string",
                                    "enum": ["upsert", "delete"],
                                    "default": "upsert",
                                },
                                "content": {"type": "string", "description": "upsert 时必填。"},
                                "encoding": {"type": "string", "enum": ["utf-8", "base64"], "default": "utf-8"},
                                "executable": {"type": "boolean"},
                            },
                            "required": ["path"],
                        },
                    },
                },
                "required": ["action"],
            },
            execute=update_skill,
            execution_mode="sequential",
        ),
    ]
