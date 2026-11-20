# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Process-wide signal that a session's list row or access may have changed.

Producers call :func:`notify` with the affected conversation ids after a
durable write or a live status change; any thread may call it. Consumers
such as the session-updates socket recompute only the rows a signal names
and keep a slow full rescan for changes no producer reports.

:func:`notify_access_changed` additionally advances :func:`access_epoch`.
:class:`BoundedGrant` reuses a successful stream authorization until that
epoch moves or :data:`STREAM_GRANT_MAX_AGE_S` passes, whichever is first.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
import weakref
from collections.abc import Awaitable, Callable, Iterator

# Revocation and scope changes no producer reports still apply within this bound.
STREAM_GRANT_MAX_AGE_S = 5.0

_lock = threading.Lock()
# custom-lint: disable-next=workspace-scoped-cache -- subscription objects are process-unique
_subscriptions: weakref.WeakSet[SessionChangeSubscription] = weakref.WeakSet()
_access_epoch = 0
# Indirection lets tests age a grant without patching the event loop's clock.
_clock = time.monotonic


class SessionChangeSubscription:
    """One consumer's pending changed ids, delivered on its own event loop."""

    def __init__(self, wake: asyncio.Event) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = wake
        self._pending: set[str] = set()

    def _deliver(self, conversation_ids: frozenset[str]) -> None:
        self._pending.update(conversation_ids)
        self._wake.set()

    def take(self) -> set[str]:
        """Return and clear the ids signalled since the previous call."""
        pending, self._pending = self._pending, set()
        return pending


@contextlib.contextmanager
def subscribe(wake: asyncio.Event) -> Iterator[SessionChangeSubscription]:
    """Receive changed ids until the block exits; *wake* is set on each delivery."""
    subscription = SessionChangeSubscription(wake)
    with _lock:
        _subscriptions.add(subscription)
    try:
        yield subscription
    finally:
        with _lock:
            _subscriptions.discard(subscription)


def notify(*conversation_ids: str | None) -> None:
    """Record that these sessions' list rows may have changed."""
    changed = frozenset(cid for cid in conversation_ids if cid)
    if not changed:
        return
    with _lock:
        subscriptions = list(_subscriptions)
    for subscription in subscriptions:
        # A consumer whose loop already closed is leaving; nothing to deliver.
        with contextlib.suppress(RuntimeError):
            subscription._loop.call_soon_threadsafe(subscription._deliver, changed)


def notify_access_changed(conversation_id: str | None = None) -> None:
    """Make every cached stream grant re-check before its next frame."""
    global _access_epoch
    with _lock:
        _access_epoch += 1
    notify(conversation_id)


def access_epoch() -> int:
    """Return the counter that every grant, admin or scope change advances."""
    with _lock:
        return _access_epoch


class BoundedGrant:
    """Reuse a successful authorization within the bounded staleness rule.

    A grant is reused until :func:`notify_access_changed` runs or
    :data:`STREAM_GRANT_MAX_AGE_S` passes; a denial is never cached.
    """

    def __init__(
        self,
        check: Callable[[], Awaitable[None]],
        *,
        max_age_s: float = STREAM_GRANT_MAX_AGE_S,
    ) -> None:
        self._check = check
        self._max_age_s = max_age_s
        self._epoch: int | None = None
        self._valid_until = 0.0

    async def __call__(self) -> None:
        # Sample before checking: a change that lands mid-check must not be cached over.
        epoch = access_epoch()
        now = _clock()
        if epoch == self._epoch and now < self._valid_until:
            return
        await self._check()
        self._epoch, self._valid_until = epoch, now + self._max_age_s
