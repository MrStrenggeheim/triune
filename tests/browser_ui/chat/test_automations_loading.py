# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Automations loading and resident state through the built SPA."""

import json
import re
from pathlib import Path

import pytest
from playwright.sync_api import Page, Route, expect

from tests._helpers.picker_routes import OWN_AGENTS
from tests.browser_ui.chat.session_contract import list_payload
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _open,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract

TASK_CHUNK = re.compile(r"/(?:assets/TasksPage-[^/]+\.js|src/pages/TasksPage\.tsx)(?:\?.*)?$")


@pytest.fixture
def automations_contract(
    workspace_journey: WorkspaceJourney, browser_contract: BrowserContract
) -> WorkspaceJourney:
    browser_contract.json(
        "/v1/scheduled-tasks",
        {
            "scheduled_tasks": [
                {
                    "id": f"task-{state}",
                    "name": f"{state.title()} triage",
                    "prompt": "Review the queue",
                    "rrule": "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
                    "agent_id": workspace_journey.chats[0].agent_id,
                    "timezone": "UTC",
                    "state": state,
                    "execution_target": "connected_host",
                    "created_at": 1,
                    "updated_at": 2,
                    **dict.fromkeys(
                        (
                            "owner_user_id",
                            "model_override",
                            "reasoning_effort",
                            "permission_mode",
                            "workspace",
                            "host_id",
                            "last_run_at",
                            "last_run_status",
                            "last_run_conversation_id",
                            "next_run_at",
                        )
                    ),
                }
                for state in ("active", "paused")
            ]
        },
    )
    browser_contract.json(OWN_AGENTS, list_payload([]))
    return workspace_journey


@pytest.mark.parametrize("width", [1440, 390])
@pytest.mark.parametrize("entry", ["dock", "route"])
def test_automations_load_only_on_first_use(
    page: Page,
    automations_contract: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
    entry: str,
    width: int,
) -> None:
    page.set_default_timeout(5_000)
    page.set_viewport_size({"width": width, "height": 900})
    requests: list[str] = []
    page.on("request", lambda request: requests.append(request.url))
    page.goto(automations_contract.chats[0].url)
    expect(_view(page, "Chat A")).to_be_visible()
    assert not [url for url in requests if TASK_CHUNK.search(url)]
    assert not [url for url in requests if "/v1/scheduled-tasks" in url]

    held: list[Route] = []
    page.route(TASK_CHUNK, lambda route: held.append(route))
    try:
        with page.expect_request(TASK_CHUNK):
            if entry == "dock":
                _open(page, "Automations")
                expect(page.get_by_role("banner", name="Application")).to_be_visible()
                expect(_view(page, "Automations").get_by_role("status")).to_contain_text("Loading")
            else:
                page.goto(f"{browser_contract.base_url}/tasks", wait_until="commit")
                expect(page.get_by_role("status")).to_contain_text("Loading")
        expect(page.get_by_role("status").filter(has_text="Loading")).to_contain_text("Loading")
        assert len(held) == 1
        page.screenshot(path=str(Path(output_path) / f"{entry}-{width}-loading.png"))
    finally:
        for route in held:
            route.continue_()
        page.unroute(TASK_CHUNK)
    expect(page.get_by_test_id("tasks-search")).to_be_visible()
    expect(page.get_by_test_id("scheduled-task-row")).to_have_count(2)
    expect(page.get_by_test_id("task-schedule-line").first).to_contain_text("8:00 AM")
    page.screenshot(path=str(Path(output_path) / f"{entry}-{width}-loaded.png"))
    assert browser_errors == []


