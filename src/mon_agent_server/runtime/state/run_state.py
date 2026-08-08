from __future__ import annotations

from typing import Any

from ...ids import create_id


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
        self.runtime_speaker: dict[str, Any] | None = None
        self.runtime_thinking_lines: list[str] = []
        self.context_user_message: dict[str, Any] | None = None
        self.context_user_persisted = False
        self.error_message: str | None = None
        self.tool_inputs: dict[str, Any] = {}
        self.tool_names: dict[str, str] = {}
        self.tool_message_ids: dict[str, str] = {}
        self.tool_starts: dict[str, int] = {}
        self.seen_tool_calls: set[str] = set()
        self.finished_tool_calls: set[str] = set()
        self.text_part_snapshots: dict[str, str] = {}
        self.speaker = dict(speaker or {})
        self.orchestration = dict(orchestration or {})
