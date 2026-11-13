# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Shared controls and retained resources for the next Triune iteration."""

import json
from pathlib import Path

from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import list_payload
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _navigate_chat,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract


def test_pane_add_empty_state_and_mobile_search(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, browser_errors: list[str]
) -> None:
    first = workspace_journey.chats[0]
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    chat = _view(page, "Chat A")
    chat.get_by_label("Message the agent").fill("Keep this draft")
    add_view = page.get_by_role("button", name="Add view to pane", exact=True)
    for density, size in (("compact", 32), ("comfortable", 44)):
        page.evaluate("value => document.documentElement.dataset.listDensity = value", density)
        page.wait_for_function(
            """expected => {
          const control = document.querySelector('[aria-label="Add view to pane"]');
          const box = control.getBoundingClientRect();
          return Math.abs(box.width - expected) <= 1 && Math.abs(box.height - expected) <= 1;
        }""",
            arg=size,
        )
        bounds = add_view.bounding_box()
        assert bounds and abs(bounds["width"] - size) <= 1 and abs(bounds["height"] - size) <= 1
    page.get_by_role("button", name="Add view to pane", exact=True).click()
    page.get_by_role("menuitem", name="Explorer", exact=True).click()
    expect(page.get_by_role("tab", name="Explorer", exact=True)).to_be_visible()
    expect(page.locator(".dock-pane:not([hidden])")).to_have_count(1)
    page.get_by_role("button", name="Close Explorer", exact=True).click()
    expect(chat.get_by_label("Message the agent")).to_have_value("Keep this draft")
    page.set_viewport_size({"width": 390, "height": 844})
    if page.get_by_role("button", name="Close navigation", exact=True).is_visible():
        page.keyboard.press("Control+b")
    search = page.get_by_role("button", name="Search or run a command", exact=True)
    bounds = search.bounding_box()
    assert bounds and bounds["width"] > 44
    expect(search).to_contain_text("Search or run a command")
    _capture(page, output_path, "phone-expanded-search-and-pane-plus")
    page.get_by_role("button", name="Close Chat A", exact=True).click()
    expect(page.get_by_text("Open a chat or tool to get started.", exact=True)).to_be_visible()
    open_button = page.locator("main").get_by_role("button", name="Open view", exact=True)
    expect(open_button).to_be_visible()
    open_button.click()
    expect(page.get_by_role("menuitem", name="Explorer", exact=True)).to_be_visible()
    _capture(page, output_path, "phone-empty-workspace-open")
    assert browser_errors == []


def test_explorer_retains_rows_and_scroll_across_hidden_layouts(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    base = "/v1/workbench-workspaces/workspace-files/resources/environments/default/filesystem"
    listing = list_payload(
        [
            {
                "path": f"file-{index:04d}.txt",
                "name": f"file-{index:04d}.txt",
                "type": "file",
                "bytes": 17,
            }
            for index in range(220)
        ]
    )
    for suffix in ("", "/", "/workspace"):
        browser_contract.json(base + suffix, listing)
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    page.get_by_role("button", name="Open view", exact=True).click()
    page.get_by_role("menuitem", name="Explorer", exact=True).click()
    tree = _view(page, "Explorer").get_by_role("tree", name="Workspace files")
    expect(tree.get_by_text("file-0000.txt", exact=True)).to_be_visible()
    snapshots = []
    for offset in (0, 1200, 3400, 0):
        tree.evaluate(
            """(el,offset) => {
              el.dispatchEvent(new WheelEvent('wheel', {bubbles:true}));
              el.scrollTop=offset;
              el.dispatchEvent(new Event('scroll'));
            }""",
            offset,
        )
        page.wait_for_timeout(100)
        before = tree.evaluate("el => ({top:el.scrollTop,height:el.scrollHeight})")
        # Newly measured virtual rows can adjust the requested offset slightly.
        assert abs(before["top"] - offset) <= 100, before
        _navigate_chat(page, second)
        _navigate_chat(page, first)
        expect(tree).to_be_visible()
        page.wait_for_timeout(200)
        after = tree.evaluate("el => ({top:el.scrollTop,height:el.scrollHeight})")
        assert abs(before["top"] - after["top"]) <= 1, (before, after)
        assert abs(before["height"] - after["height"]) <= 1, (before, after)
        snapshots.append({"offset": offset, "before": before, "after": after})
    Path(output_path).mkdir(parents=True, exist_ok=True)
    Path(output_path, "retained-explorer-geometry.json").write_text(
        json.dumps(snapshots, indent=2)
    )
    _capture(page, output_path, "retained-explorer-stable-after-switches")
    assert browser_errors == []
