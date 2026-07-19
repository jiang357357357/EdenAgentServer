from __future__ import annotations

from typing import Any

from ...core import require_core_token
from ...runtime.config import runtime_context_window


def _compact_label(entity: dict[str, Any]) -> str:
    name = str(entity.get("ai_name") or "").strip()
    model_id = str(entity.get("ai_model") or "").strip()
    if name:
        return name
    return model_id or f"AI {entity.get('id')}"


def _vendor_info(vendors: dict[str, Any], vendor: str) -> dict[str, Any]:
    info = vendors.get(vendor)
    return info if isinstance(info, dict) else {}


def _model_option(entity: dict[str, Any], current_id: Any, vendors: dict[str, Any]) -> dict[str, Any]:
    entity_id = entity.get("id")
    vendor = str(entity.get("vendor") or "").strip()
    vendor_info = _vendor_info(vendors, vendor)
    model_id = str(entity.get("ai_model") or "").strip()
    return {
        "id": str(entity_id),
        "aiEntityId": entity_id,
        "label": _compact_label(entity),
        "name": str(entity.get("ai_name") or "").strip(),
        "provider": vendor,
        "providerName": str(vendor_info.get("name") or vendor or "未知服务商"),
        "providerIcon": str(vendor_info.get("icon") or vendor or ""),
        "supportedModels": vendor_info.get("models") if isinstance(vendor_info.get("models"), list) else [],
        "modelID": model_id,
        "status": entity.get("status") or "",
        "isMultimodal": bool(entity.get("is_multimodal")),
        "contextWindow": runtime_context_window(entity),
        "selected": str(entity_id) == str(current_id),
    }


def _model_payload(handler: Any, token: str) -> dict[str, Any]:
    assistant = handler.app.core_client.get_current_assistant(token)
    character = assistant.get("character") if isinstance(assistant, dict) else None
    if not isinstance(character, dict) or not character.get("id"):
        raise RuntimeError("当前助手没有绑定角色，请先在 Core 助手管理中绑定角色。")

    current_id = character.get("ai_talk_entity_id")
    vendors = handler.app.core_client.list_service_vendors(token, "ai")
    entities = handler.app.core_client.list_ai_entities(token)
    options = [_model_option(entity, current_id, vendors) for entity in entities if isinstance(entity, dict)]
    current = next((option for option in options if option["selected"]), None)

    if current is None and current_id:
        entity = handler.app.core_client.get_ai_entity(token, current_id)
        current = _model_option(entity, current_id, vendors) if entity else None
        if current and not any(option["id"] == current["id"] for option in options):
            options.insert(0, current)

    return {
        "source": "core",
        "serviceType": "ai",
        "vendors": vendors,
        "assistant": {
            "id": assistant.get("id"),
            "name": assistant.get("name") or "",
        },
        "character": {
            "id": character.get("id"),
            "name": character.get("name") or "",
        },
        "current": current,
        "options": options,
    }


def handle_model(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if path != "/model":
        return False

    token = require_core_token(handler.headers)
    if method == "GET":
        handler.json_response(_model_payload(handler, token))
        return True

    if method == "PATCH":
        body = handler.read_json_body()
        ai_entity_id = body.get("aiEntityId") or body.get("id")
        if ai_entity_id in (None, ""):
            raise RuntimeError("缺少 aiEntityId")

        payload = _model_payload(handler, token)
        character_id = (payload.get("character") or {}).get("id")
        if not character_id:
            raise RuntimeError("当前助手没有绑定角色，请先在 Core 助手管理中绑定角色。")

        handler.app.core_client.update_character(token, character_id, {"ai_talk_entity_id": int(ai_entity_id)})
        handler.json_response(_model_payload(handler, token))
        return True

    return False
