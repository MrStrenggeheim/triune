"""SDK disk downloads use one streamed GET and publish only complete files."""

from __future__ import annotations

import asyncio
import os
import pathlib
import stat
import threading
from collections.abc import AsyncGenerator

import httpx
import pytest
from omnigent_client._errors import (
    InvalidInputError,
    OmnigentError,
    RateLimitedError,
    ServerError,
)
from omnigent_client._files import SessionFilesNamespace

pytestmark = pytest.mark.asyncio

_CHUNK = bytes(range(256)) * 256


class _ByteStream(httpx.AsyncByteStream):
    def __init__(self, body: AsyncGenerator[bytes, None]) -> None:
        self.body = body
        self.closed = False

    async def __aiter__(self):
        async for chunk in self.body:
            yield chunk

    async def aclose(self) -> None:
        await self.body.aclose()
        self.closed = True


class _StreamingOnlyResponse(httpx.Response):
    @property
    def content(self) -> bytes:
        raise AssertionError("Successful downloads must not access .content")

    async def aread(self) -> bytes:
        raise AssertionError("Successful downloads must not call .aread()")


@pytest.mark.parametrize("existing", [False, True])
async def test_download_consumes_chunks_before_requesting_more(tmp_path, existing) -> None:
    path = tmp_path / "nested" / "binary.bin"
    if existing:
        path.parent.mkdir()
        path.write_bytes(b"previous")
    requests = []
    chunks = [_CHUNK, _CHUNK[::-1], _CHUNK, b"\x00\xfftail"]

    async def body():
        for index, chunk in enumerate(chunks):
            if index:
                (temporary,) = (entry for entry in path.parent.iterdir() if entry != path)
                assert temporary.stat().st_size == index * len(_CHUNK)
                assert path.read_bytes() == b"previous" if existing else not path.exists()
            yield chunk

    stream = _ByteStream(body())

    def handler(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.url.raw_path == (
            b"/api/v1/sessions/s%20%2F%3F%25%23/resources/files/f%20%2F%3F%25%23/content"
        )
        assert request.headers["authorization"] == "Bearer fixture-token"
        assert request.headers["x-forwarded-email"] == "owner@example.test"
        assert request.extensions["timeout"] == dict.fromkeys(
            ("connect", "read", "write", "pool"), 30.0
        )
        return _StreamingOnlyResponse(200, stream=stream)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        headers={
            "Authorization": "Bearer fixture-token",
            "X-Forwarded-Email": "owner@example.test",
        },
        timeout=0.1,
    ) as client:
        files = SessionFilesNamespace(client, "https://sdk.test/api", "s /?%#")
        assert await files.download("f /?%#", path) == path

    assert len(requests) == 1
    assert path.read_bytes() == b"".join(chunks)
    assert list(path.parent.iterdir()) == [path]
    assert stream.closed


@pytest.mark.posix_only
@pytest.mark.parametrize("mask", [0o000, 0o022, 0o077])
@pytest.mark.parametrize("mode", [None, 0o600, 0o640, 0o751, 0o4750])
async def test_download_preserves_permissions_and_hardlink_contents(
    tmp_path, monkeypatch, mask, mode
) -> None:
    path = tmp_path / "result.bin"
    old_link = tmp_path / "old.bin"
    if mode is not None:
        path.write_bytes(b"previous")
        path.chmod(mode)
        os.link(path, old_link)

    original_open = os.open
    creation_modes = []

    def open_output(filename, flags, creation_mode, **kwargs):
        descriptor = original_open(filename, flags, creation_mode, **kwargs)
        creation_modes.append(stat.S_IMODE(os.fstat(descriptor).st_mode))
        return descriptor

    monkeypatch.setattr(os, "open", open_output)

    async def body():
        (temporary,) = tmp_path.glob(".omnigent-download-*.tmp")
        temporary_mode = (0o600 if mode is not None else 0o666) & ~mask
        assert stat.S_IMODE(temporary.stat().st_mode) == temporary_mode
        yield _CHUNK
        assert stat.S_IMODE(temporary.stat().st_mode) == temporary_mode
        yield b"\x00\xff"

    stream = _ByteStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        old_mask = os.umask(mask)
        try:
            result = await SessionFilesNamespace(client, "https://sdk.test", "s").download(
                "f", str(path)
            )
        finally:
            os.umask(old_mask)

    assert result == path
    assert creation_modes == [(0o600 if mode is not None else 0o666) & ~mask]
    assert path.read_bytes() == _CHUNK + b"\x00\xff"
    assert stat.S_IMODE(path.stat().st_mode) == (mode if mode is not None else 0o666 & ~mask)
    assert path.stat().st_uid == os.getuid()
    if mode is not None:
        assert old_link.read_bytes() == b"previous"
        assert old_link.stat().st_ino != path.stat().st_ino
    assert set(tmp_path.iterdir()) == ({path, old_link} if mode is not None else {path})
    assert stream.closed


