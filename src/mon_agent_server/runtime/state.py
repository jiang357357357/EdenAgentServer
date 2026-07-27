from __future__ import annotations

from typing import Any

from ..ids import create_id


class RunState:
    def __init__(
        self,
        speaker: dict[str, Any] | None = None,
        orchestration: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> None:
        self.run_id = run_id or create_id("run")
        self.assistant_message_id: str | None = None
        self.assistant_created_at: int | None = None
        self.assistant_message_ids: list[str] = []
        self.final_assistant_message_id: str | None = None
        self.runtime_message_id: str | None = None
        self.runtime_created_at: int | None = None
        self.runtime_thinking_lines: list[str] = []
        self.error_message: str | None = None
        self.tool_inputs: dict[str, Any] = {}
        self.tool_starts: dict[str, int] = {}
        self.finished_tool_calls: set[str] = set()
        self.root_web_search_count = 0
        self.root_local_search_count = 0
        self.root_workspace_path_error = False
        self.delegation_recommended = False
        self.delegation_recovered = False
        self.text_part_snapshots: dict[str, str] = {}
        self.speaker = dict(speaker or {})
        self.orchestration = dict(orchestration or {})
