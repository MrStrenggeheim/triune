# Modified for Triune.
"""Approved chat-owned layouts and captured attachment tabs through the built SPA."""

import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Page, Route, expect

from tests.browser_ui.chat.session_contract import list_payload, message_item
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _navigate_chat,
    _open,
    _saved_dock,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import (
    browser_errors as browser_errors,
)
from tests.browser_ui.chat.test_unified_workspace import (
    workspace_journey as workspace_journey,
)
from tests.browser_ui.conftest import BrowserContract


def test_sidebar_drop_and_open_to_side_keep_chat_layout_ownership(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, browser_errors: list[str]
) -> None:
    first, second = workspace_journey.chats
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    _open(page, "Explorer")
    _view(page, "Chat A").get_by_label("Message the agent").fill("Retained A draft")
    row = page.locator(f'aside [data-sidebar-session-id="{second.session_id}"]')
    row.click(button="right")
    page.get_by_role("menuitem", name="Open to side", exact=True).click()
    expect(_view(page, "Explorer")).to_be_visible()
    expect(_view(page, "Chat B")).to_be_visible()
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    _navigate_chat(page, second)
    expect(_view(page, "Explorer")).to_be_hidden()
    expect(page.get_by_role("tab", name="Chat A", exact=True)).to_have_count(0)
    _navigate_chat(page, first)
    expect(_view(page, "Explorer")).to_be_visible()
    expect(_view(page, "Chat B")).to_be_visible()
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_have_value(
        "Retained A draft"
    )
    _capture(page, output_path, "chat-owned-layout-side-open")
    _navigate_chat(page, second)
    source = page.locator(
        f'aside [data-sidebar-session-id="{first.session_id}"] a[draggable="true"]'
    )
    source.drag_to(page.locator(".dock-pane:not([hidden]) .dock-tabs"))
    expect(page.get_by_role("tab", name="Chat A", exact=True)).to_be_visible()
    assert _saved_dock(page)["activeConversationId"] == second.session_id
    assert len(_saved_dock(page)["chats"]) == 2
    page.reload()
    expect(page.get_by_role("tab", name="Chat A", exact=True)).to_be_visible()
    assert _saved_dock(page)["activeConversationId"] == second.session_id
    _capture(page, output_path, "sidebar-chat-drop-retained-after-reload")
    assert browser_errors == []


