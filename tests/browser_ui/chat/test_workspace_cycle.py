# Modified for Triune.
"""Current cycle: geometry, shared chrome and captured-file destinations."""

from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import list_payload
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _navigate_chat,
    _open,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import (
    browser_errors as browser_errors,
)
from tests.browser_ui.chat.test_unified_workspace import (
    workspace_journey as workspace_journey,
)
from tests.browser_ui.conftest import BrowserContract


def _bounds(page: Page, label: str) -> dict[str, float]:
    result = _view(page, label).bounding_box()
    assert result
    return result


def test_pinned_view_keeps_its_rectangle_and_resizes_across_chat_layouts(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, browser_errors: list[str]
) -> None:
    first, second = workspace_journey.chats
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(first.url)
    _open(page, "Explorer")
    before = _bounds(page, "Explorer")
    page.get_by_role("tab", name="Explorer", exact=True).hover()
    page.get_by_role("button", name="Pin Explorer", exact=True).click()
    assert _bounds(page, "Explorer") == before
    _navigate_chat(page, second)
    assert _bounds(page, "Explorer") == before
    expect(_view(page, "Chat B")).to_be_visible()
    _capture(page, output_path, "pinned-explorer-unchanged-in-chat-b")
    divider = page.get_by_role("separator", name="Resize panes", exact=True)
    bounds = divider.bounding_box()
    assert bounds
    x = bounds["x"] + bounds["width"] / 2
    y = bounds["y"] + bounds["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x - 90, y, steps=8)
    page.mouse.up()
    after = _bounds(page, "Explorer")
    assert after["width"] > before["width"] + 70
    _navigate_chat(page, first)
    assert _bounds(page, "Explorer") == after
    page.reload()
    assert _bounds(page, "Explorer") == after
    _capture(page, output_path, "pinned-explorer-resized-and-restored")
    divider = page.get_by_role("separator", name="Resize panes", exact=True)
    expect(divider).to_have_attribute("aria-valuemin", "20")
    expect(divider).to_have_attribute("aria-valuemax", "80")
    for _ in range(12):
        divider.press("ArrowRight")
    expect(divider).to_have_attribute("aria-valuenow", "80")
    narrow = _bounds(page, "Explorer")
    workspace_bounds = page.locator(".dock-workspace").bounding_box()
    assert workspace_bounds
    assert abs(narrow["width"] - workspace_bounds["width"] * 0.2) <= 2
    page.reload()
    assert _bounds(page, "Explorer") == narrow
    _capture(page, output_path, "pinned-explorer-twenty-percent-minimum")
    assert browser_errors == []


def test_tab_drag_previews_and_shared_context_menu(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, browser_errors: list[str]
) -> None:
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(workspace_journey.chats[0].url)
    _open(page, "Explorer")
    source = page.get_by_role("tab", name="Explorer", exact=True)
    target = page.get_by_role("tab", name="Chat A", exact=True)
    source_bounds, target_bounds = source.bounding_box(), target.bounding_box()
    assert source_bounds and target_bounds
    x = source_bounds["x"] + source_bounds["width"] / 2
    y = source_bounds["y"] + source_bounds["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 12, y, steps=3)
    page.mouse.move(target_bounds["x"] + 4, target_bounds["y"] + 20, steps=12)
    marker = page.locator('.dock-tab-group[data-insertion="true"]')
    expect(marker).to_have_count(1)
    _capture(page, output_path, "tab-insertion-primary-marker")
    page.mouse.up()
    expect(page.locator(".dock-pane:not([hidden])")).to_have_count(1)
    expect(page.get_by_role("tab", name="Chat A", exact=True)).to_be_visible()
    source = page.get_by_role("tab", name="Explorer", exact=True)
    source.click(button="right")
    expect(page.get_by_role("menuitem", name="Split right", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    bounds = source.bounding_box()
    assert bounds
    page.mouse.move(bounds["x"] + bounds["width"] / 2, bounds["y"] + 20)
    page.mouse.down()
    page.mouse.move(bounds["x"] + bounds["width"] / 2 + 12, bounds["y"] + 20, steps=3)
    zone = page.locator('.dock-pane:not([hidden]) .dock-drop-zone[data-edge="right"]')
    zone.hover()
    preview = page.locator('.dock-placement-preview[data-edge="right"]')
    expect(preview).to_be_visible()
    projected = preview.bounding_box()
    canvas = page.locator(".dock-canvas").bounding_box()
    assert projected and canvas
    assert abs(projected["width"] - canvas["width"] / 2) < 2
    assert zone.evaluate("el => getComputedStyle(el).borderWidth") == "0px"
    _capture(page, output_path, "tab-drop-half-pane-preview")
    page.mouse.up()
    final = _bounds(page, "Explorer")
    assert abs(final["x"] - projected["x"]) < 2
    assert abs(final["width"] - projected["width"]) < 2
    _capture(page, output_path, "tab-drop-final-placement")
    assert browser_errors == []


def test_search_trigger_and_popup_share_the_application_center(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, browser_errors: list[str]
) -> None:
    page.goto(workspace_journey.chats[0].url)
    for name, width, height, density in (
        ("desktop", 1440, 1000, "comfortable"),
        ("narrow-desktop", 860, 900, "comfortable"),
        ("phone-comfortable", 390, 844, "comfortable"),
        ("phone", 390, 844, "compact"),
        ("small-phone", 320, 720, "compact"),
    ):
        page.set_viewport_size({"width": width, "height": height})
        page.evaluate("value => document.documentElement.dataset.listDensity = value", density)
        scrim = page.get_by_test_id("sidebar-scrim")
        if scrim.is_visible() and scrim.get_attribute("tabindex") == "0":
            scrim.click(position={"x": width - 4, "y": 180})
        search = page.get_by_role("button", name="Search or run a command", exact=True)
        app = page.get_by_role("banner", name="Application")
        app_bounds = app.bounding_box()
        trigger_bounds = search.bounding_box()
        assert app_bounds and trigger_bounds
        center = app_bounds["x"] + app_bounds["width"] / 2
        assert abs(trigger_bounds["x"] + trigger_bounds["width"] / 2 - center) < 1
        open_button = app.get_by_role("button", name="Open view", exact=True)
        open_bounds = open_button.bounding_box()
        settings_bounds = app.get_by_role("button", name="Settings", exact=True).bounding_box()
        bell_bounds = app.get_by_role("button", name="Notifications", exact=True).bounding_box()
        assert open_bounds and settings_bounds and bell_bounds
        if width >= 768:
            assert abs(open_bounds["x"] - trigger_bounds["x"] - trigger_bounds["width"] - 8) < 1
        assert open_bounds["x"] + open_bounds["width"] < settings_bounds["x"]
        assert open_bounds["x"] + open_bounds["width"] <= bell_bounds["x"] - 4
        assert trigger_bounds["width"] >= 28
        if width == 390 and density == "compact":
            assert trigger_bounds["width"] >= 110
        if width >= 768:
            expect(open_button).to_have_text("Open")
        expect(open_button.locator("svg")).to_have_count(1)
        _capture(page, output_path, name + "-search-and-open")
        open_button.click()
        expect(page.get_by_role("menuitem", name="Explorer", exact=True)).to_be_visible()
        page.keyboard.press("Escape")
        search.click()
        popup = page.get_by_role("dialog", name="Command palette", exact=True)
        expect(popup).to_be_visible()
        popup_bounds = popup.bounding_box()
        assert popup_bounds
        assert abs(popup_bounds["x"] + popup_bounds["width"] / 2 - center) < 1
        assert popup_bounds["y"] >= app_bounds["y"] + app_bounds["height"]
        expect(page.locator('[data-slot="dialog-overlay"]')).to_have_count(0)
        _capture(page, output_path, name + "-centered-search")
        page.get_by_test_id("command-palette-input").press("Escape")
        expect(popup).to_have_count(0)
    assert browser_errors == []


def test_density_preview_cards_and_overflow_scrollbars(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, browser_errors: list[str]
) -> None:
    first = workspace_journey.chats[0]
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.contract.base_url + "/settings/appearance")
    comfortable = page.get_by_test_id("list-density-comfortable")
    compact = page.get_by_test_id("list-density-compact")
    expect(comfortable).to_have_attribute("role", "radio")
    expect(comfortable).to_contain_text("48px rows")
    expect(compact).to_contain_text("36px rows")
    compact.click()
    expect(compact).to_have_attribute("aria-checked", "true")
    comfortable.click()
    expect(comfortable).to_have_attribute("aria-checked", "true")
    _capture(page, output_path, "desktop-density-preview-cards")
    page.set_viewport_size({"width": 390, "height": 844})
    if page.get_by_role("button", name="Close navigation", exact=True).is_visible():
        page.keyboard.press("Control+b")
    expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()
    page.locator("html").evaluate("el => el.classList.add('dark')")
    compact.scroll_into_view_if_needed()
    expect(compact).to_be_visible()
    _capture(page, output_path, "phone-dark-density-preview-cards")
    page.goto(first.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    composer.fill("A long draft\n" * 35)
    expect(composer).to_have_css("scrollbar-width", "none")
    tabs = page.get_by_role("tablist", name="Views in main")
    expect(tabs).to_have_css("scrollbar-width", "none")
    assert page.locator(".chat-composer-form [data-overlay-scrollbar]").count() == 0
    _capture(page, output_path, "phone-dark-barless-composer")
    assert browser_errors == []


def test_recursive_counts_and_shallow_hierarchy_guides(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    roots = [first.session_snapshot(), second.session_snapshot()]
    children = []
    for index, parent in enumerate(
        [first.session_id, first.session_id, "child-0", "child-0", "child-0"]
    ):
        children.append(
            {
                **roots[0],
                "id": f"child-{index}",
                "title": f"Child {index}",
                "branch": {
                    "source_conversation_id": parent,
                    "reference_only": True,
                    "recovery": "replay",
                },
            }
        )
        browser_contract.json(f"/v1/sessions/child-{index}/items", list_payload([]))
    browser_contract.json(
        "/v1/sessions",
        lambda request: list_payload(
            roots + children
            if parse_qs(urlparse(request.url).query).get("include_side_chats") == ["true"]
            else roots,
        ),
    )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    root = page.locator(f'aside [data-sidebar-session-id="{first.session_id}"]')
    expander = root.get_by_role("button", name="Expand subchats of Chat A", exact=True)
    expect(expander).to_have_text("5")
    expect(expander).to_have_css("cursor", "pointer")
    expander.click()
    expect(page.locator('aside [data-sidebar-session-id="child-0"]')).to_be_visible()
    expect(page.locator('aside [data-sidebar-session-id="child-2"]')).to_have_count(0)
    child = page.locator('aside [data-sidebar-session-id="child-0"]')
    nested = child.get_by_role("button", name="Expand subchats of Child 0", exact=True)
    expect(nested).to_have_text("3")
    nested.click()
    expect(page.locator('aside [data-sidebar-session-id="child-2"]')).to_be_visible()
    _capture(page, output_path, "recursive-subchat-counts-and-guides")
    assert browser_errors == []
