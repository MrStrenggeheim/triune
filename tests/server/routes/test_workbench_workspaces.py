# Modified for Triune.
"""Workspace identities survive chat changes, authorization and service recreation."""

from __future__ import annotations

import asyncio
import subprocess
from contextlib import suppress
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.host.connect import HostProcess
from omnigent.host.frames import (
    HostFsRequestFrame,
    HostFsWriteFrame,
    HostHelloFrame,
    HostStatFrame,
    decode_host_frame,
)
from omnigent.runner.transports.ws_tunnel.frames import HelloFrame
from omnigent.runner.transports.ws_tunnel.registry import TunnelRegistry
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.auth import LEVEL_EDIT, LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.server.host_registry import HostRegistry
from omnigent.server.routes._gzip_route import GZipJSONMiddleware
from omnigent.server.routes.workbench_workspaces import create_workbench_workspaces_router
from omnigent.server.workbench_resources import HostWorkspaceResources
from omnigent.server.workbench_workspace_service import WorkbenchWorkspaceService
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.host_store import HostStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from omnigent.stores.workbench_workspace_store import WorkbenchWorkspaceStore
from omnigent.workspace_fs import WorkspaceReader, WorkspaceReaderError

ALICE = {"X-Forwarded-Email": "alice"}
BOB = {"X-Forwarded-Email": "bob"}
HOST = "1" * 32
OTHER_HOST = "2" * 32


