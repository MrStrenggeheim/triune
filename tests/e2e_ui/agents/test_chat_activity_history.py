"""Recorded native-command projection through the real Activity panel."""

from __future__ import annotations

import json
import subprocess

import httpx
from playwright.sync_api import Page, expect

from tests._helpers.polling import poll_until


def test_activity_groups_recorded_commands_by_turn(
    page: Page, seeded_session: tuple[str, str]
) -> None:
    base, session_id = seeded_session
    commands = (
        ("turn-a", "printf first-output"),
        ("turn-a", "printf failure-output; exit 7"),
        ("turn-b", "printf first-output"),
    )
    with httpx.Client(base_url=base, timeout=30) as client:
        for index, (turn, command) in enumerate(commands):
            result = subprocess.run(
                ["sh", "-c", command], capture_output=True, text=True, check=False
            )
            call_id = f"shell-{index}"
            for kind, data in (
                (
                    "function_call",
                    {
                        "name": "exec_command",
                        "agent": "codex-native-ui",
                        "call_id": call_id,
                        "arguments": json.dumps({"cmd": command}),
                    },
                ),
                (
                    "function_call_output",
                    {
                        "call_id": call_id,
                        "output": json.dumps(
                            {"exit_code": result.returncode, "stdout": result.stdout}
                        ),
                    },
                ),
            ):
                response = client.post(
                    f"/v1/sessions/{session_id}/events",
                    json={
                        "type": "external_conversation_item",
                        "data": {"item_type": kind, "item_data": data, "response_id": turn},
                    },
                )
                assert response.status_code == 202, response.text
        poll_until(
            lambda: (
                len(
                    [
                        row
                        for row in client.get(f"/v1/sessions/{session_id}/activity").json()["data"]
                        if row["state"] == "exited" and row.get("turn_id") in {"turn-a", "turn-b"}
                    ]
                )
                == 3
            ),
            timeout_s=15,
            interval_s=0.1,
        )

    page.goto(f"{base}/c/{session_id}")
    page.get_by_test_id("header-conversation-actions").click()
    page.get_by_role("menuitem", name="Open activity resources").click()
    shells = page.get_by_role("list", name="Shells", exact=True)
    first = shells.get_by_role("button", name="Expand activity · Commands · turn-a")
    second = shells.get_by_role("button", name="Expand activity · Commands · turn-b")
    expect(first).to_have_attribute("aria-expanded", "false")
    expect(second).to_have_attribute("aria-expanded", "false")
    first.press("Enter")
    expect(shells.locator("code")).to_have_count(2)
    expect(shells.get_by_text("Exit code: 7", exact=True)).to_be_visible()
    expect(shells.locator("pre").filter(has_text="failure-output")).to_be_visible()
    second.click()
    expect(shells.locator("code")).to_have_count(3)
    expect(shells.get_by_text("Exit code: 0", exact=True)).to_have_count(2)
    expect(shells.locator("pre").filter(has_text="first-output")).to_have_count(2)
