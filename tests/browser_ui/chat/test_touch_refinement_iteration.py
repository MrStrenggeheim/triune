# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Native touch arbitration and drawer geometry through the built workspace SPA."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import CDPSession, Locator, Page, expect

from tests.browser_ui.chat._geometry_helpers import PHONE, TOLERANCE, box
from tests.browser_ui.chat.session_contract import list_payload
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _saved_dock,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract

pytestmark = [
    pytest.mark.only_browser("chromium"),
    pytest.mark.browser_context_args(
        has_touch=True,
        is_mobile=True,
        viewport={**PHONE, "height": 844},
    ),
]


def _center(target: Locator) -> tuple[float, float]:
    bounds = box(target)
    return bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2


@dataclass
class _Contact:
    session: CDPSession
    point: dict[str, float]

    def move(self, x: float, y: float) -> None:
        self.point.update(x=x, y=y)
        self.session.send(
            "Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [self.point]}
        )


@contextmanager
def _contact(page: Page, target: Locator, output_path: str | None = None) -> Iterator[_Contact]:
    # Transcript/thumb helpers cannot keep one tab contact across menu opening and dragging.
    x, y = _center(target)
    session = page.context.new_cdp_session(page)
    contact = _Contact(session, {"x": x, "y": y, "id": 1, "radiusX": 2, "radiusY": 2, "force": 1})
    try:
        session.send(
            "Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [contact.point]}
        )
        yield contact
    finally:
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        session.detach()
        if output_path:
            _evidence(
                page,
                output_path,
                "touch-contact-events",
                page.evaluate("""() => ({
              events: window.__touchRefinementEvents,
              selection: document.getSelection()?.toString(),
              scrollLeft: document.querySelector('.dock-pane:not([hidden]) .dock-tabs').scrollLeft,
            })"""),
            )


