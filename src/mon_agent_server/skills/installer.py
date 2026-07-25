from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import yaml
from mon_agent_core.harness import LocalExecutionEnv, load_skills

from ..core import CoreClient
from ..tools import MonToolContext, create_mon_agent_tools
from .catalog import SKILLS_BY_ID, SkillDefinition

INSTALLATION_MANIFEST = ".monagent-skill.json"
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_FILES = 512
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
PREVIEW_TTL_SECONDS = 15 * 60


@dataclass(slots=True)
class SkillPreview:
    preview_id: str
    owner_key: str
    scope: str
    source: dict[str, str]
    stage_dir: Path
    definition: SkillDefinition
    version: str
    content_hash: str
    file_count: int
    total_bytes: int
    created_at: float
    replace_installation_id: str = ""
    enabled: bool = True


def owner_storage_key(owner_id: object) -> str:
    value = str(owner_id or "local").strip() or "local"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def skill_roots(workspace_root: str | Path, owner_key: str) -> dict[str, Path]:
    workspace = Path(workspace_root).resolve()
    return {
        "user": Path.home() / ".pi" / "agent" / "skills" / "monagent" / owner_key,
        "project": workspace / ".pi" / "skills" / "monagent" / owner_key,
    }


def _safe_subpath(value: str | None) -> Path:
    relative = Path(str(value or "."))
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("技能子目录必须是安全的相对路径")
    return relative


def _read_frontmatter(skill_file: Path) -> dict[str, Any]:
    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    parsed = yaml.safe_load(parts[1]) or {}
    return parsed if isinstance(parsed, dict) else {}


def _monagent_metadata(frontmatter: dict[str, Any]) -> dict[str, Any]:
    metadata = frontmatter.get("metadata")
    if not isinstance(metadata, dict):
        return {}
    value = metadata.get("monagent")
    return value if isinstance(value, dict) else {}


def _string_tuple(value: Any, fallback: tuple[str, ...] = ()) -> tuple[str, ...]:
    if not isinstance(value, list):
        return fallback
    return tuple(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


def _validate_tree(root: Path) -> tuple[int, int]:
    file_count = 0
    total_bytes = 0
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"技能包不能包含符号链接：{path.relative_to(root)}")
        if path.is_dir():
            continue
        file_count += 1
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ValueError(f"技能文件超过 10MB：{path.relative_to(root)}")
        total_bytes += size
        if file_count > MAX_FILES or total_bytes > MAX_TOTAL_BYTES:
            raise ValueError("技能包超过限制（最多 512 个文件、总计 50MB）")
    if file_count == 0:
        raise ValueError("技能目录为空")
    return file_count, total_bytes


def _content_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file() or path.name == INSTALLATION_MANIFEST:
            continue
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def _copy_source(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise ValueError(f"本地技能目录不存在：{source}")
    _validate_tree(source)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))


def _clone_source(uri: str, reference: str, destination: Path) -> None:
    normalized = uri.strip()
    if not (
        normalized.startswith("https://")
        or normalized.startswith("ssh://")
        or normalized.startswith("git@")
    ):
        raise ValueError("Git 技能源只允许 https、ssh 或 git@ 地址")
    command = ["git", "clone", "--depth", "1"]
    if reference:
        command.extend(["--branch", reference])
    command.extend([normalized, str(destination)])
    result = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "git clone 失败").strip()
        raise ValueError(detail[-1000:])
    shutil.rmtree(destination / ".git", ignore_errors=True)


