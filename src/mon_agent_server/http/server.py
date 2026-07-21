from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from ..app import AppState, is_agent_api_route
from ..core import CoreAuthenticationExpiredError, require_core_token
from ..logging import get_logger
from .routes import API_ROUTE_HANDLERS

http_logger = get_logger("MonAgent", "HTTP")
access_logger = get_logger("MonAgent", "Access")
core_logger = get_logger("MonAgent", "Core")

CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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

    def do_PUT(self) -> None:
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
        except (BrokenPipeError, ConnectionResetError):
            http_logger.info(f"client disconnected before response: {self.command} {self.path}")
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
        for route_handler in API_ROUTE_HANDLERS:
            if route_handler(self, path, query, method):
                return
        self.json_response({"error": "Not found"}, 404)

    def event_stream_response(self) -> None:
        token = require_core_token(self.headers)
        self.app.core_client.get_user_profile(token)
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
