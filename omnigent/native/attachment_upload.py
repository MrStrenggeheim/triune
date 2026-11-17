"""Explicit native-agent attachments: upload bytes read under the caller's OS permissions."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

import httpx

MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024


def native_attachment_response_id(session_id: str) -> str | None:
    """Capture the current native owner only from this exact session's bridge."""
    from omnigent.harnesses.codex_native.bridge import (
        bridge_dir_for_codex_home,
        read_bridge_state,
    )

    codex_home = os.environ.get("CODEX_HOME")
    if not codex_home:
        return None
    state = read_bridge_state(bridge_dir_for_codex_home(Path(codex_home)))
    if state is None or state.session_id != session_id or not state.active_turn_id:
        return None
    return f"codex_{state.active_turn_id}"


def attachment_owner_headers(
    response_id: str | None, source_call_id: str | None = None
) -> dict[str, str]:
    """Transport observed receipt ownership; missing ownership stays standalone."""
    if not response_id:
        return {}
    headers = {"X-Triune-Response-Id": response_id}
    if source_call_id:
        headers["X-Triune-Source-Call-Id"] = source_call_id
    return headers


def read_attachment(path: Path) -> bytes:
    import os
    import stat

    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Attachments must be regular files")
        content = stream.read(MAX_ATTACHMENT_BYTES + 1)
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise ValueError("Attachment exceeds 50 MB")
    return content


async def upload_attachment(
    client: httpx.AsyncClient,
    session_id: str,
    *,
    filename: str,
    content: bytes,
    source_id: str | None = None,
    response_id: str | None = None,
    source_call_id: str | None = None,
) -> dict:
    from urllib.parse import quote

    if len(content) > MAX_ATTACHMENT_BYTES:
        raise ValueError("Attachment exceeds 50 MB")
    response = await client.post(
        f"/v1/sessions/{quote(session_id, safe='')}/attachments",
        files={
            "file": (
                filename,
                content,
                mimetypes.guess_type(filename)[0] or "application/octet-stream",
            )
        },
        headers={
            **({"Idempotency-Key": source_id} if source_id else {}),
            **attachment_owner_headers(response_id, source_call_id),
        },
    )
    response.raise_for_status()
    return response.json()