def test_inline_attachment_opens_captured_tab_downloads_and_reveals_original_workspace(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    browser_contract.json("/v1/workbench-workspaces", list_payload([workspace_journey.workspace]))
    item_id = first.session_id + "-answer"
    first.set_items(
        [
            message_item(
                item_id,
                "assistant",
                "Files: [first](/workspace/guide.csv), [next](/workspace/next.csv). "
                "Folder: [root](/workspace/docs). Again: [same file](/workspace/./guide.csv).",
                response_id="artifact-turn",
            )
        ]
    )
    route = f"/v1/sessions/{first.session_id}/attachments/references/{item_id}"
    captured = "name,value\noriginal,1\n"
    captured_alias = "name,value\nalias-original,9\n"
    browser_contract.route(
        browser_contract._matcher(route),
        lambda request: request.fulfill(
            body=captured_alias
            if "/./" in parse_qs(urlparse(request.request.url).query)["path"][0]
            else captured,
            content_type="text/csv",
        ),
    )
    pending_captures: list[Route] = []

    def capture_original(request: Route) -> None:
        if not pending_captures:
            pending_captures.append(request)
            return
        request.fulfill(json={"filename": "next.csv", "mime": "text/csv", "bytes": len(captured)})

    browser_contract.route(browser_contract._matcher(route + "/capture"), capture_original)

    def metadata(request):
        name = parse_qs(urlparse(request.url).query)["path"][0].rsplit("/", 1)[-1]
        return {
            "workspace": workspace_journey.workspace,
            "path": name,
            "kind": "directory" if name == "docs" else "file",
        }

    browser_contract.json(route + "/metadata", metadata)
    browser_contract.json(
        route + "/location", {"workspace": workspace_journey.workspace, "path": "guide.csv"}
    )
    base = "/v1/workbench-workspaces/workspace-files/resources/environments/default/filesystem"
    for suffix in ("", "/", "/workspace"):
        browser_contract.json(
            base + suffix,
            list_payload(
                [
                    {"path": name, "name": name, "type": "file", "bytes": 30}
                    for name in ("guide.csv", "next.csv")
                ]
            ),
        )
    for name in ("guide.csv", "next.csv"):
        browser_contract.json(
            base + "/" + name,
            {
                "object": "session.environment.filesystem.file_content",
                "path": name,
                "content": "name,value\nlive,2\n",
                "encoding": "utf-8",
                "content_type": "text/csv",
                "bytes": 18,
            },
        )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    chat = _view(page, "Chat A")
    expect(chat.get_by_role("button", name="guide.csv", exact=True).first).to_be_visible()
    expect(chat.locator("code").filter(has_text="/workspace/docs")).to_be_visible()
    chat.get_by_role("button", name="guide.csv", exact=True).first.click()
    preview = _view(page, "guide.csv")
    expect(preview.get_by_role("status")).to_contain_text("Preparing file")
    expect(preview.locator(".monaco-editor")).to_have_count(0)
    _capture(page, output_path, "file-tab-prepares-original-before-editing")
    assert pending_captures
    pending_captures[0].fulfill(
        json={"filename": "guide.csv", "mime": "text/csv", "bytes": len(captured)}
    )
    expect(preview.locator(".view-lines")).to_contain_text("live", timeout=30000)
    editor = preview.locator(".monaco-editor").element_handle()
    with page.expect_request(
        lambda request: (
            request.method == "POST"
            and "/capture?" in request.url
            and parse_qs(urlparse(request.url).query).get("path") == ["/workspace/./guide.csv"]
        )
    ):
        chat.get_by_role("button", name="guide.csv", exact=True).last.click()
    expect(page.get_by_role("tab", name="guide.csv", exact=True)).to_have_count(1)
    page.wait_for_function("""() => Object.keys(localStorage)
        .filter(key => key.startsWith('omnigent:dock:v1:'))
        .some(key => localStorage.getItem(key).includes('/workspace/./guide.csv'))""")
    assert editor and editor.evaluate("element => element.isConnected")
    preview.get_by_role("button", name="View settings", exact=True).click()
    with page.expect_download() as latest_original:
        page.get_by_role("menuitem", name="Download captured original", exact=True).click()
    assert Path(latest_original.value.path()).read_text() == captured_alias
    expect(chat.get_by_label("Message the agent")).to_be_visible()
    panes = page.locator(".dock-pane:not([hidden])").count()
    chat.get_by_role("button", name="next.csv", exact=True).click()
    expect(_view(page, "next.csv").locator(".view-lines")).to_contain_text("live", timeout=30000)
    assert page.locator(".dock-pane:not([hidden])").count() == panes
    chat.get_by_role("button", name="guide.csv", exact=True).first.click()
    expect(preview).to_be_visible()
    assert page.locator(".dock-pane:not([hidden])").count() == panes
    preview.get_by_role("button", name="View settings", exact=True).click()
    with page.expect_download() as download:
        page.get_by_role("menuitem", name="Download captured original", exact=True).click()
    assert Path(download.value.path()).read_text() == captured
    expect(preview.get_by_role("button", name="Location", exact=True)).to_have_count(0)
    preview.get_by_role("button", name="Show comments", exact=True).click()
    expect(
        preview.get_by_role("button", name="Choose comments conversation", exact=True)
    ).to_be_visible()
    _capture(page, output_path, "live-file-editor-with-comment-owner")
    _navigate_chat(page, second)
    expect(preview).to_be_hidden()
    _navigate_chat(page, first)
    page.get_by_role("tab", name="guide.csv", exact=True).click()
    page.reload()
    expect(preview.locator(".view-lines")).to_contain_text("live", timeout=30000)
    assert browser_errors == []


def test_peer_cards_and_orchestration_keep_attribution_and_minimal_controls(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, source = workspace_journey.chats
    source.update_session(sub_agent_name="James", agent_name="James")
    body = "\n".join(
        f"Check {index}: preserve the file editor and original downloads." for index in range(12)
    )
    peer = message_item("peer-card", "user", body, response_id="peer-response")
    peer.update(
        created_at=1704067200,
        communication={
            "kind": "peer",
            "message_id": "peer-communication",
            "source_conversation_id": source.session_id,
            "source_agent_id": source.agent_id,
            "source_agent_name": "James",
            "source_title": "Chat B",
            "destination_conversation_id": first.session_id,
            "delivery_state": "confirmed",
            "receipt": "transcript",
            "sent_at": 1704067200,
        },
    )
    completed = {
        "id": "completed-agent",
        "type": "resource_event",
        "status": "completed",
        "response_id": "agent-return",
        "created_at": 1704067201,
        "event_type": "session.subagent.returned",
        "resource_type": "session",
        "resource_id": "child-ada",
        "resource": {
            "title": "Ada",
            "agent_name": "Ada",
            "task_summary": "Check access",
            "status": "completed",
        },
    }
    first.set_items(
        [
            completed,
            peer,
            message_item(
                "literal-header",
                "user",
                "Peer message from conversation example; this is my quotation.",
                response_id="human-quote",
            ),
        ]
    )
    children = [
        {
            "id": f"child-{name.lower()}",
            "title": name,
            "agent_name": name,
            "task_summary": "Verify editing" if name == "James" else "Check access",
            "tool": name,
            "session_name": name,
            "kind": "sub_agent",
            "current_task_status": "in_progress" if name == "James" else "completed",
            "busy": name == "James",
            "last_message_preview": None,
            "pending_elicitations_count": 0,
            "created_at": 1704067200,
            "updated_at": 1704067220,
            "labels": {"omnigent.codex_native.agent_nickname": name},
        }
        for name in ("James", "Ada")
    ]
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/child_sessions", list_payload(children)
    )
    for child in children:
        browser_contract.json(f"/v1/sessions/{child['id']}/child_sessions", list_payload([]))
        browser_contract.json(
            f"/v1/sessions/{child['id']}",
            {
                **first.session_snapshot(),
                "id": child["id"],
                "title": child["title"],
                "agent_name": child["agent_name"],
                "sub_agent_name": child["agent_name"],
                "status": "running" if child["busy"] else "idle",
            },
        )
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/activity",
        {
            "coverage": "complete",
            "data": [
                {
                    "id": "shell-tests",
                    "kind": "terminal",
                    "session_id": first.session_id,
                    "terminal_id": "tests",
                    "name": "tests",
                    "state": "running",
                    "started_at": 1704067230,
                }
            ],
        },
    )
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    chat = _view(page, "Chat A")
    card = chat.get_by_test_id("peer-message")
    expect(card.locator("header")).to_contain_text("James from Chat B")
    expect(
        chat.get_by_text(
            "Peer message from conversation example; this is my quotation.", exact=True
        )
    ).to_be_visible()
    assert chat.get_by_text(
        "Peer message from conversation example; this is my quotation.", exact=True
    ).evaluate("element => !!element.closest('.is-user')")
    expect(card.get_by_text("In transcript", exact=True)).to_have_count(0)
    card.hover()
    card.get_by_role("button", name="Copy", exact=True).click()
    assert page.evaluate("navigator.clipboard.readText()") == body
    card.get_by_role("button", name="Copy link", exact=True).click()
    copied = page.evaluate("navigator.clipboard.readText()")
    assert f"/c/{first.session_id}" in copied and "peer-card" in copied
    card.get_by_role("button", name="Show full", exact=True).click()
    expect(card.get_by_role("button", name="Show less", exact=True)).to_be_visible()
    card.get_by_role("button", name="Show less", exact=True).click()
    task = chat.get_by_test_id("subagent-activity")
    expect(task).to_contain_text("Ada: Check access")
    expect(task).to_contain_text("Completed")
    expect(task.get_by_role("button", name="Agent actions", exact=True)).to_have_count(0)
    _capture(page, output_path, "desktop-minimal-peer-and-completed-agent")
    task.get_by_role("link", name="Inspect Ada in Orchestration", exact=True).click()
    orchestration = _view(page, "Orchestration")
    inspector = page.get_by_role("dialog", name="Ada", exact=True)
    expect(inspector).to_have_count(0)
    task.get_by_role("link", name="Inspect Ada in Orchestration", exact=True).click()
    expect(inspector).to_have_count(0)
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(1)
    expect(
        page.get_by_role("tab", name="Orchestration", exact=True).locator("svg.lucide-workflow")
    ).to_have_count(1)
    orchestration.get_by_role("button", name="All", exact=True).click()
    entries = orchestration.get_by_role("list", name="Agents", exact=True)
    expect(entries).to_contain_text("James")
    expect(entries).to_contain_text("Ada")
    expect(orchestration.get_by_role("list", name="Shells", exact=True)).to_contain_text("tests")
    expect(
        orchestration.get_by_role("group", name="Orchestration filter", exact=True)
    ).to_be_visible()
    expect(orchestration.get_by_role("heading", name="Recent", exact=True)).to_have_count(0)
    _capture(page, output_path, "desktop-flat-orchestration")
    page.set_viewport_size({"width": 390, "height": 844})
    if page.get_by_role("button", name="Close navigation", exact=True).is_visible():
        page.keyboard.press("Control+b")
    page.get_by_role("tab", name="Chat A", exact=True).click()
    expect(card).to_be_visible()
    _capture(page, output_path, "mobile-minimal-peer-and-agent")
    page.locator("html").evaluate("element => element.classList.add('dark')")
    _capture(page, output_path, "mobile-dark-peer-and-agent")
    assert browser_errors == []


