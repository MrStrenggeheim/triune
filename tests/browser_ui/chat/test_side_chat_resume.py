"""Browser-contract proof for side-chat sending and Resume flows."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Page, Route, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item
from tests.browser_ui.chat.test_bottom_spacing23 import record_tail_geometry
from tests.browser_ui.chat.test_unified_workspace import WorkspaceJourney
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey


def test_runnerless_side_chat_sends_from_its_direct_url(
    page: Page,
    chat_session_contract: ChatSessionContract,
) -> None:
    """Chat-only side-chat ancestry does not require a coding workspace."""
    chat = chat_session_contract
    source_id = "browser-side-parent"
    chat.update_session(
        host_id=None,
        runner_id=None,
        workspace=None,
        runner_online=True,
        host_online=False,
        labels={"omnigent.side_chat": "1", "omnigent.side_chat.source_id": source_id},
    )
    chat.set_health(runner_online=True, host_online=False)
    source = {**chat._session(), "id": source_id, "labels": {}}
    chat.contract.json(f"/v1/sessions/{source_id}", source)

    page.goto(chat.url)
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible()
    prompt = "Continue this side chat without a workspace."
    composer.fill(prompt)
    page.get_by_role("button", name="Send", exact=True).click()

    expect(composer).to_have_value("")
    expect(page.get_by_role("dialog")).to_have_count(0)
    assert len(chat.event_posts) == 1
    event = chat.event_posts[0]["body"]
    assert event["type"] == "message"
    assert event["data"]["content"] == [{"type": "input_text", "text": prompt}]
    assert chat.session_patches == []


def test_side_chat_resume_conflict_refetches_metadata_and_seals_pane(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
) -> None:
    """A failed side-chat resume becomes read-only without reloading the app."""
    chat, side_chat = workspace_journey.chats
    artifacts = Path(output_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    child_id = side_chat.session_id
    child_path = f"/v1/sessions/{child_id}"
    child_gets: list[dict[str, Any]] = []
    retry_posts: list[dict[str, Any]] = []
    stop_posts: list[dict[str, Any]] = []
    child_closed = False

    chat.update_session(harness="openai-agents")
    peer = message_item("peer-child", "user", "Follow up with the side chat.", response_id="peer")
    peer["communication"] = {
        "kind": "peer",
        "message_id": "peer-child",
        "source_conversation_id": chat.session_id,
        "destination_conversation_id": child_id,
        "delivery_state": "confirmed",
    }
    chat.set_items(
        [
            peer,
            {
                "id": "parent-history",
                "response_id": "parent-response",
                "type": "message",
                "role": "user",
                "status": "completed",
                "content": [{"type": "input_text", "text": "Parent remains usable."}],
            },
        ]
    )
    side_chat.update_session(title="Follow-up side chat", status="failed")
    child_items = [
        {
            "id": "child-history",
            "response_id": "child-response",
            "type": "message",
            "role": "user",
            "status": "completed",
            "content": [
                {"type": "input_text", "text": "Side-chat history that must remain visible."}
            ],
        },
        {
            "id": "child-error",
            "response_id": "child-response",
            "type": "error",
            "status": "completed",
            "source": "execution",
            "code": "required_terminal_exited",
            "message": "The side-chat runner exited before it could resume.",
        },
    ]

    side_chat.set_items(child_items)
    contract = chat.contract
    base = re.escape(chat.base_url)
    child_session_pattern = re.compile(rf"^{base}{re.escape(child_path)}(?:\?.*)?$")

    def get_child_session(route: Route) -> None:
        if route.request.method != "GET":
            route.fallback()
            return
        snapshot = side_chat.session_snapshot()
        snapshot["labels"] = {
            "omnigent.side_chat": "1",
            "omnigent.side_chat.source_id": chat.session_id,
        }
        if child_closed:
            snapshot["labels"]["omnigent.closed"] = "true"
        child_gets.append({"labels": dict(snapshot["labels"])})
        route.fulfill(status=200, content_type="application/json", body=json.dumps(snapshot))

    contract.route(child_session_pattern, get_child_session)

    def retry_child(route: Route) -> None:
        nonlocal child_closed
        if route.request.method != "POST":
            route.fallback()
            return
        body = json.loads(route.request.post_data or "{}")
        if body == {"type": "stop_session", "data": {}}:
            stop_posts.append(body)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"queued": False}),
            )
            return
        retry_posts.append(body)
        assert body == {"type": "retry_session", "data": {}}
        child_closed = True
        route.fulfill(
            status=409,
            content_type="application/json",
            body=json.dumps(
                {"error": {"code": "conflict", "message": "This side chat has ended."}}
            ),
        )

    contract.route(re.compile(rf"^{base}{re.escape(child_path)}/events$"), retry_child)

    page.goto(chat.url)
    page.get_by_test_id("peer-message").get_by_role(
        "link", name="Follow-up side chat", exact=True
    ).click()
    parent = page.locator(f'[data-dock-view="conversation:{chat.session_id}"]')
    child = page.locator(f'[data-dock-view="conversation:{child_id}"]')
    expect(parent).to_be_visible()
    expect(child).to_be_visible()
    expect(
        child.get_by_text("Side-chat history that must remain visible.", exact=True)
    ).to_be_visible(timeout=20_000)
    resume = page.get_by_role("button", name="Resume session", exact=True)
    expect(resume).to_be_visible(timeout=10_000)
    expect(page.get_by_text("Parent remains usable.")).to_be_visible()
    before_spacing = record_tail_geometry(page, scope=child)
    (artifacts / "side-before-geometry.json").write_text(json.dumps(before_spacing, indent=2))
    page.screenshot(path=str(artifacts / "side-chat-before.png"), full_page=True)
    metadata_gets_before = len(child_gets)

    resume.click()

    expect(child.get_by_placeholder("This sub-agent session is closed")).to_be_disabled(
        timeout=10_000
    )
    expect(resume).to_have_count(0)
    expect(
        child.get_by_text("Side-chat history that must remain visible.", exact=True)
    ).to_be_visible()
    expect(page.get_by_text("Parent remains usable.")).to_be_visible()
    parent_composer = parent.get_by_label("Message the agent")
    expect(parent_composer).to_be_enabled()
    parent_composer.fill("Parent composer remains editable.")
    expect(parent_composer).to_have_value("Parent composer remains editable.")
    parent_composer.fill("")
    assert retry_posts == [{"type": "retry_session", "data": {}}]
    assert len(child_gets) > metadata_gets_before
    assert child_gets[-1]["labels"]["omnigent.closed"] == "true"
    after_spacing = record_tail_geometry(page, scope=child)
    (artifacts / "side-after-geometry.json").write_text(json.dumps(after_spacing, indent=2))
    for geometry in (before_spacing, after_spacing):
        assert geometry["viewportGap"] == pytest.approx(geometry["padding"], abs=2), geometry
    page.screenshot(path=str(artifacts / "side-chat-after.png"), full_page=True)
