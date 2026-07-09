from . import openai_compatible as _openai_compatible

globals().update({name: getattr(_openai_compatible, name) for name in dir(_openai_compatible) if not name.startswith("__")})
__all__ = [name for name in dir(_openai_compatible) if not name.startswith("__")]
