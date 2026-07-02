#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

echo "[项目根] $AGENT_ROOT"
echo
echo "========================================================"
echo "          MonAgent Server 环境检查工具 (Linux)"
echo "========================================================"
echo "Server 目录: $PROJECT_DIR"
echo

check_passed=true

echo "[1/4] 检查项目配置..."
if [[ -f "$PROJECT_DIR/pyproject.toml" ]]; then
    echo "  ✓ pyproject.toml 存在"
else
    echo "  ✗ 未找到 pyproject.toml"
    check_passed=false
fi
echo

echo "[2/4] 检查 UV..."
if command -v uv >/dev/null 2>&1; then
    echo "  ✓ $(uv --version)"
else
    echo "  ✗ UV 未安装"
    check_passed=false
fi
echo

echo "[3/4] 检查虚拟环境..."
VENV_PYTHON="$(venv_python_path)"
if [[ -x "$VENV_PYTHON" ]]; then
    echo "  ✓ 虚拟环境存在"
    echo "  ✓ Python: $("$VENV_PYTHON" --version)"
else
    echo "  ✗ 虚拟环境不存在或损坏: $VENV_PYTHON"
    echo "  提示: 运行 ./Script/EnvTools/linux/install_env.sh"
    check_passed=false
fi
echo

echo "[4/4] 检查关键依赖..."
if [[ -x "$VENV_PYTHON" ]]; then
    check_import "$VENV_PYTHON" "MonAgent Server" "import mon_agent_server; print('ok')" || check_passed=false
    check_import "$VENV_PYTHON" "MonAgent Core" "import mon_agent_core; print('ok')" || check_passed=false
    check_import "$VENV_PYTHON" "PyYAML" "import yaml; print(yaml.__version__)" || check_passed=false
    check_import "$VENV_PYTHON" "pyzmq" "import zmq; print(zmq.__version__)" || check_passed=false
else
    echo "  ✗ 无法检查依赖"
    check_passed=false
fi
echo

echo "========================================================"
if [[ "$check_passed" == true ]]; then
    status_line "[ENV_STATUS:INSTALLED]"
    echo "✓ 环境检查通过"
else
    status_line "[ENV_STATUS:NOT_INSTALLED]"
    echo "✗ 环境检查失败"
    echo "请执行: ./Script/EnvTools/linux/install_env.sh"
    exit 1
fi
