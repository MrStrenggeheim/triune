# Modified for Triune.
"""Approved chat-owned layouts and captured attachment tabs through the built SPA."""

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Locator, Page, Route, expect

from tests.browser_ui.chat._geometry_helpers import assert_no_overlap, box
from tests.browser_ui.chat.session_contract import ChatSessionContract, list_payload, message_item
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _assert_workspace_search_centered,
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
        preview.get_by_role("button", name="Choose comments conversation", exact=False)
    ).to_be_visible()
    _capture(page, output_path, "live-file-editor-with-comment-owner")
    _navigate_chat(page, second)
    expect(preview).to_be_hidden()
    _navigate_chat(page, first)
    page.get_by_role("tab", name="guide.csv", exact=True).click()
    page.reload()
    expect(preview.locator(".view-lines")).to_contain_text("live", timeout=30000)
    assert browser_errors == []


@pytest.mark.parametrize("mode", ["reuse", "beside"])
def test_queue_markdown_links_reuse_source_or_neighbor_without_repeated_split(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
    mode: str,
) -> None:
    first = workspace_journey.chats[0]
    files = {
        "queue.md": "# Queue\n\n[First file](notes.py) and [Second file](next.py).\n",
        "next.py": "second_link_target = 2\n",
    }
    environment = "/v1/workbench-workspaces/workspace-files/resources/environments/default"
    for path, content in files.items():
        first.contract.json(
            f"{environment}/filesystem/{path}",
            {
                "object": "session.environment.filesystem.file_content",
                "path": path,
                "content": content,
                "encoding": "utf-8",
                "bytes": len(content),
                "content_type": "text/markdown" if path.endswith(".md") else "text/x-python",
            },
        )
    page.add_init_script("""localStorage.setItem('omnigent:file-view-preferences',
      JSON.stringify({diffActive: false, previewableViewMode: 'preview'}));
      if (!localStorage.getItem('triune:file-opening'))
        localStorage.setItem('triune:file-opening', 'beside');""")
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(f"{first.url}?file=queue.md&workspace=workspace-files")
    queue = _view(page, "queue.md")
    expect(queue.get_by_role("button", name="First file", exact=True)).to_be_visible()
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    layout = next(
        c["layout"] for c in _saved_dock(page)["chats"] if c["conversationId"] == first.session_id
    )
    assert len(layout["panes"]) == 2
    queue_view = next(v for v in layout["views"] if v["resource"].get("path") == "queue.md")
    source = next(p for p in layout["panes"] if queue_view["id"] in p["viewIds"])
    destination = source if mode == "reuse" else next(p for p in layout["panes"] if p != source)
    _view(page, "Chat A").get_by_label("Message the agent").fill("Keep the chat beside queue.md")
    page.evaluate(
        """mode => {
      localStorage.setItem('triune:file-opening', mode);
      window.dispatchEvent(new Event('triune:file-opening-change'));
    }""",
        mode,
    )
    opened = []
    for label, path, text in (
        ("First file", "notes.py", "selection_target"),
        ("Second file", "next.py", "second_link_target"),
        ("First file", "notes.py", "selection_target"),
    ):
        page.get_by_role("tab", name="queue.md", exact=True).click()
        queue.get_by_role("button", name=label, exact=True).click()
        expect(_view(page, path).locator(".view-lines")).to_contain_text(text, timeout=30_000)
        expect(page.get_by_role("tab", name=path, exact=True)).to_have_count(1)
        layout = next(
            c["layout"]
            for c in _saved_dock(page)["chats"]
            if c["conversationId"] == first.session_id
        )
        assert len(layout["panes"]) == 2
        view = next(v for v in layout["views"] if v["resource"].get("path") == path)
        target = next(p for p in layout["panes"] if view["id"] in p["viewIds"])
        assert target["id"] == destination["id"]
        assert view["resource"]["workspace"]["id"] == "workspace-files"
        assert view["resource"]["conversationId"] == first.session_id
        opened.append(view["id"])
    assert opened[0] == opened[2]
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    page.get_by_role("tab", name="Chat A", exact=True).click()
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_have_value(
        "Keep the chat beside queue.md"
    )
    page.get_by_role("tab", name="notes.py", exact=True).click()
    _capture(page, output_path, f"queue-links-{mode}-two-panes")
    page.reload()
    page.get_by_role("tab", name="notes.py", exact=True).click()
    expect(_view(page, "notes.py").locator(".view-lines")).to_contain_text(
        "selection_target", timeout=30_000
    )
    assert len(_saved_dock(page)["chats"][0]["layout"]["panes"]) == 2
    assert workspace_journey.writes == []
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


