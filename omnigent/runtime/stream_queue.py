# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded event storage shared by live subscriptions and socket memberships."""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from collections.abc import Callable
from typing import Any

MAX_STREAM_BYTES = 8 * 1024 * 1024


class EventTooLargeError(asyncio.QueueFull):
    """One event cannot fit; replaying it unchanged cannot recover this stream."""


class StreamEvent(dict[str, Any]):
    """An internal deadline travels with an event, never into its wire fields."""

    def __init__(
        self, event: dict[str, Any], deadline: float, check: Callable[[], None] | None = None
    ) -> None:
        super().__init__(event)
        self.deadline = deadline
        self.check = check if check is not None else getattr(event, "check", None)


class BoundedEventQueue(asyncio.Queue[Any]):
    """Count serialized bytes and oldest residence time as well as events."""

    def __init__(self, *, max_events: int, max_bytes: int, max_age: float) -> None:
        super().__init__(maxsize=max_events)
        self.max_bytes = max_bytes
        self.max_age = max_age
        self.bytes = 0
        self.last_taken_deadline = 0.0
        self._sizes: deque[tuple[int, float]] = deque()
        self._space_available = asyncio.Event()
        self._space_available.set()

    @property
    def expired(self) -> bool:
        return bool(self._sizes and time.monotonic() >= self._sizes[0][1])

    def put_nowait(self, item: Any) -> None:
        size = (
            len(json.dumps(item, separators=(",", ":"), ensure_ascii=True).encode())
            if isinstance(item, dict)
            else 0
        )
        if size > self.max_bytes:
            raise EventTooLargeError
        deadline = min(time.monotonic() + self.max_age, getattr(item, "deadline", float("inf")))
        if self.expired or deadline <= time.monotonic() or self.bytes + size > self.max_bytes:
            raise asyncio.QueueFull
        super().put_nowait(item)
        self._sizes.append((size, deadline))
        self.bytes += size

    def _get(self) -> Any:
        item = super()._get()
        size, self.last_taken_deadline = self._sizes.popleft()
        self.bytes -= size
        self._space_available.set()
        return item

    async def put(self, item: Any) -> None:
        """Wait for both byte and event capacity without resetting admission age."""
        deadline = min(time.monotonic() + self.max_age, getattr(item, "deadline", float("inf")))
        if isinstance(item, dict):
            item = StreamEvent(item, deadline)
        while True:
            try:
                self.put_nowait(item)
                return
            except EventTooLargeError:
                raise
            except asyncio.QueueFull:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.expired:
                    raise TimeoutError("Stream queue admission expired") from None
                self._space_available.clear()
                await asyncio.wait_for(self._space_available.wait(), timeout=remaining)

    def clear(self) -> None:
        while not self.empty():
            self.get_nowait()
