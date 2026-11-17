"""Native attachment uploads forward original bytes, not local path authority."""

import base64
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from omnigent.harnesses.codex_native import forwarder
from omnigent.native.attachment_upload import read_attachment


@pytest.mark.parametrize("kind", ["imageView", "imageGeneration"])
async def test_codex_image_events_upload_original_bytes(kind, tmp_path):
    path = tmp_path / "image ü.png"
    original = b"\x89PNG\r\noriginal"
    path.write_bytes(original)
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "stored", "name": path.name})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handle), base_url="http://isolated"
    ) as client:
        item = {"id": "native-image-call", "type": kind, "path": str(path), "status": "completed"}
        if kind == "imageGeneration":
            item["result"] = base64.b64encode(original).decode()
            item["savedPath"] = str(path)
        await forwarder._forward_image_attachment(
            client, "chat", item, "source", response_id="codex_observed-turn"
        )
    path.unlink()
    assert len(requests) == 1
    assert requests[0].url.path == "/v1/sessions/chat/attachments"
    assert requests[0].headers["idempotency-key"] == "source"
    assert requests[0].headers["x-triune-response-id"] == "codex_observed-turn"
    assert requests[0].headers["x-triune-source-call-id"] == "native-image-call"
    assert original in requests[0].content
    assert b"filename=" in requests[0].content
    assert "attachment_error" not in item


@pytest.mark.parametrize("session_matches", [True, False])
def test_cli_upload_owner_requires_exact_bridge_session(tmp_path, monkeypatch, session_matches):
    from omnigent.harnesses.codex_native.bridge import (
        CodexNativeBridgeState,
        codex_home_for_bridge_dir,
        write_bridge_state,
    )
    from omnigent.native.attachment_upload import native_attachment_response_id

    bridge = tmp_path / "native"
    home = codex_home_for_bridge_dir(bridge)
    monkeypatch.setenv("CODEX_HOME", str(home))
    state = CodexNativeBridgeState(
        session_id="chat" if session_matches else "parent",
        socket_path=str(bridge / "unused.sock"),
        thread_id="thread",
        codex_home=str(home),
        active_turn_id="active-turn",
    )
    write_bridge_state(bridge, state)
    assert native_attachment_response_id("chat") == (
        "codex_active-turn" if session_matches else None
    )
    write_bridge_state(bridge, replace(state, active_turn_id=None))
    assert native_attachment_response_id("chat") is None


async def test_failed_native_upload_is_visible_in_the_tool_record(tmp_path):
    path = tmp_path / "image.png"
    path.write_bytes(b"image")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(403)),
        base_url="http://isolated",
    ) as client:
        item = {"type": "imageView", "path": str(path)}
        await forwarder._forward_image_attachment(client, "chat", item, "source")
    assert "Attachment unavailable" in item["attachment_error"]
    assert "Attachment unavailable" in forwarder._image_view_tool_call("id", item).output


def test_explicit_reader_limits_size_and_rejects_special_files(tmp_path, monkeypatch):
    import omnigent.native.attachment_upload as attachments

    monkeypatch.setattr(attachments, "MAX_ATTACHMENT_BYTES", 3)
    path = tmp_path / "large"
    path.write_bytes(b"four")
    with pytest.raises(ValueError, match="exceeds"):
        read_attachment(path)
    with pytest.raises((ValueError, OSError)):
        read_attachment(Path("/dev/null"))
