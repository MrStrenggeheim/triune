# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Bounded compiled-SPA acceptance for visible leases, list updates and durable drafts."""

from __future__ import annotations

import json
from collections import Counter
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Page, Request, Route, WebSocketRoute, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, list_payload
from tests.browser_ui.chat.test_unified_workspace import WorkspaceJourney, _saved_dock, _view
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract


def _summary(chat: ChatSessionContract) -> dict[str, Any]:
    """Full SessionListItem wire row; HTTP omits nulls, WS explicitly clears them."""
    session = chat.session_snapshot()
    return {
        "id": chat.session_id,
        "agent_id": chat.agent_id,
        "agent_name": chat.agent_id,
        "harness": chat.harness,
        "status": session["status"],
        "activity": {
            "own_status": session["status"],
            "descendant_running": False,
            "descendants": [],
            "descendants_complete": True,
        },
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
        "title": session["title"],
        "labels": session["labels"],
        "runner_id": None,
        "host_id": chat.host_id,
        "runner_online": None,
        "host_online": None,
        "reasoning_effort": None,
        "permission_level": 4,
        "owner": "local",
        "external_session_id": None,
        "pending_elicitations_count": 0,
        "workspace": session["workspace"],
        "workspace_switching": False,
        "workspace_revision": None,
        "git_branch": None,
        "archived": False,
        "comments_count": 0,
        "comments_updated_at": None,
        "viewer_last_seen": None,
        "viewer_unread": False,
        "search_snippet": None,
        "parent_session_id": None,
        "branch": None,
        "project_id": None,
    }


class _TranscriptSocket:
    """Use the same negotiated subscribe/sync lifecycle as test_transcript_multiplex."""

    def __init__(self, contract: BrowserContract, chats: list[ChatSessionContract]) -> None:
        self.chats = {chat.session_id: chat for chat in chats}
        self.rows = {chat.session_id: _summary(chat) for chat in chats}
        self.commands: list[dict[str, Any]] = []
        self.sockets: list[WebSocketRoute] = []
        for chat in chats:
            chat.set_items([{**item, "position": index} for index, item in enumerate(chat._items)])
        contract.websocket("**/v1/sessions/updates*", self._attach)

    def _attach(self, socket: WebSocketRoute) -> None:
        self.sockets.append(socket)

        def received(raw: str | bytes) -> None:
            command = json.loads(raw)
            self.commands.append(command)
            if command["type"] == "watch":
                socket.send(
                    json.dumps(
                        {
                            "type": "snapshot",
                            "items": [
                                self.rows[sid]
                                for sid in command["session_ids"]
                                if sid in self.rows
                            ],
                        }
                    )
                )
            elif command["type"] == "subscribe":
                sid = command["session_id"]
                items = sorted(self.chats[sid]._items, key=lambda item: item["position"])
                boundary = {
                    "conversation_id": sid,
                    "last_position": items[-1]["position"] if items else -1,
                    "last_item_id": items[-1]["id"] if items else None,
                    "item_count": len(items),
                    "item_revision": len(items),
                    "reset_revision": 0,
                    "stream_epoch": "overnight-browser-epoch",
                }
                self.event(sid, {"type": "session.heartbeat", **boundary}, socket=socket)
                for phase in ("start", "complete"):
                    self.event(
                        sid,
                        {"type": "session.sync", "phase": phase, "reset": True, **boundary},
                        socket=socket,
                    )
                    if phase == "start":
                        for item in items:
                            self.event(
                                sid,
                                {"type": "response.output_item.done", "item": item},
                                socket=socket,
                            )
            elif command["type"] == "unsubscribe":
                socket.send(
                    json.dumps(
                        {"type": "session.unsubscribed", "session_id": command["session_id"]}
                    )
                )

        socket.on_message(received)
        socket.send(json.dumps({"type": "capabilities", "transcript_stream": 1}))

    def event(
        self, sid: str, payload: dict[str, Any], *, socket: WebSocketRoute | None = None
    ) -> None:
        (socket or self.sockets[-1]).send(
            json.dumps(
                {
                    "type": "session.event",
                    "session_id": sid,
                    "event": payload,
                }
            )
        )

    def changed(self, *ids: str) -> None:
        self.sockets[-1].send(
            json.dumps({"type": "changed", "items": [self.rows[sid] for sid in ids]})
        )

    def lifecycle(self) -> list[dict[str, Any]]:
        return [
            command for command in self.commands if command["type"] in {"subscribe", "unsubscribe"}
        ]