_ITERATION5_PROFILES = [
    pytest.param(
        {"phone": False, "density": "comfortable", "theme": "light"},
        marks=pytest.mark.browser_context_args(
            viewport={"width": 1440, "height": 1000}, has_touch=False, is_mobile=False
        ),
        id="desktop-light-comfortable",
    ),
    pytest.param(
        {"phone": True, "density": "compact", "theme": "dark"},
        marks=[
            pytest.mark.only_browser("chromium"),
            pytest.mark.browser_context_args(
                viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
            ),
        ],
        id="phone-dark-compact",
    ),
]


def _iteration5_activate(target: Locator, profile: dict[str, Any]) -> None:
    target.tap() if profile["phone"] else target.click()


def _iteration5_start(page: Page, chat: ChatSessionContract, profile: dict[str, Any]) -> None:
    page.emulate_media(reduced_motion="reduce")
    page.goto(chat.url)
    expect(
        _view(page, chat.session_snapshot()["title"]).get_by_label("Message the agent")
    ).to_be_visible()
    page.evaluate(
        """profile => {
          document.documentElement.dataset.listDensity = profile.density;
          document.documentElement.classList.toggle('dark', profile.theme === 'dark');
        }""",
        profile,
    )
    assert page.evaluate("matchMedia('(pointer: coarse)').matches") == profile["phone"]


def _iteration5_sidebar(page: Page, profile: dict[str, Any]) -> Locator:
    opener = page.get_by_role("button", name="Open navigation", exact=True)
    if opener.is_visible():
        _iteration5_activate(opener, profile)
    sidebar = page.get_by_role("complementary", name="Conversations", include_hidden=True)
    expect(sidebar).to_have_attribute("aria-hidden", "false")
    return sidebar


