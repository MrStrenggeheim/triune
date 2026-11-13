# Modified for Triune.
"""Durable attachment bytes and message-captured workspace references."""

import asyncio
import base64
import hashlib
import json
import threading
from dataclasses import replace
from unittest.mock import AsyncMock
from urllib.parse import quote

import httpx
import pytest
from fastapi import HTTPException
from starlette.responses import StreamingResponse

from omnigent.db.db_models import current_workspace_id
from omnigent.entities.conversation import MessageData, NewConversationItem
from omnigent.runner.transports.ws_tunnel.frames import HelloFrame
from omnigent.runner.transports.ws_tunnel.registry import TunnelRegistry
from omnigent.server.auth import LEVEL_EDIT, LEVEL_OWNER, LEVEL_READ
from omnigent.server.routes.chat_attachments import create_chat_attachments_router
from omnigent.server.workbench_resources import HostWorkspaceResources
from omnigent.stores.artifact_store.local import LocalArtifactStore
from tests.server.routes.test_session_resources import artifact_store as artifact_store
from tests.server.routes.test_session_resources import file_app as file_app
from tests.server.routes.test_session_resources import file_client as file_client
from tests.server.routes.test_session_resources import file_conv_store as file_conv_store
from tests.server.routes.test_session_resources import file_store as file_store
from tests.server.routes.test_session_resources import runner_globals_reset as runner_globals_reset
from tests.server.routes.test_workbench_workspaces import ALICE, BOB, HOST, OTHER_HOST
from tests.server.routes.test_workbench_workspaces import workspace_stack as workspace_stack

SESSION = "79b22ebd2309e48fdeb450c65611d51b"


@pytest.fixture
def reference_capture(workspace_stack, tmp_path):
    make_app, root, conversations, permissions, _, _, _ = workspace_stack
    app, service = make_app()
    artifacts = LocalArtifactStore(str(tmp_path / "reference-artifacts"))
    app.include_router(create_chat_attachments_router(service, artifacts), prefix="/v1")
    chat = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", chat.id, LEVEL_OWNER)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="assistant", agent="agent", content=[]),
            )
        ],
    )[0]
    url = f"/v1/sessions/{chat.id}/attachments/references/{message.id}"
    return app, service, artifacts, chat, message, url


async def test_capture_returns_only_metadata_and_commits_binary_original(
    reference_capture, workspace_stack, monkeypatch
):
    app, _, artifacts, _, _, url = reference_capture
    _, root, _, _, _, frames, _ = workspace_stack
    name = "original ü space.svg"
    original = b"<svg>\x00\xfforiginal</svg>"
    source = root / name
    source.write_bytes(original)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        response = await client.post(url + "/capture", params={"path": name})
        assert response.status_code == 200, response.text
        assert response.json() == {
            "filename": name,
            "mime": "image/svg+xml",
            "bytes": len(original),
        }
        assert response.headers["Cache-Control"] == "private, no-store"
        keys = list(artifacts._root.iterdir())
        assert len(keys) == 2
        binary = next(path for path in keys if path.suffix == ".bin")
        assert binary.read_bytes() == original
        manifest_path = next(path for path in keys if path != binary)
        assert manifest_path.suffix == ".v2"
        assert not artifacts.exists(manifest_path.name.removesuffix(".v2"))
        manifest = json.loads(manifest_path.read_bytes())
        assert manifest["content_key"] == binary.name
        assert "content" not in manifest
        assert len(json.dumps(manifest)) < 512
        source.write_bytes(b"edited")
        frames.clear()
        reads = []
        get = artifacts.get

        def read(key):
            reads.append(key)
            return get(key)

        monkeypatch.setattr(artifacts, "get", read)
        again = await client.post(url + "/capture", params={"path": name})
        assert again.json() == response.json()
        assert binary.name not in reads
        downloaded = await client.get(url, params={"path": name})
        assert downloaded.content == original
        assert downloaded.headers["Content-Type"] == "image/svg+xml"
        assert downloaded.headers["Content-Disposition"] == (
            "attachment; filename*=UTF-8''" + quote(name, safe="")
        )
        assert downloaded.headers["X-Content-Type-Options"] == "nosniff"
        assert downloaded.headers["Cache-Control"] == "private, no-store"
        assert frames == []


