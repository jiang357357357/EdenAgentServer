from __future__ import annotations

import asyncio
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
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
GENERATED_RESOURCE_ROOTS = {"scripts", "references", "assets", "agents"}
GENERATED_FORBIDDEN_NAMES = {
    "README.md",
    "INSTALLATION_GUIDE.md",
    "QUICK_REFERENCE.md",
    "CHANGELOG.md",
}


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


def _generated_file_path(value: Any) -> Path:
    raw = str(value or "").strip().replace("\\", "/")
    relative = Path(raw)
    if (
        not raw
        or relative.is_absolute()
        or ".." in relative.parts
        or len(relative.parts) < 2
        or relative.parts[0] not in GENERATED_RESOURCE_ROOTS
        or any(part in {"", "."} or part.startswith(".") for part in relative.parts)
    ):
        raise ValueError(
            "技能资源路径必须位于 scripts/、references/、assets/ 或 agents/ 下，且不能包含隐藏目录或上级目录"
        )
    if relative.name in GENERATED_FORBIDDEN_NAMES:
        raise ValueError(f"技能包不应包含额外文档：{relative.name}")
    return relative


def _write_generated_files(root: Path, raw_files: Any) -> list[str]:
    if raw_files in (None, []):
        return []
    if not isinstance(raw_files, list):
        raise ValueError("files 必须是技能资源文件数组")
    written: list[str] = []
    seen: set[str] = set()
    for raw_file in raw_files:
        if not isinstance(raw_file, dict):
            raise ValueError("每个技能资源文件必须是对象")
        relative = _generated_file_path(raw_file.get("path"))
        key = relative.as_posix()
        if key in seen:
            raise ValueError(f"技能资源路径重复：{key}")
        seen.add(key)
        encoding = str(raw_file.get("encoding") or "utf-8").strip().lower()
        content = raw_file.get("content")
        if not isinstance(content, str):
            raise ValueError(f"技能资源 content 必须是字符串：{key}")
        if encoding == "utf-8":
            data = content.encode("utf-8")
        elif encoding == "base64":
            try:
                data = base64.b64decode(content, validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError(f"技能资源不是有效 Base64：{key}") from error
        else:
            raise ValueError(f"技能资源 encoding 只支持 utf-8 或 base64：{key}")
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"技能文件超过 10MB：{key}")
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        if bool(raw_file.get("executable")):
            if relative.parts[0] != "scripts":
                raise ValueError(f"只有 scripts/ 下的文件可以标记 executable：{key}")
            destination.chmod(0o755)
        written.append(key)
    return written


def _short_skill_description(description: str) -> str:
    value = description.strip().replace("\n", " ")
    if len(value) < 25:
        value = f"{value}；为相关任务提供可复用且可靠的工作流程。"
    return value if len(value) <= 64 else value[:61].rstrip() + "..."


def _validate_agent_metadata(root: Path, skill_name: str) -> None:
    target = root / "agents" / "openai.yaml"
    try:
        data = yaml.safe_load(target.read_text(encoding="utf-8")) or {}
    except Exception as error:
        raise ValueError("agents/openai.yaml 不是有效 YAML") from error
    interface = data.get("interface") if isinstance(data, dict) else None
    if not isinstance(interface, dict):
        raise ValueError("agents/openai.yaml 缺少 interface")
    for field in ("display_name", "short_description", "default_prompt"):
        if not isinstance(interface.get(field), str) or not str(interface[field]).strip():
            raise ValueError(f"agents/openai.yaml 缺少 interface.{field}")
    short_description = str(interface["short_description"]).strip()
    if not 25 <= len(short_description) <= 64:
        raise ValueError("agents/openai.yaml 的 short_description 必须为 25–64 个字符")
    if f"${skill_name}" not in str(interface["default_prompt"]):
        raise ValueError(f"agents/openai.yaml 的 default_prompt 必须明确提及 ${skill_name}")