@pytest.fixture
async def workspace_stack(db_uri, tmp_path):
    hosts = HostStore(db_uri)
    registry = HostRegistry()
    conversations = SqlAlchemyConversationStore(db_uri)
    permissions = SqlAlchemyPermissionStore(db_uri)
    for user in ("alice", "bob"):
        permissions.ensure_user(user)
    agents = SqlAlchemyAgentStore(db_uri)
    artifacts = LocalArtifactStore(str(tmp_path / "artifacts"))
    cache = AgentCache(artifacts, tmp_path / "cache")
    frames = []
    tasks = []
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "file.txt").write_text("before\n")
    subprocess.run(["git", "init", "-q", str(root)], check=True)

    async def host_worker(conn):
        while True:
            outbound = await conn.outbound_queue.get()
            if outbound is None:
                return
            frame = decode_host_frame(outbound.data)
            frames.append((conn.host_id, frame))
            if isinstance(frame, HostStatFrame):
                conn.pending_stats[frame.request_id].set_result(
                    {
                        "status": "ok",
                        "exists": Path(frame.path).expanduser().exists(),
                        "type": "directory" if Path(frame.path).expanduser().is_dir() else "file",
                        "canonical_path": str(Path(frame.path).expanduser().resolve()),
                    }
                )
            elif isinstance(frame, (HostFsRequestFrame, HostFsWriteFrame)):
                try:
                    if isinstance(frame, HostFsWriteFrame):
                        result = await asyncio.to_thread(
                            HostProcess._dispatch_fs_write_op,
                            frame.workspace,
                            frame.op,
                            {**frame.params, "session_id": frame.session_id},
                        )
                    else:
                        result = await asyncio.to_thread(
                            HostProcess._dispatch_fs_op,
                            WorkspaceReader(Path(frame.workspace)),
                            frame.op,
                            frame.session_id,
                            frame.params,
                        )
                    reply = {"status": "ok", "payload": result}
                except WorkspaceReaderError as exc:
                    reply = {
                        "status": "error",
                        "error_status": exc.status,
                        "error_code": exc.code,
                        "error": exc.message,
                    }
                conn.pending_fs_requests[frame.request_id].set_result(reply)

    for host_id in (HOST, OTHER_HOST):
        hosts.upsert_on_connect(host_id, host_id, "alice")
        conn = registry.register(
            host_id,
            AsyncMock(),
            HostHelloFrame(version="test", frame_protocol_version=1, name=host_id),
            owner="alice",
        )
        tasks.append(asyncio.create_task(host_worker(conn)))

    def make_app():
        service = WorkbenchWorkspaceService(
            store=WorkbenchWorkspaceStore(db_uri),
            host_store=hosts,
            host_registry=registry,
            conversation_store=conversations,
            agent_store=agents,
            agent_cache=cache,
            auth_provider=UnifiedAuthProvider(source="header", local_single_user=False),
            permission_store=permissions,
        )
        app = FastAPI()
        app.add_middleware(GZipJSONMiddleware)
        app.include_router(create_workbench_workspaces_router(service), prefix="/v1")

        @app.exception_handler(OmnigentError)
        async def error(request: Request, exc: OmnigentError):
            return JSONResponse(status_code=exc.http_status, content={"detail": exc.message})

        return app, service

    yield make_app, root, conversations, permissions, registry, frames, hosts
    for task in tasks:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def test_independent_resources_survive_chat_delete_and_restart(workspace_stack):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    app, _ = make_app()
    conv = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", conv.id, LEVEL_OWNER)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        resolved = await client.post(
            "/v1/workbench-workspaces/resolve", json={"session_id": conv.id}
        )
        assert resolved.status_code == 200, resolved.text
        workspace = resolved.json()
        assert workspace["capabilities"] == ["files", "search", "git", "github", "terminals"]
        again = await client.post(
            "/v1/workbench-workspaces", json={"host_id": HOST, "root": str(root)}
        )
        assert again.json()["id"] == workspace["id"]
        base = f"/v1/workbench-workspaces/{workspace['id']}/resources/environments/default"
        assert (await client.get(base + "/filesystem/file.txt")).json()["content"] == "before\n"
        saved = await client.put(base + "/filesystem/file.txt", json={"content": "after\n"})
        assert saved.status_code == 200, saved.text
        assert (root / "file.txt").read_text() == "after\n"
        edited = await client.patch(
            base + "/filesystem/file.txt", json={"old_text": "after", "new_text": "changed"}
        )
        assert edited.status_code == 200, edited.text
        assert (root / "file.txt").read_text() == "changed\n"
        await client.put(base + "/filesystem/file.txt", json={"content": "after\n"})
        payload = bytes(range(256)) * 65537
        (root / "large.bin").write_bytes(payload)
        capped = await client.get(base + "/filesystem/large.bin")
        assert capped.json()["truncated"] is True
        assert "content-encoding" not in capped.headers
        downloaded = await client.get(base + "/filesystem/large.bin", params={"download": "true"})
        assert downloaded.status_code == 200, downloaded.text[:100]
        assert downloaded.content == payload
        assert "content-encoding" not in downloaded.headers
        git = await client.get(base + "/git", params={"operation": "repository"})
        assert git.status_code == 200, git.text
        await conversations.delete_conversation(conv.id)
        assert (await client.get(base + "/filesystem/file.txt")).json()["content"] == "after\n"
        assert all(
            frame.session_id == workspace["id"]
            for _, frame in frames
            if isinstance(frame, (HostFsRequestFrame, HostFsWriteFrame))
        )
    restarted, _ = make_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=restarted), base_url="http://test", headers=ALICE
    ) as client:
        listing = (await client.get("/v1/workbench-workspaces")).json()
        assert [item["id"] for item in listing["data"]] == [workspace["id"]]
        assert (await client.get(base + "/filesystem/file.txt")).json()["content"] == "after\n"


async def test_raw_download_validates_file_and_root_without_content_preread(workspace_stack):
    make_app, root, _, _, _, frames, _ = workspace_stack
    app, _ = make_app()
    (root / "directory").mkdir()
    outside = root.parent / "secret.txt"
    outside.write_text("secret")
    (root / "escape").symlink_to(outside)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        workspace = (
            await client.post(
                "/v1/workbench-workspaces", json={"host_id": HOST, "root": str(root)}
            )
        ).json()
        base = (
            f"/v1/workbench-workspaces/{workspace['id']}/resources/"
            "environments/default/filesystem/"
        )
        frames.clear()
        for path, status in (
            ("file.txt", 200),
            ("directory", 400),
            ("missing", 404),
            ("escape", 403),
        ):
            response = await client.get(base + path, params={"download": "true"})
            assert response.status_code == status, response.text
            if status == 200:
                assert response.content == b"before\n"
        assert (
            await client.get(base + "file.txt", params={"download": "true"}, headers=BOB)
        ).status_code == 404
        assert (
            await client.get(base + "etc/passwd", params={"download": "true", "base": "host"})
        ).status_code == 403
        assert not any(getattr(frame, "op", None) == "list_or_read" for _, frame in frames)
        requests = [
            frame.params
            for _, frame in frames
            if getattr(frame, "op", None) == "filesystem_operation"
        ]
        assert requests
        assert all(params["_unconfined"] is False for params in requests)
        assert all(params["_owner"] == "alice" for params in requests)
        assert all(
            params["_roots"] == [{"path": str(root), "kind": "tree", "access": "write"}]
            for params in requests
        )


