# Modified for Triune.
"""Negotiated gzip for complete JSON responses, with handler-controlled opt-outs."""

from __future__ import annotations

import asyncio
import gzip
from collections.abc import Mapping

from fastapi.routing import APIRoute
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.gzip import GZipResponder
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Bodies below this gain nothing from gzip once the header overhead and the
# CPU are accounted for. Matches the web-ui mount's threshold.
GZIP_MINIMUM_SIZE = 1024
# Level 4 reaches the same ratio as the default 9 on JSON and source text
# (measured ~330x on a 1 MB source file) for roughly half the CPU.
GZIP_COMPRESSLEVEL = 4
# ``request.state`` key a handler sets to opt its own response out of gzip.
# See :func:`skip_gzip`.
SKIP_GZIP_STATE_KEY = "skip_gzip"


def skip_gzip(request: Request) -> None:
    """
    Opt this response out of gzip, from inside the handler.

    For content that is already entropy-coded — base64 of compressed media
    (PNG/JPEG/PDF), which carries only base64's own ~25% redundancy — gzip
    returns ~1.3x for real event-loop time: 38 ms for a 1 MB file, 385 ms at
    the 10 MiB binary cap. Not worth blocking the loop for.

    The handler is the right place to decide this because it already holds the
    payload. The alternative — recovering the same fact from the serialized
    response bytes — has to re-derive domain information from transport data,
    which brought its own failure modes (a length-bounded prefix scan, and a
    dependency on where the producer places the field).

    Sets a flag on ``request.state``, which is backed by ``scope["state"]``, so
    :class:`GZipFileContentRoute` reads it back at send time. Response body,
    headers, status, and OpenAPI are all unaffected.

    :param request: The active request.
    :returns: None.
    """
    setattr(request.state, SKIP_GZIP_STATE_KEY, True)


def _client_accepts_gzip(accept_encoding: str) -> bool:
    """
    Return whether ``Accept-Encoding`` permits gzip.

    Coding tokens are case-insensitive, and ``q=0`` means "do not use this
    coding" (RFC 9110 §12.5.3) — so a plain substring test would compress for
    a client that explicitly declined.

    :param accept_encoding: Raw header value, e.g. ``"gzip, deflate, br"``.
    :returns: True when gzip or a wildcard permits the coding.
    """
    wildcard = False
    for part in accept_encoding.split(","):
        token, _, params = part.strip().partition(";")
        token = token.strip().lower()
        if token not in {"gzip", "*"}:
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value.strip())
                except ValueError:
                    quality = 0.0
        if token == "gzip":
            return 0 < quality <= 1
        wildcard = 0 < quality <= 1
    return wildcard


class _StateAwareGZipResponder(GZipResponder):
    """
    Gzip responder that honours a handler's :func:`skip_gzip` opt-out.

    The flag can only be read at send time: the handler sets it while running,
    which is after ``handle`` dispatches but before the response body is
    emitted. Select pass-through when the response starts, before Starlette
    can buffer its headers. Forward all messages unchanged for that response.

    :param app: The wrapped ASGI app (the route's own ``handle``).
    :param minimum_size: Minimum body size to compress, e.g. ``1024``.
    :param compresslevel: gzip level passed through to Starlette.
    :param state: The request's ``scope["state"]`` dict — the same mapping
        ``request.state`` writes to, so the handler's later opt-out is visible
        through this reference.
    """

    def __init__(
        self,
        app: ASGIApp,
        minimum_size: int,
        compresslevel: int,
        state: Mapping[str, object],
        accepts_gzip: bool = True,
    ) -> None:
        super().__init__(app, minimum_size, compresslevel=compresslevel)
        self._state = state
        self._skip_compression = False
        self._accepts_gzip = accepts_gzip
        self._compresslevel = compresslevel

    async def send_with_compression(self, message: Message) -> None:
        """
        Preserve response ordering when the handler opts out of compression.

        :param message: The outgoing ASGI message.
        :returns: None.
        """
        if message["type"] == "http.response.start":
            headers = Headers(raw=message["headers"])
            content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            cache_control = {
                directive.strip().lower()
                for value in headers.getlist("cache-control")
                for directive in value.split(",")
            }
            self._skip_compression = (
                bool(self._state.get(SKIP_GZIP_STATE_KEY))
                or not (
                    content_type == "application/json"
                    or (content_type.startswith("application/") and content_type.endswith("+json"))
                )
                or "content-encoding" in headers
                or "content-range" in headers
                or "content-disposition" in headers
                or "no-transform" in cache_control
                or message["status"] < 200
                or message["status"] in {204, 206, 304}
            )
            if not self._skip_compression:
                self.initial_message = message
                return
        if self._skip_compression:
            await self.send(message)
            return
        # A streamed response passes through from its first chunk, without
        # collecting chunks or delaying the producer until the stream ends.
        if message["type"] == "http.response.body":
            body = message.get("body", b"")
            if not message.get("more_body", False) and len(body) >= self.minimum_size:
                headers = MutableHeaders(raw=self.initial_message["headers"])
                vary_values = headers.getlist("vary")
                vary = {
                    token.strip().lower() for value in vary_values for token in value.split(",")
                }
                if "*" not in vary and "accept-encoding" not in vary:
                    headers["Vary"] = ", ".join([*vary_values, "Accept-Encoding"])
                if self._accepts_gzip:
                    body = await asyncio.to_thread(
                        gzip.compress, body, compresslevel=self._compresslevel, mtime=0
                    )
                    headers["Content-Encoding"] = "gzip"
                    headers["Content-Length"] = str(len(body))
                    if "etag" in headers and not headers["etag"].startswith("W/"):
                        headers["etag"] = "W/" + headers["etag"]
                    message["body"] = body
        self._skip_compression = True
        await self.send(self.initial_message)
        await self.send(message)


class GZipJSONMiddleware:
    """Compress large JSON bodies while preserving streams and raw downloads."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") == "HEAD":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if "range" in headers:
            await self.app(scope, receive, send)
            return
        await _StateAwareGZipResponder(
            self.app,
            GZIP_MINIMUM_SIZE,
            GZIP_COMPRESSLEVEL,
            scope.setdefault("state", {}),
            accepts_gzip=_client_accepts_gzip(",".join(headers.getlist("accept-encoding"))),
        )(scope, receive, send)


class GZipFileContentRoute(APIRoute):
    """
    Route class that gzips this route's responses.

    Attach by grouping the read endpoints on their own router::

        file_read_router = APIRouter(route_class=GZipFileContentRoute)

        @file_read_router.get(path)
        async def read(...): ...

        router.include_router(file_read_router)

    (FastAPI's decorators do not accept a per-route class; ``route_class`` on
    the router is the supported form, and ``include_router`` preserves it.)

    Skips compression when the client did not ask for gzip, when the request
    carries a ``Range`` (a ``206``'s ``Content-Range`` describes the
    *unencoded* representation, so compressing the body would make the two
    disagree and break media seeking / PDF byte-range loads), and when the
    handler called :func:`skip_gzip`.
    """

    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        """
        Compress this route's response when the client and handler allow it.

        :param scope: ASGI request scope, e.g. type ``"http"``.
        :param receive: ASGI receive callable.
        :param send: ASGI send callable.
        :returns: None.
        """
        await GZipJSONMiddleware(super().handle)(scope, receive, send)


__all__ = [
    "GZIP_COMPRESSLEVEL",
    "GZIP_MINIMUM_SIZE",
    "SKIP_GZIP_STATE_KEY",
    "GZipFileContentRoute",
    "GZipJSONMiddleware",
    "skip_gzip",
]
