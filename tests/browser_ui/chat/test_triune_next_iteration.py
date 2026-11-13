# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Shared controls and retained resources for the next Triune iteration."""

import json
from contextlib import ExitStack, contextmanager
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import chat_session_handle, list_payload, message_item
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


def test_fifty_layouts_retire_while_preserving_draft_and_editor_undo(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    """Real SPA layout retirement preserves saved membership and protected editor models."""
    journey = workspace_journey
    first = journey.chats[0]
    with ExitStack() as stack:
        for index in range(2, 50):
            chat = stack.enter_context(
                contextmanager(chat_session_handle)(
                    page, browser_contract, session_id=f"retire-{index}"
                )
            )
            chat.update_session(title=f"Cold layout {index}", workspace="/workspace")
            chat.set_items(
                [
                    message_item(
                        f"retire-answer-{index}",
                        "assistant",
                        f"Answer in layout {index}",
                        response_id=f"retire-turn-{index}",
                    )
                ]
            )
            for endpoint in ("peer-messages", "branches"):
                browser_contract.json(
                    f"/v1/sessions/{chat.session_id}/{endpoint}", list_payload([])
                )
            browser_contract.json(f"/v1/sessions/{chat.session_id}/comments", [])
            journey.chats.append(chat)
        browser_contract.json("/v1/workbench-workspaces/resolve", journey.workspace, method="POST")
        browser_contract.json(
            "/v1/sessions",
            lambda _: list_payload([chat.session_snapshot() for chat in journey.chats]),
        )
        browser_contract.json(
            "/health",
            {
                "sessions": {
                    chat.session_id: {"runner_online": True, "host_online": True}
                    for chat in journey.chats
                }
            },
        )
        page.set_viewport_size({"width": 1440, "height": 1000})
        page.goto(first.url)
        _view(page, "Chat A").get_by_label("Message the agent").fill(
            "Draft retained after fifty layouts"
        )
        _open(page, "Explorer")
        _view(page, "Explorer").get_by_role("button", name="notes.py", exact=True).click()
        editor = _view(page, "notes.py")
        edit = editor.locator(".monaco-editor").first
        expect(edit).to_be_visible(timeout=30_000)
        journey.reject_writes = True
        edit.click()
        page.keyboard.press("Control+End")
        page.keyboard.press("End")
        page.keyboard.press("Enter")
        page.keyboard.insert_text("retained_delta = 42")
        editor.evaluate("el => { window.__protectedRetiredEditor = el; }")
        observations = []
        for index, chat in enumerate(journey.chats[1:], 1):
            _navigate_chat(page, chat)
            count = page.locator("[data-dock-view]").count()
            observations.append({"visited": index + 1, "mounted": count})
            if index >= 3:
                assert count <= 4, observations
        final = journey.chats[-1]
        final.wait_for_stream()
        live = message_item(
            "retirement-live",
            "assistant",
            "RETIREMENT_LIVE_UPDATE",
            response_id="live-after-fifty",
        )
        final.emit({"event": "response.output_item.done", "data": {"item": live}})
        expect(
            _view(page, final.session_snapshot()["title"]).get_by_text(
                "RETIREMENT_LIVE_UPDATE", exact=True
            )
        ).to_be_visible()
        assert len(_saved_dock(page)["chats"]) >= 50
        expect(page.get_by_text("Conversation stream capacity", exact=True)).to_have_count(0)
        _navigate_chat(page, first)
        page.get_by_role("tab", name="Chat A", exact=True).click()
        expect(_view(page, "Chat A").get_by_label("Message the agent")).to_have_value(
            "Draft retained after fifty layouts"
        )
        expect(editor).to_be_visible()
        assert editor.evaluate("el => el === window.__protectedRetiredEditor")
        expect(editor.locator(".view-line").filter(has_text="retained_delta = 42")).to_be_visible()
        edit.click()
        page.keyboard.press("Control+z")
        # Monaco may create semantic undo stops within one text insertion.
        expect(editor.locator(".view-line").filter(has_text="retained_delta = 42")).to_have_count(
            0
        )
        assert "retained_delta" not in journey.files["notes.py"]
        Path(output_path).mkdir(parents=True, exist_ok=True)
        (Path(output_path) / "fifty-layout-observations.json").write_text(
            json.dumps(observations, indent=2)
        )
        _capture(page, output_path, "fifty-layouts-draft-and-undo")
        assert browser_errors == []


@pytest.mark.parametrize("width", [390, 1440], ids=["phone", "desktop"])
def test_original_composer_shelf_requests_and_counts(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
    width: int,
) -> None:
    """Existing forms sit above the composer without overflow or moving its controls."""
    first = workspace_journey.chats[0]
    first.update_session(
        todos=[{"content": "Verify native controls", "status": "in_progress", "activeForm": ""}],
        background_task_count=1,
        background_tasks=[
            {
                "id": "shell",
                "type": "shell",
                "description": "Focused checks",
                "command": "pnpm test",
                "status": "running",
            }
        ],
    )
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/child_sessions",
        {
            "data": [
                {
                    "id": "helper",
                    "title": "Hilbert",
                    "session_name": "Hilbert",
                    "task_summary": "Inspect child controls",
                    "busy": True,
                    "current_task_status": "in_progress",
                    "pending_elicitations_count": 0,
                    "labels": {},
                }
            ]
        },
    )
    page.set_viewport_size({"width": width, "height": 1000 if width > 500 else 844})
    page.goto(first.url)
    editor = _view(page, "Chat A").get_by_label("Message the agent")
    editor.fill("Keep this draft")
    first.wait_for_stream()
    for key, extra in [
        (
            "question",
            {
                "ask_user_question": {
                    "questions": [
                        {
                            "id": "coverage",
                            "question": "Which checks should run?",
                            "options": [{"label": "Focused", "description": "Changed controls"}],
                            "multiSelect": False,
                        }
                    ]
                }
            },
        ),
        ("permission", {}),
    ]:
        first.emit(
            {
                "event": "response.elicitation_request",
                "data": {
                    "type": "response.elicitation_request",
                    "elicitation_id": key,
                    "params": {
                        "mode": "form",
                        "message": "Allow focused checks",
                        "phase": "tool_call",
                        "policy_name": "native",
                        "requestedSchema": {},
                        **extra,
                    },
                },
            }
        )
    shelf = page.get_by_test_id("composer-attention-shelf")
    expect(shelf.get_by_role("button", name="Questions: 1", exact=True)).to_be_visible()
    expect(shelf.get_by_role("button", name="Approvals: 1", exact=True)).to_be_visible()
    expect(shelf.get_by_test_id("background-task-pill")).to_contain_text("1")
    expect(shelf.get_by_test_id("subagent-task-pill")).to_contain_text("1")
    expect(shelf.get_by_role("button", name="Plan: 0 of 1 completed", exact=True)).to_be_visible()
    assert shelf.locator(".lucide-chevron-down").count() == 0
    assert shelf.evaluate("el => el.scrollWidth <= el.clientWidth + 1")
    shelf.get_by_role("button", name="Questions: 1", exact=True).click()
    expect(page.get_by_test_id("ask-user-question-form")).to_contain_text(
        "Which checks should run?"
    )
    _capture(page, output_path, f"shelf-question-{width}")
    page.keyboard.press("Escape")
    expect(editor).to_have_value("Keep this draft")
    shelf.get_by_role("button", name="Plan: 0 of 1 completed", exact=True).click()
    expect(page.get_by_text("Verify native controls", exact=True)).to_be_visible()
    _capture(page, output_path, f"shelf-plan-{width}")
    assert browser_errors == []


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
