from . import config as _config
from . import environment as _environment
from . import render as _render
from . import runner as _runner

globals().update({name: getattr(_config, name) for name in dir(_config) if not name.startswith("__")})
globals().update({name: getattr(_environment, name) for name in dir(_environment) if not name.startswith("__")})
globals().update({name: getattr(_render, name) for name in dir(_render) if not name.startswith("__")})
globals().update({name: getattr(_runner, name) for name in dir(_runner) if not name.startswith("__")})

_build_self_awake_environment_impl = _environment.build_self_awake_environment
_run_self_awake_agent_impl = _runner.run_self_awake_agent
_run_self_awake_and_persist_sync_impl = _runner.run_self_awake_and_persist_sync
_start_self_awake_run_async_impl = _runner.start_self_awake_run_async


def build_self_awake_environment(*args, **kwargs):
    _environment.self_awake_now = globals()["self_awake_now"]
    return _build_self_awake_environment_impl(*args, **kwargs)


async def run_self_awake_agent(*args, **kwargs):
    _runner.Agent = globals()["Agent"]
    _runner.create_mon_agent_tools = globals()["create_mon_agent_tools"]
    return await _run_self_awake_agent_impl(*args, **kwargs)


def run_self_awake_and_persist_sync(*args, **kwargs):
    _runner.run_self_awake_sync = globals()["run_self_awake_sync"]
    return _run_self_awake_and_persist_sync_impl(*args, **kwargs)


def start_self_awake_run_async(*args, **kwargs):
    _runner.threading = globals()["threading"]
    _runner.run_self_awake_and_persist_sync = globals()["run_self_awake_and_persist_sync"]
    return _start_self_awake_run_async_impl(*args, **kwargs)


__all__ = [
    *[name for name in dir(_config) if not name.startswith("__")],
    *[name for name in dir(_environment) if not name.startswith("__")],
    *[name for name in dir(_render) if not name.startswith("__")],
    *[name for name in dir(_runner) if not name.startswith("__")],
]