def _open_tabs(page: Page, journey: WorkspaceJourney, explorers: int = 1) -> Locator:
    page.goto(journey.chats[0].url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Touch acceptance keeps this draft")
    journey.chats[0].wait_for_stream()
    for index in range(explorers):
        page.get_by_role("button", name="Add view to pane", exact=True).click()
        page.get_by_role("menuitem", name="Explorer", exact=True).click()
        expect(page.get_by_role("tab", name="Explorer", exact=True)).to_have_count(index + 1)
    expect(page.locator(".dock-pane:not([hidden])")).to_have_count(1)
    assert page.evaluate("matchMedia('(pointer: coarse)').matches")
    return page.locator(".dock-pane:not([hidden]) .dock-tabs")


def _record_contact(page: Page) -> None:
    page.evaluate("""() => {
      window.__touchRefinementEvents = [];
      const record = event => window.__touchRefinementEvents.push({
        type: event.type, pointerId: event.pointerId, pointerType: event.pointerType,
        trusted: event.isTrusted,
        x: event.clientX ?? event.touches?.[0]?.clientX,
        y: event.clientY ?? event.touches?.[0]?.clientY,
      });
      for (const type of ['pointerdown', 'pointermove', 'pointercancel', 'pointerup',
          'touchstart', 'touchmove', 'touchend', 'touchcancel', 'scroll',
          'triune:touch-drag-start'])
        document.addEventListener(type, record, {capture: true});
      document.addEventListener('click', record);
    }""")


def _evidence(page: Page, output_path: str, name: str, data: Any) -> None:
    _capture(page, output_path, name)
    (Path(output_path) / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")


def test_mobile_tab_tap_swipe_and_stationary_menu(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    """Trusted touch switches tabs, scrolls overflow, and opens actions without activation."""
    rail = _open_tabs(page, workspace_journey, explorers=3)
    tab = rail.get_by_role("tab", name="Chat A", exact=True, include_hidden=True)
    tab.scroll_into_view_if_needed()
    expect(tab).to_have_attribute("aria-selected", "false")
    pins = _saved_dock(page)["pins"]
    x, y = _center(tab.locator(".dock-tab-type-icon"))
    hit = page.evaluate(
        """({x,y}) => document.elementFromPoint(x,y).closest('button')?.getAttribute('role')""",
        {"x": x, "y": y},
    )
    assert hit == "tab", "The invisible pin still intercepts the tab icon"
    page.touchscreen.tap(x, y)
    expect(tab).to_have_attribute("aria-selected", "true")
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_have_value(
        "Touch acceptance keeps this draft"
    )
    assert _saved_dock(page)["pins"] == pins

    overflow = rail.evaluate("el => el.scrollWidth - el.clientWidth")
    assert overflow > 60, "This scenario must exercise actual tab overflow"
    initial_scroll = rail.evaluate("el => el.scrollLeft")
    source = rail.get_by_role("tab", name="Explorer", exact=True, include_hidden=True).first
    _record_contact(page)
    with _contact(page, source.locator(".dock-tab-label"), output_path) as contact:
        x, y = contact.point["x"], contact.point["y"]
        page.wait_for_timeout(25)
        for offset in (20, 40, 60, 80):
            contact.move(x - offset, y)
            page.wait_for_timeout(16)
    page.wait_for_function(
        """initial => document.querySelector('.dock-pane:not([hidden]) .dock-tabs')
            .scrollLeft > initial + 20""",
        arg=initial_scroll,
    )
    expect(tab).to_have_attribute("aria-selected", "true")
    expect(page.get_by_role("menu")).to_have_count(0)
    expect(page.locator('.dock-tab[data-dragging="true"]')).to_have_count(0)
    events = page.evaluate("window.__touchRefinementEvents")
    assert any(event["type"] == "pointercancel" and event["trusted"] for event in events), events
    _evidence(page, output_path, "native-tab-swipe", {"events": events, "pins": pins})

    source.scroll_into_view_if_needed()
    before_menu = _saved_dock(page)
    with _contact(page, source.locator(".dock-tab-label")):
        page.wait_for_timeout(550)
        expect(
            page.get_by_role("menuitem", name="Keep open across chats", exact=True)
        ).to_be_visible()
        expect(source).to_have_attribute("aria-selected", "false")
        _capture(page, output_path, "stationary-touch-tab-menu")
    page.wait_for_timeout(100)
    expect(page.get_by_role("menu")).to_be_visible()
    expect(tab).to_have_attribute("aria-selected", "true")
    assert _saved_dock(page) == before_menu, (
        "Release changed the layout or activated a menu action"
    )
    page.keyboard.press("Escape")
    assert browser_errors == []


@pytest.mark.parametrize("hold_ms", [350, 550], ids=["hold-move", "menu-to-drag"])
def test_touch_tab_drag_uses_one_contact_and_existing_drop_preview(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
    hold_ms: int,
) -> None:
    """Both hold paths reorder a real pane without a second touch or a release click."""
    rail = _open_tabs(page, workspace_journey)
    target = rail.get_by_role("tab", name="Chat A", exact=True, include_hidden=True)
    page.touchscreen.tap(*_center(target.locator(".dock-tab-type-icon")))
    source = rail.get_by_role("tab", name="Explorer", exact=True, include_hidden=True)
    pins = _saved_dock(page)["pins"]
    _record_contact(page)
    with _contact(page, source.locator(".dock-tab-label"), output_path) as contact:
        page.wait_for_timeout(hold_ms)
        if hold_ms > 500:
            expect(page.get_by_role("menuitem", name="Close view", exact=True)).to_be_visible()
        else:
            expect(page.get_by_role("menu")).to_have_count(0)
        expect(source).to_have_attribute("data-dragging", "false")
        contact.move(contact.point["x"] - 24, contact.point["y"])
        expect(source).to_have_attribute("data-dragging", "true")
        expect(page.get_by_role("menu")).to_have_count(0)
        expect(page.locator(".dock-drop-overlay")).to_be_visible()
        bounds = box(target)
        contact.move(bounds["x"] + 4, bounds["y"] + bounds["height"] / 2)
        expect(page.locator('.dock-tab-group[data-insertion="true"]')).to_have_count(1)
        _capture(page, output_path, f"touch-drag-preview-{hold_ms}")
    expect(rail.get_by_role("tab").first).to_have_accessible_name("Explorer")
    expect(page.locator(".dock-drop-overlay")).to_have_count(0)
    expect(rail.get_by_role("tab")).to_have_count(2)
    assert _saved_dock(page)["pins"] == pins
    page.wait_for_timeout(100)
    events = page.evaluate("window.__touchRefinementEvents")
    starts = [event for event in events if event["type"] == "pointerdown"]
    assert len(starts) == 1 and starts[0]["trusted"] and starts[0]["pointerType"] == "touch", (
        events
    )
    assert not any(event["type"] == "click" for event in events), events
    page.touchscreen.tap(*_center(target.locator(".dock-tab-type-icon")))
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_have_value(
        "Touch acceptance keeps this draft"
    )
    _evidence(page, output_path, f"touch-drag-complete-{hold_ms}", events)
    assert browser_errors == []


@pytest.mark.parametrize("density,dark", [("comfortable", False), ("compact", True)])
def test_touch_sidebar_has_one_safe_area_and_guides_outside_selected_rows(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
    density: str,
    dark: bool,
) -> None:
    """Representative light/comfortable and dark/compact drawers retain density and hierarchy."""
    for chat in workspace_journey.chats:
        chat.update_session(project_id="touch-project", labels={"omni_project": "Touch hierarchy"})
    browser_contract.json(
        "/v1/projects", list_payload([{"id": "touch-project", "name": "Touch hierarchy"}])
    )
    browser_contract.json(
        "/v1/sessions/projects", [{"id": "touch-project", "name": "Touch hierarchy"}]
    )
    page.goto(workspace_journey.chats[0].url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    page.evaluate(
        """({density,dark}) => {
      document.documentElement.style.setProperty('--omnigent-safe-top', '32px');
      document.documentElement.dataset.listDensity = density;
      document.documentElement.classList.toggle('dark', dark);
      document.querySelector('.unified-workbench').dataset.iosNative = 'true';
    }""",
        {"density": density, "dark": dark},
    )
    page.get_by_role("button", name="Open navigation", exact=True).tap()
    sidebar = page.get_by_role("complementary", name="Conversations")
    expect(sidebar).to_have_attribute("aria-hidden", "false")
    projects = sidebar.get_by_role("button", name="Projects", exact=True)
    if projects.get_attribute("aria-expanded") == "false":
        projects.tap()
    folder = sidebar.locator('[data-sidebar-drop-name="Touch hierarchy"]')
    header = folder.locator("h2 button[aria-expanded]").first
    expect(header).to_be_visible()
    if header.get_attribute("aria-expanded") == "false":
        header.tap()
    row = folder.locator(f'[data-sidebar-session-id="{workspace_journey.chats[0].session_id}"]')
    expect(row.get_by_role("link", name="Chat A", exact=True)).to_have_attribute(
        "aria-current", "page"
    )
    expect(sidebar.locator(".sidebar-header-row")).to_have_count(0)
    expect(sidebar).to_have_css("padding-top", "0px")
    expect(sidebar.get_by_test_id("sidebar-primary-nav")).to_have_css("padding-top", "0px")
    appbar = box(page.get_by_role("banner", name="Application"))
    drawer = box(sidebar)
    assert appbar["y"] == pytest.approx(32, abs=TOLERANCE)
    assert appbar["height"] == pytest.approx(36 if density == "compact" else 48, abs=TOLERANCE)
    assert drawer["y"] == pytest.approx(appbar["y"] + appbar["height"], abs=TOLERANCE)
    icon = box(header.locator(".lucide-folder, .lucide-folder-open").first)
    guide = box(folder.locator("[data-sidebar-tree-guide]").first)
    fill = box(row)
    assert guide["x"] + guide["width"] / 2 == pytest.approx(
        icon["x"] + icon["width"] / 2, abs=TOLERANCE
    )
    assert fill["x"] >= guide["x"] + guide["width"] + 2
    _evidence(
        page,
        output_path,
        f"sidebar-touch-{density}",
        {"appbar": appbar, "drawer": drawer, "icon": icon, "guide": guide, "fill": fill},
    )
    assert browser_errors == []
