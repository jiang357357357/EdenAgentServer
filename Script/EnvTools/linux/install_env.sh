#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

if ! ensure_pyproject; then
    status_line "[INSTALL_STATUS:FAILED]"
    exit 1
fi

echo
echo "========================================================"
echo "          MonAgent Server 环境安装工具 (Linux)"
echo "========================================================"
echo "Agent 根目录: $AGENT_ROOT"
echo "Server 目录: $PROJECT_DIR"
echo "虚拟环境: $PROJECT_DIR/.venv"
echo

cd "$PROJECT_DIR"

echo "[1/4] 检查 UV 包管理器..."
if ! command -v uv >/dev/null 2>&1; then
    echo "✗ UV 未安装，正在自动安装..."
    python3 -m pip install uv
    if ! command -v uv >/dev/null 2>&1; then
        echo "✗ UV 安装失败"
        status_line "[INSTALL_STATUS:FAILED]"
        exit 1
    fi
fi
echo "✓ UV 已就绪: $(uv --version)"
echo

echo "[2/4] 安装并固定 Python 3.12.6..."
uv python install 3.12.6
uv python pin 3.12.6
echo "✓ Python 版本已固定为 3.12.6"
echo

echo "[3/4] 同步依赖并创建虚拟环境..."
uv sync
echo "✓ 依赖同步完成"
echo

echo "[4/4] 验证安装..."
VENV_PYTHON="$(venv_python_path)"
if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "✗ 虚拟环境 Python 不存在: $VENV_PYTHON"
    status_line "[INSTALL_STATUS:FAILED]"
    exit 1
fi

echo "✓ Python: $("$VENV_PYTHON" --version)"
check_import "$VENV_PYTHON" "MonAgent Server" "import mon_agent_server; print('ok')"
check_import "$VENV_PYTHON" "MonAgent Core" "import mon_agent_core; print('ok')"
check_import "$VENV_PYTHON" "PyYAML" "import yaml; print(yaml.__version__)"
check_import "$VENV_PYTHON" "pyzmq" "import zmq; print(zmq.__version__)"
echo

echo "========================================================"
echo "✓ MonAgent Server 环境安装完成"
echo "========================================================"
status_line "[INSTALL_STATUS:SUCCESS]"
echo "启动服务:"
echo "  uv run python -m mon_agent_server"