@pytest.mark.parametrize("width", [1440, 390])
def test_docked_automations_retain_search_filter_and_edit_dialog(
    page: Page,
    automations_contract: WorkspaceJourney,
    browser_errors: list[str],
    width: int,
) -> None:
    page.set_default_timeout(5_000)
    page.set_viewport_size({"width": width, "height": 900})
    first, second = automations_contract.chats
    page.goto(first.url)
    _open(page, "Automations")
    search = page.get_by_test_id("tasks-search")
    search.fill("triage")
    page.get_by_test_id("tasks-filter-paused").click()
    original_search = search.element_handle()
    for chat in (second, first):
        if page.get_by_role("button", name="Open navigation", exact=True).is_visible():
            page.get_by_role("button", name="Open navigation", exact=True).click()
        page.locator(f'aside [data-sidebar-session-id="{chat.session_id}"]').click()
        expect(page).to_have_url(chat.url)
    expect(search).to_have_value("triage")
    expect(page.get_by_test_id("tasks-filter-paused")).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_test_id("scheduled-task-row")).to_have_count(1)
    assert search.evaluate("(node, original) => node === original", original_search)
    page.get_by_test_id("task-row-menu").click()
    page.get_by_test_id("task-edit").click()
    name = page.get_by_test_id("task-name-input")
    expect(name).to_have_value("Paused triage")
    name.fill("Unsaved resident edit")
    original_name = name.element_handle()
    page.go_back()
    expect(page).to_have_url(second.url)
    page.go_forward()
    expect(page).to_have_url(first.url)
    expect(name).to_have_value("Unsaved resident edit")
    assert name.evaluate("(node, original) => node === original", original_name)
    page.get_by_role("button", name="Cancel", exact=True).click()
    expect(search).to_have_value("triage")
    expect(page.get_by_test_id("tasks-filter-paused")).to_have_attribute("aria-pressed", "true")
    assert browser_errors == []


def test_failed_docked_automations_import_retains_dirty_editor_and_composer(
    page: Page,
    automations_contract: WorkspaceJourney,
    output_path: str,
) -> None:
    page.set_default_timeout(5_000)
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(automations_contract.chats[0].url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    composer.fill("Draft stays mounted on failed import")
    composer_node = composer.element_handle()
    _open(page, "Explorer")
    _view(page, "Explorer").get_by_text("notes.py", exact=True).click()
    preview = _view(page, "notes.py")
    editor = preview.locator(".monaco-editor").first
    expect(editor.locator(".view-lines")).to_contain_text("selection_target", timeout=15_000)
    automations_contract.reject_writes = True
    original_content = automations_contract.files["notes.py"]
    editor.click()
    page.keyboard.press("Control+End")
    with page.expect_response(
        lambda response: (
            response.request.method == "PUT" and "/filesystem/notes.py" in response.url
        )
    ) as write:
        page.keyboard.insert_text("\n# sole-copy edit survives failed import")
    assert write.value.status == 503
    editor_node = editor.element_handle()
    documents: list[str] = []
    failures: list[str] = []
    page.on(
        "request",
        lambda request: documents.append(request.url) if request.is_navigation_request() else None,
    )
    page.on("pageerror", lambda error: failures.append(str(error)))
    page.route(TASK_CHUNK, lambda route: route.abort("failed"))
    _open(page, "Automations")
    failed = _view(page, "Automations")
    expect(failed.get_by_role("alert")).to_contain_text("Unable to load this page")
    expect(failed.get_by_role("button", name="Refresh page", exact=True)).to_be_visible()
    assert documents == []
    assert page.evaluate("sessionStorage.getItem('omnigent:chunk-reload-at')") is None
    assert composer_node.evaluate("node => node.isConnected")
    assert editor_node.evaluate("node => node.isConnected")
    assert composer_node.evaluate("node => node.value") == "Draft stays mounted on failed import"
    page.screenshot(path=str(Path(output_path) / "failed-local-import.png"))
    page.get_by_role("tab", name="notes.py", exact=True).click()
    expect(editor.locator(".view-lines")).to_contain_text("sole-copy edit survives failed import")
    page.screenshot(path=str(Path(output_path) / "retained-dirty-editor.png"))
    assert automations_contract.files["notes.py"] == original_content
    assert documents == []
    (Path(output_path) / "retained-state.json").write_text(
        json.dumps(
            {
                "automaticDocuments": documents,
                "composerConnected": composer_node.evaluate("node => node.isConnected"),
                "composerValue": composer_node.evaluate("node => node.value"),
                "editorConnected": editor_node.evaluate("node => node.isConnected"),
                "editorText": editor.locator(".view-lines").text_content(),
                "serverFile": automations_contract.files["notes.py"],
            },
            indent=2,
        )
    )
    page.get_by_role("tab", name="Automations", exact=True).click()
    page.unroute(TASK_CHUNK)
    page.once("dialog", lambda dialog: dialog.accept())
    failed.get_by_role("button", name="Refresh page", exact=True).click()
    expect(page.get_by_test_id("tasks-search")).to_be_visible()
    assert len(documents) == 1
    assert all("Failed to fetch dynamically imported module" in error for error in failures), (
        failures
    )
