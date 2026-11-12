# Modified for Triune.
"""Durable attachment bytes and message-captured workspace references."""

from dataclasses import replace

import httpx
import pytest

from omnigent.entities.conversation import MessageData, NewConversationItem
from omnigent.server.auth import LEVEL_EDIT, LEVEL_OWNER, LEVEL_READ
from omnigent.server.routes.chat_attachments import create_chat_attachments_router
from tests.server.routes.test_session_resources import artifact_store as artifact_store
from tests.server.routes.test_session_resources import file_app as file_app
from tests.server.routes.test_session_resources import file_client as file_client
from tests.server.routes.test_session_resources import file_conv_store as file_conv_store
from tests.server.routes.test_session_resources import file_store as file_store
from tests.server.routes.test_session_resources import runner_globals_reset as runner_globals_reset
from tests.server.routes.test_workbench_workspaces import ALICE, BOB, HOST, OTHER_HOST
from tests.server.routes.test_workbench_workspaces import workspace_stack as workspace_stack

SESSION = "79b22ebd2309e48fdeb450c65611d51b"


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


async def test_authorized_markdown_reference_snapshot_survives_source_and_host_loss(
    workspace_stack, db_uri, tmp_path
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
        first = await client.get(url, params={"path": source.name})
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


@pytest.mark.parametrize("grant", [LEVEL_READ, LEVEL_EDIT, LEVEL_OWNER])
async def test_reference_location_requires_session_and_original_host_ownership(
    workspace_stack, grant
):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service), prefix="/v1")
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
        denied = await client.get(
            f"/v1/sessions/{chat.id}/attachments/references/{message.id}/location",
            params={"path": "file.txt"},
        )
        assert denied.status_code == 403, denied.text
        assert frames == []


async def test_reference_location_rejects_changed_original_generation(
    workspace_stack, monkeypatch
):
    make_app, root, conversations, permissions, _, _, hosts = workspace_stack
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
    host = hosts.get_host(HOST)
    replacement = replace(host, created_at=host.created_at + 1)
    monkeypatch.setattr(hosts, "get_host", lambda host_id: replacement)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=ALICE
    ) as client:
        for suffix in ("", "/location"):
            response = await client.get(
                f"/v1/sessions/{chat.id}/attachments/references/{message.id}{suffix}",
                params={"path": "file.txt"},
            )
            assert response.status_code == 409, response.text
            assert (
                response.json()["detail"]
                == "The original workspace generation is no longer available"
            )


async def test_reference_location_requires_the_source_message_and_its_captured_scope(
    workspace_stack,
):
    make_app, root, conversations, permissions, _, frames, _ = workspace_stack
    app, service = make_app()
    app.include_router(create_chat_attachments_router(service), prefix="/v1")
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
            response = await client.get(
                f"/v1/sessions/{session_id}/attachments/references/{item_id}/location",
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
