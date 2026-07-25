from __future__ import annotations

from html.parser import HTMLParser
import ipaddress
import os
import re
import socket
from typing import Any
import urllib.parse
import urllib.request
import zlib


_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "div",
    "dl",
    "dt",
    "dd",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul",
}
_IGNORED_TAGS = {"aside", "canvas", "footer", "nav", "noscript", "script", "style", "svg", "template"}
_ALLOWED_CONTENT_TYPES = (
    "text/",
    "application/json",
    "application/ld+json",
    "application/xhtml+xml",
    "application/xml",
)


def fetch_timeout_seconds() -> float:
    raw = os.environ.get("MON_AGENT_FETCH_TIMEOUT_MS", "20000").strip()
    try:
        timeout_ms = int(raw)
    except ValueError:
        timeout_ms = 20_000
    return min(max(timeout_ms, 1_000), 120_000) / 1_000


def fetch_max_bytes() -> int:
    raw = os.environ.get("MON_AGENT_FETCH_MAX_BYTES", "2097152").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 2 * 1024 * 1024
    return min(max(value, 64 * 1024), 10 * 1024 * 1024)


def _is_public_address(address: str) -> bool:
    value = ipaddress.ip_address(address.split("%", 1)[0])
    return not (
        value.is_private
        or value.is_loopback
        or value.is_link_local
        or value.is_multicast
        or value.is_reserved
        or value.is_unspecified
    )


def validate_public_http_url(url_text: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url_text)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"只支持 http/https URL: {url_text}")
    if parsed.username or parsed.password:
        raise ValueError("网页 URL 不允许携带用户名或密码")
    hostname = (parsed.hostname or "").strip().rstrip(".").lower()
    if not hostname:
        raise ValueError("网页 URL 缺少主机名")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise ValueError("出于安全原因，web_fetch 不允许访问本机或内部网络地址")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)}
    except socket.gaierror as error:
        raise ValueError(f"无法解析网页主机名 {hostname}: {error}") from error
    if not addresses or any(not _is_public_address(address) for address in addresses):
        raise ValueError("出于安全原因，web_fetch 不允许访问本机、私网或保留地址")
    return parsed


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        validate_public_http_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ReadableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self._ignored_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _IGNORED_TAGS:
            self._ignored_depth += 1
            return
        if self._ignored_depth:
            return
        if tag == "title":
            self._in_title = True
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("- ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _IGNORED_TAGS and self._ignored_depth:
            self._ignored_depth -= 1
            return
        if self._ignored_depth:
            return
        if tag == "title":
            self._in_title = False
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        if self._in_title:
            self.title_parts.append(data)
            return
        self.parts.append(data)

    def text(self) -> str:
        value = "".join(self.parts).replace("\r", "")
        value = re.sub(r"[ \t\f\v]+", " ", value)
        value = re.sub(r" *\n *", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()

    def title(self) -> str | None:
        value = re.sub(r"\s+", " ", "".join(self.title_parts)).strip()
        return value or None


def extract_html(raw: str) -> tuple[str | None, str]:
    parser = ReadableHTMLParser()
    parser.feed(raw)
    parser.close()
    return parser.title(), parser.text()


def _decode_body(raw: bytes, content_type: str) -> tuple[str, str]:
    match = re.search(r"charset\s*=\s*['\"]?([^;\s'\"]+)", content_type, re.I)
    candidates = [match.group(1) if match else "", "utf-8", "gb18030"]
    for charset in candidates:
        if not charset:
            continue
        try:
            return raw.decode(charset), charset
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8-replace"


def _read_limited(response: Any, max_bytes: int) -> tuple[bytes, bool]:
    raw = response.read(max_bytes + 1)
    return raw[:max_bytes], len(raw) > max_bytes


def _decompress_limited(raw: bytes, encoding: str, max_bytes: int) -> tuple[bytes, bool]:
    if encoding == "gzip":
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    elif encoding == "deflate":
        decoder = zlib.decompressobj()
    else:
        return raw, False
    value = decoder.decompress(raw, max_bytes + 1)
    return value[:max_bytes], len(value) > max_bytes or bool(decoder.unconsumed_tail)


def fetch_web_page(url_text: str) -> dict[str, Any]:
    validate_public_http_url(url_text)
    max_bytes = fetch_max_bytes()
    request = urllib.request.Request(
        url_text,
        headers={
            "accept": "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
            "accept-encoding": "gzip, deflate",
            "user-agent": os.environ.get("MON_AGENT_HTTP_USER_AGENT", "MonAgent/0.1"),
        },
    )
    opener = urllib.request.build_opener(SafeRedirectHandler())
    with opener.open(request, timeout=fetch_timeout_seconds()) as response:
        content_type = response.headers.get("content-type", "application/octet-stream").lower()
        content_encoding = response.headers.get("content-encoding", "").lower()
        final_url = response.url
        validate_public_http_url(final_url)
        if not any(content_type.startswith(prefix) for prefix in _ALLOWED_CONTENT_TYPES):
            raise ValueError(f"暂不支持抓取该内容类型: {content_type}")
        raw, transport_truncated = _read_limited(response, max_bytes)

    raw, decompressed_truncated = _decompress_limited(raw, content_encoding, max_bytes)
    truncated = transport_truncated or decompressed_truncated
    decoded, charset = _decode_body(raw, content_type)
    if "html" in content_type:
        title, body = extract_html(decoded)
    else:
        title, body = None, decoded.strip()
    return {
        "url": final_url,
        "contentType": content_type,
        "title": title,
        "body": body,
        "bytes": len(raw),
        "truncated": truncated,
        "charset": charset,
    }
