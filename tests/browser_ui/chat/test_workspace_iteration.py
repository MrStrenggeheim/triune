# Modified for Triune.
"""Approved chat-owned layouts and captured attachment tabs through the built SPA."""

import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, expect

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
                "Folder: [root](/workspace/docs).",
                response_id="artifact-turn",
            )
        ]
    )
    route = f"/v1/sessions/{first.session_id}/attachments/references/{item_id}"
    captured = "name,value\noriginal,1\n"
    browser_contract.route(
        browser_contract._matcher(route),
        lambda request: request.fulfill(body=captured, content_type="text/csv"),
    )

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
    expect(chat.get_by_role("button", name="guide.csv", exact=True)).to_be_visible()
    expect(chat.locator("code").filter(has_text="/workspace/docs")).to_be_visible()
    chat.get_by_role("button", name="guide.csv", exact=True).click()
    preview = _view(page, "guide.csv")
    expect(preview.locator(".view-lines")).to_contain_text("live", timeout=30000)
    expect(chat.get_by_label("Message the agent")).to_be_visible()
    panes = page.locator(".dock-pane:not([hidden])").count()
    chat.get_by_role("button", name="next.csv", exact=True).click()
    expect(_view(page, "next.csv").locator(".view-lines")).to_contain_text("live", timeout=30000)
    assert page.locator(".dock-pane:not([hidden])").count() == panes
    chat.get_by_role("button", name="guide.csv", exact=True).click()
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
    picker.get_by_role("button", name="Insert quote", exact=True).click()
    draft = _view(page, "Chat B").get_by_label("Message the agent")
    expect(draft).to_have_value(re.compile(r"Existing B draft[\s\S]*> Answer from Chat A"))
    assert first.event_posts == []
    assert second.event_posts == []
    _capture(page, output_path, "quote-in-existing-unsent-draft")
    assert browser_errors == []