@pytest.mark.parametrize("peer", [False, True])
async def test_runneronly_post_capture_uses_get_and_keeps_runner_acl(
    workspace_stack, tmp_path, monkeypatch, peer
):
    make_app, root, conversations, permissions, _, host_frames, _ = workspace_stack
    app, service = make_app()
    artifact_store = LocalArtifactStore(str(tmp_path / "runner-captures"))
    registry = TunnelRegistry()
    service.tunnel_registry = registry
    runner_id = "3" * 32
    conn = registry.register(
        runner_id,
        AsyncMock(),
        HelloFrame(runner_version="test", frame_protocol_version=1),
        owner="alice",
    )
    chat = conversations.create_conversation(runner_id=runner_id, workspace=str(root))
    permissions.grant("alice", chat.id, LEVEL_OWNER)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="assistant", agent="agent", content=[]),
            )
        ],
    )[0]
    app.include_router(create_chat_attachments_router(service, artifact_store), prefix="/v1")
    recipient = chat
    received = message
    if peer:
        recipient = conversations.create_conversation(host_id=HOST, workspace=str(root))
        permissions.grant("alice", recipient.id, LEVEL_OWNER)
        permissions.grant("bob", recipient.id, LEVEL_OWNER)
        [received] = conversations.append(
            recipient.id,
            [
                NewConversationItem(
                    type="message",
                    response_id="peer-turn",
                    data=MessageData(
                        role="user",
                        content=[],
                        communication={
                            "kind": "peer",
                            "message_id": message.id,
                            "source_conversation_id": chat.id,
                            "destination_conversation_id": recipient.id,
                            "source_resource_scope": message.data.resource_scope,
                        },
                    ),
                )
            ],
        )
    url = f"/v1/sessions/{recipient.id}/attachments/references/{received.id}"
    name = "runner ü space.svg"
    original = b"<svg>runner original</svg>"
    requests = []

    async def runner_request(target_id, connection, method, path, **kwargs):
        requests.append((method, path, kwargs))
        assert target_id == runner_id and connection is conn
        if method != "GET":
            return httpx.Response(405, json={"detail": "Method Not Allowed"})
        prefix = f"/v1/sessions/{chat.id}/resources/environments/default"
        if path == prefix:
            return httpx.Response(200, json={"metadata": {"root": str(root)}})
        assert path == prefix + "/filesystem/" + quote(name, safe="")
        assert kwargs == {"params": {"download": "true"}}
        return httpx.Response(200, content=original, headers={"Content-Type": "image/svg+xml"})

    monkeypatch.setattr(service, "runner_request", runner_request)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        for grant in (LEVEL_READ, LEVEL_EDIT, LEVEL_OWNER):
            permissions.grant("bob", chat.id, grant)
            denied = await client.post(url + "/capture", params={"path": name}, headers=BOB)
            assert denied.status_code == 403, denied.text
        assert requests == []
        captured = await client.post(url + "/capture", params={"path": name})
        assert captured.status_code == 200, captured.text
        assert captured.json() == {
            "filename": name,
            "mime": "image/svg+xml",
            "bytes": len(original),
        }
        assert all(method == "GET" for method, _, _ in requests)
        assert sum("/filesystem/" in path for _, path, _ in requests) == 1
        requests.clear()
        denied = await client.get(url, params={"path": name}, headers=BOB)
        assert denied.status_code == 403, denied.text
        assert requests == []
        if peer:
            conn.owner = "bob"
            denied = await client.get(url, params={"path": name})
            assert denied.status_code == 403, denied.text
            assert requests == []
            conn.owner = "alice"
        registry.deregister(runner_id)
        assert (
            await client.post(url + "/capture", params={"path": name})
        ).json() == captured.json()
        assert (await client.get(url, params={"path": name})).content == original
        assert requests == []
        assert host_frames == []


@pytest.mark.parametrize("method", ["GET", "POST"])
async def test_legacy_capture_is_readable_without_original_target(
    reference_capture, workspace_stack, method
):
    app, _, artifacts, chat, message, url = reference_capture
    _, _, _, _, registry, frames, _ = workspace_stack
    name = "old ü data.bin"
    original = b"\x00\xfflegacy original"
    snapshot_id = (
        "chat-reference-"
        + hashlib.sha256(
            json.dumps([current_workspace_id(), "alice", chat.id, message.id, name]).encode()
        ).hexdigest()
    )
    artifacts.put(
        snapshot_id,
        json.dumps(
            {
                "filename": name,
                "mime": "application/octet-stream",
                "content": base64.b64encode(original).decode(),
            }
        ).encode(),
    )
    registry.deregister(HOST)
    frames.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        response = await client.request(
            method, url + ("/capture" if method == "POST" else ""), params={"path": name}
        )
        assert response.status_code == 200, response.text
        if method == "GET":
            assert response.content == original
        else:
            assert response.json() == {
                "filename": name,
                "mime": "application/octet-stream",
                "bytes": len(original),
            }
        assert frames == []
        assert not artifacts.exists(snapshot_id + ".v2")


