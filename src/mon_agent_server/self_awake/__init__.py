from . import config as _config
from . import environment as _environment
from . import render as _render
from . import runner as _runner

globals().update({name: getattr(_config, name) for name in dir(_config) if not name.startswith("__")})
globals().update({name: getattr(_environment, name) for name in dir(_environment) if not name.startswith("__")})
globals().update({name: getattr(_render, name) for name in dir(_render) if not name.startswith("__")})
globals().update({name: getattr(_runner, name) for name in dir(_runner) if not name.startswith("__")})


def build_self_awake_environment(*args, **kwargs):
    _environment.self_awake_now = globals()["self_awake_now"]
    return _environment.build_self_awake_environment(*args, **kwargs)


async def run_self_awake_agent(*args, **kwargs):
    _runner.Agent = globals()["Agent"]
    _runner.create_mon_agent_tools = globals()["create_mon_agent_tools"]
    return await _runner.run_self_awake_agent(*args, **kwargs)


def run_self_awake_and_persist_sync(*args, **kwargs):
    _runner.run_self_awake_sync = globals()["run_self_awake_sync"]
    _runner.update_self_awake_timer_from_decision = globals()["update_self_awake_timer_from_decision"]
    return _runner.run_self_awake_and_persist_sync(*args, **kwargs)


def start_self_awake_run_async(*args, **kwargs):
    _runner.threading = globals()["threading"]
    _runner.run_self_awake_and_persist_sync = globals()["run_self_awake_and_persist_sync"]
    return _runner.start_self_awake_run_async(*args, **kwargs)


__all__ = [
    *[name for name in dir(_config) if not name.startswith("__")],
    *[name for name in dir(_environment) if not name.startswith("__")],
    *[name for name in dir(_render) if not name.startswith("__")],
    *[name for name in dir(_runner) if not name.startswith("__")],
]
