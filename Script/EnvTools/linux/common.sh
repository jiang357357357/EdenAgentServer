#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AGENT_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"

status_line() {
    printf '%s\n' "$1"
}

ensure_pyproject() {
    if [[ ! -f "$PROJECT_DIR/pyproject.toml" ]]; then
        echo "✗ 未在项目目录找到 pyproject.toml"
        echo "当前目录: $PROJECT_DIR"
        return 1
    fi
}

ensure_uv() {
    if command -v uv >/dev/null 2>&1; then
        return 0
    fi

    echo "✗ UV 未安装"
    echo "请先安装 UV: pip install uv"
    return 1
}

venv_python_path() {
    echo "$PROJECT_DIR/.venv/bin/python"
}

check_import() {
    local python_bin="$1"
    local label="$2"
    local code="$3"

    if result="$("$python_bin" -c "$code" 2>/dev/null)"; then
        echo "  ✓ $label: $result"
        return 0
    fi

    echo "  ✗ $label 未安装"
    return 1
}