@pytest.mark.parametrize("profile", _ITERATION5_PROFILES)
def test_iteration5_sidebar_status_actions_and_hierarchy(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
    profile: dict[str, Any],
) -> None:
    """One live hierarchy proves grouped status, shared action surface and native hit targets."""
    first, second = workspace_journey.chats
    first.update_session(
        project_id="iteration5-project",
        labels={"omni_project": "Iteration five"},
        pending_elicitations_count=2,
        status="running",
        activity={"own_status": "idle", "descendant_running": True},
    )
    second.update_session(
        branch={"source_conversation_id": first.session_id, "reference_only": True},
        status="running",
        activity={"own_status": "running", "descendant_running": False},
    )
    browser_contract.json(
        "/v1/projects", list_payload([{"id": "iteration5-project", "name": "Iteration five"}])
    )
    browser_contract.json(
        "/v1/sessions/projects", [{"id": "iteration5-project", "name": "Iteration five"}]
    )
    browser_contract.json(
        "/v1/projects/iteration5-project/sessions",
        lambda _: list_payload([chat.session_snapshot() for chat in workspace_journey.chats]),
    )
    # Unfiltered pinned results advertise a legacy server that stores pins locally.
    browser_contract.json(
        "/v1/sessions",
        lambda request: list_payload(
            [
                chat.session_snapshot()
                for chat in workspace_journey.chats
                if parse_qs(urlparse(request.url).query).get("pinned") != ["true"]
                or chat.session_snapshot()["labels"].get("omnigent.pinned")
            ]
        ),
    )
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    _iteration5_start(page, first, profile)
    sidebar = _iteration5_sidebar(page, profile)
    projects = sidebar.get_by_role("button", name="Projects", exact=True)
    if projects.get_attribute("aria-expanded") == "false":
        _iteration5_activate(projects, profile)
    project = sidebar.locator('[data-sidebar-drop-name="Iteration five"]')
    project_header = project.locator("h2 button[aria-expanded]").first
    expect(project_header).to_be_visible()
    if project_header.get_attribute("aria-expanded") == "false":
        _iteration5_activate(project_header, profile)
    parent = sidebar.locator(f'[data-sidebar-session-id="{first.session_id}"]')
    actions = parent.get_by_role("button", name="Conversation actions", exact=True)
    expect(
        parent.locator('[data-testid="session-state-badge"][data-state="awaiting"]')
    ).to_have_count(1)
    expect(
        parent.locator('[data-testid="session-state-badge"][data-state="running"]')
    ).to_have_count(1)
    assert actions.get_attribute("aria-describedby")
    assert "2 approval prompts waiting" in actions.evaluate(
        "el => document.getElementById(el.getAttribute('aria-describedby')).textContent"
    )
    target = box(actions)
    assert target["width"] == pytest.approx(44 if profile["phone"] else 24, abs=1)
    _iteration5_activate(
        parent.get_by_role("button", name="Session status", exact=True)
        if profile["phone"]
        else actions,
        profile,
    )
    expect(page.get_by_role("menuitem", name="Pin", exact=True)).to_be_visible()
    expect(page.get_by_test_id("quick-pin-conversation")).to_have_count(0)
    page.keyboard.press("Escape")
    _iteration5_activate(
        parent.get_by_role("button", name="Expand subchats of Chat A", exact=True), profile
    )
    expect(
        parent.locator('[data-state="running"][data-testid="session-state-badge"]')
    ).to_have_count(0)
    expect(
        parent.locator('[data-state="awaiting"][data-testid="session-state-badge"]')
    ).to_have_count(1)
    child = sidebar.locator(f'[data-sidebar-session-id="{second.session_id}"]')
    expect(
        child.locator('[data-state="running"][data-testid="session-state-badge"]')
    ).to_have_count(1)
    guide = child.locator("[data-sidebar-tree-guide]").last
    density_gap = child.evaluate(
        "el => parseFloat(getComputedStyle(el).getPropertyValue('--list-row-gap'))"
    )
    assert box(child)["x"] - box(guide)["x"] - box(guide)["width"] >= density_gap - 1
    assert parent.evaluate("el => getComputedStyle(el).backgroundColor") not in (
        "transparent",
        "rgba(0, 0, 0, 0)",
    )
    expect(parent.get_by_role("link", name="Chat A", exact=True)).to_have_css(
        "background-color", "rgba(0, 0, 0, 0)"
    )
    density_gap = parent.evaluate(
        "el => parseFloat(getComputedStyle(el).getPropertyValue('--list-row-gap'))"
    )
    folder = sidebar.locator('[data-sidebar-drop-name="Iteration five"]')
    project_guide = box(folder.locator("[data-sidebar-tree-guide]").first)
    branch_guide = box(child.locator("[data-sidebar-tree-guide]").last)
    assert box(parent)["x"] - project_guide["x"] - project_guide["width"] >= density_gap - 1
    assert box(child)["x"] - branch_guide["x"] - branch_guide["width"] >= density_gap - 1
    inset = child.evaluate("el => el.style.getPropertyValue('--sidebar-row-inset')")
    _iteration5_activate(
        child.get_by_role("button", name="Conversation actions", exact=True), profile
    )
    _iteration5_activate(page.get_by_role("menuitem", name="Rename", exact=True), profile)
    rename = page.get_by_test_id("rename-conversation-input")
    expect(rename).to_be_focused()
    assert (
        rename.evaluate("el => el.closest('li').style.getPropertyValue('--sidebar-row-inset')")
        == inset
    )
    page.keyboard.press("Escape")
    _iteration5_activate(
        child.get_by_role("button", name="Conversation actions", exact=True), profile
    )
    _iteration5_activate(page.get_by_role("menuitem", name="Copy link", exact=True), profile)
    assert page.evaluate("navigator.clipboard.readText()") == second.url
    expect(parent.get_by_role("link", name="Chat A", exact=True)).to_have_attribute(
        "aria-current", "page"
    )
    assert all(chat.session_patches == [] for chat in workspace_journey.chats)
    _iteration5_activate(
        child.get_by_role("button", name="Conversation actions", exact=True), profile
    )
    with page.expect_response(
        lambda response: (
            response.url == f"{browser_contract.base_url}/v1/sessions/{second.session_id}"
            and response.request.method == "PATCH"
        )
    ) as pin_response:
        _iteration5_activate(page.get_by_role("menuitem", name="Pin", exact=True), profile)
    assert pin_response.value.ok
    expect(sidebar.get_by_text("Pinned", exact=True)).to_be_visible()
    assert any("labels" in patch for patch in second.session_patches)
    search_button = sidebar.get_by_role("button", name="Search", exact=True)
    assert search_button.get_attribute("aria-keyshortcuts")
    _iteration5_activate(search_button, profile)
    if profile["phone"]:
        expect(sidebar).to_have_attribute("aria-hidden", "true")
        _iteration5_activate(
            page.get_by_test_id("context-search-bar").get_by_role(
                "button", name="Edit search query", exact=True
            ),
            profile,
        )
    expect(page.get_by_label("Search chats", exact=True)).to_be_focused()
    page.get_by_label("Search chats", exact=True).fill("Preserved search query")
    expect(page.get_by_label("Search chats", exact=True)).to_have_value("Preserved search query")
    _capture(page, output_path, f"iteration5-sidebar-{profile['theme']}-{profile['density']}")
    assert all(chat.event_posts == [] for chat in workspace_journey.chats)
    assert browser_errors == []