@pytest.mark.parametrize("dangling", [False, True])
@pytest.mark.parametrize("during_download", [False, True])
async def test_download_rejects_final_symlinks(tmp_path, dangling, during_download) -> None:
    path = tmp_path / "result.bin"
    target = tmp_path / "target.bin"
    if not dangling:
        target.write_bytes(b"target stays intact")
    if during_download:
        path.write_bytes(b"previous")
    else:
        path.symlink_to(target)
    requests = []

    async def body():
        yield _CHUNK
        path.unlink()
        path.symlink_to(target)
        yield b"tail"

    stream = _ByteStream(body())

    def handler(request):
        requests.append(request)
        return _StreamingOnlyResponse(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError, match="must not be a symlink"):
            await SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)

    assert len(requests) == int(during_download)
    assert stream.closed == during_download
    assert path.is_symlink()
    assert path.readlink() == target
    assert not target.exists() if dangling else target.read_bytes() == b"target stays intact"
    assert set(tmp_path.iterdir()) == ({path} if dangling else {path, target})


@pytest.mark.parametrize(
    ("status", "payload", "exception", "code", "message"),
    [
        (
            400,
            b'{"error":{"code":"invalid_input","message":"bad file"}}',
            InvalidInputError,
            "invalid_input",
            "bad file",
        ),
        (401, b"auth required", OmnigentError, "", "auth required"),
        (403, b"forbidden", OmnigentError, "", "forbidden"),
        (
            404,
            b'{"error":{"code":"not_found","message":"missing"}}',
            OmnigentError,
            "not_found",
            "missing",
        ),
        (
            429,
            b'{"error":{"code":"rate_limited","message":"slow down"}}',
            RateLimitedError,
            "rate_limited",
            "slow down",
        ),
        (502, b"<html>bad gateway</html>", ServerError, "", "<html>bad gateway</html>"),
    ],
)
async def test_download_converts_streamed_http_errors(
    tmp_path, status, payload, exception, code, message
) -> None:
    path = tmp_path / "result.bin"
    path.write_bytes(b"previous")
    requests = []

    async def body():
        yield payload[:8]
        yield payload[8:]

    stream = _ByteStream(body())

    def handler(request):
        requests.append(request)
        return httpx.Response(status, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(exception) as caught:
            await SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)

    assert type(caught.value) is exception
    assert caught.value.status_code == status
    assert caught.value.code == code
    assert str(caught.value) == message
    assert path.read_bytes() == b"previous"
    assert list(tmp_path.iterdir()) == [path]
    assert len(requests) == 1
    assert stream.closed


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize(
    "fault",
    [httpx.ReadError, httpx.ReadTimeout, httpx.RemoteProtocolError, asyncio.CancelledError],
)
async def test_download_keeps_destination_after_chunk_failure(tmp_path, existing, fault) -> None:
    path = tmp_path / "result.bin"
    if existing:
        path.write_bytes(b"previous")

    async def body():
        yield _CHUNK
        raise fault("interrupted")

    stream = _ByteStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        with pytest.raises(fault, match="interrupted"):
            await SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)

    assert path.read_bytes() == b"previous" if existing else not path.exists()
    assert list(tmp_path.iterdir()) == ([path] if existing else [])
    assert stream.closed


async def test_download_cancellation_while_waiting_for_next_chunk(tmp_path) -> None:
    path = tmp_path / "result.bin"
    path.write_bytes(b"previous")
    waiting = asyncio.Event()

    async def body():
        yield _CHUNK
        waiting.set()
        await asyncio.Event().wait()

    stream = _ByteStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        task = asyncio.create_task(
            SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)
        )
        await asyncio.wait_for(waiting.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert path.read_bytes() == b"previous"
    assert list(tmp_path.iterdir()) == [path]
    assert stream.closed


@pytest.mark.parametrize(
    "fault", ["fdopen", "write", "close", "chmod", "replace", "cancel_and_close"]
)
async def test_download_keeps_destination_after_disk_failure(tmp_path, monkeypatch, fault) -> None:
    path = tmp_path / "result.bin"
    path.write_bytes(b"previous")
    opened = []
    original_fdopen = os.fdopen
    descriptors = []
    loop_thread = threading.get_ident()

    class Writer:
        def __init__(self, file):
            self.file = file
            opened.append(file)

        def write(self, chunk):
            assert threading.get_ident() != loop_thread
            self.file.write(chunk)
            if fault == "write":
                raise OSError("disk fault")

        def close(self):
            assert threading.get_ident() != loop_thread
            self.file.close()
            if fault in {"close", "cancel_and_close"}:
                raise OSError("disk fault")

    def open_output(descriptor, *args, **kwargs):
        descriptors.append(descriptor)
        if fault == "fdopen":
            raise OSError("disk fault")
        return Writer(original_fdopen(descriptor, *args, **kwargs))

    def fail(*args, **kwargs):
        raise OSError("disk fault")

    monkeypatch.setattr(os, "fdopen", open_output)
    if fault in {"chmod", "replace"}:
        monkeypatch.setattr(pathlib.Path, fault, fail)

    async def body():
        yield _CHUNK
        if fault == "cancel_and_close":
            raise asyncio.CancelledError("cancelled transfer")
        yield b"tail"

    stream = _ByteStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        exception = asyncio.CancelledError if fault == "cancel_and_close" else OSError
        with pytest.raises(exception):
            await SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)

    assert descriptors
    for descriptor in descriptors:
        with pytest.raises(OSError):
            os.fstat(descriptor)
    assert all(file.closed for file in opened)
    assert path.read_bytes() == b"previous"
    assert list(tmp_path.iterdir()) == [path]
    assert stream.closed


