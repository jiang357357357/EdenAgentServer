from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

MAX_DEPTH = 10


def parse_monconfig(path: Path) -> dict[str, dict[str, str]]:
    data: dict[str, dict[str, str]] = {}
    section = "default"
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            data.setdefault(section, {})
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data.setdefault(section, {})[key.strip().upper()] = value.strip()
    return data


def find_monconfig_files(start: Path) -> list[Path]:
    files: list[Path] = []
    current = start.resolve()
    for _ in range(MAX_DEPTH):
        candidate = current / ".monconfig"
        if candidate.exists():
            files.append(candidate)
        if current.parent == current:
            break
        current = current.parent
    return files


@dataclass(slots=True)
class MonConfig:
    data: dict[str, dict[str, str]]
    workspace_root: Path
    files: list[Path]

    def get(self, section: str, key: str, fallback: str | None = None) -> str | None:
        section_key = section.lower()
        value_key = key.upper()
        env_key = f"{section_key.upper()}_{value_key}"
        return self.data.get(section_key, {}).get(value_key) or os.environ.get(env_key) or fallback

    def number(self, section: str, key: str, fallback: int) -> int:
        raw = self.get(section, key)
        if raw is None or raw == "":
            return fallback
        try:
            return int(float(raw))
        except ValueError:
            return fallback

    def boolean(self, section: str, key: str, fallback: bool) -> bool:
        raw = self.get(section, key)
        if raw is None or raw == "":
            return fallback
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def path(self, section: str, key: str, fallback: str) -> Path:
        raw = self.get(section, key, fallback) or fallback
        value = Path(raw)
        return value if value.is_absolute() else self.workspace_root / value


def load_mon_config(start: Path) -> MonConfig:
    files = find_monconfig_files(start)
    data: dict[str, dict[str, str]] = {}
    for file in reversed(files):
        parsed = parse_monconfig(file)
        for section, values in parsed.items():
            data[section] = {**data.get(section, {}), **values}
    workspace_root = files[0].parent if files else start.resolve()
    return MonConfig(data=data, workspace_root=workspace_root, files=files)