@pytest.mark.parametrize("failure", ["invalid_base64", "empty", "overrun", "changed", "cancel"])
async def test_raw_download_cancels_on_invalid_or_interrupted_read(
    workspace_stack, monkeypatch, failure
):
    make_app, root, _, _, _, frames, _ = workspace_stack
    app, service = make_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        resolved = (
            await client.post(
                "/v1/workbench-workspaces", json={"host_id": HOST, "root": str(root)}
            )
        ).json()
    workspace = service.store.get(resolved["id"], "alice")
    adapter = HostWorkspaceResources(service, workspace)
    operation = adapter.filesystem_operation

    async def faulty(body):
        if body["operation"] == "download_read":
            if failure == "cancel":
                raise asyncio.CancelledError()
            if failure != "changed":
                return {
                    "content_base64": {
                        "invalid_base64": "!",
                        "empty": "",
                        "overrun": "eHh4eHh4eHg=",
                    }[failure]
                }
        return await operation(body)

    monkeypatch.setattr(adapter, "filesystem_operation", faulty)
    response = await adapter.download_file("file.txt")
    if failure == "changed":
        (root / "file.txt").write_text("changed during capture")
    expected_error = asyncio.CancelledError if failure == "cancel" else HTTPException
    with pytest.raises(expected_error) as error:
        async for _ in response.body_iterator:
            pass
    if isinstance(error.value, HTTPException):
        assert error.value.status_code == (409 if failure == "changed" else 502)
    operations = [frame.params.get("operation") for _, frame in frames if hasattr(frame, "params")]
    assert operations.count("download_cancel") == 1


@pytest.mark.parametrize("grant", [LEVEL_READ, LEVEL_EDIT])
@pytest.mark.parametrize("accept_encoding", ["gzip", "identity"])
async def test_chat_share_does_not_grant_workspace_or_host(
    workspace_stack, grant, accept_encoding
):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    app, _ = make_app()
    conv = conversations.create_conversation(host_id=HOST, workspace=str(root))
    permissions.grant("alice", conv.id, LEVEL_OWNER)
    permissions.grant("bob", conv.id, grant)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Accept-Encoding": accept_encoding},
    ) as client:
        owner = await client.post(
            "/v1/workbench-workspaces/resolve", json={"session_id": conv.id}, headers=ALICE
        )
        workspace_id = owner.json()["id"]
        frames.clear()
        assert (
            await client.post(
                "/v1/workbench-workspaces/resolve", json={"session_id": conv.id}, headers=BOB
            )
        ).status_code == 403
        assert (
            await client.post(
                "/v1/workbench-workspaces", json={"host_id": HOST, "root": str(root)}, headers=BOB
            )
        ).status_code == 403
        assert (
            await client.get(f"/v1/workbench-workspaces/{workspace_id}", headers=BOB)
        ).status_code == 404
        assert (
            await client.get(
                f"/v1/workbench-workspaces/{workspace_id}/resources/environments/default/filesystem/file.txt",
                headers=BOB,
            )
        ).status_code == 404
        assert (await client.get("/v1/workbench-workspaces", headers=BOB)).json()["data"] == []
        assert (await client.get("/v1/workbench-workspaces")).status_code == 401
        assert frames == []