def _settle(page: Page) -> None:
    # Observe beyond the provider's 250 ms invalidation/watch debounce.
    page.wait_for_timeout(750)


def _without_titles(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _without_titles(item) for key, item in value.items() if key != "title"}
    if isinstance(value, list):
        return [_without_titles(item) for item in value]
    return value


@pytest.mark.browser_context_args(viewport={"width": 1440, "height": 1000})
def test_visible_chat_focus_and_titles_preserve_leases_and_drafts(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
) -> None:
    """Focus routes sends without rebinding; streamed titles retain the actual dock and inputs."""
    first, second = workspace_journey.chats
    transport = _TranscriptSocket(browser_contract, workspace_journey.chats)
    reads: Counter[str] = Counter()

    def record(request: Request) -> None:
        path = urlparse(request.url).path
        if request.method == "GET" and any(
            path
            in {f"/v1/sessions/{chat.session_id}{suffix}" for suffix in ("", "/items", "/stream")}
            for chat in workspace_journey.chats
        ):
            reads[request.url] += 1

    page.on("request", record)
    page.goto(first.url)
    expect(_view(page, "Chat A").get_by_text("Answer from Chat A", exact=True)).to_be_visible()
    page.locator(f'aside [data-sidebar-session-id="{second.session_id}"]').click(button="right")
    page.get_by_role("menuitem", name="Open to side", exact=True).click()
    expect(_view(page, "Chat B").get_by_text("Answer from Chat B", exact=True)).to_be_visible()
    views = [
        page.locator(f'[data-dock-view="{_view(page, title).get_attribute("data-dock-view")}"]')
        for title in ("Chat A", "Chat B")
    ]
    inputs = [view.get_by_label("Message the agent", exact=True) for view in views]
    for composer, text in zip(inputs, ("A stays unsent", "B stays unsent"), strict=True):
        composer.fill(text)
    _settle(page)
    assert Counter(
        command["session_id"]
        for command in transport.lifecycle()
        if command["type"] == "subscribe"
    ) == {first.session_id: 1, second.session_id: 1}
    baseline_commands, baseline_reads = list(transport.lifecycle()), reads.copy()
    for _ in range(5):
        for composer in inputs:
            composer.click()
            expect(composer).to_be_focused()
    _settle(page)
    assert transport.lifecycle() == baseline_commands
    assert reads == baseline_reads, "Focus triggered a session/items reconcile or SSE fallback"
    nodes = [_view(page, title).element_handle() for title in ("Chat A", "Chat B")]
    bounds = [_view(page, title).bounding_box() for title in ("Chat A", "Chat B")]
    saved = _saved_dock(page)
    assert saved is not None
    for index in range(3):
        for chat, title in zip(workspace_journey.chats, ("Renamed A", "Renamed B"), strict=True):
            current = f"{title} {index}" if index < 2 else title
            chat.update_session(title=current)
            transport.rows[chat.session_id]["title"] = current
            transport.event(
                chat.session_id,
                {"type": "session.title", "conversation_id": chat.session_id, "title": current},
            )
    for index, title in enumerate(("Renamed A", "Renamed B")):
        expect(page.get_by_role("tab", name=title, exact=True)).to_be_visible()
        expect(_view(page, title)).to_be_visible()
        assert nodes[index] is not None and nodes[index].evaluate(
            "(node, current) => node.isConnected && node === current",
            _view(page, title).element_handle(),
        )
        assert _view(page, title).bounding_box() == pytest.approx(bounds[index], abs=1)
    _settle(page)
    assert _without_titles(_saved_dock(page)) == _without_titles(saved)
    for composer, text in zip(inputs, ("A stays unsent", "B stays unsent"), strict=True):
        expect(composer).to_have_value(text)
    # Hold B's acknowledgement while focus and a subsequent send move to A.
    pending: list[Route] = []

    def hold(route: Route) -> None:
        if route.request.method != "POST":
            route.fallback()
            return
        second.event_posts.append({"url": route.request.url, "body": route.request.post_data_json})
        pending.append(route)

    browser_contract.route(
        browser_contract._matcher(f"/v1/sessions/{second.session_id}/events"), hold
    )
    with page.expect_request(
        lambda request: (
            request.method == "POST" and request.url.endswith(f"/{second.session_id}/events")
        )
    ):
        inputs[1].press("Enter")
    inputs[0].click()
    pending[0].fulfill(json=second.event_ack)
    expect(inputs[0]).to_have_value("A stays unsent")
    expect(inputs[1]).to_have_value("")
    with page.expect_response(
        lambda response: response.url.endswith(f"/{first.session_id}/events")
    ):
        inputs[0].press("Enter")
    for chat, text in zip(
        workspace_journey.chats, ("A stays unsent", "B stays unsent"), strict=True
    ):
        assert len(chat.event_posts) == 1
        assert chat.event_posts[0]["url"].endswith(f"/{chat.session_id}/events")
        assert text in json.dumps(chat.event_posts[0]["body"])
    assert transport.lifecycle() == baseline_commands
    assert len(transport.sockets) == 1
    assert first.stream.connection_generation == second.stream.connection_generation == 0
    Path(output_path).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(Path(output_path) / "desktop-focus-title-send.png"))
    # Closing a visible view really releases its subscription, unlike changing focus.
    page.get_by_role("button", name="Close Renamed B", exact=True).click()
    expect(_view(page, "Renamed B")).to_have_count(0)
    _settle(page)
    assert transport.lifecycle()[len(baseline_commands) :] == [
        {"type": "unsubscribe", "session_id": second.session_id}
    ]
    assert browser_errors == []


