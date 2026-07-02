#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

echo "========================================================"
echo "          MonAgent Server 环境清理工具 (Linux)"
echo "========================================================"
echo "Server 目录: $PROJECT_DIR"
echo

cd "$PROJECT_DIR"
for path in ".venv" ".python-version"; do
    if [[ -e "$path" ]]; then
        rm -rf "$path"
        echo "✓ 已删除: $path"
    else
        echo "- 不存在: $path"
    fi
done

status_line "[REMOVE_STATUS:SUCCESS]"
