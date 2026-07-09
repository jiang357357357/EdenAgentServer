from . import loader as _loader

globals().update({name: getattr(_loader, name) for name in dir(_loader) if not name.startswith("__")})
__all__ = [name for name in dir(_loader) if not name.startswith("__")]