def test_selected_quote_menu_reuses_app_controls_and_retains_destination_draft(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    browser_contract.json(
        "/v1/context-references/chats",
        {
            "data": [{"id": second.session_id, "title": "Chat B", "parent_id": None}],
            "has_more": False,
            "next_cursor": None,
        },
    )
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/context-reference",
        {
            "version": 1,
            "snapshot_id": "selection-snapshot",
            "source_id": first.session_id,
            "source_title": "Chat A",
            "destination_id": None,
            "scope": "quote",
            "boundary_id": first.session_id + "-answer",
            "captured_at": 1704067200,
            "items": [],
            "quote": "Answer from Chat A",
            "audience": "owner",
            "representation": "Answer from Chat A",
        },
        method="POST",
    )
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/context-reference/check",
        {"allowed": True},
        method="POST",
    )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(second.url)
    _view(page, "Chat B").get_by_label("Message the agent").fill("Existing B draft")
    _navigate_chat(page, first)
    _view(page, "Chat A").get_by_text("Answer from Chat A", exact=True).evaluate("""element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }""")
    menu = page.get_by_role("menu", name="Selected text", exact=True)
    expect(menu.get_by_role("menuitem", name="Reply", exact=True)).to_be_visible()
    expect(menu.get_by_role("menuitem", name="Reply", exact=True).locator("svg")).to_have_count(1)
    expect(menu.get_by_role("menuitem", name="Ask subchat…", exact=True)).to_be_visible()
    _capture(page, output_path, "selection-menu-approved-actions")
    menu.get_by_role("menuitem", name="Send to…", exact=True).click()
    picker = page.get_by_role("dialog", name="Send to", exact=True)
    expect(picker).to_be_visible()
    picker.get_by_role("button", name="Chat B", exact=True).click()
    draft = _view(page, "Chat B").get_by_label("Message the agent")
    expect(_view(page, "Chat B").get_by_label("Reply text before quote 1")).to_have_value(
        "Existing B draft"
    )
    expect(draft).to_have_value("")
    expect(_view(page, "Chat B").get_by_test_id("composer-reply-quote")).to_contain_text(
        "Answer from Chat A"
    )
    expect(draft).not_to_have_value(re.compile("Chat context snapshot|snapshot_id"))
    assert first.event_posts == []
    assert second.event_posts == []
    _capture(page, output_path, "quote-in-existing-unsent-draft")
    assert browser_errors == []


