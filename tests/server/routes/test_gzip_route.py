# Modified for Triune.
"""ASGI response ordering for handler-controlled gzip opt-outs."""

from __future__ import annotations

import copy
import gzip
import threading

import pytest
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from omnigent.server.routes._gzip_route import (
    SKIP_GZIP_STATE_KEY,
    GZipJSONMiddleware,
    _StateAwareGZipResponder,
)


async def _exchange(
    messages: list[Message],
    *,
    accept_encoding: str = "gzip",
    scope_overrides: dict | None = None,
    nested: bool = False,
) -> list[Message]:
    sent: list[Message] = []
    scope: Scope = {
        "type": "http",
        "method": "GET",
        "headers": [(b"accept-encoding", accept_encoding.encode())],
        **(scope_overrides or {}),
    }

    async def app(_scope: Scope, _receive: Receive, send: Send) -> None:
        for index, message in enumerate(messages):
            await send(copy.deepcopy(message))
            if message["type"] == "http.response.body" and message.get("more_body"):
                # The first streamed chunk must leave before producing the next.
                assert sent == messages[: index + 1]

    async def receive() -> Message:
        return {"type": "http.request", "body": b""}

    async def send(message: Message) -> None:
        sent.append(copy.deepcopy(message))

    wrapped: ASGIApp = GZipJSONMiddleware(app)
    if nested:
        wrapped = GZipJSONMiddleware(wrapped)
    await wrapped(scope, receive, send)
    return sent


async def test_json_compression_keeps_cpu_work_off_the_event_loop(monkeypatch):
    main_thread = threading.get_ident()
    compressed_on: list[int] = []
    compress = gzip.compress

    def track_compression(*args, **kwargs):
        compressed_on.append(threading.get_ident())
        return compress(*args, **kwargs)

    monkeypatch.setattr(gzip, "compress", track_compression)
    body = b"x" * 4096
    sent = await _exchange(
        [
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            },
            {"type": "http.response.body", "body": body},
        ]
    )
    assert gzip.decompress(sent[1]["body"]) == body
    assert len(compressed_on) == 1 and compressed_on[0] != main_thread


@pytest.mark.parametrize(
    "accept_encoding,compressed",
    [
        ("gzip", True),
        ("GZip;q=0.5", True),
        ("br, *;q=0.5", True),
        ("gzip;q=0, *;q=1", False),
        ("gzip;q=0.0", False),
        ("gzip;q=broken", False),
        ("gzip;q=2", False),
        ("identity", False),
        ("", False),
    ],
)
async def test_json_gzip_negotiation_and_cache_headers(accept_encoding, compressed):
    body = b'{"content":"' + b"repeated text " * 300 + b'"}'
    start: Message = {
        "type": "http.response.start",
        "status": 200,
        "headers": [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"private, max-age=60"),
            (b"vary", b"Origin"),
            (b"vary", b"Cookie"),
            (b"etag", b'"original"'),
        ],
    }
    sent = await _exchange(
        [start, {"type": "http.response.body", "body": body}],
        accept_encoding=accept_encoding,
        nested=True,
    )
    headers = Headers(raw=sent[0]["headers"])
    assert headers["cache-control"] == "private, max-age=60"
    assert headers["vary"] == "Origin, Cookie, Accept-Encoding"
    assert (headers.get("content-encoding") == "gzip") is compressed
    payload = sent[1]["body"]
    assert int(headers["content-length"]) == len(payload)
    assert (gzip.decompress(payload) if compressed else payload) == body
    assert headers["etag"] == ('W/"original"' if compressed else '"original"')


@pytest.mark.parametrize(
    "content_type,extra_headers,status,streaming,scope_overrides",
    [
        ("application/json", [], 200, True, {}),
        ("text/event-stream", [], 200, True, {}),
        ("application/octet-stream", [], 200, True, {}),
        ("image/png", [], 200, False, {}),
        ("application/json", [(b"content-disposition", b"attachment")], 200, False, {}),
        ("application/json", [(b"content-encoding", b"br")], 200, False, {}),
        ("application/json", [(b"cache-control", b"private, No-Transform")], 200, False, {}),
        (
            "application/json",
            [(b"cache-control", b"private"), (b"cache-control", b"no-transform")],
            200,
            False,
            {},
        ),
        ("application/json", [(b"content-range", b"bytes 0-2047/4096")], 206, False, {}),
        ("application/json", [], 304, False, {}),
        ("application/json", [], 200, False, {"method": "HEAD"}),
        ("application/json", [], 200, False, {"headers": [(b"range", b"bytes=0-2047")]}),
        ("application/json", [], 200, False, {"state": {SKIP_GZIP_STATE_KEY: True}}),
    ],
)
async def test_noncompressible_responses_pass_through(
    content_type, extra_headers, status, streaming, scope_overrides
):
    messages: list[Message] = [
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", content_type.encode()), *extra_headers],
        },
        {"type": "http.response.body", "body": b"x" * 2048, "more_body": streaming},
    ]
    if streaming:
        messages.append({"type": "http.response.body", "body": b"last chunk"})
    assert await _exchange(messages, scope_overrides=scope_overrides) == messages


@pytest.mark.parametrize("vary", [b"*", b"Origin, accept-encoding"])
async def test_json_gzip_preserves_existing_vary(vary):
    messages: list[Message] = [
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"application/problem+json"), (b"vary", vary)],
        },
        {"type": "http.response.body", "body": b"x" * 2048},
    ]
    sent = await _exchange(messages)
    assert Headers(raw=sent[0]["headers"])["vary"] == vary.decode()
    assert gzip.decompress(sent[1]["body"]) == messages[1]["body"]


@pytest.mark.parametrize("scope", [{"type": "websocket"}, {"type": "lifespan"}])
async def test_non_http_scopes_pass_through(scope):
    messages = [{"type": "websocket.accept"}, {"type": "websocket.send", "text": "hello"}]
    assert await _exchange(messages, scope_overrides=scope) == messages


@pytest.mark.parametrize("status,body", [(200, b"{}"), (304, b"")])
async def test_small_or_not_modified_json_preserves_cache_metadata(status, body):
    messages: list[Message] = [
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"cache-control", b"private, max-age=60"),
                (b"etag", b'"original"'),
                (b"vary", b"Cookie"),
            ],
        },
        {"type": "http.response.body", "body": body},
    ]
    assert await _exchange(messages) == messages


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True])
async def test_skipped_gzip_preserves_response_start_and_body(streaming: bool) -> None:
    """An opt-out forwards headers before every body, including streamed bodies."""
    body = b'{"encoding":"base64","content":"AA=="}'
    messages: list[Message] = [
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"application/json")],
        },
    ]
    if streaming:
        messages.append({"type": "http.response.body", "body": body[:10], "more_body": True})
        messages.append({"type": "http.response.body", "body": body[10:]})
    else:
        messages.append({"type": "http.response.body", "body": body})

    scope: Scope = {"type": "http", "state": {}}
    sent: list[Message] = []

    async def app(scope: Scope, _receive: Receive, send: Send) -> None:
        scope["state"][SKIP_GZIP_STATE_KEY] = True
        for message in messages:
            await send(copy.deepcopy(message))

    async def receive() -> Message:
        return {"type": "http.request", "body": b""}

    async def send(message: Message) -> None:
        sent.append(copy.deepcopy(message))

    responder = _StateAwareGZipResponder(app, 1024, 4, scope["state"])
    await responder(scope, receive, send)

    assert sent == messages