def _definition_from_directory(root: Path, known_tools: set[str]) -> tuple[SkillDefinition, str]:
    result = asyncio.run(load_skills(LocalExecutionEnv(root), str(root)))
    skills = result.get("skills") or []
    diagnostics = result.get("diagnostics") or []
    if len(skills) != 1:
        message = "; ".join(str(item.get("message") or item) for item in diagnostics) or "必须且只能包含一个有效技能"
        raise ValueError(message)
    skill = skills[0]
    skill_file = Path(skill.file_path)
    frontmatter = _read_frontmatter(skill_file)
    metadata = _monagent_metadata(frontmatter)
    name = str(skill.name).strip()
    if not SKILL_NAME_PATTERN.fullmatch(name):
        raise ValueError("技能 name 只能包含小写字母、数字和单个连字符")
    if name in SKILLS_BY_ID:
        raise ValueError(f"技能名称与内置技能冲突：{name}")
    tool_names = _string_tuple(metadata.get("tools"))
    unknown_tools = sorted(set(tool_names) - known_tools)
    if unknown_tools:
        raise ValueError(f"技能声明了未知工具：{', '.join(unknown_tools)}")
    profiles = _string_tuple(metadata.get("profiles"), ("user_chat",))
    invalid_profiles = sorted(set(profiles) - {"user_chat", "self_awake"})
    if invalid_profiles:
        raise ValueError(f"技能声明了未知运行档案：{', '.join(invalid_profiles)}")
    display_name = str(metadata.get("display_name") or frontmatter.get("display-name") or name).strip()
    version = str(metadata.get("version") or frontmatter.get("version") or "0.0.0").strip()
    definition = SkillDefinition(
        id=name,
        name=display_name,
        description=str(skill.description).strip(),
        tool_names=tool_names,
        instructions=(str(skill.content).strip(),),
        profiles=profiles,
        model_invocable=not bool(skill.disable_model_invocation),
        source="installed",
        file_path=str(skill_file),
    )
    return definition, version


def load_installed_skill_definitions(
    workspace_root: str | Path,
    owner_key: str,
) -> tuple[SkillDefinition, ...]:
    known_tools = {
        tool.name
        for profile in ("user_chat", "self_awake")
        for tool in create_mon_agent_tools(workspace_root, MonToolContext(), profile)
    }
    definitions: dict[str, SkillDefinition] = {}
    for scope, root in skill_roots(workspace_root, owner_key).items():
        if not root.exists():
            continue
        for directory in sorted(root.iterdir()):
            manifest_path = directory / INSTALLATION_MANIFEST
            if not directory.is_dir() or not manifest_path.is_file():
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if not manifest.get("enabled", True) or manifest.get("trustStatus") != "trusted":
                    continue
                definition, _version = _definition_from_directory(directory, known_tools)
                definitions[definition.id] = replace(definition, scope=scope)
            except Exception:
                continue
    return tuple(definitions.values())