async def test_download_waits_for_inflight_write_on_repeated_cancellation(tmp_path, monkeypatch):
    path = tmp_path / "result.bin"
    path.write_bytes(b"previous")
    started = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    original_fdopen = os.fdopen
    opened = []

    class Writer:
        def __init__(self, file):
            self.file = file
            opened.append(file)

        def write(self, chunk):
            loop.call_soon_threadsafe(started.set)
            assert release.wait(5)
            return self.file.write(chunk)

        def close(self):
            self.file.close()

    def open_output(descriptor, *args, **kwargs):
        return Writer(original_fdopen(descriptor, *args, **kwargs))

    monkeypatch.setattr(os, "fdopen", open_output)

    async def body():
        yield _CHUNK
        yield b"tail"

    stream = _ByteStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        task = asyncio.create_task(
            SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)
        )
        try:
            await asyncio.wait_for(started.wait(), 5)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert opened and not opened[0].closed
            task.cancel()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert all(file.closed for file in opened)
    assert path.read_bytes() == b"previous"
    assert list(tmp_path.iterdir()) == [path]
    assert stream.closed


async def test_download_cancellation_during_stream_closure(tmp_path) -> None:
    path = tmp_path / "result.bin"
    path.write_bytes(b"previous")
    closing = asyncio.Event()
    release = asyncio.Event()

    async def body():
        yield _CHUNK

    class SlowCloseStream(_ByteStream):
        async def aclose(self):
            closing.set()
            await release.wait()
            await super().aclose()

    stream = SlowCloseStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        task = asyncio.create_task(
            SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)
        )
        try:
            await asyncio.wait_for(closing.wait(), 5)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            task.cancel()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert path.read_bytes() == b"previous"
    assert list(tmp_path.iterdir()) == [path]
    assert stream.closed


async def test_get_content_still_returns_binary_bytes() -> None:
    requests = []

    async def body():
        yield _CHUNK
        yield b"\x00\xff"

    stream = _ByteStream(body())

    def handler(request):
        requests.append(request)
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await SessionFilesNamespace(client, "https://sdk.test", "s").get_content("f")

    assert type(result) is bytes
    assert result == _CHUNK + b"\x00\xff"
    assert len(requests) == 1
    assert stream.closed


@pytest.mark.parametrize("cancel", [False, True])
async def test_download_keeps_destination_when_stream_close_fails(tmp_path, cancel) -> None:
    path = tmp_path / "result.bin"
    path.write_bytes(b"previous")

    async def body():
        yield _CHUNK
        if cancel:
            raise asyncio.CancelledError("cancelled transfer")

    class FailedCloseStream(_ByteStream):
        async def aclose(self):
            await super().aclose()
            raise OSError("stream close failed")

    stream = FailedCloseStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        exception = asyncio.CancelledError if cancel else OSError
        with pytest.raises(exception):
            await SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)

    assert path.read_bytes() == b"previous"
    assert list(tmp_path.iterdir()) == [path]
    assert stream.closed


async def test_download_publishes_empty_file(tmp_path) -> None:
    path = tmp_path / "empty.bin"
    path.write_bytes(b"previous")

    async def body():
        for chunk in []:
            yield chunk

    stream = _ByteStream(body())
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: _StreamingOnlyResponse(200, stream=stream))
    ) as client:
        assert (
            await SessionFilesNamespace(client, "https://sdk.test", "s").download("f", path)
            == path
        )

    assert path.read_bytes() == b""
    assert list(tmp_path.iterdir()) == [path]
    assert stream.closed