async def test_capture_waits_for_commit_and_shares_one_live_read(
    reference_capture, workspace_stack, monkeypatch
):
    app, _, artifacts, chat, _, url = reference_capture
    _, root, _, permissions, _, frames, _ = workspace_stack
    permissions.grant("bob", chat.id, LEVEL_OWNER)
    entered, release = threading.Event(), threading.Event()
    publish = artifacts.put_if_absent

    def paused(key, data):
        entered.set()
        assert release.wait(10)
        return publish(key, data)

    monkeypatch.setattr(artifacts, "put_if_absent", paused)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        first = asyncio.create_task(client.post(url + "/capture", params={"path": "file.txt"}))
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            assert not first.done()
            assert all(path.suffix == ".bin" for path in artifacts._root.iterdir())
            # Even a chat owner cannot join another reader's private capture.
            for method, suffix in (("GET", ""), ("POST", "/capture")):
                denied = await client.request(
                    method, url + suffix, params={"path": "file.txt"}, headers=BOB
                )
                assert denied.status_code == 403, denied.text
            (root / "file.txt").write_text("edited after the source read")
            second = asyncio.create_task(client.get(url, params={"path": "file.txt"}))
        finally:
            release.set()
        captured, downloaded = await asyncio.gather(first, second)
        assert captured.status_code == downloaded.status_code == 200
        assert downloaded.content == b"before\n"
        assert (await client.get(url, params={"path": "file.txt"}, headers=BOB)).status_code == 403
        operations = [
            frame.params.get("operation") for _, frame in frames if hasattr(frame, "params")
        ]
        assert operations.count("download_begin") == 1
        assert operations.count("download_cancel") == 1


async def test_competing_servers_preserve_first_committed_original(
    reference_capture, workspace_stack, monkeypatch
):
    app, first_service, artifacts, _, _, url = reference_capture
    make_app, _, _, _, _, _, _ = workspace_stack
    other_app, other_service = make_app()
    other_artifacts = LocalArtifactStore(artifacts.storage_location)
    other_app.include_router(
        create_chat_attachments_router(other_service, other_artifacts), prefix="/v1"
    )
    entered = [asyncio.Event(), asyncio.Event()]
    release = [asyncio.Event(), asyncio.Event()]

    async def download(self, path, *, max_bytes=None):
        index = 0 if self.service is first_service else 1

        async def chunks():
            entered[index].set()
            await release[index].wait()
            yield b"original" if index == 0 else b"edited later"

        return StreamingResponse(chunks())

    monkeypatch.setattr(HostWorkspaceResources, "download_file", download)
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
        ) as first_client,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=other_app), base_url="http://test", headers=ALICE
        ) as other_client,
    ):
        first = asyncio.create_task(first_client.get(url, params={"path": "file.txt"}))
        await asyncio.wait_for(entered[0].wait(), 10)
        second = asyncio.create_task(other_client.get(url, params={"path": "file.txt"}))
        try:
            await asyncio.wait_for(entered[1].wait(), 10)
            release[0].set()
            original = await first
        finally:
            release[0].set()
            release[1].set()
        competing = await second
        assert original.status_code == competing.status_code == 200
        assert original.content == competing.content == b"original"
        assert len(list(artifacts._root.iterdir())) == 2
        assert (await other_client.post(url + "/capture", params={"path": "file.txt"})).json()[
            "bytes"
        ] == len(b"original")


