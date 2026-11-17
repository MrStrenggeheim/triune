"""Session-scoped files namespace — upload, list, get, delete."""

# Modified for Triune: stream disk downloads with atomic publication and cleanup.

from __future__ import annotations

import asyncio
import mimetypes
import os
import pathlib
import stat
import uuid
from collections.abc import AsyncIterator, Coroutine
from urllib.parse import quote

import httpx

from ._errors import raise_for_status, require_json_object, response_body
from ._types import File, PaginatedList


def _download_destination_mode(path: pathlib.Path) -> int | None:
    """Reject final-path symlinks, including dangling ones, without following them."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"Download destination must not be a symlink: {path}")
    return stat.S_IMODE(info.st_mode) if stat.S_ISREG(info.st_mode) else None


class _DownloadIO:
    """Drain in-flight I/O and preserve cancellation through subsequent cleanup."""

    def __init__(self) -> None:
        self.cancelled: asyncio.CancelledError | None = None

    async def finish(self, operation: Coroutine[object, object, object]) -> None:
        task = asyncio.create_task(operation)
        while True:
            try:
                await asyncio.shield(task)
                break
            except asyncio.CancelledError as exc:
                self.cancelled = exc
                if task.cancelled():
                    raise
            except Exception as exc:
                if self.cancelled is not None:
                    raise self.cancelled from exc
                raise
        if self.cancelled is not None:
            raise self.cancelled


class _DownloadStream(httpx.AsyncByteStream):
    """Protect closure both at HTTPX iterator exhaustion and on context exit."""

    def __init__(self, stream: httpx.AsyncByteStream, io: _DownloadIO) -> None:
        self._stream = stream
        self._io = io

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self._stream:
                yield chunk
        except asyncio.CancelledError as exc:
            self._io.cancelled = exc
            raise

    async def aclose(self) -> None:
        await self._io.finish(self._stream.aclose())


class FilesNamespace:
    """
    Factory for session-scoped file namespaces.

    :param http: Shared async HTTP client.
    :param base_url: Server base URL, e.g. ``"http://localhost:8080"``.
    """

    def __init__(self, http: httpx.AsyncClient, base_url: str) -> None:
        """
        Initialize the unbound files namespace.

        :param http: Shared async HTTP client.
        :param base_url: Server base URL, e.g. ``"http://localhost:8080"``.
        :returns: None.
        """
        self._http = http
        self._base = base_url

    def for_session(self, session_id: str) -> SessionFilesNamespace:
        """
        Return a file namespace bound to one session.

        ``/v1/files`` has been removed; callers must scope uploads and
        downloads to the session/conversation that owns the file.

        :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
        :returns: A :class:`SessionFilesNamespace` bound to that session.
        """
        return SessionFilesNamespace(self._http, self._base, session_id)

    async def upload(self, path: str) -> File:
        """Legacy global upload removed; use ``for_session(id).upload``."""
        raise RuntimeError(
            "/v1/files was removed; use client.files.for_session(session_id).upload(path)"
        )

    async def list(self, *args: object, **kwargs: object) -> list[File]:
        """Legacy global list removed; use ``for_session(id).list``."""
        raise RuntimeError(
            "/v1/files was removed; use client.files.for_session(session_id).list()"
        )

    async def get(self, file_id: str) -> File:
        """Legacy global get removed; use ``for_session(id).get``."""
        raise RuntimeError(
            "/v1/files was removed; use client.files.for_session(session_id).get(file_id)"
        )

    async def get_content(self, file_id: str) -> bytes:
        """Legacy global content download removed; use ``for_session(id).get_content``."""
        raise RuntimeError(
            "/v1/files was removed; use client.files.for_session(session_id).get_content(file_id)"
        )

    async def download(self, file_id: str, to_path: str | pathlib.Path) -> pathlib.Path:
        """Legacy global download removed; use ``for_session(id).download``."""
        raise RuntimeError(
            "/v1/files was removed; use "
            "client.files.for_session(session_id).download(file_id, path)"
        )

    async def delete(self, file_id: str) -> None:
        """Legacy global delete removed; use ``for_session(id).delete``."""
        raise RuntimeError(
            "/v1/files was removed; use client.files.for_session(session_id).delete(file_id)"
        )


class SessionFilesNamespace:
    """
    File operations scoped to a single session.

    :param http: Shared async HTTP client.
    :param base_url: Server base URL, e.g. ``"http://localhost:8080"``.
    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    """

    def __init__(self, http: httpx.AsyncClient, base_url: str, session_id: str) -> None:
        """
        Initialize the session-scoped files namespace.

        :param http: Shared async HTTP client.
        :param base_url: Server base URL, e.g. ``"http://localhost:8080"``.
        :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
        :returns: None.
        """
        self._http = http
        self._base = base_url
        self._session_id = session_id

    @property
    def session_id(self) -> str:
        """
        The session/conversation id this namespace is bound to.

        :returns: Session id, e.g. ``"conv_abc123"``.
        """
        return self._session_id

    @property
    def _path(self) -> str:
        """
        Session-scoped files collection URL.

        :returns: Fully qualified endpoint URL.
        """
        return f"{self._base}/v1/sessions/{quote(self._session_id, safe='')}/resources/files"

    @staticmethod
    def _resource_to_file(data: dict[str, object]) -> File:
        """
        Convert a session file resource response to SDK ``File``.

        :param data: JSON object returned by a session file endpoint.
        :returns: The corresponding :class:`File`.
        """
        metadata = data.get("metadata")
        metadata_dict = metadata if isinstance(metadata, dict) else {}
        return File.from_dict(
            {
                "id": data.get("id", ""),
                "filename": metadata_dict.get("filename", data.get("name", "")),
                "bytes": metadata_dict.get("bytes", 0),
                "created_at": metadata_dict.get("created_at", 0),
            }
        )

    async def upload(self, path: str) -> File:
        """
        Upload a local file into this session's file namespace.

        :param path: Path to the local file, e.g. ``"./report.pdf"``.
        :returns: The uploaded file metadata.
        """
        p = pathlib.Path(path)
        content_type = mimetypes.guess_type(str(p))[0]
        with open(p, "rb") as f:
            resp = await self._http.post(
                self._path,
                files={"file": (p.name, f, content_type)},
                timeout=30.0,
            )
        raise_for_status(resp.status_code, response_body(resp))
        return self._resource_to_file(
            require_json_object(resp, "POST /v1/sessions/{session_id}/resources/files")
        )

    async def list(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        order: str = "desc",
    ) -> list[File]:
        """
        List files owned by this session.

        :param limit: Maximum number of files to return.
        :param after: Cursor for forward pagination,
            e.g. ``"file_abc123"``.
        :param order: Sort order, e.g. ``"desc"``.
        :returns: File metadata entries.
        """
        params: dict[str, str | int] = {"limit": limit, "order": order}
        if after is not None:
            params["after"] = after
        resp = await self._http.get(self._path, params=params)
        raise_for_status(resp.status_code, response_body(resp))
        page = PaginatedList.from_dict(
            require_json_object(resp, "GET /v1/sessions/{session_id}/resources/files")
        )
        return [self._resource_to_file(d) for d in page.data]

    async def get(self, file_id: str) -> File:
        """
        Get session file metadata by ID.

        :param file_id: Server-issued file id, e.g. ``"file_abc123"``.
        :returns: File metadata.
        """
        resp = await self._http.get(f"{self._path}/{quote(file_id, safe='')}")
        raise_for_status(resp.status_code, response_body(resp))
        return self._resource_to_file(
            require_json_object(resp, "GET /v1/sessions/{session_id}/resources/files/{file_id}")
        )

    async def get_content(self, file_id: str) -> bytes:
        """
        Download session file content.

        :param file_id: Server-issued file id, e.g. ``"file_abc123"``.
        :returns: Raw file bytes.
        """
        resp = await self._http.get(
            f"{self._path}/{quote(file_id, safe='')}/content",
            timeout=30.0,
        )
        if resp.status_code >= 400:
            raise_for_status(resp.status_code, response_body(resp))
        return resp.content

    async def download(self, file_id: str, to_path: str | pathlib.Path) -> pathlib.Path:
        """
        Stream file content to a sibling temporary file, then replace the destination.

        Final-path symlinks (including dangling ones) are rejected before download
        and checked again before publication.
        Failures or cancellation before replacement leave the destination intact.
        Existing regular-file permissions are preserved; new files use the current umask.
        Replacement temporary files are private from creation through transfer.
        Atomic replacement creates a new inode, so other hard links and already-open
        readers retain the old contents; ownership and other metadata are not copied.
        Parent directories follow normal filesystem path resolution.

        :param file_id: Server-issued file id, e.g. ``"file_abc123"``.
        :param to_path: Local output path, e.g. ``"./out/report.pdf"``.
        :returns: The path that was written.
        """
        path = pathlib.Path(to_path)
        destination_mode = _download_destination_mode(path)
        io = _DownloadIO()
        temporary: pathlib.Path | None = None
        try:
            async with self._http.stream(
                "GET",
                f"{self._path}/{quote(file_id, safe='')}/content",
                timeout=30.0,
            ) as resp:
                assert isinstance(resp.stream, httpx.AsyncByteStream)
                resp.stream = _DownloadStream(resp.stream, io)
                if resp.status_code >= 400:
                    await resp.aread()
                    raise_for_status(resp.status_code, response_body(resp))
                path.parent.mkdir(parents=True, exist_ok=True)
                candidate = path.parent / f".omnigent-download-{uuid.uuid4().hex}.tmp"
                descriptor = os.open(
                    candidate,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600 if destination_mode is not None else 0o666,
                )
                temporary = candidate
                try:
                    output = os.fdopen(descriptor, "wb")
                except BaseException:
                    os.close(descriptor)
                    raise
                try:
                    async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                        await io.finish(asyncio.to_thread(output.write, chunk))
                finally:
                    await io.finish(asyncio.to_thread(output.close))
            mode = _download_destination_mode(path)
            if mode is not None:
                temporary.chmod(mode)
            temporary.replace(path)
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError as exc:
                    if io.cancelled is not None:
                        raise io.cancelled from exc
                    raise
        return path

    async def delete(self, file_id: str) -> None:
        """
        Delete a session-scoped file.

        :param file_id: Server-issued file id, e.g. ``"file_abc123"``.
        :returns: None.
        """
        resp = await self._http.delete(f"{self._path}/{quote(file_id, safe='')}")
        if resp.status_code >= 400:
            raise_for_status(resp.status_code, response_body(resp))
