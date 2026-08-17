from __future__ import annotations

import json
import sys
from typing import Any

from .web import web_search
from .web_fetcher import fetch_web_page


def run(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "")
    params = request.get("params") if isinstance(request.get("params"), dict) else {}
    if action == "open":
        return fetch_web_page(str(params.get("url") or ""))
    if action == "search":
        domains = params.get("domains")
        return web_search(
            str(params.get("query") or ""),
            int(params.get("max_results") or 5),
            params.get("language"),
            params.get("time_range"),
            None,
            domains if isinstance(domains, list) else None,
        )
    raise ValueError(f"未知 Web 工作进程操作：{action}")


def main() -> int:
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("Web 工作进程请求必须是对象")
        envelope = {"ok": True, "result": run(request)}
    except Exception as error:
        envelope = {"ok": False, "error": str(error)}
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