@pytest.mark.parametrize("committed", [False, True])
async def test_publication_error_preserves_winner_and_primary_error(
    reference_capture, monkeypatch, caplog, committed
):
    app, _, artifacts, _, _, url = reference_capture
    publish = artifacts.put_if_absent

    def failed(key, data):
        if committed:
            assert publish(key, data)
        raise OSError("Publication response failed")

    monkeypatch.setattr(artifacts, "put_if_absent", failed)
    if not committed:

        def failed_cleanup(key):
            raise OSError("Cleanup failed too")

        monkeypatch.setattr(artifacts, "delete", failed_cleanup)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        response = await client.post(url + "/capture", params={"path": "file.txt"})
        assert response.status_code == 502
        assert "Publication response failed" in caplog.text
        if committed:
            assert (await client.get(url, params={"path": "file.txt"})).content == b"before\n"
            assert len(list(artifacts._root.iterdir())) == 2
        else:
            assert "Unpublished attachment cleanup failed" in caplog.text
            assert all(path.suffix == ".bin" for path in artifacts._root.iterdir())


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize(
    "failure", ["source", "cancel", "storage", "publication", "oversize", "short"]
)
async def test_failed_capture_never_publishes_partial_original(
    reference_capture, workspace_stack, monkeypatch, method, failure
):
    app, _, artifacts, _, _, url = reference_capture
    closed = []

    async def chunks():
        try:
            yield b"partial"
            if failure == "source":
                raise HTTPException(409, "Source changed")
            if failure == "cancel":
                raise asyncio.CancelledError()
            if failure == "oversize":
                yield b"x" * (50 * 1024 * 1024)
        finally:
            closed.append(True)

    async def download(self, path, *, max_bytes=None):
        headers = {"Content-Length": "100"} if failure == "short" else {}
        return StreamingResponse(chunks(), headers=headers)

    monkeypatch.setattr(HostWorkspaceResources, "download_file", download)
    if failure in {"storage", "publication"}:

        def broken(key, data):
            raise OSError("Storage unavailable")

        monkeypatch.setattr(artifacts, "put" if failure == "storage" else "put_if_absent", broken)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        request = client.request(
            method, url + ("/capture" if method == "POST" else ""), params={"path": "file.txt"}
        )
        if failure == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await request
        else:
            response = await request
            assert (
                response.status_code
                == {
                    "source": 409,
                    "storage": 502,
                    "publication": 502,
                    "oversize": 413,
                    "short": 502,
                }[failure]
            )
        assert closed == [True]
        assert list(artifacts._root.iterdir()) == []


@pytest.mark.parametrize("size", [0, 50 * 1024 * 1024, 50 * 1024 * 1024 + 1])
async def test_capture_raw_host_limit_and_cleanup(reference_capture, workspace_stack, size):
    app, _, artifacts, _, _, url = reference_capture
    _, root, _, _, _, frames, _ = workspace_stack
    with (root / "file.txt").open("wb") as source:
        source.truncate(size)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        response = await client.post(url + "/capture", params={"path": "file.txt"})
        assert response.status_code == (200 if size <= 50 * 1024 * 1024 else 413), response.text
        operations = [
            frame.params.get("operation") for _, frame in frames if hasattr(frame, "params")
        ]
        assert operations.count("download_begin") == operations.count("download_cancel") == 1
        assert not any(getattr(frame, "op", None) == "list_or_read" for _, frame in frames)
        if response.status_code == 200:
            assert response.json()["bytes"] == size
        else:
            assert "download_read" not in operations
            assert list(artifacts._root.iterdir()) == []


async def test_capture_requires_trusted_origin(reference_capture, workspace_stack, monkeypatch):
    app, _, artifacts, _, _, url = reference_capture
    _, _, _, _, _, frames, _ = workspace_stack
    monkeypatch.setenv("OMNIGENT_WS_ALLOWED_ORIGINS", "https://trusted.test")
    frames.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        denied = await client.post(
            url + "/capture", params={"path": "file.txt"}, headers={"Origin": "https://evil.test"}
        )
        assert denied.status_code == 403
        assert frames == []
        assert list(artifacts._root.iterdir()) == []
        allowed = await client.post(
            url + "/capture",
            params={"path": "file.txt"},
            headers={"Origin": "https://trusted.test"},
        )
        assert allowed.status_code == 200, allowed.text


async def test_reference_metadata_classifies_without_reading_file_bytes(workspace_stack):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    (root / "folder ü").mkdir()
    (root / "document ü.csv").write_text("a,b\n1,2")
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service), prefix="/v1")
    chat = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", chat.id, LEVEL_OWNER)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="assistant", agent="agent", content=[]),
            )
        ],
    )[0]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        base = f"/v1/sessions/{chat.id}/attachments/references/{message.id}/metadata"
        for path, expected in [
            ("document ü.csv", "file"),
            ("folder ü", "directory"),
            ("missing.txt", "missing"),
            (str(root), "directory"),
        ]:
            response = await client.get(base, params={"path": path})
            assert response.status_code == 200, response.text
            assert response.json()["kind"] == expected
        denied = await client.get(base, params={"path": "../private.txt"})
        assert denied.status_code in {400, 403}
    reads = [frame for _, frame in frames if getattr(frame, "op", None) == "list_or_read"]
    assert reads
    assert all(frame.params["path"] == "" for frame in reads)


