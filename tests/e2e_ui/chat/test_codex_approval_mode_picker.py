"""E2E: the Codex future-turn picker reads native-observed settings."""

from __future__ import annotations

import json
from urllib.parse import urlparse

import pytest
from playwright.sync_api import Page, Route, expect

from tests.e2e_ui.conftest import fetch_with_retry

# Conversation-label key the server stamps after a confirmed switch.
_APPROVAL_MODE_LABEL_KEY = "omnigent.codex_native.next_turn_permissions_v1"


def _patch_session_as_codex_native(
    page: Page,
    session_id: str,
    *,
    approval_mode: str | None = None,
) -> list[dict]:
    """Patch the browser's session snapshot into a codex-native response.

    The server fixture seeds a normal ``hello_world`` session so the page can
    boot against the real app/server. This route patch changes only ``GET``
    and ``PATCH /v1/sessions/{session_id}`` responses as seen by the browser,
    simulating a codex-native session. An ``approval_mode`` PATCH answers the
    way the real server does after the runner confirms the switch: the
    read-back label is stamped on the returned snapshot.

    :param page: Playwright page before navigation.
    :param session_id: Session id to patch, e.g. ``"conv_abc123"``.
    :param approval_mode: Initial ``omnigent.codex_native.approval_mode``
        label value; ``None`` simulates a session that has not switched yet
        (the picker shows its unset placeholder).
    :returns: Captured PATCH request bodies.
    """
    latest_payload: dict | None = None
    patch_bodies: list[dict] = []
    # Mutable so the PATCH handler can update it without rebinding the name.
    cur_approval_mode: list[str | None] = [approval_mode]

    def _handle(route: Route) -> None:
        nonlocal latest_payload
        request = route.request
        parsed = urlparse(request.url)
        if parsed.path not in {
            f"/v1/sessions/{session_id}",
            f"/v1/sessions/{session_id}/codex/next-turn-permissions/v1",
        }:
            route.continue_()
            return

        headers = {"content-type": "application/json"}
        if request.method == "GET":
            response = fetch_with_retry(route)
            payload = response.json()
            headers = {**response.headers, **headers}
        elif request.method == "POST" and parsed.path.endswith("/codex/next-turn-permissions/v1"):
            request_body = json.loads(request.post_data or "{}")
            patch_bodies.append(request_body)
            assert request_body["protocol"] == "codex-next-turn-permissions/v1"
            assert request_body["scope"] == "subsequent_turns"
            cur_approval_mode[0] = request_body["mode"]
            route.fulfill(
                status=200,
                headers=headers,
                body=json.dumps({**request_body, "status": "accepted"}),
            )
            return
        else:
            route.continue_()
            return

        labels = dict(payload.get("labels", {}))
        labels["omnigent.wrapper"] = "codex-native-ui"
        if cur_approval_mode[0] is not None:
            labels[_APPROVAL_MODE_LABEL_KEY] = cur_approval_mode[0]
        payload["labels"] = labels
        payload["harness"] = "codex"
        payload["llm_model"] = "gpt-5.5"
        latest_payload = dict(payload)
        route.fulfill(
            status=200,
            headers=headers,
            body=json.dumps(payload),
        )

    page.route("**/v1/sessions/**", _handle)
    return patch_bodies


@pytest.mark.parametrize("width", [390, 1440], ids=["phone", "desktop"])
def test_codex_native_approval_mode_switch_persists(
    page: Page,
    seeded_session: tuple[str, str],
    width: int,
) -> None:
    """Picking an approval preset in the gear modal PATCHes the server.

    Selecting "Approve for me" sends ``{"approval_mode": "approve-for-me"}``
    to ``PATCH /v1/sessions/{id}`` for a structured native settings update.
    The acknowledgement does not replace the displayed native observation.
    Reload reads the later server-side observation.

    :param page: Playwright page fixture.
    :param seeded_session: ``(base_url, session_id)`` for a real server-backed
        session; the browser snapshot is patched to a codex-native session
        that has not switched modes yet.
    :returns: None.
    """
    base_url, session_id = seeded_session
    patch_bodies = _patch_session_as_codex_native(page, session_id)

    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{base_url}/c/{session_id}")

    picker = page.get_by_test_id("composer-permission-chip")
    expect(picker).to_be_visible(timeout=15_000)
    picker.click()
    expect(page.get_by_test_id("composer-permission-option-read-only")).to_be_visible()
    expect(page.get_by_test_id("composer-permission-menu")).to_contain_text(
        "Triune action policies"
    )
    with page.expect_response(
        lambda response: (
            response.request.method == "POST"
            and urlparse(response.url).path
            == f"/v1/sessions/{session_id}/codex/next-turn-permissions/v1"
            and response.status == 200
        )
    ):
        page.get_by_test_id("composer-permission-option-approve-for-me").click()

    assert patch_bodies[-1] == {
        "protocol": "codex-next-turn-permissions/v1",
        "scope": "subsequent_turns",
        "mode": "approve-for-me",
    }

    # PATCH acceptance is not a native observation; reload reads the saved observation.
    expect(picker).to_have_accessible_name("Next-turn permissions: Next turn: Unknown")
    page.reload()
    expect(page.get_by_test_id("composer-permission-chip")).to_contain_text("Approve for me")


def test_codex_native_approval_mode_starts_from_label(
    page: Page,
    seeded_session: tuple[str, str],
) -> None:
    """A session with a stamped read-back label opens on that preset.

    Covers the TUI→web direction as the browser sees it: after a
    ``/permissions`` change inside Codex the server stamps
    ``omnigent.codex_native.approval_mode``, and the picker reflects it on
    load instead of the unset placeholder.

    :param page: Playwright page fixture.
    :param seeded_session: ``(base_url, session_id)`` for a real server-backed
        session; the browser snapshot is patched to a codex-native session
        already in ``full-access``.
    :returns: None.
    """
    base_url, session_id = seeded_session
    _patch_session_as_codex_native(page, session_id, approval_mode="full-access")

    page.goto(f"{base_url}/c/{session_id}")

    picker = page.get_by_test_id("composer-permission-chip")
    expect(picker).to_be_visible(timeout=15_000)
    expect(picker).to_contain_text("Full Access")
