# Modified for Triune.
"""Approved chat-owned layouts and captured attachment tabs through the built SPA."""

import re
from typing import Any

import pytest
from playwright.sync_api import Locator, Page, Route, expect

from tests.browser_ui.chat._geometry_helpers import box
from tests.browser_ui.chat.session_contract import ChatSessionContract, list_payload, message_item
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


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "mobile"])
def test_session_layout_presets(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, width: int
) -> None:
    first = workspace_journey.chats[0]
    first.contract.json(f"/v1/hosts/{first.host_id}/filesystem", list_payload([]))
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(first.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    composer.fill("Keep this draft through layout changes")
    header = page.get_by_role("banner", name="Application")
    presets = header.get_by_role("button", name="Layout presets")
    bell = header.get_by_role("button", name="Notifications")
    assert box(presets)["x"] + box(presets)["width"] <= box(bell)["x"]
    presets.click()
    page.get_by_role("menuitem", name="Three columns").click()
    expect(composer).to_have_value("Keep this draft through layout changes")
    if width > 640:
        empty = page.locator(".dock-pane").filter(has_text="Open a chat or tool to get started.")
        expect(empty).to_have_count(2)
        empty.first.get_by_role("button", name="Open view", exact=True).click()
        page.get_by_role("menuitem", name="New chat", exact=True).click()
        expect(empty).to_have_count(1)
        dividers = page.get_by_role("separator", name="Resize panes")
        before = [box(divider)["x"] for divider in dividers.all()]
        divider = box(dividers.first)
        x = divider["x"] + divider["width"] / 2
        y = divider["y"] + divider["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 40, y, steps=8)
        page.mouse.up()
        assert box(dividers.first)["x"] == pytest.approx(before[0] + 40, abs=2)
        assert box(dividers.last)["x"] == pytest.approx(before[1], abs=1)
        dividers.last.press("ArrowRight")
        assert box(dividers.first)["x"] == pytest.approx(before[0] + 40, abs=2)
        assert box(dividers.last)["x"] > before[1]
    else:
        expect(page.locator(".dock-pane:visible")).to_have_count(1)
    saved = _saved_dock(page)
    layout = next(
        chat["layout"] for chat in saved["chats"] if chat["conversationId"] == first.session_id
    )
    assert len(layout["panes"]) == 3
    _capture(page, output_path, "three-column-layout")
    page.reload()
    expect(composer).to_have_value("Keep this draft through layout changes")
    restored = _saved_dock(page)
    assert (
        next(
            chat["layout"]
            for chat in restored["chats"]
            if chat["conversationId"] == first.session_id
        )
        == layout
    )


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
