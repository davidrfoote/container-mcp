"""
Session status state machine.

Valid statuses and their allowed transitions:
  pending         -> active, failed
  active          -> awaiting_approval, completed, failed
  awaiting_approval -> active, failed
  completed       -> (terminal)
  failed          -> (terminal)
"""

TRANSITIONS: dict[str, list[str]] = {
    "pending": ["active", "failed"],
    "active": ["awaiting_approval", "completed", "failed"],
    "awaiting_approval": ["active", "failed"],
    "completed": [],
    "failed": [],
}


def can_transition(current: str, target: str) -> bool:
    """Return True if transitioning from current to target is allowed."""
    allowed = TRANSITIONS.get(current, [])
    return target in allowed


def next_allowed(current: str) -> list[str]:
    """Return list of valid next statuses from current."""
    return TRANSITIONS.get(current, [])