@pytest.mark.parametrize("profile", _ITERATION5_PROFILES)
def test_iteration5_accepted_session_focus_and_search_scroll(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
    profile: dict[str, Any],
) -> None:
    """Cross retained/sidebar/palette/result boundaries once, preserving query and exact reveal."""
    first, second = workspace_journey.chats
    target = f"{second.session_id}-needle"
    text = "Final needle then needle."
    rows = []
    for index in range(16):
        rows.append(
            message_item(
                f"focus-request-{index}", "user", f"Request {index}", response_id=f"focus-{index}"
            )
        )
        rows.append(
            message_item(
                target if index == 7 else f"focus-answer-{index}",
                "assistant",
                text
                if index == 7
                else "\n\n".join(f"Paragraph {line} from turn {index}." for line in range(18)),
                response_id=f"focus-{index}",
            )
        )
    second.set_items(list(reversed(rows)))
    browser_contract.json(
        "/v1/sessions/search/messages",
        {
            "data": [
                {
                    "session_id": second.session_id,
                    "title": "Chat B",
                    "item_id": target,
                    "role": "assistant",
                    "created_at": 1,
                    "text": text,
                    "text_start": 0,
                    "content_hash": "iteration5",
                    "snippet": text,
                    "snippet_start": 0,
                    "ranges": [{"start": 6, "end": 12}, {"start": 18, "end": 24}],
                    "occurrence_count": 2,
                }
            ],
            "has_more": False,
            "next_cursor": None,
        },
    )
    _iteration5_start(page, first, profile)
    first_input = _view(page, "Chat A").get_by_label("Message the agent")
    _iteration5_activate(first_input, profile)
    first_input.fill("Retained A draft")
    first_input.evaluate("el => el.setSelectionRange(2, 7)")
    _navigate_chat(page, second)
    second_input = _view(page, "Chat B").get_by_label("Message the agent")
    expect(second_input).to_be_visible()
    expect(second_input).not_to_be_focused() if profile["phone"] else expect(
        second_input
    ).to_be_focused()
    _iteration5_activate(second_input, profile)
    second_input.fill("Retained B draft")
    _navigate_chat(page, first)
    expect(first_input).to_have_value("Retained A draft")
    expect(first_input).not_to_be_focused() if profile["phone"] else expect(
        first_input
    ).to_be_focused()
    _iteration5_sidebar(page, profile)
    _iteration5_activate(
        page.locator(f'aside [data-sidebar-session-id="{first.session_id}"] a').first, profile
    )
    expect(first_input).not_to_be_focused() if profile["phone"] else expect(
        first_input
    ).to_be_focused()
    expect(first_input).to_have_value("Retained A draft")
    assert first_input.evaluate("el => [el.selectionStart, el.selectionEnd]") == [2, 7]
    page.keyboard.press("ControlOrMeta+Alt+s")
    palette = page.get_by_role("dialog", name="Switch session", exact=True)
    expect(palette).to_be_visible()
    page.get_by_test_id("command-palette-input").fill("Chat B")
    _iteration5_activate(palette.get_by_role("option", name="Chat B", exact=True), profile)
    expect(palette).to_have_count(0)
    expect(second_input).to_have_value("Retained B draft")
    expect(second_input).not_to_be_focused() if profile["phone"] else expect(
        second_input
    ).to_be_focused()
    _iteration5_activate(second_input, profile)
    page.keyboard.press("ControlOrMeta+f")
    query = page.get_by_label("Search chats", exact=True)
    query.fill("need")
    expect(query).to_be_focused()
    query.fill("needle ")
    _assert_workspace_search_centered(page, "Chat B", target, 6)
    expect(query).to_be_focused()
    if profile["phone"]:
        # The open drawer's scrim covers the application-bar toggle.
        scrim = page.get_by_test_id("sidebar-scrim")
        scrim.tap(position={"x": box(scrim)["width"] - 4, "y": 150})
        expect(
            page.get_by_role("complementary", name="Conversations", include_hidden=True)
        ).to_have_attribute("aria-hidden", "true")
    _iteration5_activate(
        page.get_by_test_id("context-search-bar").get_by_role(
            "button", name="Next match", exact=True
        ),
        profile,
    )
    _assert_workspace_search_centered(page, "Chat B", target, 18)
    expect(second_input).not_to_be_focused()
    expect(query).to_have_value("needle ")
    _iteration5_activate(
        page.get_by_test_id("context-search-bar").get_by_role(
            "button", name="Edit search query", exact=True
        ),
        profile,
    )
    scope = page.get_by_role("group", name="Search scope", exact=True)
    _iteration5_activate(scope.get_by_role("button", name="All chats", exact=True), profile)
    page.keyboard.press("ControlOrMeta+Alt+s")
    expect(palette).to_be_visible()
    page.get_by_test_id("command-palette-input").fill("Chat A")
    _iteration5_activate(palette.get_by_role("option", name="Chat A", exact=True), profile)
    expect(palette).to_have_count(0)
    expect(page).to_have_url(first.url)
    expect(query).to_have_value("needle ")
    _iteration5_activate(
        page.locator('[data-search-result="message"]').filter(has_text=text).first, profile
    )
    expect(page).to_have_url(second.url)
    _assert_workspace_search_centered(page, "Chat B", target, 6)
    expect(second_input).not_to_be_focused() if profile["phone"] else expect(
        second_input
    ).to_be_focused()
    assert _saved_dock(page)["activeConversationId"] == second.session_id
    expect(second_input).to_have_value("Retained B draft")
    _capture(page, output_path, f"iteration5-focus-search-{profile['theme']}-{profile['density']}")
    assert all(
        chat.event_posts == [] and chat.session_patches == [] for chat in workspace_journey.chats
    )
    assert browser_errors == []