@pytest.fixture
def peer_reference_capture(reference_capture, workspace_stack):
    app, service, artifacts, source, source_message, _ = reference_capture
    _, root, conversations, permissions, _, _, _ = workspace_stack
    recipient_root = root.parent / "peer-recipient"
    recipient_root.mkdir()
    (recipient_root / "file.txt").write_text("WRONG RECIPIENT BYTES")
    (recipient_root / "report.md").mkdir()
    (root / "report.md").write_text("source report")
    recipient = conversations.create_conversation(
        host_id=OTHER_HOST, workspace=str(recipient_root)
    )
    permissions.grant("alice", recipient.id, LEVEL_OWNER)
    [received] = conversations.append(
        recipient.id,
        [
            NewConversationItem(
                type="message",
                response_id="peer-turn",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "[report](report.md)"}],
                    communication={
                        "kind": "peer",
                        "message_id": source_message.id,
                        "source_conversation_id": source.id,
                        "destination_conversation_id": recipient.id,
                        "source_resource_scope": source_message.data.resource_scope,
                    },
                ),
            )
        ],
    )
    url = f"/v1/sessions/{recipient.id}/attachments/references/{received.id}"
    return app, service, artifacts, source, recipient, received, url


async def test_peer_reference_uses_source_scope_and_ignores_old_recipient_capture(
    peer_reference_capture, workspace_stack
):
    app, _, artifacts, source, recipient, received, url = peer_reference_capture
    _, root, conversations, _, registry, frames, _ = workspace_stack
    assert received.data.resource_scope["workspace"] == recipient.workspace
    old_snapshot = (
        "chat-reference-"
        + hashlib.sha256(
            json.dumps(
                [current_workspace_id(), "alice", recipient.id, received.id, "file.txt"]
            ).encode()
        ).hexdigest()
    )
    artifacts.put(
        old_snapshot,
        json.dumps(
            {"filename": "file.txt", "content": base64.b64encode(b"WRONG").decode()}
        ).encode(),
    )
    conversations.set_host_id(source.id, OTHER_HOST, recipient.workspace)
    frames.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        metadata = await client.get(url + "/metadata", params={"path": "report.md"})
        assert metadata.status_code == 200, metadata.text
        assert metadata.json()["kind"] == "file"
        assert metadata.json()["workspace"]["root"] == str(root)
        location = await client.get(url + "/location", params={"path": "file.txt"})
        assert location.status_code == 200, location.text
        assert location.json()["workspace"]["host_id"] == HOST
        assert location.json()["workspace"]["root"] == str(root)
        captured = await client.post(url + "/capture", params={"path": "file.txt"})
        assert captured.status_code == 200, captured.text
        assert captured.json()["bytes"] == len(b"before\n")
        assert (await client.get(url, params={"path": "file.txt"})).content == b"before\n"
        assert frames and all(host_id == HOST for host_id, _ in frames)
        registry.deregister(HOST)
        frames.clear()
        assert (await client.get(url, params={"path": "file.txt"})).content == b"before\n"
        assert (await client.get(url + "/metadata", params={"path": "file.txt"})).json()[
            "kind"
        ] == "captured"
        assert frames == []


@pytest.mark.parametrize("side", ["source", "recipient"])
@pytest.mark.parametrize("grant", [None, LEVEL_READ, LEVEL_EDIT])
async def test_peer_reference_rechecks_both_session_acls_before_cached_bytes(
    peer_reference_capture, workspace_stack, side, grant
):
    app, _, _, source, recipient, _, url = peer_reference_capture
    _, _, _, permissions, _, frames, _ = workspace_stack
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        assert (
            await client.post(url + "/capture", params={"path": "file.txt"})
        ).status_code == 200
        session_id = source.id if side == "source" else recipient.id
        permissions.revoke("alice", session_id)
        if grant is not None:
            permissions.grant("alice", session_id, grant)
        frames.clear()
        for suffix in ("/metadata", "/location", "/capture", ""):
            denied = await client.request(
                "POST" if suffix == "/capture" else "GET",
                url + suffix,
                params={"path": "file.txt"},
            )
            assert denied.status_code in {403, 404}, denied.text
        assert frames == []


