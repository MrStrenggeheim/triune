"""Exercise the Stop command through the built chat UI and isolated session transport."""

import re

import pytest
from playwright.sync_api import Page, Route, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item


@pytest.mark.parametrize("width", [1280, 390], ids=["desktop", "phone"])
@pytest.mark.parametrize(
    ("outcome", "next_turn"),
    [
        ("accepted", None),
        ("already_ended", None),
        ("interrupted", None),
        ("superseded", "codex_successor"),
        (None, "codex_successor"),
        (None, "codex_original"),
        ("superseded", "codex_streamed"),
    ],
)
def test_stop_preserves_draft_and_observed_turn(
    page: Page,
    chat_session_contract: ChatSessionContract,
    width: int,
    outcome: str | None,
    next_turn: str | None,
) -> None:
    chat = chat_session_contract
    chat.harness = "codex-native"
    target = "codex_original"
    draft = "Keep this unsent follow-up"
    chat.update_session(status="running", active_response_id=target)
    page.set_viewport_size({"width": width, "height": 844})
    page.goto(chat.url)
    chat.wait_for_stream()
    composer = page.get_by_label("Message the agent")
    stop = page.get_by_role("button", name="Interrupt", exact=True)
    expect(stop).to_be_enabled(timeout=20_000)
    url = f"{chat.base_url}/v1/sessions/{chat.session_id}"
    sent = []
    refreshes = []

    pending: list[Route] = []

    def reply(route: Route) -> None:
        sent.append(route.request.post_data_json)
        assert route.request.headers.get("idempotency-key")
        if len(sent) == 1:
            pending.append(route)
        else:
            route.fulfill(
                status=202,
                json={
                    "queued": False,
                    "response_id": sent[-1]["data"]["response_id"],
                    "interrupt_outcome": "accepted",
                },
            )

    def snapshot(route: Route) -> None:
        refreshes.append(route.request.url)
        route.fulfill(json=chat.session_snapshot())

    page.route(url + "/events", reply)
    page.route(re.compile(re.escape(url) + r"\?.*refresh_state=true"), snapshot)
    with page.expect_request(lambda req: req.url == url + "/events"):
        if width == 390:
            stop.click()
        else:
            composer.fill(draft)
            composer.press("Escape")
    if width == 390:
        composer.fill(draft)
    expect(composer).to_have_value(draft)
    assert sent == [{"type": "interrupt", "data": {"response_id": target}}]
    chat.update_session(status="running" if next_turn else "idle", active_response_id=next_turn)
    if next_turn == "codex_streamed":
        # The new answer streams before the old receipt and its stale idle snapshot arrive.
        chat.emit_busy(next_turn)
        text = "The successor is still answering"
        chat.emit(
            {
                "event": "response.output_item.done",
                "data": {
                    "item": message_item("live-answer", "assistant", text, response_id=next_turn)
                },
            }
        )
        expect(page.get_by_text(text, exact=True)).to_be_visible(timeout=15_000)
        chat.update_session(status="idle", active_response_id=None)
    with page.expect_response(
        lambda response: (
            response.url == url + "/events"
            if outcome == "accepted"
            else response.url.startswith(url + "?") and "refresh_state=true" in response.url
        ),
        timeout=10_000,
    ):
        request = pending.pop()
        if outcome is None:
            request.abort("connectionreset")
        else:
            request.fulfill(
                status=202,
                json={"queued": False, "response_id": target, "interrupt_outcome": outcome},
            )
    if outcome == "accepted":
        # Acceptance acknowledges dispatch; the terminal lifecycle arrives on SSE.
        chat.emit_idle(target)
    if next_turn == target:
        check = page.get_by_role("button", name="Check active turn")
        expect(check).to_be_visible()
        expect(composer).to_have_value(draft)
        assert sent == [{"type": "interrupt", "data": {"response_id": target}}]
        next_turn = "codex_successor"
        chat.update_session(status="running", active_response_id=next_turn)
        check.click()
        expect(check).to_have_count(0)
    if next_turn:
        # A second deliberate Stop proves the refreshed identity is actionable.
        expect(composer).to_have_value(draft)
        expect(page.get_by_text("Interrupt could not be confirmed.", exact=False)).to_have_count(0)
        with page.expect_request(lambda req: req.url == url + "/events"):
            composer.press("Escape")
        assert sent == [
            {"type": "interrupt", "data": {"response_id": turn}} for turn in (target, next_turn)
        ]
    else:
        expect(page.get_by_test_id("working-indicator")).to_have_count(0)
        assert sent == [{"type": "interrupt", "data": {"response_id": target}}]
    expect(composer).to_have_value(draft)
    if outcome != "accepted":
        assert refreshes