@pytest.mark.only_browser("chromium")
@pytest.mark.browser_context_args(
    viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
)
def test_phone_child_updates_stay_scoped_and_structural_changes_converge(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
) -> None:
    """A watched child refreshes its branch, while root sort, project moves and revoke converge."""
    first, child = workspace_journey.chats
    transport = _TranscriptSocket(browser_contract, workspace_journey.chats)
    rows = transport.rows
    rows[child.session_id].update(
        parent_session_id=first.session_id,
        branch={
            "source_conversation_id": first.session_id,
            "root_conversation_id": first.session_id,
            "source_item_id": None,
            "source_response_id": None,
            "inherited_item_count": 0,
            "inherited_last_item_id": None,
            "reference_boundary_item_id": None,
            "created_at": 1_704_067_200,
            "reference_only": True,
            "recovery": "replay",
        },
    )
    child.update_session(
        parent_session_id=first.session_id, branch=rows[child.session_id]["branch"]
    )

    def child_sessions(_request: Request) -> dict[str, Any]:
        row = rows[child.session_id]
        return list_payload(
            [
                {
                    "id": child.session_id,
                    "object": "child_session",
                    "parent_session_id": first.session_id,
                    "title": row["title"],
                    "task_summary": None,
                    "tool": None,
                    "session_name": None,
                    "kind": "sub_agent",
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "agent_id": child.agent_id,
                    "agent_name": child.agent_id,
                    "current_task_id": None,
                    "current_task_status": None,
                    "busy": row["status"] == "running",
                    "labels": row["labels"],
                    "last_task_error": None,
                    "last_message_preview": None,
                    "pending_elicitations_count": 0,
                    "routed_model": None,
                    "routing_decision_id": None,
                }
            ]
        )

    browser_contract.json(f"/v1/sessions/{first.session_id}/child_sessions", child_sessions)
    for sid, title, project in (
        ("overnight-root", "Root peer", None),
        ("overnight-anchor", "Root anchor", None),
        ("overnight-project", "Project peer", "Stable project"),
    ):
        rows[sid] = {
            **_summary(first),
            "id": sid,
            "title": title,
            "updated_at": 1_704_067_190,
            "project_id": project,
            "labels": {"omni_project": project} if project else {},
        }
        browser_contract.json(f"/v1/sessions/{sid}/items", list_payload([]))
    rows["overnight-anchor"]["updated_at"] = 1_704_067_195
    projects = [{"id": name, "name": name} for name in ("Stable project", "Moved project")]
    browser_contract.json("/v1/projects", list_payload(projects))
    browser_contract.json("/v1/sessions/projects", projects)
    counts: Counter[str] = Counter()

    def listing(request: Request) -> dict[str, Any]:
        query = parse_qs(urlparse(request.url).query)
        project = query.get("project", [None])[0]
        kind = query.get("kind", ["default"])[0]
        key = f"project:{project}" if project else "branches" if kind == "any" else "roots"
        if query.get("pinned") == ["true"]:
            key = "pinned"
        counts[key] += 1
        data = [
            row
            for row in rows.values()
            if key != "pinned"
            and (kind == "any" or not row["parent_session_id"])
            and (project is None or row["project_id"] == project)
        ]
        return list_payload(
            [
                {key: value for key, value in row.items() if value is not None}
                for row in sorted(data, key=lambda row: row["updated_at"], reverse=True)
            ]
        )

    browser_contract.json("/v1/sessions", listing)
    page.emulate_media(color_scheme="dark", reduced_motion="reduce")
    page.goto(first.url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_enabled()
    page.get_by_role("button", name="Open navigation", exact=True).tap()
    sidebar = page.get_by_role("complementary", name="Conversations", include_hidden=True)
    expect(sidebar).to_have_attribute("aria-hidden", "false")
    section = sidebar.get_by_role("button", name="Projects", exact=True)
    if section.get_attribute("aria-expanded") == "false":
        section.tap()
    folders = [
        sidebar.locator(f'[data-sidebar-drop-name="{name}"]')
        for name in ("Stable project", "Moved project")
    ]
    for folder in folders:
        header = folder.locator("h2 button[aria-expanded]").first
        expect(header).to_be_visible()
        if header.get_attribute("aria-expanded") == "false":
            header.tap()
    parent = sidebar.locator(f'[data-sidebar-session-id="{first.session_id}"]')
    expand = parent.get_by_role("button", name="Expand subchats of Chat A", exact=True)
    expect(expand).to_be_visible()
    expand.tap()
    nested = sidebar.locator(f'[data-sidebar-session-id="{child.session_id}"]')
    expect(nested).to_be_visible()
    expect(folders[0].get_by_text("Project peer", exact=True)).to_be_visible()
    _settle(page)
    assert all(
        counts[key] > 0
        for key in ("roots", "branches", "project:Stable project", "project:Moved project")
    )
    assert any(
        child.session_id in command.get("session_ids", [])
        for command in transport.commands
        if command["type"] == "watch"
    )
    baseline = counts.copy()
    for index in range(6):
        rows[child.session_id].update(updated_at=1_704_067_210 + index, status="running")
        rows[child.session_id]["activity"] = {
            "own_status": "running",
            "descendant_running": False,
            "descendants": [],
            "descendants_complete": True,
        }
        transport.changed(child.session_id)
    expect(
        nested.locator('[data-testid="session-state-badge"][data-state="running"]')
    ).to_be_visible()
    _settle(page)
    assert counts["branches"] > baseline["branches"], "Affected branch inventory did not reconcile"
    assert {key: value for key, value in counts.items() if key != "branches"} == {
        key: value for key, value in baseline.items() if key != "branches"
    }, "Child sort updates refetched unrelated root/project lists"
    baseline = counts.copy()
    rows["overnight-root"]["updated_at"] = 1_704_067_300
    transport.changed("overnight-root")
    _settle(page)
    assert counts["roots"] > baseline["roots"], "Background root sort must still reconcile"
    root = sidebar.locator('[data-sidebar-session-id="overnight-root"]')
    expect(root).to_be_visible()
    # Touch emulation leaves a compatibility mouse in the list, which holds its sort keys.
    page.mouse.move(195, 20)
    page.wait_for_function(
        "({node, anchor}) => !!(node.compareDocumentPosition(anchor) & "
        "Node.DOCUMENT_POSITION_FOLLOWING)",
        arg={
            "node": root.element_handle(),
            "anchor": sidebar.locator(
                '[data-sidebar-session-id="overnight-anchor"]'
            ).element_handle(),
        },
    )
    rows["overnight-project"].update(
        project_id="Moved project", labels={"omni_project": "Moved project"}
    )
    transport.changed("overnight-project")
    expect(folders[0].get_by_text("Project peer", exact=True)).to_have_count(0)
    expect(folders[1].get_by_text("Project peer", exact=True)).to_be_visible()
    del rows["overnight-project"]
    transport.sockets[-1].send(json.dumps({"type": "removed", "ids": ["overnight-project"]}))
    expect(sidebar.locator('[data-sidebar-session-id="overnight-project"]')).to_have_count(0)
    _settle(page)
    expect(sidebar.locator('[data-sidebar-session-id="overnight-project"]')).to_have_count(0)
    expect(nested).to_be_visible()
    assert len(transport.sockets) == 1
    Path(output_path).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(Path(output_path) / "phone-scoped-child-and-structural.png"))
    assert browser_errors == []


