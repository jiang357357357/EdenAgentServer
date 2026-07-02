from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .app import AppState, is_agent_api_route
from .core import CoreAuthenticationExpiredError, read_auth_token, require_core_token
from .logging import get_logger
from .self_awake import run_self_awake_sync

http_logger = get_logger("MonAgent", "HTTP")
access_logger = get_logger("MonAgent", "Access")
core_logger = get_logger("MonAgent", "Core")

CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
}


class AgentHTTPServer(ThreadingHTTPServer):
    app: AppState


class AgentRequestHandler(BaseHTTPRequestHandler):
    server_version = "MonAgentPython/0.1"

    @property
    def app(self) -> AppState:
        return self.server.app  # type: ignore[attr-defined]

    def do_OPTIONS(self) -> None:
        self.json_response(True)

    def do_GET(self) -> None:
        self.handle_request()

    def do_POST(self) -> None:
        self.handle_request()

    def do_PATCH(self) -> None:
        self.handle_request()

    def log_message(self, format: str, *args: Any) -> None:
        access_logger.info(f"{self.client_address[0]} {self.command} {self.path} {format % args}")

    def handle_request(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = self.strip_api_prefix(parsed.path)
        try:
            if path == "/events" and self.command == "GET":
                self.event_stream_response()
                return
            if is_agent_api_route(path) or self.command != "GET":
                self.handle_api(path, urllib.parse.parse_qs(parsed.query))
                return
            if self.app.config.is_dev:
                self.proxy_to_vite(path, parsed.query)
                return
            self.json_response({"error": "Not found"}, 404)
        except CoreAuthenticationExpiredError as error:
            if error.detail != "not_authenticated":
                core_logger.warning(f"auth failed: {error.path} {error.detail}")
            self.json_response(
                {
                    "error": str(error),
                    "code": "core_authentication_expired",
                    "path": error.path,
                    "detail": error.detail,
                },
                error.status,
            )
        except Exception as error:
            http_logger.error(f"request failed: {error}", exc_info=True)
            self.json_response({"error": str(error)}, 500)

    def handle_api(self, path: str, query: dict[str, list[str]]) -> None:
        method = self.command
        if method == "GET" and path == "/session":
            token = require_core_token(self.headers)
            limit = self.query_int(query, "limit", 50)
            sessions = self.app.core_client.list_agent_sessions(token, limit)
            for session in sessions:
                self.app.store.upsert_session_info(session)
            self.json_response(sessions)
            return

        if method == "POST" and path == "/session":
            token = require_core_token(self.headers)
            body = self.read_json_body()
            session = self.app.store.create_session(str(body.get("title") or ""))
            self.app.mark_hydrated(session["id"])
            self.app.core_client.sync_agent_session(token, session)
            self.app.events.emit({"type": "session.created", "properties": {"sessionID": session["id"], "info": session}})
            self.json_response(session)
            return

        message_match = re.match(r"^/session/([^/]+)/message$", path)
        if message_match and method == "GET":
            session_id = urllib.parse.unquote(message_match.group(1))
            token = require_core_token(self.headers)
            if not self.app.runtime.is_running(session_id):
                self.app.hydrate(token, session_id)
            else:
                self.app.ensure_hydrated(token, session_id)
            self.json_response(self.app.store.list_messages(session_id, self.query_int(query, "limit", 100)))
            return

        if message_match and method == "POST":
            session_id = urllib.parse.unquote(message_match.group(1))
            token = require_core_token(self.headers)
            body = self.read_json_body()
            self.app.ensure_hydrated(token, session_id)
            message = self.app.runtime.append_user_only(session_id, body.get("parts") or [])
            self.app.core_client.sync_agent_message(token, self.app.store.require_session(session_id)["info"], message)
            self.json_response(True)
            return

        prompt_match = re.match(r"^/session/([^/]+)/prompt$", path)
        if prompt_match and method == "POST":
            session_id = urllib.parse.unquote(prompt_match.group(1))
            token = require_core_token(self.headers)
            body = self.read_json_body()
            self.app.ensure_hydrated(token, session_id)
            self.app.runtime.prompt_async(session_id, body.get("parts") or [], token)
            self.json_response(True)
            return

        if method == "GET" and path == "/permission":
            self.json_response(self.app.permissions.list())
            return

        permission_match = re.match(r"^/permission/([^/]+)/reply$", path)
        if permission_match and method == "POST":
            body = self.read_json_body()
            result = self.app.permissions.reply(
                urllib.parse.unquote(permission_match.group(1)),
                body.get("reply") or "reject",
                body.get("message"),
            )
            self.json_response(result)
            return

        if method == "GET" and path == "/question":
            self.json_response(self.app.questions.list())
            return

        question_reply_match = re.match(r"^/question/([^/]+)/reply$", path)
        if question_reply_match and method == "POST":
            body = self.read_json_body()
            result = self.app.questions.reply(urllib.parse.unquote(question_reply_match.group(1)), body.get("answers") or [])
            self.json_response(result)
            return

        question_reject_match = re.match(r"^/question/([^/]+)/reject$", path)
        if question_reject_match and method == "POST":
            result = self.app.questions.reject(urllib.parse.unquote(question_reject_match.group(1)))
            self.json_response(result)
            return

        if method == "GET" and path == "/tools/status":
            self.json_response(
                {
                    "search": {
                        "status": "online",
                        "provider": "python-agent-core",
                        "mode": "embedded",
                        "label": "Python AgentCore",
                        "message": "Python Agent Server 已启动；当前内置 Mon 工具、备忘录工具、自醒工具和 Python AgentCore 文件工具。",
                    },
                    "tools": {
                        "loaded_tools": "loaded_tools",
                        "web_search": "web_search",
                        "web_fetch": "web_fetch",
                        "ask_user": "ask_user",
                        "analyze_image": "analyze_image",
                        "analyze_screen": "analyze_screen",
                        "create_memo": "create_memo",
                        "create_reminder": "create_reminder",
                        "dispatch_due_memos": "dispatch_due_memos",
                        "set_self_awake_timer": "set_self_awake_timer",
                        "read": "read",
                        "grep": "grep",
                        "find": "find",
                        "ls": "ls",
                        "bash": "bash",
                        "edit": "edit",
                        "write": "write",
                    },
                }
            )
            return

        if method == "GET" and path == "/self-awake/runs":
            token = require_core_token(self.headers)
            if "page" in query or "page_size" in query:
                self.json_response(
                    self.app.core_client.list_self_awake_runs_page(
                        token,
                        page=self.query_int(query, "page", 1),
                        page_size=self.query_int(query, "page_size", self.query_int(query, "limit", 30)),
                        q=self.query_value(query, "q"),
                    )
                )
            else:
                self.json_response(self.app.core_client.list_self_awake_runs(token, self.query_int(query, "limit", 30)))
            return

        if method == "POST" and path == "/internal/self-awake/run":
            body = self.read_json_body()
            token = read_auth_token(self.headers)
            context = body.get("context") if isinstance(body.get("context"), dict) else {}
            decision = run_self_awake_sync(body, self.app, token)
            server_run_id = None
            server_error = ""
            if token:
                try:
                    persisted = self.app.core_client.persist_self_awake_run(token, decision, context)
                    server_run_id = persisted.get("id") if isinstance(persisted, dict) else None
                except Exception as error:
                    server_error = str(error)
            self.json_response({**decision, "server_run_id": server_run_id, "server_error": server_error})
            return

        if method == "GET" and path == "/memos":
            token = require_core_token(self.headers)
            self.json_response(
                self.app.core_client.list_memos(
                    token,
                    {
                        "kind": self.query_value(query, "kind"),
                        "status": self.query_value(query, "status"),
                        "priority": self.query_value(query, "priority"),
                        "q": self.query_value(query, "q"),
                        "limit": self.query_int(query, "limit", 80),
                    },
                )
            )
            return

        if method == "POST" and path == "/memos":
            token = require_core_token(self.headers)
            body = self.read_json_body()
            self.json_response(self.app.core_client.create_memo(token, {**body, "source": "monagent_ui"}), 201)
            return

        memo_match = re.match(r"^/memos/(\d+)$", path)
        if memo_match and method == "PATCH":
            token = require_core_token(self.headers)
            self.json_response(self.app.core_client.update_memo(token, int(memo_match.group(1)), self.read_json_body()))
            return

        if method == "GET" and path == "/memos/next-wake":
            token = require_core_token(self.headers)
            self.json_response(self.app.core_client.get_next_memo_wake(token, self.query_value(query, "after")))
            return

        if method == "POST" and path == "/memos/dispatch-due":
            token = require_core_token(self.headers)
            self.json_response(self.app.core_client.dispatch_due_memos(token, self.read_json_body()))
            return

        memo_action_match = re.match(r"^/memos/(\d+)/(complete|snooze|triggered)$", path)
        if memo_action_match and method == "POST":
            token = require_core_token(self.headers)
            memo_id = int(memo_action_match.group(1))
            action = memo_action_match.group(2)
            if action == "complete":
                self.json_response(self.app.core_client.complete_memo(token, memo_id))
            elif action == "snooze":
                self.json_response(self.app.core_client.snooze_memo(token, memo_id, self.read_json_body()))
            else:
                self.json_response(self.app.core_client.mark_memo_triggered(token, memo_id))
            return

        self.json_response({"error": "Not found"}, 404)

    def event_stream_response(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "keep-alive")
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        try:
            for frame in self.app.events.stream():
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def proxy_to_vite(self, path: str, query: str) -> None:
        target = f"http://localhost:{self.app.config.vite_port}{path}{'?' + query if query else ''}"
        try:
            with urllib.request.urlopen(target, timeout=15) as response:
                body = response.read()
                self.send_response(response.status)
                self.send_header("content-type", response.headers.get("content-type", "application/octet-stream"))
                self.send_header("content-length", str(len(body)))
                for key, value in CORS_HEADERS.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)
        except Exception:
            body = f"Vite dev server not running on :{self.app.config.vite_port}. Run: npm run dev:web".encode("utf-8")
            self.send_response(503)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def json_response(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length <= 0:
            return {}
        text = self.rfile.read(length).decode("utf-8", errors="replace")
        if not text.strip():
            return {}
        data = json.loads(text)
        return data if isinstance(data, dict) else {}

    @staticmethod
    def strip_api_prefix(path: str) -> str:
        if path == "/api":
            return "/"
        if path.startswith("/api/"):
            return path[4:]
        return path

    @staticmethod
    def query_value(query: dict[str, list[str]], key: str) -> str | None:
        values = query.get(key)
        return values[0] if values else None

    @classmethod
    def query_int(cls, query: dict[str, list[str]], key: str, fallback: int) -> int:
        value = cls.query_value(query, key)
        if value is None:
            return fallback
        try:
            return int(value)
        except ValueError:
            return fallback