async def test_workspace_listing_reuses_targets_only_within_request(workspace_stack, monkeypatch):
    make_app, root, _, _, registry, _, hosts = workspace_stack
    app, service = make_app()
    host = hosts.get_host(HOST)
    generation = f"{host.created_at}:{host.account_generation or 'external'}"
    workspaces = [
        service.store.resolve(
            owner_user_id="alice",
            host_id=HOST,
            target_kind="host",
            target_id=HOST,
            generation=generation,
            root=str(root / str(index)),
        )
        for index in range(4)
    ]
    stale = service.store.resolve(
        owner_user_id="alice",
        host_id=HOST,
        target_kind="host",
        target_id=HOST,
        generation="stale",
        root=str(root),
    )
    get_host = Mock(wraps=hosts.get_host)
    monkeypatch.setattr(hosts, "get_host", get_host)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        first = await client.get("/v1/workbench-workspaces", headers={"Accept-Encoding": "gzip"})
        assert first.status_code == 200, first.text
        assert first.headers["content-encoding"] == "gzip"
        by_id = {item["id"]: item for item in first.json()["data"]}
        assert all(by_id[item.id]["available"] for item in workspaces)
        assert by_id[stale.id]["available"] is False
        assert get_host.call_count == 2
        registry.deregister(HOST)
        get_host.reset_mock()
        second = await client.get("/v1/workbench-workspaces")
        assert all(item["available"] is False for item in second.json()["data"])
        assert get_host.call_count == 2
        hidden = await client.get("/v1/workbench-workspaces", headers=BOB)
        assert hidden.json()["data"] == []
        assert get_host.call_count == 2


async def test_same_path_on_other_host_has_different_identity_and_no_fallback(workspace_stack):
    make_app, root, _, _, registry, frames, _ = workspace_stack
    app, _ = make_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        first = (
            await client.post(
                "/v1/workbench-workspaces", json={"host_id": HOST, "root": str(root)}
            )
        ).json()
        other = (
            await client.post(
                "/v1/workbench-workspaces", json={"host_id": OTHER_HOST, "root": str(root)}
            )
        ).json()
        assert first["id"] != other["id"]
        base = f"/v1/workbench-workspaces/{first['id']}/resources/environments/default"
        frames.clear()
        assert (
            await client.get(base + "/filesystem/etc/passwd", params={"base": "host"})
        ).status_code == 403
        assert (
            await client.post(
                base + "/filesystem-operations",
                json={
                    "operation": "copy",
                    "entries": [{"source": "file.txt", "destination": "/outside/file.txt"}],
                    "_unconfined": True,
                },
            )
        ).status_code == 403
        registry.deregister(HOST)
        assert (await client.get(base + "/filesystem/file.txt")).status_code == 503
        assert frames == []


async def test_runner_without_filesystem_identity_fails_closed(workspace_stack):
    make_app, _, conversations, permissions, _, frames, _ = workspace_stack
    app, _ = make_app()
    conv = conversations.create_conversation(runner_id="3" * 32)
    permissions.grant("alice", conv.id, LEVEL_OWNER)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        response = await client.post(
            "/v1/workbench-workspaces/resolve", json={"session_id": conv.id}
        )
        assert response.status_code == 409
        assert frames == []


async def test_runner_adapter_pins_source_root_owner_and_generation(workspace_stack, monkeypatch):
    make_app, root, conversations, permissions, _, host_frames, _ = workspace_stack
    app, service = make_app()
    registry = TunnelRegistry()
    service.tunnel_registry = registry
    service.host_store = None
    runner_id = "3" * 32
    hello = HelloFrame(runner_version="test", frame_protocol_version=1)
    conn = registry.register(runner_id, AsyncMock(), hello, owner="alice")
    conv = conversations.create_conversation(runner_id=runner_id)
    permissions.grant("alice", conv.id, LEVEL_OWNER)
    requests = []
    reported_root = str(root)

    async def runner_request(target_id, connection, method, path, **kwargs):
        requests.append((target_id, connection.generation, method, path))
        if path.endswith("/environments/default"):
            return httpx.Response(200, json={"metadata": {"root": reported_root}})
        return httpx.Response(200, json={"content": "runner bytes"})

    monkeypatch.setattr(service, "runner_request", runner_request)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        resolved = await client.post(
            "/v1/workbench-workspaces/resolve", json={"session_id": conv.id}
        )
        assert resolved.status_code == 200, resolved.text
        workspace = resolved.json()
        assert workspace["target_kind"] == "runneronly"
        assert workspace["source_environment_id"] == f"{conv.id}/default"
        assert "terminals" not in workspace["capabilities"]
        base = f"/v1/workbench-workspaces/{workspace['id']}/resources"
        url = base + "/environments/default/filesystem/file.txt"
        assert (await client.get(url)).json()["content"] == "runner bytes"
        assert (
            await client.get(
                base + "/environments/default/git", params={"directories": '["/outside"]'}
            )
        ).status_code == 403
        assert (
            await client.post(
                base + "/environments/default/content-replace",
                json={"path": "/outside", "action": "preview"},
            )
        ).status_code == 403
        assert all(
            target == runner_id
            and generation == conn.generation
            and f"/sessions/{conv.id}/" in path
            for target, generation, _, path in requests
        )
        reported_root = "/different/filesystem"
        assert (await client.get(url)).status_code == 409
        reported_root = str(root)
        registry.register(runner_id, AsyncMock(), hello, owner="alice")
        assert (await client.get(url)).status_code == 409
        assert host_frames == []