@pytest.mark.parametrize("entry", ["Ask subchat…", "Send to…"])
@pytest.mark.parametrize("width", [390, 1440], ids=["phone", "desktop"])
def test_quote_subchat_opens_before_launch_and_hides_inherited_history(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
    entry: str,
    width: int,
) -> None:
    """Create once, seed a clean quote, open before host readiness, and fold inherited history."""
    source, child = workspace_journey.chats
    source_item = source.session_id + "-answer"
    branch = {
        "source_conversation_id": source.session_id,
        "source_item_id": source_item,
        "inherited_last_item_id": "copied-source",
        "inherited_item_count": 1,
        "reference_only": False,
        "recovery": "replay",
    }
    child.update_session(title="Subchat", branch=branch)
    child.set_items(
        [
            message_item(
                "copied-source", "assistant", "Inherited source history", response_id="source-turn"
            )
        ]
    )
    created: list[dict] = []
    launches: list[Route] = []
    browser_contract.json(
        "/v1/sessions",
        lambda _: list_payload(
            [source.session_snapshot(), *([child.session_snapshot()] if created else [])]
        ),
    )

    def fork(route: Route) -> None:
        created.append(route.request.post_data_json)
        route.fulfill(json=child.session_snapshot())

    def labels(route: Route) -> None:
        child.update_session(
            labels={
                **child.session_snapshot().get("labels", {}),
                **route.request.post_data_json.get("labels", {}),
            }
        )
        route.fulfill(json=child.session_snapshot())

    browser_contract.route(
        browser_contract._matcher(f"/v1/sessions/{source.session_id}/fork"), fork
    )
    browser_contract.route(
        browser_contract._matcher(f"/v1/sessions/{child.session_id}"),
        lambda route: labels(route) if route.request.method == "PATCH" else route.fallback(),
    )
    browser_contract.route(
        browser_contract._matcher(f"/v1/hosts/{source.host_id}/runners"),
        lambda route: launches.append(route),
    )
    browser_contract.json(
        f"/v1/sessions/{source.session_id}/context-reference",
        {
            "version": 1,
            "snapshot_id": "quote-snapshot",
            "source_id": source.session_id,
            "source_title": "Chat A",
            "destination_id": None,
            "scope": "quote",
            "boundary_id": source_item,
            "captured_at": 1704067200,
            "items": [],
            "quote": "Answer from Chat A",
            "audience": "owner",
            "representation": "Selected text",
        },
        method="POST",
    )
    browser_contract.json(
        f"/v1/sessions/{source.session_id}/context-reference/check",
        {"allowed": True},
        method="POST",
    )
    browser_contract.json(
        "/v1/context-references/chats", {"data": [], "has_more": False, "next_cursor": None}
    )
    page.set_viewport_size({"width": width, "height": 1000 if width > 500 else 844})
    page.goto(source.url)
    if page.get_by_role("button", name="Close navigation", exact=True).is_visible():
        page.keyboard.press("Control+b")
    _view(page, "Chat A").get_by_text("Answer from Chat A", exact=True).evaluate("""element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }""")
    page.get_by_role("menu", name="Selected text", exact=True).get_by_role(
        "menuitem", name=entry, exact=True
    ).click()
    if entry == "Send to…":
        page.get_by_role("dialog", name="Send to", exact=True).get_by_role(
            "button", name="New subchat", exact=True
        ).click()
    view = _view(page, "Subchat")
    expect(view.get_by_test_id("composer-reply-quote")).to_contain_text("Answer from Chat A")
    page.wait_for_function(
        "() => !!document.querySelector('[data-testid=\"composer-reply-quote\"]')"
    )
    assert len(created) == 1
    assert len(launches) == 1, "The child must be shown before host launch has completed"
    expect(page.get_by_role("dialog", name="Ask subchat", exact=True)).to_have_count(0)
    expect(view.get_by_label("Message the agent")).not_to_have_value(
        re.compile("Chat context snapshot|snapshot_id|Open source")
    )
    expect(view.get_by_text("Inherited source history", exact=True)).to_have_count(0)
    view.get_by_role("button", name="Show history", exact=True).click()
    expect(view.get_by_text("Inherited source history", exact=True)).to_be_visible()
    view.get_by_role("button", name="Hide history", exact=True).click()
    expect(view.get_by_text("Inherited source history", exact=True)).to_have_count(0)
    _capture(page, output_path, f"direct-subchat-{width}-{entry[:3]}")
    for route in launches:
        route.fulfill(json={"runner_id": "quote-runner"})
    assert source.event_posts == [] and child.event_posts == []
    assert browser_errors == []
