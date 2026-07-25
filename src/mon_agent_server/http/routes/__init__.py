from .memos import handle_memos
from .model import handle_model
from .permissions import handle_permissions
from .questions import handle_questions
from .screen_capture import handle_screen_capture
from .self_awake import handle_self_awake
from .sessions import handle_sessions
from .speech import handle_speech
from .skills import handle_skills
from .tools import handle_tools

API_ROUTE_HANDLERS = (
    handle_sessions,
    handle_speech,
    handle_permissions,
    handle_questions,
    handle_screen_capture,
    handle_tools,
    handle_skills,
    handle_model,
    handle_self_awake,
    handle_memos,
)

__all__ = ["API_ROUTE_HANDLERS"]