async def test_provider_uses_workspace_target_and_namespace(workspace_stack, monkeypatch):
    from omnigent.runner import pr_resource

    make_app, root, _, _, _, frames, _ = workspace_stack
    app, _ = make_app()
    calls = []

    def pr_info(target_root, *, session_id=None, pr_url=None):
        calls.append((target_root, session_id))
        return {"object": "session.github.info", "account": "selected-host-account"}

    monkeypatch.setattr(pr_resource, "pr_info", pr_info)
    uploads = []

    def upload_pr_attachment(target_root, **kwargs):
        uploads.append((target_root, kwargs))
        return {"url": "https://provider.example/attachment.png"}

    monkeypatch.setattr(pr_resource, "upload_pr_attachment", upload_pr_attachment)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        workspace = (
            await client.post(
                "/v1/workbench-workspaces", json={"host_id": OTHER_HOST, "root": str(root)}
            )
        ).json()
        result = await client.get(f"/v1/workbench-workspaces/{workspace['id']}/resources/github")
        assert result.status_code == 200, result.text
        assert result.json()["account"] == "selected-host-account"
        assert calls == [(str(root), workspace["id"])]
        assert frames[-1][0] == OTHER_HOST
        url = f"/v1/workbench-workspaces/{workspace['id']}/resources/github/attachments"
        attached = await client.post(
            url,
            data={"pr_url": "https://provider.example/pr/1"},
            files={"file": ("image.png", b"attachment bytes")},
        )
        assert attached.status_code == 200, attached.text
        assert uploads[0][0] == str(root)
        assert uploads[0][1]["session_id"] == workspace["id"]
        assert uploads[0][1]["content"] == b"attachment bytes"
        assert frames[-1][0] == OTHER_HOST
        assert (
            await client.post(
                url,
                headers=BOB,
                data={"pr_url": "https://provider.example/pr/1"},
                files={"file": ("image.png", b"forbidden")},
            )
        ).status_code == 404
        assert len(uploads) == 1

        nested = root / "nested repo"
        nested.mkdir()
        scoped = await client.get(
            f"/v1/workbench-workspaces/{workspace['id']}/resources/github",
            params={"folder": "nested repo"},
        )
        assert scoped.status_code == 200, scoped.text
        assert calls[-1][0] == str(nested)
        scope_identity = calls[-1][1]
        assert scope_identity != workspace["id"]
        attached = await client.post(
            url + "?folder=nested%20repo",
            data={"pr_url": "https://provider.example/pr/1"},
            files={"file": ("nested.png", b"nested bytes")},
        )
        assert attached.status_code == 200, attached.text
        assert uploads[-1][0] == str(nested)
        assert uploads[-1][1]["session_id"] == scope_identity
        assert uploads[-1][1]["content"] == b"nested bytes"
        outside = root.parent / "outside-pr-root"
        outside.mkdir(exist_ok=True)
        (root / "outward").symlink_to(outside, target_is_directory=True)
        for folder in ("../outside-pr-root", str(outside), "outward"):
            rejected = await client.get(
                f"/v1/workbench-workspaces/{workspace['id']}/resources/github",
                params={"folder": folder},
            )
            assert rejected.status_code in {400, 403}, rejected.text
        assert len(calls) == 2