async def test_peer_reference_rechecks_source_host_ownership_before_cached_bytes(
    peer_reference_capture, workspace_stack, monkeypatch
):
    app, service, _, _, _, _, url = peer_reference_capture
    _, _, _, _, _, frames, _ = workspace_stack
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        assert (
            await client.post(url + "/capture", params={"path": "file.txt"})
        ).status_code == 200
        get_host = service.host_store.get_host
        monkeypatch.setattr(
            service.host_store,
            "get_host",
            lambda host_id: replace(get_host(host_id), user_id="bob"),
        )
        frames.clear()
        for suffix in ("/metadata", "/location", "/capture", ""):
            denied = await client.request(
                "POST" if suffix == "/capture" else "GET",
                url + suffix,
                params={"path": "file.txt"},
            )
            assert denied.status_code == 403, denied.text
        assert frames == []


@pytest.mark.parametrize("missing", ["scope", "source", "native", "destination"])
async def test_peer_reference_without_trusted_source_never_uses_recipient_scope(
    peer_reference_capture, workspace_stack, monkeypatch, missing
):
    app, service, _, _, _, received, url = peer_reference_capture
    _, _, _, _, _, frames, _ = workspace_stack
    changes = {
        "scope": {"source_resource_scope": None},
        "source": {"source_conversation_id": None},
        "native": {"kind": "native_agent"},
        "destination": {"destination_conversation_id": "0" * 32},
    }
    unavailable = received.model_copy(
        update={
            "data": received.data.model_copy(
                update={
                    "communication": received.data.communication.model_copy(
                        update=changes[missing]
                    )
                }
            )
        }
    )
    get_item = service.conversation_store.get_item
    monkeypatch.setattr(
        service.conversation_store,
        "get_item",
        lambda session_id, item_id: (
            unavailable if item_id == received.id else get_item(session_id, item_id)
        ),
    )
    frames.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        for suffix in ("/metadata", "/location", "/capture", ""):
            response = await client.request(
                "POST" if suffix == "/capture" else "GET",
                url + suffix,
                params={"path": "file.txt"},
            )
            assert response.status_code == 409, response.text
        assert frames == []


