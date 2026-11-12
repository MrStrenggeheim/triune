"""Personal session orchestration preference, independent of shared configuration."""

from typing import Protocol


class OrchestrationPreferenceStore(Protocol):
    def get_enabled(self, *, user_id: str | None) -> bool:
        """Return the personal preference, defaulting to enabled."""
        ...

    def set_enabled(self, enabled: bool, *, user_id: str | None) -> bool:
        """Persist the preference for the active account and workspace."""
        ...