class SkillInstallationService:
    def __init__(self, workspace_root: str | Path, core_client: CoreClient) -> None:
        self.workspace_root = Path(workspace_root).resolve()
        self.core_client = core_client
        self._previews: dict[str, SkillPreview] = {}
        self._lock = threading.RLock()

    def inspect(self, owner_id: object, payload: dict[str, Any]) -> dict[str, Any]:
        owner_key = owner_storage_key(owner_id)
        scope = str(payload.get("scope") or "user")
        source_type = str(payload.get("sourceType") or "local")
        source_uri = str(payload.get("sourceUri") or "").strip()
        source_ref = str(payload.get("sourceRef") or "").strip()
        source_subpath = str(payload.get("sourceSubpath") or "").strip()
        if scope not in {"user", "project"}:
            raise ValueError("scope 必须是 user 或 project")
        if source_type not in {"local", "git"}:
            raise ValueError("当前版本支持 local 和 git 技能源")
        if not source_uri:
            raise ValueError("缺少 sourceUri")
        root = skill_roots(self.workspace_root, owner_key)[scope]
        root.mkdir(parents=True, exist_ok=True)
        preview_id = f"skill_preview_{uuid.uuid4().hex}"
        checkout = root / ".staging" / preview_id / "checkout"
        checkout.parent.mkdir(parents=True, exist_ok=False)
        try:
            if source_type == "local":
                _copy_source(Path(source_uri).expanduser().resolve(), checkout)
            else:
                _clone_source(source_uri, source_ref, checkout)
            selected = (checkout / _safe_subpath(source_subpath)).resolve()
            if checkout not in selected.parents and selected != checkout:
                raise ValueError("技能子目录超出检出目录")
            if selected != checkout:
                _validate_tree(selected)
                prepared = checkout.parent / "skill"
                shutil.copytree(selected, prepared)
                shutil.rmtree(checkout)
                prepared.rename(checkout)
            file_count, total_bytes = _validate_tree(checkout)
            known_tools = {
                tool.name
                for profile in ("user_chat", "self_awake")
                for tool in create_mon_agent_tools(self.workspace_root, MonToolContext(), profile)
            }
            definition, version = _definition_from_directory(checkout, known_tools)
            preview = SkillPreview(
                preview_id=preview_id,
                owner_key=owner_key,
                scope=scope,
                source={
                    "type": source_type,
                    "uri": source_uri,
                    "ref": source_ref,
                    "subpath": source_subpath,
                },
                stage_dir=checkout,
                definition=definition,
                version=version,
                content_hash=_content_hash(checkout),
                file_count=file_count,
                total_bytes=total_bytes,
                created_at=time.time(),
                replace_installation_id=str(payload.get("replaceInstallationID") or "").strip(),
                enabled=bool(payload.get("enabled", True)),
            )
            with self._lock:
                self._discard_expired_previews()
                self._previews[preview_id] = preview
            return self._preview_payload(preview)
        except Exception:
            shutil.rmtree(checkout.parent, ignore_errors=True)
            raise

    def install(self, owner_id: object, token: str, device_id: str, preview_id: str) -> dict[str, Any]:
        owner_key = owner_storage_key(owner_id)
        with self._lock:
            self._discard_expired_previews()
            preview = self._previews.pop(preview_id, None)
        if preview is None or preview.owner_key != owner_key:
            raise ValueError("技能预检已失效，请重新预检")
        root = skill_roots(self.workspace_root, owner_key)[preview.scope]
        target = root / preview.definition.id
        if target.exists() and not preview.replace_installation_id:
            shutil.rmtree(preview.stage_dir.parent, ignore_errors=True)
            raise ValueError("该技能已安装；请先卸载或使用更新流程")
        installation_id = preview.replace_installation_id or f"skill_{uuid.uuid4().hex}"
        manifest = {
            "schemaVersion": 1,
            "installationID": installation_id,
            "skillName": preview.definition.id,
            "scope": preview.scope,
            "source": preview.source,
            "version": preview.version,
            "contentHash": preview.content_hash,
            "enabled": preview.enabled,
            "trustStatus": "trusted",
        }
        (preview.stage_dir / INSTALLATION_MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        backup = target.with_name(f".{target.name}.updating-{uuid.uuid4().hex}")
        if target.exists():
            target.rename(backup)
        preview.stage_dir.rename(target)
        shutil.rmtree(preview.stage_dir.parent, ignore_errors=True)
        try:
            record = self.core_client.upsert_skill_installation(
                token,
                {
                    "external_installation_id": installation_id,
                    "device_id": device_id,
                    "skill_name": preview.definition.id,
                    "display_name": preview.definition.name,
                    "description": preview.definition.description,
                    "scope": preview.scope,
                    "source_type": preview.source["type"],
                    "source_uri": preview.source["uri"],
                    "source_ref": preview.source["ref"],
                    "installed_version": preview.version,
                    "content_hash": preview.content_hash,
                    "enabled": preview.enabled,
                    "trust_status": "trusted",
                    "manifest_snapshot": manifest,
                },
            )
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            if backup.exists():
                backup.rename(target)
            raise
        shutil.rmtree(backup, ignore_errors=True)
        return self._record_payload(record, target)

    def inspect_update(
        self,
        owner_id: object,
        token: str,
        device_id: str,
        installation_id: str,
    ) -> dict[str, Any]:
        record = self._find_record(token, device_id, installation_id)
        snapshot = record.get("manifest_snapshot") if isinstance(record.get("manifest_snapshot"), dict) else {}
        source = snapshot.get("source") if isinstance(snapshot.get("source"), dict) else {}
        return self.inspect(
            owner_id,
            {
                "scope": record.get("scope") or "user",
                "sourceType": record.get("source_type") or source.get("type"),
                "sourceUri": record.get("source_uri") or source.get("uri"),
                "sourceRef": record.get("source_ref") or source.get("ref"),
                "sourceSubpath": source.get("subpath") or "",
                "replaceInstallationID": installation_id,
                "enabled": bool(record.get("enabled", True)),
            },
        )

    def list(self, owner_id: object, token: str, device_id: str) -> list[dict[str, Any]]:
        owner_key = owner_storage_key(owner_id)
        records = self.core_client.list_skill_installations(token, device_id)
        roots = skill_roots(self.workspace_root, owner_key)
        items: list[dict[str, Any]] = []
        for definition in SKILLS_BY_ID.values():
            items.append({
                "id": f"builtin:{definition.id}",
                "skillName": definition.id,
                "displayName": definition.name,
                "description": definition.description,
                "sourceType": "builtin",
                "scope": "system",
                "enabled": True,
                "trustStatus": "trusted",
                "builtin": True,
                "tools": list(definition.tool_names),
                "profiles": list(definition.profiles),
                "available": True,
            })
        for record in records:
            scope = str(record.get("scope") or "user")
            path = roots.get(scope, roots["user"]) / str(record.get("skill_name") or "")
            items.append(self._record_payload(record, path))
        return items

    def set_enabled(
        self,
        owner_id: object,
        token: str,
        device_id: str,
        installation_id: str,
        enabled: bool,
    ) -> dict[str, Any]:
        owner_key = owner_storage_key(owner_id)
        record = self._find_record(token, device_id, installation_id)
        path = skill_roots(self.workspace_root, owner_key)[record["scope"]] / record["skill_name"]
        manifest = self._read_manifest(path)
        manifest["enabled"] = enabled
        (path / INSTALLATION_MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        updated = self.core_client.update_skill_installation(
            token,
            installation_id,
            {"enabled": enabled, "manifest_snapshot": manifest},
        )
        return self._record_payload(updated, path)

    def uninstall(self, owner_id: object, token: str, device_id: str, installation_id: str) -> dict[str, Any]:
        owner_key = owner_storage_key(owner_id)
        with self._lock:
            pending_updates = [
                key
                for key, preview in self._previews.items()
                if preview.owner_key == owner_key and preview.replace_installation_id == installation_id
            ]
            for key in pending_updates:
                preview = self._previews.pop(key)
                shutil.rmtree(preview.stage_dir.parent, ignore_errors=True)
        record = self._find_record(token, device_id, installation_id)
        path = skill_roots(self.workspace_root, owner_key)[record["scope"]] / record["skill_name"]
        trash = path.with_name(f".{path.name}.deleting-{uuid.uuid4().hex}")
        if path.exists():
            path.rename(trash)
        try:
            result = self.core_client.delete_skill_installation(token, installation_id)
        except Exception:
            if trash.exists():
                trash.rename(path)
            raise
        shutil.rmtree(trash, ignore_errors=True)
        return result

    def _find_record(self, token: str, device_id: str, installation_id: str) -> dict[str, Any]:
        record = next(
            (item for item in self.core_client.list_skill_installations(token, device_id) if item.get("external_installation_id") == installation_id),
            None,
        )
        if not record:
            raise ValueError("技能安装记录不存在")
        return record

    @staticmethod
    def _read_manifest(path: Path) -> dict[str, Any]:
        manifest_path = path / INSTALLATION_MANIFEST
        if not manifest_path.is_file():
            raise ValueError("本地技能清单不存在")
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}

    def _discard_expired_previews(self) -> None:
        cutoff = time.time() - PREVIEW_TTL_SECONDS
        expired = [key for key, value in self._previews.items() if value.created_at < cutoff]
        for key in expired:
            preview = self._previews.pop(key)
            shutil.rmtree(preview.stage_dir.parent, ignore_errors=True)

    @staticmethod
    def _preview_payload(preview: SkillPreview) -> dict[str, Any]:
        return {
            "previewID": preview.preview_id,
            "skillName": preview.definition.id,
            "displayName": preview.definition.name,
            "description": preview.definition.description,
            "version": preview.version,
            "scope": preview.scope,
            "source": preview.source,
            "tools": list(preview.definition.tool_names),
            "profiles": list(preview.definition.profiles),
            "modelInvocable": preview.definition.model_invocable,
            "contentHash": preview.content_hash,
            "fileCount": preview.file_count,
            "totalBytes": preview.total_bytes,
            "expiresAt": int((preview.created_at + PREVIEW_TTL_SECONDS) * 1000),
            "replaceInstallationID": preview.replace_installation_id or None,
        }

    @staticmethod
    def _record_payload(record: dict[str, Any], path: Path) -> dict[str, Any]:
        snapshot = record.get("manifest_snapshot") if isinstance(record.get("manifest_snapshot"), dict) else {}
        source = snapshot.get("source") if isinstance(snapshot.get("source"), dict) else {}
        return {
            "id": record.get("external_installation_id"),
            "skillName": record.get("skill_name"),
            "displayName": record.get("display_name"),
            "description": record.get("description"),
            "scope": record.get("scope"),
            "sourceType": record.get("source_type"),
            "sourceUri": record.get("source_uri"),
            "sourceRef": record.get("source_ref"),
            "sourceSubpath": source.get("subpath") or "",
            "version": record.get("installed_version"),
            "contentHash": record.get("content_hash"),
            "enabled": bool(record.get("enabled")),
            "trustStatus": record.get("trust_status"),
            "builtin": False,
            "available": path.is_dir(),
            "installedAt": record.get("installed_at"),
            "updatedAt": record.get("updated_at"),
        }
