# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Iteration 6 journeys through the built SPA and sealed browser contracts.

Native insets are synthetic CSS emulation; gallery touches use Chromium CDP.
Run only after the parent freezes and builds the integrated candidate.
"""

from __future__ import annotations

import io
import json
import re
from itertools import pairwise
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image
from playwright.sync_api import Locator, Page, Route, expect

from tests.browser_ui.chat._geometry_helpers import (
    TOLERANCE,
    assert_no_overlap,
    assert_same_vertical_center,
    assert_within_viewport,
    box,
)
from tests.browser_ui.chat.session_contract import list_payload, message_item
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _navigate_chat,
    _open,
    _saved_dock,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract

DESKTOP = ("desktop", "light", "comfortable")
PHONE = ("phone", "dark", "compact")
AGENT_NAME = "Geometry helper with a deliberately long display name"
pytestmark = pytest.mark.timeout(90)


@pytest.fixture(
    params=[
        pytest.param(DESKTOP, id="desktop-light-comfortable"),
        pytest.param(
            PHONE,
            id="phone-dark-compact",
            marks=pytest.mark.browser_context_args(has_touch=True, is_mobile=True),
        ),
    ]
)
def appearance(page: Page, request: pytest.FixtureRequest) -> tuple[str, str, str]:
    device, theme, density = request.param
    page.set_default_timeout(8_000)
    page.set_viewport_size(
        {"width": 390 if device == "phone" else 1440, "height": 844 if device == "phone" else 1000}
    )
    page.emulate_media(color_scheme=theme, reduced_motion="reduce")
    # Seed once, so cold navigations cannot undo the settings changed by a journey.
    page.add_init_script(
        f"""if (!sessionStorage.getItem('iteration6:appearance-seeded')) {{
          localStorage.setItem('web-theme', {json.dumps(theme)});
          localStorage.setItem('omnigent:list-density', {json.dumps(density)});
          sessionStorage.setItem('iteration6:appearance-seeded', 'true');
        }}"""
    )
    return device, theme, density


def _evidence(output_path: str, name: str, value: Any) -> None:
    root = Path(output_path)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.json").write_text(json.dumps(value, indent=2) + "\n")


def _navigation(page: Page) -> Locator:
    toggle = page.get_by_role("button", name="Open navigation", exact=True)
    if toggle.is_visible():
        toggle.click()
    return page.locator("aside.conversations-sidebar:visible")


def _close_phone_navigation(page: Page) -> None:
    scrim = page.get_by_test_id("sidebar-scrim")
    if scrim.is_visible() and scrim.get_attribute("tabindex") == "0":
        scrim.click(position={"x": page.viewport_size["width"] - 4, "y": 180})


def _landing_routes(contract: BrowserContract, journey: WorkspaceJourney) -> None:
    host_id = journey.chats[0].host_id
    for suffix in ("", "/workspace"):
        contract.json(
            f"/v1/hosts/{host_id}/filesystem{suffix}", {"available": True, **list_payload([])}
        )


def _chat_layout(page: Page, conversation_id: str) -> dict:
    return next(
        entry["layout"]
        for entry in _saved_dock(page)["chats"]
        if entry["conversationId"] == conversation_id
    )


def _assert_new_destination(page: Page, base_url: str) -> None:
    expect(page).to_have_url(base_url + "/")
    expect(page.get_by_test_id("new-chat-landing-input")).to_be_visible()
    navigation = _navigation(page)
    expect(navigation.locator('[data-sidebar-session-id] [aria-current="page"]')).to_have_count(0)
    new_session = navigation.get_by_test_id("new-chat-button")
    # This nav link exposes selection through the shared paint rather than aria-current.
    assert new_session.evaluate("""element => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--sidebar-active)';
      element.append(probe);
      const selected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(element).backgroundColor === selected;
    }""")
    _close_phone_navigation(page)


def test_startup_restores_owner_and_respects_explicit_destinations(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    appearance: tuple[str, str, str],
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    _landing_routes(browser_contract, workspace_journey)
    page.goto(first.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent", exact=True)
    composer.fill("Iteration 6 retained owner draft")
    _open(page, "Changes")
    page.get_by_role("tab", name="Chat A", exact=True).click()
    composer.click()
    saved_layout = _chat_layout(page, first.session_id)
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    assert page.evaluate("localStorage.getItem('triune:startup-destination')") is None

    with page.expect_request(
        lambda request: (
            urlparse(request.url).path == f"/v1/sessions/{first.session_id}"
            and parse_qs(urlparse(request.url).query).get("include_items") == ["false"]
        )
    ):
        page.goto(browser_contract.base_url + "/")
    expect(page).to_have_url(first.url)
    expect(composer).to_have_value("Iteration 6 retained owner draft")
    assert _chat_layout(page, first.session_id) == saved_layout
    navigation = _navigation(page)
    expect(
        navigation.locator(f'[data-sidebar-session-id="{first.session_id}"] [aria-current="page"]')
    ).to_have_count(1)
    _capture(page, output_path, "startup-restored-owner-and-selection")

    navigation.get_by_test_id("new-chat-button").click()
    _assert_new_destination(page, browser_contract.base_url)
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    assert _chat_layout(page, first.session_id) == saved_layout
    _capture(page, output_path, "startup-deliberate-new-session")

    _navigate_chat(page, first)
    expect(composer).to_have_value("Iteration 6 retained owner draft")
    _navigation(page).get_by_test_id("settings-button").click()
    if appearance[0] == "phone":
        page.get_by_role("combobox", name="Settings section", exact=True).click()
        page.get_by_role("option", name="Appearance", exact=True).click()
    else:
        page.get_by_test_id("settings-nav-appearance").click()
    layout = page.get_by_test_id("settings-group-density")
    continue_card = layout.get_by_test_id("startup-continue")
    new_card = layout.get_by_test_id("startup-new")
    expect(continue_card).to_have_attribute("role", "radio")
    expect(continue_card).to_have_attribute("aria-checked", "true")
    new_card.click()
    expect(new_card).to_have_attribute("aria-checked", "true")
    assert page.evaluate("localStorage.getItem('triune:startup-destination')") == "new"
    _capture(page, output_path, "startup-settings-new-chat")

    if appearance == DESKTOP:
        with page.expect_download() as download:
            page.get_by_test_id("export-settings-button").click()
        exported = json.loads(Path(download.value.path()).read_text())
        assert exported["settings"]["triune:startup-destination"] == "new"
        _evidence(output_path, "startup-export", exported)

    page.goto(browser_contract.base_url + "/")
    _assert_new_destination(page, browser_contract.base_url)
    assert _chat_layout(page, first.session_id) == saved_layout
    # A cold explicit /c link wins even when the saved owner and preference differ.
    page.goto(second.url)
    expect(page).to_have_url(second.url)
    expect(_view(page, "Chat B").get_by_label("Message the agent")).to_be_visible()
    _navigate_chat(page, first)
    expect(composer).to_have_value("Iteration 6 retained owner draft")
    assert _chat_layout(page, first.session_id) == saved_layout

    if appearance == DESKTOP:
        page.goto(browser_contract.base_url + "/settings/appearance")
        page.get_by_test_id("reset-appearance-button").click()
        reset = page.get_by_role("dialog", name="Reset appearance?", exact=True)
        reset.get_by_test_id("reset-appearance-confirm").click()
        expect(reset).to_be_hidden()
        expect(page.get_by_test_id("startup-continue")).to_have_attribute("aria-checked", "true")
        page.goto(browser_contract.base_url + "/")
        expect(page).to_have_url(first.url)
        expect(composer).to_have_value("Iteration 6 retained owner draft")
    _evidence(output_path, "startup-layout-retained", _chat_layout(page, first.session_id))
    assert browser_errors == []


@pytest.mark.parametrize("appearance", [DESKTOP], ids=["desktop-light-comfortable"], indirect=True)
def test_startup_missing_owner_falls_back_without_erasing_layout(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    appearance: tuple[str, str, str],
    output_path: str,
    browser_errors: list[str],
) -> None:
    first = workspace_journey.chats[0]
    _landing_routes(browser_contract, workspace_journey)
    page.goto(first.url)
    _view(page, "Chat A").get_by_label("Message the agent").fill("Retain inaccessible draft")
    _open(page, "Changes")
    saved_layout = _chat_layout(page, first.session_id)
    requests: list[str] = []

    def missing_owner(route: Route) -> None:
        requests.append(route.request.url)
        route.fulfill(status=404, json={"detail": "Session no longer available"})

    browser_contract.route(
        browser_contract._matcher(f"/v1/sessions/{first.session_id}"), missing_owner
    )
    page.goto(browser_contract.base_url + "/")
    _assert_new_destination(page, browser_contract.base_url)
    expect(page.get_by_role("status").filter(has_text="Restoring session…")).to_have_count(0)
    assert requests
    assert _chat_layout(page, first.session_id) == saved_layout
    _capture(page, output_path, "startup-missing-owner-fallback")
    browser_contract.json(f"/v1/sessions/{first.session_id}", first.session_snapshot())
    _navigate_chat(page, first)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_have_value(
        "Retain inaccessible draft"
    )
    assert browser_errors == []


def test_sidebar_rollup_uses_revealable_children_only_while_collapsed(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    appearance: tuple[str, str, str],
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    second.update_session(
        branch={"source_conversation_id": first.session_id, "reference_only": True},
        status="running",
        pending_elicitations_count=2,
        activity={
            "own_status": "running",
            "descendant_running": False,
            "descendants_complete": True,
            "descendants": [],
        },
    )
    # Match the current server projection: unknown error coverage is explicit.
    visible_child = {
        "id": second.session_id,
        "status": "running",
        "updated_at": 1_704_067_200,
        "pending_elicitations_count": 2,
        "viewer_last_seen": 1_704_067_200,
        "viewer_unread": False,
        "latest_error": "unknown",
        "branch_source_id": first.session_id,
        "parent_session_id": None,
        "archived": False,
        "project_id": None,
        "labels": {},
        "permission_level": 4,
        "owner": "local",
    }
    excluded = [
        {
            **visible_child,
            "id": "archived-branch",
            "archived": True,
            "status": "failed",
            "pending_elicitations_count": 9,
        },
        {
            **visible_child,
            "id": "filtered-branch",
            "status": "failed",
            "project_id": "hidden-project",
            "pending_elicitations_count": 7,
        },
        {
            **visible_child,
            "id": "delegation-only",
            "branch_source_id": None,
            "parent_session_id": first.session_id,
            "status": "failed",
        },
    ]
    first.update_session(
        status="idle",
        activity={
            "own_status": "idle",
            "descendant_running": True,
            "descendants_complete": True,
            "descendants": [visible_child, *excluded],
        },
    )

    def sessions(request: Any) -> dict:
        query = parse_qs(urlparse(request.url).query)
        if query.get("pinned") == ["true"]:
            return list_payload([])
        # The loaded unarchived tree contains the one currently revealable branch.
        rows = [{**first.session_snapshot(), "status": "running"}]
        if query.get("include_side_chats") == ["true"]:
            rows.append(second.session_snapshot())
        return list_payload(rows)

    browser_contract.json("/v1/sessions", sessions)
    page.goto(first.url)
    sidebar = _navigation(page)
    root = sidebar.locator(f'[data-sidebar-session-id="{first.session_id}"]')
    child = sidebar.locator(f'[data-sidebar-session-id="{second.session_id}"]')
    expand = root.get_by_role("button", name="Expand subchats of Chat A", exact=True)
    expect(expand).to_be_visible()
    badges = root.get_by_test_id("session-state-badge")
    expect(badges).to_have_count(2)
    expect(
        root.locator('[data-testid="session-state-badge"][data-state="awaiting"]')
    ).to_have_count(1)
    expect(
        root.locator('[data-testid="session-state-badge"][data-state="running"]')
    ).to_have_count(1)
    expect(root.locator('[data-state="error"]')).to_have_count(0)
    actions = root.get_by_role("button", name="Conversation actions", exact=True)
    expect(actions).to_have_accessible_description(
        re.compile("2 approval prompts waiting.*Session running")
    )
    expect(root).to_have_attribute("data-status-coverage", "partial")
    _capture(page, output_path, "sidebar-collapsed-revealable-rollup")
    expand.click()
    expect(child).to_be_visible()
    expect(badges).to_have_count(0)
    expect(root).not_to_have_attribute("data-status-coverage", "partial")
    expect(child.get_by_test_id("session-state-badge")).to_have_count(2)
    _capture(page, output_path, "sidebar-expanded-own-only")
    root.get_by_role("button", name="Collapse subchats of Chat A", exact=True).click()
    expect(badges).to_have_count(2)

    # A new authorized projection may revoke a member while branch metadata is retained.
    first.update_session(
        activity={
            "own_status": "idle",
            "descendant_running": True,
            "descendants_complete": True,
            "descendants": excluded,
        }
    )
    page.reload()
    sidebar = _navigation(page)
    root = sidebar.locator(f'[data-sidebar-session-id="{first.session_id}"]')
    expect(
        root.get_by_role("button", name="Expand subchats of Chat A", exact=True)
    ).to_be_visible()
    expect(root.get_by_test_id("session-state-badge")).to_have_count(0)
    expect(root).to_have_attribute("data-status-coverage", "partial")
    _capture(page, output_path, "sidebar-revoked-member-not-restored-from-tree")
    _evidence(output_path, "sidebar-projection", first.session_snapshot()["activity"])
    assert browser_errors == []


def _settle_popup(popup: Locator) -> None:
    expect(popup).to_be_visible()
    popup.evaluate("""async element => {
      for (const animation of element.getAnimations({subtree: true})) {
        if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
      }
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }""")


def _popup_gap(popup: Locator, trigger: Any) -> dict:
    _settle_popup(popup)
    geometry = popup.evaluate(
        """(popup, trigger) => {
      const surface = trigger.querySelector('[data-header-action-surface]') || trigger;
      const nearest = trigger.closest('.workbench-app-bar, .workspace-control-header, ' +
        '.chat-header, .composer-shelf-content, .composer-shelf-surface');
      const row = nearest.closest('.composer-shelf-content') || nearest;
      const rect = row.getBoundingClientRect();
      const overlap = Math.min(0, parseFloat(getComputedStyle(row).marginBottom) || 0);
      const bottom = rect.bottom + overlap;
      const paint = surface.getBoundingClientRect(), panel = popup.getBoundingClientRect();
      const side = popup.dataset.side;
      return {side, row:rect.toJSON(), paint:paint.toJSON(), popup:panel.toJSON(),
        inset:side === 'top' ? paint.top - rect.top : bottom - paint.bottom,
        gap:side === 'top' ? rect.top - panel.bottom : panel.top - bottom,
        height:innerHeight, width:innerWidth};
    }""",
        trigger,
    )
    assert geometry["side"] in {"top", "bottom"}, geometry
    assert geometry["inset"] >= -TOLERANCE, geometry
    assert geometry["gap"] == pytest.approx(geometry["inset"], abs=TOLERANCE), geometry
    assert geometry["popup"]["top"] >= -TOLERANCE, geometry
    assert geometry["popup"]["bottom"] <= geometry["height"] + TOLERANCE, geometry
    assert_within_viewport(box(popup), geometry["width"])
    return geometry


def _queue_geometry(chat: Locator) -> dict:
    strip = chat.get_by_test_id("composer-queued-strip")
    rows = strip.get_by_role("listitem")
    expect(rows).to_have_count(2)
    first, second = box(rows.nth(0)), box(rows.nth(1))
    assert first["height"] == pytest.approx(second["height"], abs=TOLERANCE)
    controls = rows.nth(0).get_by_role("button")
    expect(controls).to_have_count(4)
    bounds = [box(control) for control in controls.all()]
    for left, right in pairwise(bounds):
        assert_no_overlap(left, right)
        assert_same_vertical_center(left, right)
    return {
        "row": first,
        "gap": second["y"] - first["y"] - first["height"],
        "controls": bounds,
        "slotHeight": strip.evaluate(
            "el => el.closest('.composer-shelf-presence').getBoundingClientRect().height"
        ),
        "gutter": chat.locator(".chat-composer-form").evaluate("""element =>
          element.getBoundingClientRect().bottom -
          element.querySelector('[data-composer-card]').getBoundingClientRect().bottom"""),
    }


def _seed_agent_popup(journey: WorkspaceJourney, contract: BrowserContract) -> dict:
    first, second = journey.chats
    name = AGENT_NAME
    task = "Inspect narrow resource controls and preserve readable task summaries"
    labels = {"omnigent.subagent.card_summary": task}
    second.update_session(title=name, labels=labels, parent_session_id=first.session_id)
    child = {
        "id": second.session_id,
        "title": name,
        "agent_name": name,
        "tool": None,
        "session_name": name,
        "task_summary": task,
        "busy": True,
        "current_task_status": "in_progress",
        "pending_elicitations_count": 0,
        "last_message_preview": "Reply: Kept on the second line",
        "labels": labels,
    }
    contract.json(
        f"/v1/sessions/{first.session_id}/child_sessions", lambda _request: list_payload([child])
    )
    return child


def _agent_popup_geometry(
    page: Page, journey: WorkspaceJourney, contract: BrowserContract, output_path: str
) -> dict:
    first = journey.chats[0]
    _evidence(output_path, "fixture-progress", {"action": "seed agent popup"})
    child = _seed_agent_popup(journey, contract)
    # Changes detaches this chat; an old mock socket may stay connected until heartbeat.
    before_generation = first.stream.connection_generation
    first.wait_for_stream(timeout=8)
    _evidence(
        output_path,
        "agents-stream-ready",
        {
            "connected": first.stream.connected,
            "beforeGeneration": before_generation,
            "generation": first.stream.connection_generation,
        },
    )
    _evidence(output_path, "fixture-progress", {"action": "emit connected child delta"})
    first.emit(
        {
            "event": "session.child_session.updated",
            "data": {
                "type": "session.child_session.updated",
                "conversation_id": first.session_id,
                "child_session_id": child["id"],
                "child": child,
            },
        }
    )
    name = child["title"]
    trigger = _view(page, "Chat A").get_by_test_id("subagent-task-pill")
    _evidence(output_path, "fixture-progress", {"action": "click Agents trigger"})
    trigger.click()
    popup = page.get_by_role("dialog", name="1 sub-agent: 1 active", exact=True)
    _settle_popup(popup)
    row = popup.locator("[data-resource-row]")
    expect(row).to_have_count(1)
    expect(row.get_by_role("link", name=AGENT_NAME, exact=True)).to_be_visible()
    detail = row.locator(".resource-title-detail")
    description = row.locator(".resource-description")
    expect(description).to_contain_text(child["last_message_preview"])
    geometry = detail.evaluate("""element => {
      const header = element.parentElement, next = header.nextElementSibling;
      const style = getComputedStyle(element);
      const rect = node => node.getBoundingClientRect().toJSON();
      const lines = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects())
          if (rect.width && rect.height) lines.push(Math.round(rect.top));
      }
      return {header:rect(header), task:rect(element), preview:rect(next),
        lineTops:[...new Set(lines)], textOverflow:style.textOverflow,
        whiteSpace:style.whiteSpace, scrollWidth:element.scrollWidth,
        clientWidth:element.clientWidth};
    }""")
    assert len(geometry["lineTops"]) <= 1, geometry
    assert geometry["textOverflow"] == "ellipsis" and geometry["whiteSpace"] == "nowrap"
    assert geometry["scrollWidth"] > geometry["clientWidth"] > 0, geometry
    assert geometry["preview"]["top"] >= geometry["header"]["bottom"] - TOLERANCE, geometry
    assert geometry["preview"]["height"] <= 17, geometry
    expect(row.get_by_role("status", name="Running", exact=True)).to_be_visible()
    expect(row.locator(".resource-status-text")).to_be_hidden()
    bounds = box(row)
    controls = row.locator(".resource-actions").get_by_role("button")
    expect(controls).to_have_count(2)
    control_boxes = [box(control) for control in controls.all()]
    for left, right in pairwise(control_boxes):
        assert_no_overlap(left, right)
    for control in control_boxes:
        assert_no_overlap(geometry["header"], control)
        assert control["x"] + control["width"] <= bounds["x"] + bounds["width"] + TOLERANCE
    _capture(page, output_path, "narrow-agent-popup-single-line-task")
    row.get_by_role("button", name=f"Open chat beside · {name}", exact=True).click()
    expect(popup).to_be_hidden()
    expect(_view(page, name).get_by_label("Message the agent")).to_be_visible()
    page.get_by_role("tab", name="Chat A", exact=True).click()
    return geometry


def test_queue_plan_popup_and_synthetic_safe_top_follow_density(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    appearance: tuple[str, str, str],
    output_path: str,
    browser_errors: list[str],
) -> None:
    first = workspace_journey.chats[0]
    todos = [
        {
            "content": "Active integration task",
            "status": "in_progress",
            "activeForm": "Inspecting",
        },
        {"content": "Pending integration task", "status": "pending", "activeForm": ""},
    ]
    first.update_session(todos=todos)
    # Conversation-list titles outrank child summaries in the canonical presentation cache.
    workspace_journey.chats[1].update_session(title=AGENT_NAME)
    page.goto(first.url)
    first.wait_for_stream()
    chat = _view(page, "Chat A")
    composer = chat.get_by_label("Message the agent", exact=True)
    first.emit_busy("iteration6-queue")
    expect(chat.get_by_role("button", name="Interrupt", exact=True)).to_be_visible()
    for message in ("Iteration 6 queue one", "Iteration 6 queue two"):
        composer.fill(message)
        chat.get_by_role("button", name="Send", exact=True).click()
    composer.fill("Draft retained through plan and resize")
    measurements = {}
    for density in ("comfortable", "compact"):
        page.locator("html").evaluate(
            "(element, value) => element.dataset.listDensity = value", density
        )
        geometry = _queue_geometry(chat)
        measurements[density] = geometry
        expected_action = 44 if appearance[0] == "phone" else 24
        assert geometry["row"]["height"] == pytest.approx(expected_action, abs=TOLERANCE)
        assert geometry["gap"] == pytest.approx(
            4 if density == "comfortable" else 2, abs=TOLERANCE
        )
        for control in geometry["controls"]:
            assert control["height"] == pytest.approx(expected_action, abs=TOLERANCE)
            assert control["width"] == pytest.approx(expected_action, abs=TOLERANCE)
        inset = 4 if density == "comfortable" else 2
        assert geometry["slotHeight"] == pytest.approx(
            expected_action * 2 + geometry["gap"] + 2 * (inset + 1), abs=TOLERANCE
        )
        if appearance[0] == "phone":
            assert geometry["gutter"] == pytest.approx(inset * 2, abs=TOLERANCE)
        _capture(page, output_path, f"queue-{density}")
    page.locator("html").evaluate(
        "(element, value) => element.dataset.listDensity = value", appearance[2]
    )

    shelf = chat.get_by_test_id("composer-attention-shelf")
    plan_trigger = shelf.get_by_role("button", name="Plan: 0 of 2 completed", exact=True)
    trigger_handle = plan_trigger.element_handle()
    assert trigger_handle
    plan_trigger.click()
    plan = page.get_by_role("dialog", name="Plan", exact=True)
    active = plan.get_by_role("listitem").filter(has_text="Active integration task")
    pending = plan.get_by_role("listitem").filter(has_text="Pending integration task")
    active_marker = active.locator('[data-slot="checkbox-visual"]')
    pending_marker = pending.locator('[data-slot="checkbox-visual"]')
    expect(active).to_contain_text("In progress")
    expect(active_marker).to_have_attribute("data-state", "unchecked")
    expect(pending_marker).to_have_attribute("data-state", "unchecked")
    expect(active_marker).to_have_attribute("aria-hidden", "true")
    expect(active_marker.locator("svg, input")).to_have_count(0)
    for property_name in ("width", "height", "border-radius", "background-color"):
        assert active_marker.evaluate(
            "(el, name) => getComputedStyle(el).getPropertyValue(name)", property_name
        ) == pending_marker.evaluate(
            "(el, name) => getComputedStyle(el).getPropertyValue(name)", property_name
        )
    assert active_marker.evaluate(
        "el => getComputedStyle(el).borderColor"
    ) != pending_marker.evaluate("el => getComputedStyle(el).borderColor")
    measurements["planPopup"] = _popup_gap(plan, trigger_handle)
    _capture(page, output_path, "active-plan-unchecked-box")
    page.set_viewport_size({"width": page.viewport_size["width"], "height": 420})
    measurements["resizedShelfPopup"] = _popup_gap(plan, trigger_handle)
    page.set_viewport_size(
        {"width": page.viewport_size["width"], "height": 844 if appearance[0] == "phone" else 1000}
    )
    page.keyboard.press("Escape")

    completed = [{**todo, "status": "completed"} for todo in todos]
    first.update_session(todos=completed)
    first.emit(
        {
            "event": "session.todos",
            "data": {
                "type": "session.todos",
                "conversation_id": first.session_id,
                "todos": completed,
            },
        }
    )
    expect(shelf).to_be_hidden()
    actions = chat.get_by_test_id("header-conversation-actions")
    actions.click()
    page.get_by_role("menuitem", name="Open plan", exact=True).click()
    expect(plan).to_contain_text("Active integration task")
    expect(plan.locator('[data-slot="checkbox-visual"][data-state="checked"]')).to_have_count(2)
    _capture(page, output_path, "settled-plan-manually-opened")
    page.keyboard.press("Escape")

    app = page.get_by_role("banner", name="Application")
    open_button = app.get_by_role("button", name="Open view", exact=True)
    open_handle = open_button.element_handle()
    assert open_handle
    if appearance[0] == "phone":
        open_bounds = box(open_button)
        assert open_bounds["width"] == pytest.approx(28, abs=TOLERANCE)
        assert open_bounds["height"] == pytest.approx(28, abs=TOLERANCE)
        hit = open_button.evaluate("""element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element, '::after');
          return {x:rect.left + parseFloat(style.left), y:rect.top + parseFloat(style.top),
            width:rect.width - parseFloat(style.left) - parseFloat(style.right),
            height:rect.height - parseFloat(style.top) - parseFloat(style.bottom)};
        }""")
        assert hit["width"] > open_bounds["width"]
        assert_no_overlap(hit, box(app.locator("[data-workbench-search]")))
        assert_no_overlap(hit, box(app.locator("[data-notification-bell]")))
        assert hit["y"] >= box(app)["y"]
        assert hit["y"] + hit["height"] <= box(app)["y"] + box(app)["height"]
        measurements["mobileOpen"] = {"face": open_bounds, "hit": hit}
        page.touchscreen.tap(open_bounds["x"] - 1, open_bounds["y"] + open_bounds["height"] / 2)
    else:
        open_button.click()
    menu = page.locator('[data-slot="dropdown-menu-content"][data-state="open"]')
    measurements["headerPopup"] = _popup_gap(menu, open_handle)
    page.set_viewport_size({"width": page.viewport_size["width"], "height": 560})
    measurements["resizedHeaderPopup"] = _popup_gap(menu, open_handle)
    _capture(page, output_path, "header-popup-resize-collision")
    _evidence(output_path, "fixture-progress", {"action": "select Changes in resized Open menu"})
    menu.get_by_role("menuitem", name="Changes", exact=True).click()
    _evidence(output_path, "fixture-progress", {"action": "return to Chat A tab"})
    page.get_by_role("tab", name="Chat A", exact=True).click()
    page.set_viewport_size(
        {
            "width": 390 if appearance[0] == "phone" else 1440,
            "height": 844 if appearance[0] == "phone" else 1000,
        }
    )
    expect(composer).to_have_value("Draft retained through plan and resize")

    if appearance[0] == "phone":
        # Emulate the wrapper-owned inset in CSS, without claiming a native-shell run.
        page.locator(".unified-workbench").evaluate("""element => {
          element.dataset.iosNative = 'true';
          element.style.setProperty('--omnigent-safe-top', '24px');
        }""")
        assert box(app)["y"] == pytest.approx(24, abs=TOLERANCE)
        assert box(app)["height"] == pytest.approx(36, abs=TOLERANCE)
        pixels = Image.open(io.BytesIO(page.screenshot(animations="disabled"))).convert("RGB")
        inset_pixel, appbar_pixel = pixels.getpixel((2, 12)), pixels.getpixel((2, 30))
        assert inset_pixel == appbar_pixel, (inset_pixel, appbar_pixel)
        content_pixel = page.locator(".unified-workbench").evaluate("""element => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        }""")
        assert inset_pixel != tuple(content_pixel), (inset_pixel, content_pixel)
        measurements["syntheticSafeTop"] = {
            "inset": 24,
            "insetPixel": inset_pixel,
            "appbarPixel": appbar_pixel,
        }
        _capture(page, output_path, "synthetic-native-safe-top-paint")
    measurements["agents"] = _agent_popup_geometry(
        page, workspace_journey, browser_contract, output_path
    )
    expect(composer).to_have_value("Draft retained through plan and resize")
    _evidence(output_path, "density-plan-popup-geometry", measurements)
    assert browser_errors == []


def _gallery_state(stage: Locator) -> dict:
    return stage.evaluate("""element => {
      const image = element.querySelector('img');
      const matrix = new DOMMatrixReadOnly(getComputedStyle(image).transform);
      return {zoom:matrix.a, x:matrix.e, y:matrix.f,
        maxX:Math.max(0, (image.offsetWidth * matrix.a - element.clientWidth) / 2),
        maxY:Math.max(0, (image.offsetHeight * matrix.a - element.clientHeight) / 2)};
    }""")


def _assert_gallery_bounds(stage: Locator) -> dict:
    state = _gallery_state(stage)
    assert abs(state["x"]) <= state["maxX"] + TOLERANCE, state
    assert abs(state["y"]) <= state["maxY"] + TOLERANCE, state
    return state


def test_gallery_native_pinch_pan_and_fit_navigation(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    appearance: tuple[str, str, str],
    output_path: str,
    browser_errors: list[str],
) -> None:
    first = workspace_journey.chats[0]
    attachment = message_item(
        "iteration6-images", "user", "Two captured gallery images", response_id="iteration6-images"
    )
    originals = {}
    for name, width, height in (("portrait", 100, 1000), ("tiny", 1, 1)):
        buffer = io.BytesIO()
        Image.new("RGB", (width, height), (104, 81, 139)).save(buffer, format="PNG")
        png = buffer.getvalue()
        originals[name] = png
        resource = f"/v1/sessions/{first.session_id}/resources/files/{name}"
        browser_contract.json(
            resource,
            {"name": f"{name}.png", "metadata": {"bytes": len(png), "content_type": "image/png"}},
        )
        browser_contract.route(
            browser_contract._matcher(resource + "/content"),
            lambda route, _request, content=png: route.fulfill(
                body=content, content_type="image/png"
            ),
        )
        attachment["content"].append(
            {"type": "input_image", "file_id": name, "filename": f"{name}.png"}
        )
    first.set_items([attachment])
    page.goto(first.url)
    chat = _view(page, "Chat A")
    transcript = chat.locator('[role="log"] > div').first.element_handle()
    assert transcript
    scroll_before = transcript.evaluate("element => element.scrollTop")
    chat.get_by_role("button", name="Zoom image: portrait.png", exact=True).click()
    gallery = page.get_by_role("dialog")
    stage = gallery.get_by_test_id("lightbox-stage")
    expect(stage.get_by_role("img", name="portrait.png", exact=True)).to_have_js_property(
        "naturalHeight", 1000
    )
    expect(gallery.get_by_text("1 / 2", exact=True)).to_be_visible()
    initial_stage = box(stage)
    controls = gallery.get_by_role("button", name="Close", exact=True)
    reset = gallery.get_by_role("button", name="Reset zoom", exact=True)
    measurements: dict[str, Any] = {"fit": _assert_gallery_bounds(stage)}

    if appearance[0] == "phone":
        page.evaluate("""() => {
          window.__iteration6Touches = [];
          const types = ['pointerdown', 'pointermove', 'pointerup',
            'pointercancel', 'lostpointercapture'];
          for (const type of types)
            document.addEventListener(type, event => {
              if (event.target instanceof Element &&
                event.target.closest('[data-testid="lightbox-stage"]'))
                window.__iteration6Touches.push({type, id:event.pointerId,
                  primary:event.isPrimary, pointerType:event.pointerType,
                  x:event.clientX, y:event.clientY});
            }, true);
        }""")
        cdp = page.context.new_cdp_session(page)
        cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 2})
        cx = round(initial_stage["x"] + initial_stage["width"] / 2)
        cy = round(initial_stage["y"] + initial_stage["height"] / 2)

        def touch(kind: str, *points: tuple[int, int, int]) -> None:
            cdp.send(
                "Input.dispatchTouchEvent",
                {
                    "type": kind,
                    "touchPoints": [
                        {"id": identity, "x": x, "y": y, "radiusX": 2, "radiusY": 2, "force": 1}
                        for identity, x, y in points
                    ],
                },
            )
            page.evaluate("() => new Promise(requestAnimationFrame)")

        def swipe(dx: int, dy: int = 0) -> None:
            touch("touchStart", (1, cx, cy))
            touch("touchMove", (1, cx + dx // 2, cy + dy // 2))
            touch("touchMove", (1, cx + dx, cy + dy))
            touch("touchEnd")

        try:
            touch("touchStart", (1, cx - 40, cy))
            touch("touchStart", (1, cx - 40, cy), (2, cx + 40, cy))
            touch("touchMove", (1, cx - 80, cy), (2, cx + 80, cy))
            expect(reset).to_have_text("200%")
            pinched = _assert_gallery_bounds(stage)
            assert pinched["zoom"] == pytest.approx(2, abs=0.01)
            touch("touchEnd")
            # Survivor continuity stays in component pointer-up tests; use a fresh native drag.
            touch("touchStart", (1, cx, cy))
            touch("touchMove", (1, cx, cy + 40))
            continued = _assert_gallery_bounds(stage)
            _evidence(
                output_path,
                "gallery-native-fresh-pan",
                {
                    "pinched": pinched,
                    "continued": continued,
                    "nativePartialLiftProof": False,
                    "events": page.evaluate("window.__iteration6Touches"),
                },
            )
            assert continued["y"] - pinched["y"] == pytest.approx(40, abs=TOLERANCE)
            touch("touchEnd")
            # Reach a real pan bound using a captured contact, then reverse immediately.
            touch("touchStart", (1, cx, cy - 120))
            touch("touchMove", (1, cx, cy + 320))
            at_edge = _assert_gallery_bounds(stage)
            assert at_edge["y"] == pytest.approx(at_edge["maxY"], abs=TOLERANCE)
            touch("touchMove", (1, cx, cy + 310))
            reversed_pan = _assert_gallery_bounds(stage)
            assert reversed_pan["y"] == pytest.approx(at_edge["y"] - 10, abs=TOLERANCE)
            touch("touchEnd")
            expect(gallery.get_by_text("1 / 2", exact=True)).to_be_visible()
            swipe(-120)
            expect(gallery.get_by_text("1 / 2", exact=True)).to_be_visible()
            expect(controls).to_be_visible()
            measurements["pinch"] = pinched
            measurements["freshSingleTouchPan"] = continued
            measurements["nativePartialLiftProof"] = False
            measurements["reversedPan"] = reversed_pan
            _capture(page, output_path, "gallery-native-pinch-and-pan")

            reset.click()
            touch("touchStart", (1, cx - 40, cy))
            touch("touchStart", (1, cx - 40, cy), (2, cx + 40, cy))
            touch("touchCancel")
            expect(controls).to_be_visible()
            touch("touchStart", (1, cx, cy))
            touch("touchEnd")
            expect(controls).to_have_count(0)
            gallery.press("Tab")
            expect(controls).to_be_visible()

            for dx, counter in ((-120, "2 / 2"), (-120, "2 / 2"), (120, "1 / 2")):
                swipe(dx)
                expect(gallery.get_by_text(counter, exact=True)).to_be_visible()
                expect(reset).to_have_text("100%")
                expect(controls).to_be_visible()
                assert box(stage) == pytest.approx(initial_stage, abs=TOLERANCE)
                roll = gallery.get_by_role("group", name="Chat images", exact=True)
                selected = roll.locator('[aria-current="true"]')
                expect(selected).to_be_visible()
                page.wait_for_function(
                    """element => {
                  const selected = element.querySelector('[aria-current="true"]')
                    .getBoundingClientRect();
                  const frame = element.getBoundingClientRect();
                  const delta = selected.x + selected.width / 2 - frame.x - frame.width / 2;
                  return Math.abs(delta) <= 1;
                }""",
                    arg=roll.element_handle(),
                )

            touch("touchStart", (1, cx, cy))
            page.set_viewport_size({"width": 390, "height": 740})
            touch("touchEnd")
            expect(gallery.get_by_text("1 / 2", exact=True)).to_be_visible()
            measurements["resized"] = _assert_gallery_bounds(stage)
            page.set_viewport_size({"width": 390, "height": 844})
            events = page.evaluate("window.__iteration6Touches")
            assert any(
                event["pointerType"] == "touch" and not event["primary"] for event in events
            )
            assert any(event["type"] == "pointerup" and event["primary"] for event in events)
            assert any(event["type"] == "pointercancel" for event in events)
            measurements["nativePointerEvents"] = events
            _capture(page, output_path, "gallery-fit-swipe-endpoints")
            assert transcript.evaluate("element => element.scrollTop") == scroll_before
            with page.expect_download() as download:
                gallery.get_by_role("button", name="Download image", exact=True).click()
            assert Path(download.value.path()).read_bytes() == originals["portrait"]
            swipe(0, 120)
            expect(gallery).to_be_hidden()
        finally:
            _evidence(
                output_path,
                "gallery-native-pointer-events",
                page.evaluate("window.__iteration6Touches"),
            )
            cdp.detach()
    else:
        stage.hover()
        page.mouse.wheel(0, -240)
        expect(reset).not_to_have_text("100%")
        measurements["desktopWheel"] = _assert_gallery_bounds(stage)
        reset.click()
        gallery.get_by_role("button", name="Next image", exact=True).click()
        expect(gallery.get_by_text("2 / 2", exact=True)).to_be_visible()
        expect(reset).to_have_text("100%")
        expect(gallery.get_by_role("button", name="Next image", exact=True)).to_be_disabled()
        _capture(page, output_path, "gallery-desktop-next-image")
        controls.click()
        expect(gallery).to_be_hidden()
    _evidence(output_path, "gallery-gesture-state", measurements)
    assert browser_errors == []
