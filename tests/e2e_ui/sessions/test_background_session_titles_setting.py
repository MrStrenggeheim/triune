# Modified for Triune: cover server-persisted live agent communication settings.
"""E2E: Settings → General background session-title preference.

The toggle persists the user's browser-local preference through
``localStorage``. This covers the real settings round trip without launching
an LLM title-generation turn.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from playwright.sync_api import Page, expect


def _open_general_settings(page: Page, base_url: str):
    """Navigate to Settings → General and wait for the toggle to mount."""
    page.goto(f"{base_url}/settings/general")
    return page.get_by_test_id("background-session-titles-toggle")


def test_background_session_titles_defaults_on_and_persists(
    page: Page,
    live_server: str,
) -> None:
    """The preference starts on, survives an opt-out, and can be restored."""
    base_url = live_server
    toggle = _open_general_settings(page, base_url)
    expect(toggle).to_be_visible(timeout=30_000)
    expect(toggle).to_have_attribute("aria-checked", "true")

    toggle.click()
    expect(toggle).to_have_attribute("aria-checked", "false")

    page.reload()
    toggle = _open_general_settings(page, base_url)
    expect(toggle).to_have_attribute("aria-checked", "false", timeout=30_000)

    toggle.click()
    expect(toggle).to_have_attribute("aria-checked", "true")

    page.reload()
    toggle = _open_general_settings(page, base_url)
    expect(toggle).to_have_attribute("aria-checked", "true", timeout=30_000)


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "mobile"])
def test_agent_communication_defaults_on_and_persists_without_restart(
    page: Page, live_server: str, output_path: str, width: int
) -> None:
    """The personal setting saves on the server and survives a real page reload."""
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{live_server}/settings/general")
    toggle = page.get_by_role("switch", name="Agent communication", exact=True)
    expect(toggle).to_be_enabled(timeout=30_000)
    expect(toggle).to_have_attribute("aria-checked", "true")
    with page.expect_response(
        lambda response: (
            response.request.method == "PUT"
            and response.url.endswith("/v1/preferences/session-orchestration")
        )
    ) as changed:
        toggle.click()
    assert changed.value.ok
    assert changed.value.json() == {"enabled": False, "server_enabled": True}
    page.reload()
    expect(toggle).to_be_enabled(timeout=30_000)
    expect(toggle).to_have_attribute("aria-checked", "false")
    toggle.click()
    expect(toggle).to_have_attribute("aria-checked", "true")
    expect(toggle).to_be_enabled()
    page.reload()
    expect(toggle).to_be_enabled(timeout=30_000)
    expect(toggle).to_have_attribute("aria-checked", "true")
    toggle.scroll_into_view_if_needed()
    directory = Path(output_path)
    directory.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(directory / f"agent-communication-{width}.png"))