_READ_DURABLE_DRAFTS = """async () => {
      const scope = sessionStorage.getItem('omnigent.sessionDrafts.scope');
      const databases = await indexedDB.databases();
      if (!scope || !databases.some(db => db.name === 'omnigent-message-queues'))
        return null;
      const saved = await new Promise((resolve, reject) => {
        const open = indexedDB.open('omnigent-message-queues', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('queues', 'readonly');
          const read = tx.objectStore('queues').get(`composer:${scope}`);
          tx.oncomplete = () => { db.close(); resolve(read.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      if (saved?.version !== 1) return null;
      return Object.fromEntries(Object.entries(saved.drafts).sort().map(([id, draft]) =>
        [id, {text: draft.text, files: draft.files.map(file => ({
          name: file.name, type: file.type, bytes: [...new Uint8Array(file.data)]
        }))}]));
    }"""


def _wait_durable_drafts(page: Page, expected: dict[str, Any]) -> None:
    """Observe committed IDB bytes using only readonly transactions, never store imports."""
    page.wait_for_function(
        f"""async expected => {{
          const actual = await ({_READ_DURABLE_DRAFTS})();
          return JSON.stringify(actual) === JSON.stringify(expected);
        }}""",
        arg=dict(sorted(expected.items())),
        polling=50,
        timeout=8_000,
    )


