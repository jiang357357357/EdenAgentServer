from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


def _ancestors(start: Path):
    current = start.resolve()
    if current.is_file():
        current = current.parent
    while True:
        yield current
        if current.parent == current:
            return
        current = current.parent


def _strip_inline_comment(line: str) -> str:
    in_single_quote = False
    in_double_quote = False
    for index, char in enumerate(line):
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
        elif char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
        elif char in "#;" and not in_single_quote and not in_double_quote:
            if index == 0 or line[index - 1].isspace():
                return line[:index]
    return line


def parse_monconfig(path: Path) -> dict[str, dict[str, str]]:
    data: dict[str, dict[str, str]] = {}
    section = "_root"
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = _strip_inline_comment(raw_line).strip()
        if not line:
            continue
        if line.startswith("["):
            if not line.endswith("]") or not line[1:-1].strip():
                raise ValueError(f"{path}:{line_number}: invalid section")
            section = line[1:-1].strip().lower()
            data.setdefault(section, {})
            continue
        if "=" not in line:
            raise ValueError(f"{path}:{line_number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip().upper()
        if not key:
            raise ValueError(f"{path}:{line_number}: empty key")
        data.setdefault(section, {})[key] = value.strip()
    return data


def find_monconfig_files(start: Path) -> list[Path]:
    """返回最近的一份模块配置；保留列表返回类型以兼容旧调用。"""
    for directory in _ancestors(start):
        candidate = directory / ".monconfig"
        if candidate.is_file():
            return [candidate]
    return []


def find_workspace_root(start: Path) -> Path | None:
    for directory in _ancestors(start):
        if (directory / ".monconfig").is_file() and (directory / ".monworkspace").is_file():
            return directory
    return None


@dataclass(slots=True)
class MonConfig:
    data: dict[str, dict[str, str]]
    module_root: Path
    workspace_root: Path
    files: list[Path]

    def get(self, section: str, key: str, fallback: str | None = None) -> str | None:
        return self.data.get(section.strip().lower(), {}).get(key.strip().upper(), fallback)

    def number(self, section: str, key: str, fallback: int) -> int:
        raw = self.get(section, key)
        if raw is None or raw == "":
            return fallback
        try:
            return int(raw)
        except ValueError as error:
            raise ValueError(f"[{section}] {key} must be an integer, got {raw!r}") from error

    def boolean(self, section: str, key: str, fallback: bool) -> bool:
        raw = self.get(section, key)
        if raw is None or raw == "":
            return fallback
        normalized = raw.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"[{section}] {key} must be a boolean, got {raw!r}")

    def path(self, section: str, key: str, fallback: str) -> Path:
        raw = self.get(section, key, fallback) or fallback
        value = Path(raw)
        return value if value.is_absolute() else self.module_root / value


def load_mon_config(start: Path) -> MonConfig:
    resolved_start = start.resolve()
    files = find_monconfig_files(resolved_start)
    module_root = files[0].parent if files else resolved_start
    workspace_root = find_workspace_root(resolved_start) or module_root
    data = parse_monconfig(files[0]) if files else {}
    return MonConfig(data=data, module_root=module_root, workspace_root=workspace_root, files=files)
