# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Workspace chrome and notification geometry through the compiled SPA."""

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat._geometry_helpers import box
from tests.browser_ui.chat.test_iteration6 import (
    _close_phone_navigation,
    _landing_routes,
    _navigation,
)
from tests.browser_ui.chat.test_iteration6 import appearance as appearance
from tests.browser_ui.chat.test_unified_workspace import WorkspaceJourney, _capture
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract

pytestmark = pytest.mark.timeout(90)


def test_footer_settings_tab_geometry_and_notification_disclosure(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    appearance: tuple[str, str, str],
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    _landing_routes(browser_contract, workspace_journey)
    for index, chat in enumerate((first, second), 1):
        chat.update_session(
            title=(
                f"Archive example {index}: a long conversation title "
                "for checking the full notification paragraph"
            )
        )
    second.update_session(
        branch={"source_conversation_id": first.session_id, "reference_only": True}
    )
    page.goto(first.url)
    expect(page.get_by_label("Message the agent").first).to_be_visible()
    app = page.get_by_role("banner", name="Application")
    expect(app.get_by_role("button", name="Settings", exact=True)).to_have_count(0)
    expect(app.get_by_role("button", name="Open view").locator("svg")).to_have_attribute(
        "stroke-width", "2.5"
    )
    for density in ("comfortable", "compact"):
        page.evaluate("value => document.documentElement.dataset.listDensity = value", density)
        tab = page.locator(".dock-tab-group").first
        icon = box(tab.locator(".dock-tab-type-icon"))
        close = box(tab.locator(".dock-tab-close"))
        group = box(tab)
        assert icon["x"] - group["x"] == pytest.approx(
            group["x"] + group["width"] - close["x"] - close["width"], abs=1
        )
        assert icon["height"] == pytest.approx(close["height"], abs=1)
        if appearance[0] == "desktop":
            tab.hover()
            pin = box(tab.locator(".dock-tab-pin"))
            assert pin["x"] + pin["width"] / 2 == pytest.approx(
                icon["x"] + icon["width"] / 2, abs=1
            )
        _capture(page, output_path, f"tab-{density}")
    page.evaluate("value => document.documentElement.dataset.listDensity = value", appearance[2])
    navigation = _navigation(page)
    settings = navigation.get_by_test_id("settings-button")
    expect(settings).to_be_visible()
    assert not settings.evaluate("element => element.closest('nav')")
    parent_row = navigation.locator(f'[data-sidebar-session-id="{first.session_id}"]')
    expander = parent_row.get_by_role(
        "button", name="Expand subchats of " + first.session_snapshot()["title"], exact=True
    )
    if appearance[0] == "desktop":
        page.mouse.move(0, 0)
        before = box(expander)
        expect(
            parent_row.locator('[data-testid="conversation-actions"] > [aria-hidden]')
        ).to_have_css("opacity", "0")
        parent_row.hover()
        archive = box(parent_row.get_by_test_id("quick-archive-conversation"))
        more_action = box(parent_row.get_by_test_id("conversation-actions"))
        child_action = box(expander)
        assert archive["x"] < more_action["x"] < child_action["x"]
        assert child_action["x"] == pytest.approx(before["x"], abs=1)
        expected_gap = 8 if appearance[2] == "comfortable" else 4
        assert more_action["x"] - archive["x"] - archive["width"] == pytest.approx(
            expected_gap, abs=1
        )
    expander.click()
    page.clock.pause_at(page.evaluate("Date.now() + 1000"))
    for chat in (second, first):
        row = navigation.locator(f'[data-sidebar-session-id="{chat.session_id}"]')
        row.hover()
        row.get_by_role("button", name="Conversation actions", exact=True).click()
        page.get_by_role("menuitem", name="Archive", exact=True).click()
        page.clock.run_for(100)
    _close_phone_navigation(page)
    page.clock.run_for(100)
    preview = page.get_by_role("region", name="Notifications", exact=True)
    card = preview.get_by_test_id("archive-undo-toast-item")
    expect(card).to_contain_text("Archived 2 chats")
    bell = app.get_by_role("button", name="Notifications", exact=True)
    bounds = box(card)
    bell_bounds = box(bell)
    assert bounds["x"] + bounds["width"] == pytest.approx(
        min(bell_bounds["x"] + bell_bounds["width"], page.viewport_size["width"] - 16), abs=1
    )
    scroller = preview.locator(".notification-toast-scroll")
    scroll_box = box(scroller)
    assert bounds["x"] - scroll_box["x"] >= 15
    assert bounds["y"] - scroll_box["y"] >= 15
    assert preview.evaluate("element => getComputedStyle(element).overflow") == "visible"
    _capture(page, output_path, "notification-shadow-space")
    bell.click()
    page.clock.run_for(100)
    feed = page.get_by_role("dialog", name="Notifications", exact=True)
    paragraph = feed.locator(".notification-description")
    more = paragraph.get_by_role("button", name="more", exact=True)
    expect(more).to_be_visible()
    line_height = paragraph.evaluate("element => parseFloat(getComputedStyle(element).lineHeight)")
    collapsed = box(paragraph)
    assert collapsed["height"] == pytest.approx(line_height * 2, abs=1)
    more_box = box(more)
    assert more_box["y"] >= collapsed["y"] + line_height - 1
    _capture(page, output_path, "notification-two-lines")
    more.click()
    less = paragraph.get_by_role("button", name="less", exact=True)
    expect(less).to_be_visible()
    less_box = box(less)
    expanded = box(paragraph)
    assert expanded["height"] > collapsed["height"]
    assert less_box["x"] + less_box["width"] == pytest.approx(
        more_box["x"] + more_box["width"], abs=1
    )
    assert less_box["y"] >= expanded["y"] + expanded["height"] - line_height - 1
    _capture(page, output_path, "notification-full-paragraph")
    less.press("Enter")
    expect(more).to_be_visible()
    assert box(paragraph)["height"] == pytest.approx(collapsed["height"], abs=1)
    expect(feed.get_by_role("button", name="Undo", exact=True)).to_be_visible()
    feed.get_by_role("button", name="Close notifications").click()
    page.clock.resume()
    settings = _navigation(page).get_by_test_id("settings-button")
    settings.click()
    expect(page).to_have_url(browser_contract.base_url + "/settings/general")
    _capture(page, output_path, "sidebar-settings-navigation")
    assert browser_errors == []
