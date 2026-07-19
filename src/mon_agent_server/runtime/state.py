from __future__ import annotations

from typing import Any


class RunState:
    def __init__(self, speaker: dict[str, Any] | None = None) -> None:
        self.assistant_message_id: str | None = None
        self.assistant_created_at: int | None = None
        self.assistant_current_segment_index: int | None = None
        self.assistant_next_segment_index = 0
        self.runtime_thinking_lines: list[str] = []
        self.error_message: str | None = None
        self.tool_inputs: dict[str, Any] = {}
        self.tool_starts: dict[str, int] = {}
        self.finished_tool_calls: set[str] = set()
        self.text_part_snapshots: dict[str, str] = {}
        self.speaker = dict(speaker or {})