def _wait_draft_hydration(page: Page) -> None:
    page.wait_for_function("""() => {
      const scope = sessionStorage.getItem('omnigent.sessionDrafts.scope');
      return scope && window.__overnightDraftReads?.[`composer:${scope}`] > 0;
    }""")


@pytest.mark.browser_context_args(viewport={"width": 1440, "height": 1000})
def test_two_pages_preserve_independent_draft_files_and_remote_deletion(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    output_path: str,
) -> None:
    """Independent hydrated pages merge real File bytes and never revive a sent remote draft."""
    first, second = workspace_journey.chats
    other = page.context.new_page()
    other_errors: list[str] = []
    other.on("pageerror", lambda error: other_errors.append(str(error)))
    files = [
        ("alpha.txt", "text/plain", b"alpha\x00utf8 \xc3\xa4\n"),
        ("beta.json", "application/json", b'{"owner":"beta","n":2}\n'),
    ]
    expected: dict[str, Any] = {}
    try:
        for target, chat in zip((page, other), workspace_journey.chats, strict=True):
            # Observe the app's completed hydration read before our own readonly IDB probes.
            target.add_init_script("""(() => {
              const original = IDBObjectStore.prototype.get;
              IDBObjectStore.prototype.get = function(key) {
                const request = original.call(this, key);
                if (this.name === 'queues' && this.transaction.mode === 'readonly' &&
                    typeof key === 'string' && key.startsWith('composer:')) {
                  this.transaction.addEventListener('complete', () => {
                    window.__overnightDraftReads ??= {};
                    window.__overnightDraftReads[key] =
                      (window.__overnightDraftReads[key] ?? 0) + 1;
                  }, {once: true});
                }
                return request;
              };
            })();""")
            target.goto(chat.url)
            composer = _view(target, chat.session_snapshot()["title"]).get_by_label(
                "Message the agent"
            )
            expect(composer).to_be_enabled()
            expect(composer).to_have_value("")
            _wait_draft_hydration(target)
            _wait_durable_drafts(target, {})
        assert page.evaluate("location.origin") == other.evaluate("location.origin")
        assert page.evaluate(
            "sessionStorage.getItem('omnigent.sessionDrafts.scope')"
        ) == other.evaluate("sessionStorage.getItem('omnigent.sessionDrafts.scope')")
        for target, chat, (name, mime, data) in zip(
            (page, other), workspace_journey.chats, files, strict=True
        ):
            title = chat.session_snapshot()["title"]
            view = _view(target, title)
            view.get_by_label("Message the agent").fill(f"Exact draft for {title}")
            view.locator('form.chat-composer-form input[type="file"]').set_input_files(
                {"name": name, "mimeType": mime, "buffer": data}
            )
            expect(view.get_by_role("button", name=f"Remove {name}", exact=True)).to_be_visible()
            expected[chat.session_id] = {
                "text": f"Exact draft for {title}",
                "files": [{"name": name, "type": mime, "bytes": list(data)}],
            }
        for target in (page, other):
            _wait_durable_drafts(target, expected)
        # Both instances now observe both entries, leaving a genuinely stale A in page B.
        for target, chat, (name, _mime, _data) in zip(
            (page, other), workspace_journey.chats, files, strict=True
        ):
            target.reload()
            _wait_draft_hydration(target)
            view = _view(target, chat.session_snapshot()["title"])
            expect(view.get_by_label("Message the agent")).to_have_value(
                expected[chat.session_id]["text"]
            )
            expect(view.get_by_role("button", name=f"Remove {name}", exact=True)).to_be_visible()
            expect(view.locator('button[aria-label^="Remove "]')).to_have_count(1)
            _wait_durable_drafts(target, expected)
        Path(output_path).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(output_path) / "durable-page-a.png"))
        other.screenshot(path=str(Path(output_path) / "durable-page-b.png"))
        # Sending restored Files proves hydration reconstructed exact bytes, not just chip names.
        for index, (target, chat, (name, mime, data)) in enumerate(
            zip((page, other), workspace_journey.chats, files, strict=True)
        ):
            chat.reject_uploads = False
            chat.contract.json(
                f"/v1/sessions/{chat.session_id}/resources/files/browser-upload-1",
                {
                    "id": "browser-upload-1",
                    "object": "session.resource",
                    "type": "file",
                    "session_id": chat.session_id,
                    "name": name,
                    "metadata": {
                        "filename": name,
                        "bytes": len(data),
                        "created_at": 1_704_067_200,
                        "source_metadata": None,
                    },
                },
            )
            view = _view(target, chat.session_snapshot()["title"])
            if index == 1:
                text = "B edited after A was sent"
                view.get_by_label("Message the agent").fill(text)
                expected[chat.session_id]["text"] = text
                _wait_durable_drafts(target, expected)
            with target.expect_response(
                lambda response, sid=chat.session_id: response.url.endswith(f"/{sid}/events")
            ):
                view.get_by_role("button", name="Send", exact=True).click()
            assert len(chat.upload_requests) == len(chat.event_posts) == 1
            upload = chat.upload_requests[0]
            multipart = BytesParser(policy=email_policy).parsebytes(
                f"Content-Type: {upload['content_type']}\r\nMIME-Version: 1.0\r\n\r\n".encode()
                + upload["body_bytes"]
            )
            parts = [part for part in multipart.iter_parts() if part.get_filename() is not None]
            assert len(parts) == 1
            assert (
                parts[0].get_filename(),
                parts[0].get_content_type(),
                parts[0].get_payload(decode=True),
            ) == (name, mime, data)
            assert expected[chat.session_id]["text"] in json.dumps(chat.event_posts[0]["body"])
            del expected[chat.session_id]
            _wait_durable_drafts(target, expected)
        assert first.stream.connection_generation >= 2
        assert second.stream.connection_generation >= 2
        assert other_errors == browser_errors == []
    finally:
        Path(output_path).mkdir(parents=True, exist_ok=True)
        diagnostics = {
            "expected_at_exit": expected,
            "page_a": page.evaluate(_READ_DURABLE_DRAFTS),
            "page_b": other.evaluate(_READ_DURABLE_DRAFTS),
        }
        (Path(output_path) / "draft-durability-at-exit.json").write_text(
            json.dumps(diagnostics, indent=2) + "\n"
        )
        other.close()
