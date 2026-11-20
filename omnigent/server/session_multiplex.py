# Modified for Triune.
"""Socket-owned transcript memberships on the existing session-list WebSocket."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from collections import deque
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, cast

import anyio
from fastapi import APIRouter, Request, WebSocket
from fastapi.routing import APIRoute

from omnigent.errors import OmnigentError
from omnigent.runtime import session_stream
from omnigent.runtime.stream_queue import (
    MAX_STREAM_BYTES,
    BoundedEventQueue,
    EventTooLargeError,
    StreamEvent,
)
from omnigent.server import presence
from omnigent.server.session_recovery import valid_window_options, validate_sync_complete
from omnigent.server.stream_observation import new_wire_observation

_logger = logging.getLogger(__name__)
MAX_MEMBERSHIPS = 32
_MEMBER_MAX_EVENTS = 128
_MEMBER_MAX_BYTES = MAX_STREAM_BYTES
_MEMBER_MAX_AGE_S = 15.0
_WRITE_TIMEOUT_S = 5.0
_AUTH_HANDOFF_TIMEOUT_S = 1.0


@dataclass
class _Membership:
    task: asyncio.Task[None] | None = None
    presence: dict[str, Any] = field(default_factory=dict)
    subscription_id: str | None = None
    item_references: bool = False
    closed: bool = False
    authorize: Callable[[], Awaitable[None]] | None = None

    def envelope(self, session_id: str, kind: str, **payload: Any) -> dict[str, Any]:
        return {
            "type": kind,
            "session_id": session_id,
            **({"subscription_id": self.subscription_id} if self.subscription_id else {}),
            **payload,
        }

    queue: BoundedEventQueue = field(
        default_factory=lambda: BoundedEventQueue(
            max_events=_MEMBER_MAX_EVENTS,
            max_bytes=_MEMBER_MAX_BYTES,
            max_age=_MEMBER_MAX_AGE_S,
        )
    )


class _MembershipRequest(Request):
    def __init__(self, websocket: WebSocket, membership: _Membership) -> None:
        scope = {
            **websocket.scope,
            "type": "http",
            "method": "GET",
            "state": dict(websocket.scope.get("state", {})),
        }
        super().__init__(scope)
        self.membership = membership
        self.state.presence_membership = membership.presence
        self.state.multiplex = True
        self.state.feed_v2 = membership.subscription_id is not None
        self.state.item_references = membership.item_references

    async def is_disconnected(self) -> bool:
        # The socket reader exclusively owns receive; never consume its messages here.
        return self.membership.closed


class SessionMultiplex:
    """Independent bounded memberships sharing a deadline-limited physical writer."""

    def __init__(
        self,
        router: APIRouter,
        websocket: WebSocket,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        _emit_lock: asyncio.Lock | None = None,
        *,
        feed_v2: bool = False,
    ) -> None:
        self.feed_v2 = feed_v2
        self.router = router
        self.websocket = websocket
        self._sender = send
        self.members: dict[str, _Membership] = {}
        self._writing = False
        self._write_available = asyncio.Event()
        self._write_available.set()
        self._ready: deque[object] = deque()
        self._broken = False
        self._observation = new_wire_observation()

    async def send(
        self,
        frame: dict[str, Any],
        authorize: Callable[[], Awaitable[None]] | None = None,
        current: Callable[[], bool] | None = None,
    ) -> None:
        started = time.monotonic() if self._observation else 0.0
        # Initial authorization is independent: an unready member owns no turn.
        await asyncio.sleep(0)
        if authorize is not None:
            await authorize()
        ticket = object()
        self._ready.append(ticket)
        waited = False
        try:
            while self._writing or self._ready[0] is not ticket:
                waited = True
                self._write_available.clear()
                await self._write_available.wait()
            if self._broken:
                raise ConnectionError("Session socket writer closed")
            if waited and authorize is not None:
                # A completed contender owns the next admission turn, not the
                # physical writer. Re-admit within a deadline; a stream grant is
                # reused only until an access change or its 5 s bound.
                try:
                    async with asyncio.timeout(_AUTH_HANDOFF_TIMEOUT_S):
                        await authorize()
                except TimeoutError:
                    raise ConnectionError("Session publication authorization deadline") from None
            if current is not None and not current():
                return
            # No suspension from final authorization through physical socket claim.
            self._writing = True
            try:
                writing = time.monotonic() if self._observation else 0.0
                async with asyncio.timeout(_WRITE_TIMEOUT_S):
                    await self._sender(frame)
                if self._observation is not None:
                    sent = time.monotonic()
                    self._observation.delivered(
                        frame, (sent - started) * 1000, (sent - writing) * 1000
                    )
            except asyncio.CancelledError:
                # ASGI send cancellation leaves delivery uncertain; no sibling may
                # reuse the writer until this physical socket is made terminal.
                self._broken = True
                with anyio.CancelScope(shield=True), contextlib.suppress(Exception):
                    async with asyncio.timeout(1):
                        await self.websocket.close(code=1011)
                raise
            except (TimeoutError, OSError):
                self._broken = True
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(1):
                        await self.websocket.close(code=1011)
                raise ConnectionError("Session socket write failed") from None
            finally:
                self._writing = False
        finally:
            self._ready.remove(ticket)
            self._write_available.set()

    async def _remove(self, session_id: str) -> None:
        member = self.members.pop(session_id, None)
        if member is not None:
            member.closed = True
            if member.task is not None:
                member.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await member.task

    async def close(self) -> None:
        self._broken = True
        self._write_available.set()
        members = list(self.members.values())
        self.members.clear()
        tasks = []
        for member in members:
            member.closed = True
            if member.task is not None:
                member.task.cancel()
                tasks.append(member.task)
        await asyncio.gather(*tasks, return_exceptions=True)

    async def handle(self, message: dict[str, Any]) -> bool:
        kind = message.get("type")
        if kind not in {"subscribe", "unsubscribe", "presence"}:
            return False
        session_id = message.get("session_id")
        if kind == "presence":
            idle = message.get("idle")
            if not isinstance(idle, bool):
                return True
            selected = (
                [(session_id, self.members[session_id])]
                if isinstance(session_id, str) and session_id in self.members
                else list(self.members.items())
                if session_id is None
                else []
            )
            for selected_id, member in selected:
                if member.authorize is not None:
                    try:
                        await member.authorize()
                    except OmnigentError as exc:
                        await self._remove(selected_id)
                        await self.send(
                            member.envelope(selected_id, "session.error", code=exc.code)
                        )
                        continue
                    except ConnectionError:
                        await self._remove(selected_id)
                        await self.send(
                            member.envelope(selected_id, "session.error", code="stream_reconnect")
                        )
                        continue
                identity = member.presence
                identity["idle"] = idle
                if "token" in identity:
                    presence.update_idle(
                        identity["root_id"], identity["user_id"], identity["token"], idle
                    )
            return True
        if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
            return True
        subscription_id = message.get("subscription_id") if self.feed_v2 else None
        if subscription_id is not None and (
            not isinstance(subscription_id, str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", subscription_id)
        ):
            return True
        if kind == "unsubscribe":
            previous = self.members.get(session_id)
            if previous is not None and previous.subscription_id != subscription_id:
                return True
            await self._remove(session_id)
            await self.send(
                _Membership(subscription_id=subscription_id).envelope(
                    session_id, "session.unsubscribed"
                )
            )
            return True
        member = _Membership(
            subscription_id=subscription_id,
            presence={"idle": message.get("idle", False)},
            item_references=message.get("item_references") is True,
        )
        after_position = message.get("after_position", -1)
        after_revision = message.get("after_revision")
        epoch = message.get("stream_epoch")
        idle = message.get("idle", False)
        initial_limit = message.get("initial_limit")
        window_start_position = message.get("window_start_position")
        valid = (
            isinstance(after_position, int)
            and not isinstance(after_position, bool)
            and after_position >= -1
            and (
                after_revision is None
                or (
                    isinstance(after_revision, int)
                    and not isinstance(after_revision, bool)
                    and after_revision >= 0
                )
            )
            and (epoch is None or (isinstance(epoch, str) and len(epoch) <= 256))
            and isinstance(idle, bool)
            and valid_window_options(initial_limit, window_start_position)
        )
        if not valid:
            await self.send(member.envelope(session_id, "session.error", code="invalid_input"))
            return True
        if session_id not in self.members and len(self.members) >= MAX_MEMBERSHIPS:
            await self.send(
                member.envelope(session_id, "session.error", code="subscription_limit")
            )
            return True
        await self._remove(session_id)
        self.members[session_id] = member
        member.task = asyncio.create_task(
            self._pump(
                session_id,
                member,
                after_position,
                after_revision,
                epoch,
                idle,
                initial_limit,
                window_start_position,
            ),
            name=f"session-transcript:{session_id}",
        )
        return True

    async def _pump(
        self,
        session_id: str,
        member: _Membership,
        after_position: int,
        after_revision: int | None,
        epoch: str | None,
        idle: bool,
        initial_limit: int | None,
        window_start_position: int | None,
    ) -> None:
        async def error(code: str) -> None:
            member.queue.clear()
            if not self._broken:
                await self.send(
                    member.envelope(session_id, "session.error", code=code),
                    current=lambda: not member.closed and self.members.get(session_id) is member,
                )

        try:
            # Both endpoints belong to this router; use the same authorization,
            # strict runner preparation, resource snapshots and recovery generator.
            endpoint = next(
                route.endpoint
                for route in self.router.routes
                if isinstance(route, APIRoute)
                and route.path.endswith("/sessions/{session_id}/stream")
            )
            request = _MembershipRequest(self.websocket, member)
            factory = cast(
                Callable[..., Awaitable[AsyncGenerator[dict[str, Any], None]]],
                vars(endpoint)["stream_events"],
            )
            stream = await factory(
                request=request,
                session_id=session_id,
                idle=idle,
                after_position=after_position,
                after_revision=after_revision,
                stream_epoch=epoch,
                initial_limit=initial_limit,
                window_start_position=window_start_position,
            )
            member.authorize = request.state.stream_authorize
            async with contextlib.aclosing(stream) as frames:

                async def produce() -> None:
                    async for event in frames:
                        if member.closed:
                            return
                        try:
                            await member.queue.put(
                                StreamEvent(
                                    member.envelope(session_id, "session.event", event=event),
                                    getattr(
                                        event, "deadline", time.monotonic() + _MEMBER_MAX_AGE_S
                                    ),
                                    getattr(event, "check", None),
                                )
                            )
                        except EventTooLargeError:
                            raise session_stream.SubscriberEventTooLargeError from None
                        except (asyncio.QueueFull, TimeoutError):
                            raise session_stream.SubscriberOverflowError from None
                        await asyncio.sleep(0)
                    raise ConnectionError("Session stream ended")

                async def deliver() -> None:
                    while True:
                        if member.queue.expired:
                            raise session_stream.SubscriberOverflowError
                        frame = await member.queue.get()
                        remaining_age = max(0, member.queue.last_taken_deadline - time.monotonic())
                        if remaining_age <= 0:
                            raise session_stream.SubscriberOverflowError

                        async def authorize_frame(frame=frame) -> None:
                            if member.authorize is not None:
                                await member.authorize()
                            check = getattr(frame, "check", None)
                            if check is not None:
                                check()
                            validate_sync_complete(session_id, frame["event"])

                        try:
                            async with asyncio.timeout(remaining_age):
                                await self.send(
                                    frame,
                                    authorize_frame,
                                    lambda: (
                                        not member.closed
                                        and self.members.get(session_id) is member
                                    ),
                                )
                        except TimeoutError:
                            raise session_stream.SubscriberOverflowError from None

                workers = [asyncio.create_task(produce()), asyncio.create_task(deliver())]
                try:
                    done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in workers:
                        task.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
            if not member.closed:
                await error("stream_reconnect")
        except OmnigentError as exc:
            await error(exc.code)
        except session_stream.SubscriberEventTooLargeError:
            await error("stream_event_too_large")
        except session_stream.SubscriberOverflowError:
            await error("stream_overflow")
        except (ConnectionError, OSError):
            await error("stream_reconnect")
        except Exception as exc:  # noqa: BLE001 -- isolate one failed membership
            # Log only identity and exception class; validation text can contain bodies.
            _logger.error("Session membership %s failed (%s)", session_id, type(exc).__name__)
            await error("stream_failed")
        finally:
            member.closed = True
            if self.members.get(session_id) is member:
                self.members.pop(session_id, None)