@pytest.mark.parametrize(
    "name,mime,data",
    [
        ("my chart ü.png", "image/png", b"\x89PNG\r\noriginal"),
        (
            "vector.svg",
            "image/svg+xml",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
        ("report.pdf", "application/pdf", b"%PDF-original"),
        ("notes.md", "text/markdown", b"# Original"),
        ("script.py", "text/x-python", b"print('original')"),
        ("data.json", "application/json", b'{"original":true}'),
        ("data.yaml", "text/yaml", b"original: true"),
        ("data.csv", "text/csv", b"a,b\n1,2"),
        ("data.tsv", "text/tab-separated-values", b"a\tb\n1\t2"),
        ("page.html", "text/html", b"<script>parent.hacked=true</script>"),
        ("sound.mp3", "audio/mpeg", b"ID3-original"),
        ("movie.mp4", "video/mp4", b"original movie"),
        ("slides.pptx", "application/octet-stream", b"PK-original"),
        ("archive.zip", "application/zip", b"PK-zip"),
        ("other.bin", "application/octet-stream", b"\x00\xfforiginal"),
    ],
)
async def test_presentation_upload_keeps_original_bytes_without_model_support(
    file_client, name, mime, data
):
    uploaded = await file_client.post(
        f"/v1/sessions/{SESSION}/resources/files?presentation=true",
        files={"file": (name, data, mime)},
    )
    assert uploaded.status_code == 201, uploaded.text
    record = uploaded.json()
    content = await file_client.get(
        f"/v1/sessions/{SESSION}/resources/files/{record['id']}/content"
    )
    assert content.status_code == 200
    assert content.content == data
    assert content.headers["x-content-type-options"] == "nosniff"
    assert content.headers["content-disposition"].startswith("attachment;")
    other = await file_client.get(
        f"/v1/sessions/405bfe154d5c0e795a2b87021bc897bf/resources/files/{record['id']}/content"
    )
    assert other.status_code == 404


async def test_explicit_agent_attachment_persists_a_message_and_survives_source_deletion(
    file_client, file_conv_store, tmp_path
):
    source = tmp_path / "temporary ü.txt"
    source.write_text("durable bytes")
    uploaded = await file_client.post(
        f"/v1/sessions/{SESSION}/attachments",
        files={"file": (source.name, source.read_bytes(), "text/plain")},
    )
    assert uploaded.status_code == 200, uploaded.text
    source.unlink()
    record = uploaded.json()
    message = next(item for item in file_conv_store.appended_items if item.type == "message")
    assert message.data.content == [
        {"type": "output_file", "file_id": record["id"], "filename": source.name}
    ]
    response = await file_client.get(
        f"/v1/sessions/{SESSION}/resources/files/{record['id']}/content"
    )
    assert response.content == b"durable bytes"


async def test_markdown_reference_stays_with_original_workspace_and_enforces_boundaries(
    workspace_stack,
):
    make_app, root, conversations, permissions, _, _, _ = workspace_stack
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service), prefix="/v1")
    chat = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", chat.id, 4)
    path = root / "image ü space.svg"
    path.write_bytes(b"<svg/>")
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(
                    role="assistant",
                    agent="agent",
                    content=[
                        {"type": "output_text", "text": "![chart](image%20%C3%BC%20space.svg)"}
                    ],
                ),
            )
        ],
    )[0]
    original = message.data.resource_scope
    assert original["workspace"] == str(root)
    second = root.parent / "second"
    second.mkdir()
    (second / path.name).write_text("WRONG WORKSPACE")
    conversations.set_host_id(chat.id, OTHER_HOST, str(second))
    url = f"/v1/sessions/{chat.id}/attachments/references/{message.id}"
    location_url = url + "/location"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        current = await client.post(
            "/v1/workbench-workspaces/resolve", json={"session_id": chat.id}
        )
        assert current.status_code == 200, current.text
        location = await client.get(location_url, params={"path": str(path)})
        assert location.status_code == 200, location.text
        captured = location.json()
        assert captured["path"] == path.name
        assert captured["workspace"]["root"] == str(root)
        assert captured["workspace"]["host_id"] == HOST
        assert captured["workspace"]["generation"] == original["generation"]
        assert captured["workspace"]["available"] is True
        assert captured["workspace"]["id"] != current.json()["id"]
        assert (await client.get(location_url, params={"path": path.name})).json() == captured
        response = await client.get(url, params={"path": path.name})
        assert response.status_code == 200, response.text
        assert response.content == b"<svg/>"
        assert (await client.get(url, params={"path": str(path)})).content == b"<svg/>"
        for unsafe in (
            "../outside",
            "nested/../file",
            str(second / path.name),
            "/etc/passwd",
            "",
            ".",
            "bad\x00path",
        ):
            for endpoint in (url, location_url):
                assert (await client.get(endpoint, params={"path": unsafe})).status_code in {
                    400,
                    403,
                }
        outside = root.parent / "secret"
        outside.write_text("secret")
        (root / "escape").symlink_to(outside)
        assert (await client.get(url, params={"path": "escape"})).status_code == 403
        assert (await client.get(url, params={"path": path.name}, headers=BOB)).status_code in {
            403,
            404,
        }
        assert (
            await client.get(location_url, params={"path": path.name}, headers=BOB)
        ).status_code in {403, 404}
        path.unlink()
        assert (await client.get(url, params={"path": path.name})).status_code == 404


@pytest.mark.parametrize("capture_method", ["GET", "POST"])
async def test_authorized_markdown_reference_snapshot_survives_source_and_host_loss(
    workspace_stack, db_uri, tmp_path, capture_method
):
    import shutil

    from omnigent.stores.artifact_store.local import LocalArtifactStore
    from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore

    make_app, root, conversations, permissions, registry, _, _ = workspace_stack
    app, service = make_app()
    files = SqlAlchemyFileStore(db_uri)
    artifacts = LocalArtifactStore(str(tmp_path / "reference-artifacts"))
    app.include_router(create_chat_attachments_router(service, artifacts), prefix="/v1")
    chat = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", chat.id, 4)
    original = b"image original bytes"
    source = root / "saved ü.png"
    source.write_bytes(original)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(
                    role="assistant",
                    agent="agent",
                    content=[{"type": "output_text", "text": "![saved](saved.png)"}],
                ),
            )
        ],
    )[0]
    url = f"/v1/sessions/{chat.id}/attachments/references/{message.id}"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        first = await client.request(
            capture_method,
            url + ("/capture" if capture_method == "POST" else ""),
            params={"path": source.name},
        )
        assert first.status_code == 200, first.text
        shutil.rmtree(root)
        again = await client.get(url, params={"path": source.name})
        assert again.status_code == 200, again.text
        assert again.content == original
        unavailable = await client.get(url + "/location", params={"path": source.name})
        assert unavailable.status_code == 400
        assert "does not exist" in unavailable.json()["detail"]
        captured_metadata = await client.get(url + "/metadata", params={"path": source.name})
        assert captured_metadata.json()["kind"] == "captured"
        registry.deregister(HOST)
        assert (await client.get(url + "/metadata", params={"path": source.name})).json()[
            "kind"
        ] == "captured"
        offline = await client.get(url + "/location", params={"path": source.name})
        assert offline.status_code == 400
        assert "offline" in offline.json()["detail"]
        assert (await client.get(url, params={"path": source.name})).content == original
        assert files.list(session_id=chat.id).data == []
        denied = await client.get(url, params={"path": source.name}, headers=BOB)
        assert denied.status_code in {403, 404}
    restarted, service = make_app()
    restarted.include_router(
        create_chat_attachments_router(service, LocalArtifactStore(artifacts.storage_location)),
        prefix="/v1",
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=restarted), base_url="http://test", headers=ALICE
    ) as client:
        assert (await client.get(url, params={"path": source.name})).content == original
        assert (await client.post(url + "/capture", params={"path": source.name})).json() == {
            "filename": source.name,
            "mime": "image/png",
            "bytes": len(original),
        }


