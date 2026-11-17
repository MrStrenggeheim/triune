"""Socket-owned transcript memberships on the existing session-list WebSocket."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, cast

from fastapi import APIRouter, Request, WebSocket
from fastapi.routing import APIRoute
from starlette.responses import StreamingResponse

from omnigent.errors import OmnigentError
from omnigent.runtime import session_stream
from omnigent.server import presence
from omnigent.server.session_recovery import valid_window_options

_logger = logging.getLogger(__name__)
_MAX_MEMBERSHIPS = 32


@dataclass
class _Membership:
    task: asyncio.Task[None] | None = None
    presence: dict[str, Any] = field(default_factory=dict)
    closed: bool = False
    authorize: Callable[[], Awaitable[None]] | None = None


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

    async def is_disconnected(self) -> bool:
        # The socket reader exclusively owns receive; never consume its messages here.
        return self.membership.closed


class SessionMultiplex:
    """Reuse the authorized SSE endpoint; share only the socket's serialized sender."""

    def __init__(
        self,
        router: APIRouter,
        websocket: WebSocket,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        emit_lock: asyncio.Lock,
    ) -> None:
        self.router = router
        self.websocket = websocket
        self._sender = send
        self.emit_lock = emit_lock
        self.members: dict[str, _Membership] = {}

    async def send(
        self, frame: dict[str, Any], authorize: Callable[[], Awaitable[None]] | None = None
    ) -> None:
        async with self.emit_lock:
            if authorize is not None:
                await authorize()
            await self._sender(frame)

    async def _remove(self, session_id: str) -> None:
        member = self.members.pop(session_id, None)
        if member is not None:
            member.closed = True
            if member.task is not None:
                member.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await member.task

    async def close(self) -> None:
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
                            {"type": "session.error", "session_id": selected_id, "code": exc.code}
                        )
                        continue
                    except ConnectionError:
                        await self._remove(selected_id)
                        await self.send(
                            {
                                "type": "session.error",
                                "session_id": selected_id,
                                "code": "stream_reconnect",
                            }
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
        if kind == "unsubscribe":
            await self._remove(session_id)
            await self.send({"type": "session.unsubscribed", "session_id": session_id})
            return True
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
            await self.send(
                {"type": "session.error", "session_id": session_id, "code": "invalid_input"}
            )
            return True
        if session_id not in self.members and len(self.members) >= _MAX_MEMBERSHIPS:
            await self.send(
                {"type": "session.error", "session_id": session_id, "code": "subscription_limit"}
            )
            return True
        await self._remove(session_id)
        member = _Membership(presence={"idle": idle})
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
            response: StreamingResponse = await endpoint(
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
            # This endpoint returns our async generator of unencoded SSE strings.
            stream = cast(AsyncGenerator[str, None], response.body_iterator)
            async with contextlib.aclosing(stream) as frames:
                async for chunk in frames:
                    if member.closed:
                        break
                    data = "\n".join(
                        line[5:].lstrip()
                        for line in chunk.splitlines()
                        if line.startswith("data:")
                    )
                    if data == "[DONE]":
                        break
                    if data:
                        await self.send(
                            {
                                "type": "session.event",
                                "session_id": session_id,
                                "event": json.loads(data),
                            },
                            member.authorize,
                        )
            if not member.closed:
                await self.send(
                    {"type": "session.error", "session_id": session_id, "code": "stream_reconnect"}
                )
        except OmnigentError as exc:
            await self.send({"type": "session.error", "session_id": session_id, "code": exc.code})
        except session_stream.SubscriberOverflowError:
            await self.send(
                {"type": "session.error", "session_id": session_id, "code": "stream_overflow"}
            )
        except (ConnectionError, OSError):
            await self.send(
                {"type": "session.error", "session_id": session_id, "code": "stream_reconnect"}
            )
        except Exception as exc:  # noqa: BLE001 -- isolate one failed membership
            # Log only identity and exception class; validation text can contain bodies.
            _logger.error("Session membership %s failed (%s)", session_id, type(exc).__name__)
            await self.send(
                {"type": "session.error", "session_id": session_id, "code": "stream_failed"}
            )
        finally:
            member.closed = True
            if self.members.get(session_id) is member:
                self.members.pop(session_id, None)