@pytest.mark.parametrize("profile", _ITERATION5_PROFILES)
def test_iteration5_identity_coherence_and_optical_tab_add_gap(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
    profile: dict[str, Any],
) -> None:
    """One captured child converges across real owners, then measures painted plus geometry."""
    first = workspace_journey.chats[0]
    child_id = "iteration5-native-child"
    labels = {
        "omnigent.codex_native.agent_nickname": "Curie",
        "omnigent.subagent.card_summary": "Check access",
    }
    child = {
        "id": child_id,
        "title": "Task title must not become the recipient name",
        "agent_name": "codex-native-ui",
        "tool": "codex-native-ui",
        "session_name": "task",
        "task_summary": "Check access",
        "current_task_status": "in_progress",
        "busy": True,
        "pending_elicitations_count": 0,
        "last_message_preview": "Reply: Latest report",
        "created_at": 1704067200,
        "updated_at": 1704067202,
        "labels": labels,
    }
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/child_sessions", lambda _: list_payload([child])
    )
    browser_contract.json(f"/v1/sessions/{child_id}/child_sessions", list_payload([]))
    browser_contract.json(
        f"/v1/sessions/{child_id}",
        lambda _: {**first.session_snapshot(), **child, "parent_session_id": first.session_id},
    )
    delegated = {
        "id": "identity-instruction",
        "type": "resource_event",
        "status": "completed",
        "response_id": "identity-dispatch",
        "created_at": 1704067200,
        "event_type": "session.subagent.delegated",
        "resource_type": "session",
        "resource_id": child_id,
        "resource": {
            "agent_name": "codex-native-ui",
            "task_summary": "Stale captured task",
            "dispatch_id": "identity-dispatch",
            "task_input": "Original instruction",
            "task_input_ref": {"conversation_id": child_id, "item_id": "captured-instruction"},
            "task_input_position": 1,
        },
    }
    returned = {
        **delegated,
        "id": "identity-return",
        "created_at": 1704067202,
        "event_type": "session.subagent.returned",
        "resource": {
            **delegated["resource"],
            "result_text": "Latest report",
            "result_finality": "final_answer",
            "result_revision": 1,
            "result_ref": {"conversation_id": child_id, "item_id": "captured-return"},
            "result_position": 2,
            "status": "completed",
        },
    }
    peer = message_item(
        "identity-peer", "user", "Original peer instruction", response_id="identity-peer"
    )
    peer["communication"] = {
        "kind": "peer",
        "message_id": "identity-peer",
        "source_conversation_id": first.session_id,
        "source_agent_name": "codex-native-ui",
        "source_title": "Chat A",
        "destination_conversation_id": child_id,
        "delivery_state": "confirmed",
    }
    first.set_items([returned, peer, delegated])
    _iteration5_start(page, first, profile)
    first.wait_for_stream()
    chat = _view(page, "Chat A")
    group = chat.get_by_role("button", name=re.compile(r"Started or steered .*subagent"))
    if group.count() and group.first.get_attribute("aria-expanded") == "false":
        _iteration5_activate(group.first, profile)
    task = chat.get_by_test_id("subagent-activity")
    expect(task).to_have_count(1)
    expect(task).to_contain_text("Curie")
    expect(task).to_contain_text("Check access")
    expect(task).to_contain_text("Reply: Latest report")
    peer_card = chat.get_by_test_id("peer-message")
    expect(peer_card).to_contain_text("Chat A sent to Curie")
    expect(peer_card).to_contain_text("Check access")
    expect(peer_card).to_contain_text("Reply: Latest report")
    expect(peer_card.get_by_role("button", name="Copy", exact=True)).to_have_count(0)
    task_node = task.element_handle()
    assert task_node
    child.update(
        labels={
            **labels,
            "omnigent.codex_native.agent_nickname": "Boole",
            "omnigent.subagent.card_summary": "Review focus",
        },
        last_message_preview="Instruction: Continue review",
        updated_at=1704067203,
    )
    first.emit(
        {
            "event": "session.child_session.updated",
            "data": {
                "conversation_id": first.session_id,
                "child_session_id": child_id,
                "child": child,
            },
        }
    )
    steering = {
        **delegated,
        "id": "identity-steering",
        "created_at": 1704067203,
        "resource": {
            **delegated["resource"],
            "task_input": "Continue review",
            "task_input_ref": {"conversation_id": child_id, "item_id": "captured-steering"},
            "task_input_position": 3,
        },
    }
    first.emit({"event": "response.output_item.done", "data": {"item": steering}})
    expect(task).to_contain_text("Boole")
    expect(task).to_contain_text("Review focus")
    expect(task).to_contain_text("Instruction: Continue review")
    expect(peer_card).to_contain_text("Chat A sent to Boole")
    expect(peer_card).to_contain_text("Review focus")
    expect(peer_card).to_contain_text("Instruction: Continue review")
    assert task_node.evaluate("el => el.isConnected")
    expect(task).to_have_count(1)
    _capture(
        page, output_path, f"iteration5-agent-card-peer-{profile['theme']}-{profile['density']}"
    )
    _iteration5_activate(chat.get_by_test_id("subagent-task-pill"), profile)
    agents_popup = page.get_by_role("dialog", name=re.compile(r"1 sub-agent"))
    expect(agents_popup).to_contain_text("Boole")
    expect(agents_popup).to_contain_text("Review focus")
    expect(agents_popup).to_contain_text("Instruction: Continue review")
    _capture(page, output_path, f"iteration5-agent-shelf-{profile['theme']}-{profile['density']}")
    page.keyboard.press("Escape")
    _iteration5_activate(
        task.get_by_role("link", name="Inspect Boole in Orchestration", exact=True), profile
    )
    orchestration = _view(page, "Orchestration")
    entry = orchestration.locator(f'[data-agent-id="{child_id}"]')
    expect(entry).to_contain_text("Boole")
    expect(entry).to_contain_text("Review focus")
    expect(entry).to_contain_text("Instruction: Continue review")
    expect(orchestration.get_by_role("dialog", name="Boole", exact=True)).to_have_count(0)
    tab = page.get_by_role("tab", name="Orchestration", exact=True)
    header = tab.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), "
        "' dock-pane-header ')][1]"
    )
    add = header.get_by_role("button", name="Add view to pane", exact=True)
    final_tab = header.locator(".dock-tab-group").last
    expect(add).to_be_visible()
    assert_no_overlap(box(final_tab), box(add))
    if profile["phone"]:
        assert min(box(add)["width"], box(add)["height"]) >= 44
    last_bounds, add_bounds = box(final_tab), box(add)
    painted = add.locator("svg").evaluate("""svg => {
      const points = [...svg.querySelectorAll('path,line')].flatMap(path => {
        const b = path.getBBox(), m = path.getScreenCTM();
        const inset = parseFloat(getComputedStyle(path).strokeWidth) / 2;
        return [new DOMPoint(b.x-inset,b.y-inset).matrixTransform(m),
          new DOMPoint(b.x+b.width+inset,b.y+b.height+inset).matrixTransform(m)];
      });
      return {left: Math.min(...points.map(p=>p.x)), right: Math.max(...points.map(p=>p.x))};
    }""")
    gap = painted["left"] - (last_bounds["x"] + last_bounds["width"])
    assert 0 <= gap <= (24 if profile["phone"] else 14), {"painted": painted, "gap": gap}
    add.focus()
    page.keyboard.press("Enter")
    expect(page.get_by_role("menuitem", name="Explorer", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(add).to_be_focused()
    _capture(page, output_path, f"iteration5-tab-optics-{profile['theme']}-{profile['density']}")
    if profile["phone"]:
        for destination in ("Explorer", "Changes"):
            _iteration5_activate(add, profile)
            _iteration5_activate(
                page.get_by_role("menuitem", name=destination, exact=True), profile
            )
            expect(page.get_by_role("tab", name=destination, exact=True)).to_be_visible()
        strip = header.locator(".dock-tabs")
        assert strip.evaluate("el => el.scrollWidth > el.clientWidth")
        strip.evaluate("el => { el.scrollLeft = el.scrollWidth; }")
        expect(add).to_be_visible()
        _iteration5_activate(add, profile)
        expect(page.get_by_role("menuitem", name="Explorer", exact=True)).to_be_visible()
        page.keyboard.press("Escape")
    Path(output_path).mkdir(parents=True, exist_ok=True)
    (Path(output_path) / "iteration5-tab-optics.json").write_text(
        json.dumps(
            {
                "profile": profile,
                "painted": painted,
                "optical_gap": gap,
                "add_target": add_bounds,
                "last_tab": last_bounds,
                "phase": "before additional overflow tabs",
            },
            indent=2,
        )
    )
    _capture(
        page, output_path, f"iteration5-identity-tab-gap-{profile['theme']}-{profile['density']}"
    )
    assert all(
        chat.event_posts == [] and chat.session_patches == [] for chat in workspace_journey.chats
    )
    assert browser_errors == []
