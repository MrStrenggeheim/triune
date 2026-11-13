# Modified for Triune.
"""Approved workspace surfaces through the built SPA with sealed API contracts."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import Locator, Page, Request, expect

from tests.browser_ui.chat.session_contract import list_payload
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
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


def _close_navigation(page: Page) -> None:
    scrim = page.get_by_test_id("sidebar-scrim")
    if scrim.is_visible() and scrim.get_attribute("aria-hidden") == "false":
        scrim.click(position={"x": page.viewport_size["width"] - 4, "y": 150})
        expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()
        return
    close = page.get_by_role("button", name="Close navigation", exact=True)
    if close.is_visible():
        close.click()
    expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()


def test_mobile_composer_keeps_tabs_and_follows_appearance_density(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    host = workspace_journey.chats[0].host_id
    for suffix in ("", "/workspace"):
        browser_contract.json(f"/v1/hosts/{host}/filesystem{suffix}", list_payload([]))
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(workspace_journey.chats[0].url)
    chat = _view(page, "Chat A")
    composer = chat.get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Mobile draft stays here")
    selector = chat.get_by_test_id("composer-workspace-dir")
    expect(selector).to_be_visible()
    expect(selector.locator(".workspace-selector-details")).to_be_hidden()
    expect(selector).to_have_attribute("aria-label", "Change workspace: Browser host:/workspace")
    expect(page.get_by_role("combobox", name="Open views", exact=True)).to_have_count(0)
    expect(page.get_by_role("tablist", name="Views in main")).to_be_visible()

    geometry = chat.evaluate("""element => {
      const form = element.querySelector('.chat-composer-form');
      const card = form.querySelector('[data-composer-card]');
      const appbar = document.querySelector('.workbench-app-bar');
      const navigation = document.querySelector('.dock-pane:not([hidden]) .dock-pane-header');
      const header = element.querySelector('.workspace-control-header');
      return {
        appbar: appbar.getBoundingClientRect().height,
        navigation: navigation.getBoundingClientRect().height,
        viewHeader: header.getBoundingClientRect().height,
        gutter: form.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom,
        belowForm: element.getBoundingClientRect().bottom - form.getBoundingClientRect().bottom,
      };
    }""")
    assert geometry == {
        "appbar": 48,
        "navigation": 48,
        "viewHeader": 48,
        "gutter": 8,
        "belowForm": 0,
    }, geometry
    page.evaluate("document.documentElement.dataset.listDensity = 'compact'")
    for row in (
        ".workbench-app-bar",
        ".dock-pane:not([hidden]) .dock-pane-header",
        ".workspace-control-header",
    ):
        assert page.locator(row).first.evaluate("el => el.getBoundingClientRect().height") == 36
    page.get_by_role("button", name="Open navigation", exact=True).click()
    entry = page.locator(".conversations-sidebar .sidebar-row").first
    expect(entry).to_have_css("padding-top", "2px")
    page.evaluate("document.documentElement.dataset.listDensity = 'comfortable'")
    expect(entry).to_have_css("padding-top", "6px")
    page.get_by_test_id("sidebar-scrim").click(position={"x": 385, "y": 500})
    expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()
    _capture(page, output_path, "mobile-tabs-composer")

    selector.click()
    expect(page.get_by_role("dialog", name="Select workspace", exact=True)).to_be_visible()
    page.get_by_role("button", name="Cancel", exact=True).click()
    expect(composer).to_have_value("Mobile draft stays here")

    page.evaluate("""() => {
      document.documentElement.style.setProperty('--omnigent-safe-bottom', '20px');
      document.querySelector('.unified-workbench').dataset.iosNative = 'true';
    }""")
    assert (
        page.locator(".dock-workspace").evaluate(
            "el => window.innerHeight - el.getBoundingClientRect().bottom"
        )
        == 20
    )
    assert (
        chat.locator(".chat-composer-form").evaluate("el => getComputedStyle(el).paddingBottom")
        == "8px"
    )
    assert (
        chat.evaluate(
            "el => getComputedStyle(el.closest('.dock-view-slot'), '::after').borderBottomWidth"
        )
        == "0px"
    )
    assert chat.evaluate(
        """el => {
          const pane = getComputedStyle(el.closest('.dock-view-slot'));
          const shell = getComputedStyle(document.querySelector('.unified-workbench'));
          return pane.backgroundColor === shell.backgroundColor;
        }"""
    )

    page.evaluate("""() => {
      document.documentElement.style.removeProperty('--omnigent-safe-bottom');
      delete document.querySelector('.unified-workbench').dataset.iosNative;
    }""")
    page.set_viewport_size({"width": 1440, "height": 1000})
    expect(page.get_by_role("tablist", name="Views in main")).to_be_visible()
    expect(page.get_by_role("combobox", name="Open views", exact=True)).to_have_count(0)
    expect(composer).to_have_value("Mobile draft stays here")
    assert browser_errors == []


def _assert_picker(page: Page, host_id: str, root: str) -> Locator:
    dialog = page.get_by_role("dialog", name="Select workspace", exact=True)
    expect(dialog).to_be_visible()
    for section in ("Host", "Path"):
        region = dialog.get_by_role("region", name=section, exact=True)
        expect(region).to_be_in_viewport()
    expect(dialog.get_by_test_id(f"workspace-selection-host-{host_id}")).to_have_attribute(
        "aria-pressed", "true"
    )
    path = dialog.get_by_role("textbox", name="Current folder path", exact=True)
    expect(path).to_have_value(root)
    expect(path).to_be_focused()
    footer = dialog.get_by_test_id("workspace-selection-footer")
    expect(footer.get_by_role("button")).to_have_count(2)
    for label in ("Cancel", "Use workspace"):
        expect(dialog.get_by_role("button", name=label, exact=True)).to_have_count(1)
        expect(footer.get_by_role("button", name=label, exact=True)).to_be_in_viewport()
    header = dialog.get_by_test_id("workspace-picker-header")
    expect(header.get_by_role("button", name="Use workspace", exact=True)).to_have_count(0)
    expect(header.get_by_role("button", name="Cancel", exact=True)).to_have_count(0)
    return dialog


def test_combined_workspace_picker_changes_explorer_requests_and_cancel_retains_root(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    host_id = journey.chats[0].host_id
    created: list[dict[str, Any]] = []
    filesystem_requests: list[str] = []
    candidates = {
        root: {**journey.workspace, "id": f"workspace-{name}", "root": root}
        for name, root in (("desktop", "/candidate-desktop"), ("phone", "/candidate-phone"))
    }

    def create_workspace(request: Request) -> dict[str, Any]:
        body = request.post_data_json
        created.append(body)
        assert body["host_id"] == host_id
        return candidates[body["root"]]

    browser_contract.json("/v1/workbench-workspaces", create_workspace, method="POST")
    for root in ("", "/workspace", "/cancelled", *candidates):
        path = f"/v1/hosts/{host_id}/filesystem{root}"
        browser_contract.json(
            path,
            list_payload(
                [
                    {
                        "name": "folder",
                        "path": f"{root or '/home/fixture'}/folder",
                        "type": "directory",
                    }
                ]
            ),
        )
    for workspace in candidates.values():
        base = f"/v1/workbench-workspaces/{workspace['id']}"
        environment = f"{base}/resources/environments/default"
        browser_contract.json(base, workspace)
        browser_contract.json(environment, {"metadata": {"root": workspace["root"]}})
        browser_contract.json(
            f"{environment}/git",
            {**list_payload([]), "repositories": [], "source": "git", "root_is_repository": False},
        )
        browser_contract.json(f"{environment}/changes", list_payload([]))
        listing = list_payload(
            [{"name": "candidate.txt", "path": "candidate.txt", "type": "file"}]
        )
        for suffix in ("", "/", workspace["root"]):
            browser_contract.json(f"{environment}/filesystem{suffix}", listing)

    page.on(
        "request",
        lambda request: (
            filesystem_requests.append(urlparse(request.url).path)
            if "/resources/environments/default/filesystem" in request.url
            else None
        ),
    )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(journey.chats[0].url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    _close_navigation(page)
    _open(page, "Explorer")
    explorer = _view(page, "Explorer")
    expect(explorer.get_by_text("notes.py", exact=True)).to_be_visible()
    root = "/workspace"
    for name, width, height, next_root in (
        ("desktop", 1440, 1000, "/candidate-desktop"),
        ("phone", 390, 844, "/candidate-phone"),
    ):
        page.set_viewport_size({"width": width, "height": height})
        selector = explorer.get_by_role(
            "button", name=f"Select workspace: Browser host:{root}", exact=True
        )
        selector.click()
        dialog = _assert_picker(page, host_id, root)
        _capture(page, output_path, f"{name}-workspace-picker")
        dialog.get_by_role("textbox", name="Current folder path").fill("/cancelled")
        dialog.get_by_role("button", name="Add host…", exact=True).click()
        setup = page.get_by_role("dialog", name="Connect a host", exact=True)
        expect(setup).to_be_visible()
        expect(setup).to_contain_text("triune host --server")
        expect(setup).to_contain_text(journey.chats[0].contract.base_url)
        _capture(page, output_path, f"{name}-add-host-instructions")
        setup.get_by_role("button", name="Close", exact=True).click()
        expect(dialog.get_by_role("textbox", name="Current folder path")).to_have_value(
            "/cancelled"
        )
        dialog.get_by_role("button", name="Cancel", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(selector).to_be_visible()
        assert len(created) == (0 if name == "desktop" else 1)
        assert not any("/workspace-cancelled/" in url for url in filesystem_requests)
        selector.click()
        dialog = _assert_picker(page, host_id, root)
        dialog.get_by_role("textbox", name="Current folder path").fill(next_root)
        with page.expect_request(
            lambda request, name=name: (
                f"/workbench-workspaces/workspace-{name}/resources/" in request.url
                and "/filesystem" in request.url
            )
        ):
            dialog.get_by_role("button", name="Use workspace", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(explorer.get_by_text("candidate.txt", exact=True)).to_be_visible()
        expect(
            explorer.get_by_role(
                "button", name=f"Select workspace: Browser host:{next_root}", exact=True
            )
        ).to_be_visible()
        assert created[-1] == {"host_id": host_id, "root": next_root}
        assert any(f"/workspace-{name}/resources/" in url for url in filesystem_requests)
        _capture(page, output_path, f"{name}-explorer-confirmed-root")
        root = next_root
    assert journey.writes == []
    assert browser_errors == []


def test_settings_from_closed_navigation_retains_draft_and_approved_chrome(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    chat = workspace_journey.chats[0]
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(chat.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Draft survives settings on desktop and phone")
    _close_navigation(page)
    tab = page.get_by_role("tab", name="Chat A", exact=True)
    expect(tab.locator("svg.lucide-message-square")).to_have_count(1)
    expect(tab).to_have_attribute("aria-selected", "true")
    appbar = page.get_by_role("banner", name="Application")
    assert tab.evaluate(
        "el => getComputedStyle(el.parentElement).backgroundColor"
    ) != appbar.evaluate("el => getComputedStyle(el).backgroundColor")
    send = _view(page, "Chat A").get_by_role("button", name="Send", exact=True)
    expect(send).to_be_enabled()
    assert send.locator("svg").evaluate("el => getComputedStyle(el).color") == "rgb(255, 255, 255)"
    assert send.evaluate("el => getComputedStyle(el).backgroundColor") == "rgb(104, 81, 139)"
    close = page.get_by_role("button", name="Close Chat A", exact=True)
    assert close.get_attribute("title") is None
    assert close.get_attribute("data-tooltip") is None
    close.hover()
    expect(page.get_by_role("tooltip")).to_have_count(0)
    _capture(page, output_path, "desktop-approved-chrome")
    for name, width, height in (("desktop", 1440, 1000), ("phone", 390, 844)):
        page.set_viewport_size({"width": width, "height": height})
        _close_navigation(page)
        appbar.get_by_role("button", name="Settings", exact=True).click()
        expect(page).to_have_url(
            re.compile(re.escape(chat.contract.base_url) + r"/settings(?:/general)?$")
        )
        expect(page.get_by_test_id("settings-group-composer")).to_be_visible()
        if name == "desktop":
            expect(page.get_by_test_id("settings-nav-general")).to_be_in_viewport()
            expect(page.get_by_test_id("settings-nav-appearance")).to_be_in_viewport()
        else:
            chooser = page.get_by_role("combobox", name="Settings section", exact=True)
            expect(chooser).to_be_in_viewport()
            chooser.click()
            expect(page.get_by_role("option", name="Appearance", exact=True)).to_be_visible()
            page.keyboard.press("Escape")
        _capture(page, output_path, f"{name}-settings-navigation")
        heading_bounds = page.get_by_role("heading", name="General", level=1).bounding_box()
        appbar_bounds = appbar.bounding_box()
        (Path(output_path) / f"{name}-settings-geometry.json").write_text(
            json.dumps(
                {
                    "heading": heading_bounds,
                    "appbar": appbar_bounds,
                    "open_button": appbar.get_by_role("button", name="Open view").bounding_box(),
                },
                indent=2,
            )
            + "\n"
        )
        assert heading_bounds and appbar_bounds
        assert heading_bounds["y"] >= appbar_bounds["y"] + appbar_bounds["height"], (
            name,
            heading_bounds,
            appbar_bounds,
        )
        page.go_back()
        expect(page).to_have_url(chat.url)
        expect(composer).to_have_value("Draft survives settings on desktop and phone")
        expect(page.get_by_role("button", name="Open navigation", exact=True)).to_be_visible()
        _capture(page, output_path, f"{name}-draft-after-settings")
    assert chat.event_posts == []
    assert browser_errors == []


def test_activity_sources_group_hosts_and_chats_and_agent_cli_is_discoverable(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    browser_contract.json("/v1/workbench-workspaces", list_payload([journey.workspace]))
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(journey.chats[0].url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    _close_navigation(page)
    page.get_by_role("button", name="Open view", exact=True).click()
    expect(page.get_by_role("menuitem", name="Existing shells", exact=True)).to_have_count(0)
    agent_cli = page.get_by_role("menuitem", name="Agent CLI", exact=True)
    expect(agent_cli).to_be_visible()
    expect(agent_cli.locator("svg.lucide-hat-glasses")).to_have_count(1)
    _capture(page, output_path, "desktop-open-menu-agent-cli")
    page.get_by_role("menuitem", name="Orchestration", exact=True).click()
    activity = _view(page, "Orchestration")
    source = activity.get_by_role("button", name="Choose orchestration source", exact=False)
    source.click()
    dialog = page.get_by_role("dialog", name="Orchestration source", exact=True)
    for group, option in (("Hosts", "Browser host"), ("Chats", "Chat B")):
        expect(
            dialog.get_by_role("group", name=group, exact=True).get_by_role(
                "option", name=option, exact=True
            )
        ).to_be_visible()
    _capture(page, output_path, "desktop-activity-grouped-sources")
    dialog.get_by_role("option", name="Chat B", exact=True).click()
    expect(dialog).to_have_count(0)
    expect(source).to_contain_text("Chat: Chat B")
    page.set_viewport_size({"width": 390, "height": 844})
    source.click()
    expect(dialog.get_by_role("option", name="Browser host", exact=True)).to_be_in_viewport()
    expect(dialog.get_by_role("option", name="Chat B", exact=True)).to_be_in_viewport()
    _capture(page, output_path, "phone-activity-grouped-sources")
    dialog.get_by_role("option", name="Browser host", exact=True).click()
    expect(dialog).to_have_count(0)
    expect(source).to_contain_text("Host: Browser host")
    expect(activity.get_by_role("button", name="shell · fixture", exact=True)).to_be_visible()
    assert journey.attachments == []
    assert journey.stops == []
    assert browser_errors == []
