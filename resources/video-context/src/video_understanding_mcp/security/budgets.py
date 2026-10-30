"""Context-local aggregate CPU and memory accounting for one bounded operation."""

from __future__ import annotations

import contextvars
from dataclasses import dataclass, field


@dataclass
class JobResourceBudget:
    max_cpu_seconds: float
    max_memory_bytes: int
    completed_child_cpu: float = 0.0
    peak_child_memory: int = 0
    active_child_cpu: dict[int, float] = field(default_factory=dict)
    active_child_memory: dict[int, int] = field(default_factory=dict)

    def update_child(self, identifier: int, *, cpu_seconds: float, memory_bytes: int) -> None:
        self.active_child_cpu[identifier] = max(0.0, cpu_seconds)
        self.active_child_memory[identifier] = max(0, memory_bytes)
        self.peak_child_memory = max(self.peak_child_memory, memory_bytes)

    def finish_child(self, identifier: int) -> None:
        self.completed_child_cpu += self.active_child_cpu.pop(identifier, 0.0)
        self.active_child_memory.pop(identifier, None)

    @property
    def child_cpu_seconds(self) -> float:
        return self.completed_child_cpu + sum(self.active_child_cpu.values())

    @property
    def active_child_memory_bytes(self) -> int:
        return sum(self.active_child_memory.values())


_CURRENT_BUDGET: contextvars.ContextVar[JobResourceBudget | None] = contextvars.ContextVar(
    "video_mcp_resource_budget", default=None
)


def current_resource_budget() -> JobResourceBudget | None:
    return _CURRENT_BUDGET.get()


def set_resource_budget(budget: JobResourceBudget) -> contextvars.Token[JobResourceBudget | None]:
    return _CURRENT_BUDGET.set(budget)


def reset_resource_budget(token: contextvars.Token[JobResourceBudget | None]) -> None:
    _CURRENT_BUDGET.reset(token)
