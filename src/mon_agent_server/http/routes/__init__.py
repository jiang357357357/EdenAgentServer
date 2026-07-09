from .memos import handle_memos
from .model import handle_model
from .permissions import handle_permissions
from .questions import handle_questions
from .self_awake import handle_self_awake
from .sessions import handle_sessions
from .tools import handle_tools

API_ROUTE_HANDLERS = (
    handle_sessions,
    handle_permissions,
    handle_questions,
    handle_tools,
    handle_model,
    handle_self_awake,
    handle_memos,
)

__all__ = ["API_ROUTE_HANDLERS"]
