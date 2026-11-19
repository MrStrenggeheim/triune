"""Coordinate managed runtime work with the published-release systemd unit."""

from __future__ import annotations

import asyncio
import os
import re
import sys
from collections.abc import Callable, Coroutine
from contextlib import ExitStack, contextmanager
from functools import wraps
from pathlib import Path
from typing import Any, ParamSpec, TypeVar

from starlette.responses import JSONResponse

INSTALL = Path("/home/agent/apps/omnigent")
_prefix = Path(sys.prefix).resolve()
MANAGED = sys.platform == "linux" and _prefix.parent.parent == INSTALL / "releases"

_Params = ParamSpec("_Params")
_Result = TypeVar("_Result")
_Busy = TypeVar("_Busy")


@contextmanager
def admit_work():
    """Hold shared admission through dispatch. The unit locks the same directory inode."""
    if not MANAGED:
        yield True
        return

    import fcntl

    with ExitStack() as locks:
        for directory in (INSTALL / "releases", INSTALL):
            fd = os.open(directory, os.O_DIRECTORY)
            locks.callback(os.close, fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
        yield True


def defer_during_update(
    busy_result: _Busy = None,
) -> Callable[
    [Callable[_Params, Coroutine[Any, Any, _Result]]],
    Callable[_Params, Coroutine[Any, Any, _Result | _Busy]],
]:
    """Leave background work for its existing recovery or polling loop."""

    def decorate(
        fn: Callable[_Params, Coroutine[Any, Any, _Result]],
    ) -> Callable[_Params, Coroutine[Any, Any, _Result | _Busy]]:
        @wraps(fn)
        async def guarded(*args: _Params.args, **kwargs: _Params.kwargs) -> _Result | _Busy:
            with admit_work() as admitted:
                if admitted:
                    return await fn(*args, **kwargs)
                return busy_result

        return guarded

    return decorate


def start_admitted_task(coroutine, name):
    """Transfer a start lease to the task, including cancellation before its first await."""
    with ExitStack() as stack:
        if not stack.enter_context(admit_work()):
            coroutine.close()
            return None
        task = asyncio.create_task(coroutine, name=name)
        lease = stack.pop_all()
        task.add_done_callback(lambda _: lease.close())
        return task


class ReleaseAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        kind = scope["type"]
        # Host control tunnels carry replies/heartbeats. Runner and terminal
        # sockets can admit native input and hold their lease until disconnect.
        if (
            not MANAGED
            or kind not in ("http", "websocket")
            or (kind == "websocket" and re.fullmatch(r"/v1/hosts/[^/]+/tunnel", path))
            or (
                scope.get("method") == "GET"
                and (
                    path in ("/", "/health", "/api/version", "/v1/sessions")
                    or path.startswith("/assets/")
                )
            )
            or path
            in (
                "/api/server-update",
                "/api/server-update/install",
                "/api/server-update/check",
                "/api/server-update/mode",
            )
            or (kind == "websocket" and path == "/v1/sessions/updates")
        ):
            await self.app(scope, receive, send)
            return
        with admit_work() as admitted:
            if admitted:
                await self.app(scope, receive, send)
            elif kind == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            else:
                await JSONResponse(
                    {"detail": "Published release activation in progress."}, status_code=503
                )(scope, receive, send)