def _write_agent_metadata(
    root: Path,
    skill_name: str,
    display_name: str,
    description: str,
    default_prompt: str,
) -> None:
    target = root / "agents" / "openai.yaml"
    if target.exists():
        _validate_agent_metadata(root, skill_name)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    prompt = default_prompt.strip() or "完成当前任务。"
    if f"${skill_name}" not in prompt:
        prompt = f"使用 ${skill_name} 技能：{prompt}"
    # JSON string literals are valid YAML quoted scalars. Keep keys unquoted to
    # match Codex's agents/openai.yaml interface format exactly.
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    target.write_text(
        "\n".join(
            (
                "interface:",
                f"  display_name: {quote(display_name)}",
                f"  short_description: {quote(_short_skill_description(description))}",
                f"  default_prompt: {quote(prompt)}",
                "",
            )
        ),
        encoding="utf-8",
    )
    _validate_agent_metadata(root, skill_name)


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
    coroutine = load_skills(LocalExecutionEnv(root), str(root))
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        result = asyncio.run(coroutine)
    else:
        # Candidate creation is exposed as an agent tool and therefore normally
        # runs inside AgentCore's event loop. Keep the synchronous installer API
        # while giving the async skill loader its own loop in a worker thread.
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="skill-validation") as executor:
            result = executor.submit(asyncio.run, coroutine).result()
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

    def inspect_generated(self, owner_id: object, payload: dict[str, Any]) -> dict[str, Any]:
        """Build and validate a complete model-authored skill package."""
        owner_key = owner_storage_key(owner_id)
        scope = str(payload.get("scope") or "user").strip()
        name = str(payload.get("name") or "").strip()
        description = str(payload.get("description") or "").strip()
        instructions = str(payload.get("instructions") or "").strip()
        display_name = str(payload.get("display_name") or name).strip()
        version = str(payload.get("version") or "1.0.0").strip()
        tools = _string_tuple(payload.get("tools"))
        profiles = _string_tuple(payload.get("profiles"), ("user_chat",))
        if scope not in {"user", "project"}:
            raise ValueError("scope 必须是 user 或 project")
        if not SKILL_NAME_PATTERN.fullmatch(name):
            raise ValueError("技能 name 只能包含小写字母、数字和单个连字符")
        if not description:
            raise ValueError("技能 description 不能为空")
        if not instructions:
            raise ValueError("技能 instructions 不能为空")

        root = skill_roots(self.workspace_root, owner_key)[scope]
        preview_id = f"skill_preview_{uuid.uuid4().hex}"
        checkout = root / ".staging" / preview_id / "checkout"
        checkout.mkdir(parents=True, exist_ok=False)
        frontmatter = {
            "name": name,
            "description": description,
            "metadata": {
                "monagent": {
                    "display_name": display_name,
                    "version": version,
                    "tools": list(tools),
                    "profiles": list(profiles),
                }
            },
        }
        skill_text = f"---\n{yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False)}---\n\n{instructions}\n"
        (checkout / "SKILL.md").write_text(skill_text, encoding="utf-8")
        try:
            written_files = _write_generated_files(checkout, payload.get("files"))
            _write_agent_metadata(
                checkout,
                name,
                display_name,
                description,
                str(payload.get("default_prompt") or ""),
            )
            file_count, total_bytes = _validate_tree(checkout)
            known_tools = {
                tool.name
                for profile in ("user_chat", "self_awake")
                for tool in create_mon_agent_tools(self.workspace_root, MonToolContext(), profile)
            }
            definition, normalized_version = _definition_from_directory(checkout, known_tools)
            preview = SkillPreview(
                preview_id=preview_id,
                owner_key=owner_key,
                scope=scope,
                source={"type": "generated", "uri": f"generated:{name}", "ref": "", "subpath": ""},
                stage_dir=checkout,
                definition=definition,
                version=normalized_version,
                content_hash=_content_hash(checkout),
                file_count=file_count,
                total_bytes=total_bytes,
                created_at=time.time(),
            )
            with self._lock:
                self._discard_expired_previews()
                self._previews[preview_id] = preview
            result = self._preview_payload(preview)
            result["generatedFiles"] = written_files
            return result
        except Exception:
            shutil.rmtree(checkout.parent, ignore_errors=True)
            raise

    def create_generated(
        self,
        owner_id: object,
        token: str,
        device_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate and atomically create or update a model-authored skill."""
        preview_payload = self.inspect_generated(owner_id, payload)
        preview_id = str(preview_payload["previewID"])
        name = str(preview_payload["skillName"])
        scope = str(preview_payload["scope"])
        existing = next(
            (
                record
                for record in self._list_records(token, device_id)
                if record.get("skill_name") == name and record.get("scope") == scope
            ),
            None,
        )
        if existing:
            with self._lock:
                preview = self._previews.get(preview_id)
                if preview is not None:
                    preview.replace_installation_id = str(existing.get("external_installation_id") or "")
        try:
            return self.install(owner_id, token, device_id, preview_id)
        except Exception:
            with self._lock:
                abandoned = self._previews.pop(preview_id, None)
            if abandoned is not None:
                shutil.rmtree(abandoned.stage_dir.parent, ignore_errors=True)
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
            "fileCount": preview.file_count,
            "totalBytes": preview.total_bytes,
            "enabled": preview.enabled,
            "trustStatus": "trusted",
            "deviceID": device_id,
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
        if (record.get("source_type") or source.get("type")) == "generated":
            raise ValueError("智能体生成的技能请通过技能创建流程直接更新。")
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
        records = self._list_records(token, device_id)
        roots = skill_roots(self.workspace_root, owner_key)
        records = self._reconcile_local_records(token, device_id, roots, records)
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
        installed_names: dict[str, list[str]] = {}
        for record in records:
            installed_names.setdefault(str(record.get("skill_name") or ""), []).append(str(record.get("scope") or "user"))
        for record in records:
            scope = str(record.get("scope") or "user")
            path = roots.get(scope, roots["user"]) / str(record.get("skill_name") or "")
            payload = self._record_payload(record, path)
            scopes = installed_names.get(str(record.get("skill_name") or ""), [])
            payload["shadowed"] = scope == "user" and "project" in scopes
            items.append(payload)
        return items

    def list_for_model(
        self,
        owner_id: object,
        token: str,
        device_id: str,
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Return a compact, truthful skill inventory for model-facing tools."""
        filters = filters or {}
        kind = str(filters.get("kind") or "all").strip()
        scope = str(filters.get("scope") or "all").strip()
        enabled = str(filters.get("enabled") or "all").strip()
        if kind not in {"all", "builtin", "generated", "installed"}:
            raise ValueError("kind 必须是 all、builtin、generated 或 installed")
        if scope not in {"all", "system", "user", "project"}:
            raise ValueError("scope 必须是 all、system、user 或 project")
        if enabled not in {"all", "enabled", "disabled"}:
            raise ValueError("enabled 必须是 all、enabled 或 disabled")

        def matches(item: dict[str, Any]) -> bool:
            source_type = str(item.get("sourceType") or "")
            is_builtin = bool(item.get("builtin"))
            if kind == "builtin" and not is_builtin:
                return False
            if kind == "generated" and source_type != "generated":
                return False
            if kind == "installed" and (is_builtin or source_type == "generated"):
                return False
            if scope != "all" and str(item.get("scope") or "") != scope:
                return False
            if enabled == "enabled" and not bool(item.get("enabled")):
                return False
            if enabled == "disabled" and bool(item.get("enabled")):
                return False
            return True

        fields = (
            "id",
            "skillName",
            "displayName",
            "description",
            "scope",
            "sourceType",
            "version",
            "enabled",
            "trustStatus",
            "builtin",
            "available",
            "shadowed",
            "fileCount",
            "totalBytes",
        )
        return [
            {field: item.get(field) for field in fields if field in item}
            for item in self.list(owner_id, token, device_id)
            if matches(item)
        ]

    def details(self, owner_id: object, token: str, device_id: str, installation_id: str) -> dict[str, Any]:
        owner_key = owner_storage_key(owner_id)
        record = self._find_record(token, device_id, installation_id)
        scope = str(record.get("scope") or "user")
        path = skill_roots(self.workspace_root, owner_key)[scope] / str(record.get("skill_name") or "")
        payload = self._record_payload(record, path)
        payload["manifest"] = self._read_manifest(path) if path.is_dir() else {}
        skill_file = path / "SKILL.md"
        payload["content"] = skill_file.read_text(encoding="utf-8") if skill_file.is_file() else ""
        payload["files"] = [
            item.relative_to(path).as_posix()
            for item in sorted(path.rglob("*"))
            if item.is_file() and item.name != INSTALLATION_MANIFEST
        ] if path.is_dir() else []
        return payload

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
            (item for item in self._list_records(token, device_id) if item.get("external_installation_id") == installation_id),
            None,
        )
        if not record:
            raise ValueError("技能安装记录不存在")
        return record

    def _list_records(self, token: str, device_id: str) -> list[dict[str, Any]]:
        """Return every installation owned by the user on this local runtime."""
        return list(self.core_client.list_skill_installations(token, None))

    def _reconcile_local_records(
        self,
        token: str,
        device_id: str,
        roots: dict[str, Path],
        records: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Restore missing Core metadata from trusted local installation manifests."""
        known = {str(item.get("external_installation_id") or "") for item in records}
        known_tools = {
            tool.name
            for profile in ("user_chat", "self_awake")
            for tool in create_mon_agent_tools(self.workspace_root, MonToolContext(), profile)
        }
        for scope, root in roots.items():
            if not root.is_dir():
                continue
            for path in sorted(root.iterdir()):
                manifest_path = path / INSTALLATION_MANIFEST
                if not path.is_dir() or not manifest_path.is_file():
                    continue
                try:
                    manifest = self._read_manifest(path)
                    installation_id = str(manifest.get("installationID") or "")
                    if not installation_id or installation_id in known:
                        continue
                    definition, version = _definition_from_directory(path, known_tools)
                    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
                    record = self.core_client.upsert_skill_installation(
                        token,
                        {
                            "external_installation_id": installation_id,
                            "device_id": str(manifest.get("deviceID") or device_id or "local"),
                            "skill_name": definition.id,
                            "display_name": definition.name,
                            "description": definition.description,
                            "scope": scope,
                            "source_type": str(source.get("type") or "local"),
                            "source_uri": str(source.get("uri") or ""),
                            "source_ref": str(source.get("ref") or ""),
                            "installed_version": str(manifest.get("version") or version),
                            "content_hash": str(manifest.get("contentHash") or _content_hash(path)),
                            "enabled": bool(manifest.get("enabled", True)),
                            "trust_status": str(manifest.get("trustStatus") or "trusted"),
                            "manifest_snapshot": manifest,
                        },
                    )
                    records.append(record)
                    known.add(installation_id)
                except Exception:
                    continue
        return records

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
            "fileCount": snapshot.get("fileCount"),
            "totalBytes": snapshot.get("totalBytes"),
            "enabled": bool(record.get("enabled")),
            "trustStatus": record.get("trust_status"),
            "builtin": False,
            "available": path.is_dir(),
            "installedAt": record.get("installed_at"),
            "updatedAt": record.get("updated_at"),
        }