@pytest.mark.parametrize("grant", [LEVEL_READ, LEVEL_EDIT, LEVEL_OWNER])
@pytest.mark.parametrize("endpoint", ["/location", "/capture"])
async def test_reference_location_requires_session_and_original_host_ownership(
    workspace_stack, artifact_store, grant, endpoint
):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service, artifact_store), prefix="/v1")
    chat = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", chat.id, LEVEL_OWNER)
    permissions.grant("bob", chat.id, grant)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="assistant", agent="agent", content=[]),
            )
        ],
    )[0]
    frames.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=BOB
    ) as client:
        denied = await client.request(
            "POST" if endpoint == "/capture" else "GET",
            f"/v1/sessions/{chat.id}/attachments/references/{message.id}{endpoint}",
            params={"path": "file.txt"},
        )
        assert denied.status_code == 403, denied.text
        assert frames == []


async def test_reference_location_rejects_changed_original_generation(
    workspace_stack, artifact_store, monkeypatch
):
    make_app, root, conversations, permissions, _, _, hosts = workspace_stack
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service, artifact_store), prefix="/v1")
    chat = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", chat.id, LEVEL_OWNER)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="assistant", agent="agent", content=[]),
            )
        ],
    )[0]
    host = hosts.get_host(HOST)
    replacement = replace(host, created_at=host.created_at + 1)
    monkeypatch.setattr(hosts, "get_host", lambda host_id: replacement)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        for suffix in ("", "/location", "/capture"):
            response = await client.request(
                "POST" if suffix == "/capture" else "GET",
                f"/v1/sessions/{chat.id}/attachments/references/{message.id}{suffix}",
                params={"path": "file.txt"},
            )
            assert response.status_code == 409, response.text
            assert (
                response.json()["detail"]
                == "The original workspace generation is no longer available"
            )


async def test_reference_location_requires_the_source_message_and_its_captured_scope(
    workspace_stack, artifact_store
):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service, artifact_store), prefix="/v1")
    chat = conversations.create_conversation()
    permissions.grant("alice", chat.id, LEVEL_OWNER)
    message = conversations.append(
        chat.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="assistant", agent="agent", content=[]),
            )
        ],
    )[0]
    conversations.set_host_id(chat.id, HOST, str(root))
    other = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", other.id, LEVEL_OWNER)
    frames.clear()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        for session_id, item_id, status in (
            (chat.id, "0" * 32, 404),
            (other.id, message.id, 404),
            (chat.id, message.id, 409),
        ):
            for suffix, method in (("/location", "GET"), ("/capture", "POST")):
                response = await client.request(
                    method,
                    f"/v1/sessions/{session_id}/attachments/references/{item_id}{suffix}",
                    params={"path": "file.txt"},
                )
                assert response.status_code == status, response.text
        assert frames == []


async def test_presentation_upload_keeps_supported_native_filesystem_delivery(file_client):
    native = "64a784c3aa907d1774f44313546947c6"
    response = await file_client.post(
        f"/v1/sessions/{native}/resources/files?presentation=true",
        files={"file": ("workbook.xlsx", b"PK-original", "application/zip")},
    )
    assert response.status_code == 201, response.text
    assert response.json()["metadata"]["source_metadata"]["delivery"] == "filesystem"
