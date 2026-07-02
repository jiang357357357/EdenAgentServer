from __future__ import annotations


LEVEL_VALUES = {
    "DEBUG": 10,
    "INFO": 20,
    "WARNING": 30,
    "ERROR": 40,
    "CRITICAL": 50,
}


def normalize_level(name: str) -> str:
    return str(name or "INFO").upper()


def get_level_value(name: str) -> int:
    return LEVEL_VALUES.get(normalize_level(name), 20)
