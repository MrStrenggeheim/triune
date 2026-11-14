# Modified for Triune.
"""Docked workspace journeys through the built SPA and sealed backend contracts."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Locator, Page, Route, WebSocketRoute, expect

from tests.browser_ui.chat.session_contract import (
    ChatSessionContract,
    chat_session_handle,
    list_payload,
    message_item,
)
from tests.browser_ui.conftest import BrowserContract


@pytest.fixture
def browser_errors(page: Page) -> Iterator[list[str]]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    yield errors
    assert errors == [], "Browser runtime errors: " + "\n".join(errors)


@dataclass
class WorkspaceJourney:
    chats: list[ChatSessionContract]
    workspace: dict[str, Any]
    files: dict[str, str]
    writes: list[dict[str, Any]] = field(default_factory=list)
    stops: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)
    reject_writes: bool = False


@pytest.fixture
def workspace_journey(page: Page, browser_contract: BrowserContract) -> Iterator[WorkspaceJourney]:
    """Two real SPA conversations with explicit filesystem and shell wire contracts."""
    contract = browser_contract
    contract.json(
        "/v1/preferences/session-orchestration", {"enabled": True, "server_enabled": True}
    )
    with ExitStack() as stack:
        chats = [
            stack.enter_context(
                contextmanager(chat_session_handle)(page, contract, session_id=f"workspace-{name}")
            )
            for name in ("a", "b")
        ]
        for label, chat in zip(("Chat A", "Chat B"), chats, strict=True):
            chat.update_session(title=label, workspace="/workspace")
            chat.set_items(
                [
                    message_item(
                        f"{chat.session_id}-answer",
                        "assistant",
                        f"Answer from {label}",
                        response_id=f"{chat.session_id}-turn",
                    )
                ]
            )
            for endpoint in ("peer-messages", "branches"):
                contract.json(f"/v1/sessions/{chat.session_id}/{endpoint}", list_payload([]))
            contract.json(f"/v1/sessions/{chat.session_id}/resources/shells", list_payload([]))
            contract.json(f"/v1/sessions/{chat.session_id}/runtime-notices", {"data": []})
            contract.json(f"/v1/sessions/{chat.session_id}/comments", [])
        contract.json(
            "/v1/sessions", lambda _: list_payload([chat.session_snapshot() for chat in chats])
        )
        contract.json(
            "/health",
            {
                "sessions": {
                    chat.session_id: {"runner_online": True, "host_online": True} for chat in chats
                }
            },
        )
        workspace = {
            "id": "workspace-files",
            "root": "/workspace",
            "host_id": chats[0].host_id,
            "target_kind": "host",
            "available": True,
            "permission_level": 4,
            "capabilities": ["files", "git", "terminals"],
        }
        journey = WorkspaceJourney(
            chats,
            workspace,
            {"notes.py": "selection_target = 'keep this selection'\nprint(selection_target)\n"},
        )
        contract.json("/v1/workbench-workspaces/resolve", workspace, method="POST")
        contract.json("/v1/workbench-workspaces/workspace-files", workspace)
        environment = "/v1/workbench-workspaces/workspace-files/resources/environments/default"
        contract.json(environment, {"metadata": {"root": "/workspace"}})
        contract.json(
            f"{environment}/git",
            {**list_payload([]), "repositories": [], "source": "git", "root_is_repository": False},
        )
        contract.json(f"{environment}/changes", list_payload([]))
        listing = list_payload(
            [
                {"path": name, "name": name, "type": "file", "bytes": len(content)}
                for name, content in journey.files.items()
            ]
        )
        for suffix in ("", "/", "/workspace"):
            contract.json(f"{environment}/filesystem{suffix}", listing)

        def file_content(route: Route) -> None:
            if route.request.method == "PUT":
                body = route.request.post_data_json
                journey.writes.append({"url": route.request.url, "body": body})
                if journey.reject_writes:
                    route.fulfill(status=503, json={"detail": "Fixture filesystem unavailable"})
                    return
                journey.files["notes.py"] = body["content"]
                route.fulfill(status=204)
            elif route.request.method == "GET":
                content = journey.files["notes.py"]
                route.fulfill(
                    json={
                        "object": "session.environment.filesystem.file_content",
                        "path": "notes.py",
                        "content": content,
                        "encoding": "utf-8",
                        "content_type": "text/x-python",
                        "bytes": len(content),
                    }
                )
            else:
                route.fallback()

        contract.route(contract._matcher(f"{environment}/filesystem/notes.py"), file_content)
        contract.route(
            contract._matcher(f"{environment}/filesystem/workspace/notes.py"), file_content
        )
        terminal_api = "/v1/workbench-workspaces/workspace-files/terminals"
        terminal = {
            "id": "manual-shell",
            "object": "terminal",
            "name": "shell",
            "workspace_id": workspace["id"],
            "state": "running",
            "connectivity": "connected",
            "output": "Shell fixture ready",
            "metadata": {"terminal_name": "shell", "session_key": "fixture", "running": True},
        }
        contract.json(terminal_api, list_payload([terminal]))
        contract.json(terminal_api, terminal, method="POST")
        contract.json(f"{terminal_api}/manual-shell", terminal)

        def stop(route: Route) -> None:
            journey.stops.append(route.request.url)
            route.fulfill(json={"state": "stopped"})

        contract.route(contract._matcher(f"{terminal_api}/manual-shell/stop"), stop)

        def attach(socket: WebSocketRoute) -> None:
            journey.attachments.append(socket.url)
            socket.send(b"Shell fixture ready\r\n$ ")
            socket.on_message(lambda _message: None)

        contract.websocket(
            "**/v1/workbench-workspaces/workspace-files/terminals/manual-shell/attach*", attach
        )
        yield journey


def _capture(page: Page, output_path: str, name: str) -> None:
    Path(output_path).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(Path(output_path) / f"{name}.png"), animations="disabled")


def _assert_transcript_painted_at_top(
    page: Page, title: str, output_path: str, artifact_name: str
) -> None:
    """Visibility alone misses an opaque element hidden by an ancestor's alpha mask."""
    text = _view(page, title).get_by_text(f"Answer from {title}", exact=True)
    expect(text).to_be_visible()
    ancestors = text.evaluate(
        """element => {
          const rows = [];
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            rows.push({
              tag: node.tagName, className: node.className,
              rect: node.getBoundingClientRect().toJSON(),
              color: style.color, backgroundColor: style.backgroundColor,
              opacity: style.opacity, visibility: style.visibility,
              maskImage: style.maskImage, webkitMaskImage: style.webkitMaskImage,
              maskSize: style.maskSize, maskPosition: style.maskPosition,
              clipPath: style.clipPath, overflow: style.overflow,
              filter: style.filter, transform: style.transform,
              scrollTop: node.scrollTop, clientHeight: node.clientHeight,
            });
          }
          return rows;
        }"""
    )
    Path(output_path).mkdir(parents=True, exist_ok=True)
    (Path(output_path) / f"{artifact_name}-transcript-style.json").write_text(
        json.dumps(ancestors, indent=2) + "\n"
    )
    viewport = next(row for row in ancestors if "chat-scroll-" in row["className"])
    text_rect, viewport_rect = ancestors[0]["rect"], viewport["rect"]
    assert viewport_rect["top"] <= text_rect["top"], ancestors
    assert text_rect["bottom"] <= viewport_rect["bottom"] - 32, ancestors
    for row in ancestors:
        assert float(row["opacity"]) > 0, row
        mask = row["maskImage"]
        if mask == "none":
            continue
        first_color = re.search(r"rgba?\([^)]+\)|transparent|black", mask)
        assert first_color and first_color.group().replace(" ", "") in {
            "black",
            "rgb(0,0,0)",
            "rgba(0,0,0,1)",
        }, f"Transcript top is masked: {row}"


def _view(page: Page, title: str) -> Locator:
    return page.get_by_role("tabpanel", name=title, exact=True)


def _navigate_chat(page: Page, chat: ChatSessionContract) -> None:
    if page.get_by_role("button", name="Open navigation", exact=True).is_visible():
        page.get_by_role("button", name="Open navigation", exact=True).click()
    page.locator(f'aside [data-sidebar-session-id="{chat.session_id}"]').click()
    expect(page).to_have_url(chat.url)
    expect(_view(page, chat.session_snapshot()["title"])).to_be_visible()


def _open(page: Page, title: str) -> None:
    page.get_by_role("button", name="Open view", exact=True).click()
    page.get_by_role("menuitem", name=title, exact=True).click()


def _action(page: Page, title: str, action: str) -> None:
    assert action == "Keep open across chats"
    page.get_by_role("tab", name=title, exact=True).hover()
    page.get_by_role("button", name=f"Pin {title}", exact=True).click()


def _drag_view(page: Page, title: str, target: str, edge: str) -> None:
    source = page.get_by_role("tab", name=title, exact=True)
    pane = page.locator(".dock-pane").filter(has=page.get_by_role("tab", name=target, exact=True))
    bounds = source.bounding_box()
    assert bounds
    page.mouse.move(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
    page.mouse.down()
    page.mouse.move(
        bounds["x"] + bounds["width"] / 2 + 12, bounds["y"] + bounds["height"] / 2, steps=3
    )
    zone = pane.locator(f'.dock-drop-zone[data-edge="{edge}"]')
    expect(zone).to_be_visible()
    zone.hover()
    expect(zone).to_have_attribute("data-over", "true")
    page.mouse.up()
    expect(page.locator(".dock-drop-overlay")).to_have_count(0)


def _saved_dock(page: Page) -> dict[str, Any]:
    return page.evaluate("""() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('omnigent:dock:v1:'));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    }""")


def test_unified_chat_draft_layout_and_global_commands(
    page: Page,
    chat_session_contract: ChatSessionContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    chat = chat_session_contract
    chat.update_session(title="Workspace conversation")
    chat.seed_transcript(2)
    chat.contract.json(f"/v1/sessions/{chat.session_id}/peer-messages", list_payload([]))
    chat.contract.json(f"/v1/sessions/{chat.session_id}/branches", list_payload([]))
    chat.contract.json(
        f"/v1/sessions/{chat.session_id}/resources/environments/default/search", list_payload([])
    )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(chat.url)
    expect(page.get_by_role("banner", name="Application")).to_be_visible()
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("A draft retained through layout changes")
    expect(composer).to_have_value("A draft retained through layout changes")
    page.get_by_role("button", name="Search or run a command").click()
    page.get_by_test_id("command-palette-input").fill("Orchestration")
    expect(page.get_by_role("option", name="Orchestration", exact=True)).to_be_visible()
    _capture(page, output_path, "palette-before-escape")
    page.get_by_test_id("command-palette-input").press("Escape")
    expect(page.get_by_role("dialog", name="Command palette")).to_have_count(0)
    expect(composer).to_have_value("A draft retained through layout changes")
    page.get_by_role("button", name="Close navigation", exact=True).click()
    _capture(page, output_path, "workspace-desktop")
    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.get_by_role("tab", name="Workspace conversation", exact=True)).to_be_visible()
    expect(composer).to_have_value("A draft retained through layout changes")
    _capture(page, output_path, "workspace-mobile")
    page.reload()
    expect(composer).to_have_value("A draft retained through layout changes")
    assert browser_errors == []


def test_busy_workspace_moves_resize_and_targeted_send(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    first, second = journey.chats
    page.set_viewport_size({"width": 1920, "height": 1080})
    page.goto(first.url)
    first_draft = _view(page, "Chat A").get_by_label("Message the agent")
    expect(first_draft).to_be_visible()
    first_draft.fill("Draft only for A")
    _navigate_chat(page, second)
    second_draft = _view(page, "Chat B").get_by_label("Message the agent")
    second_draft.fill("Send only to B")
    page.locator(f'aside [data-sidebar-session-id="{first.session_id}"]').click(button="right")
    page.get_by_role("menuitem", name="Open to side", exact=True).click()
    expect(first_draft).to_be_visible()
    expect(second_draft).to_be_visible()
    first_draft.click()
    _open(page, "Explorer")
    explorer = _view(page, "Explorer")
    expect(explorer).to_be_visible()
    explorer.get_by_text("notes.py", exact=True).click()
    preview = _view(page, "notes.py")
    editor = preview.locator(".monaco-editor").first
    expect(editor).to_be_visible(timeout=30_000)
    expect(editor.locator(".view-lines")).to_contain_text("selection_target", timeout=30_000)
    _drag_view(page, "notes.py", "Chat A", "bottom")
    page.get_by_role("button", name="Close navigation", exact=True).click()
    expect(first_draft).to_have_value("Draft only for A")
    expect(second_draft).to_have_value("Send only to B")
    for title in ("Chat A", "Chat B", "Explorer", "notes.py"):
        expect(_view(page, title)).to_be_visible()
    _assert_transcript_painted_at_top(page, "Chat A", output_path, "busy-chat-a")
    _assert_transcript_painted_at_top(page, "Chat B", output_path, "busy-chat-b")
    editor_bounds = editor.bounding_box()
    assert editor_bounds and editor_bounds["height"] >= 200, editor_bounds
    assert page.locator('.dock-pane[data-focused="true"]').count() == 1
    _capture(page, output_path, "busy-four-views")
    editor_input = editor.get_by_role("textbox", name="Editor content", exact=True)
    editor_input.focus()
    expect(editor_input).to_be_focused()
    editor_input.press("Control+Home")
    editor_input.press("Shift+ArrowRight")
    editor_input.press("Shift+ArrowRight")
    editor_input.press("Shift+ArrowRight")
    expect(editor.locator(".selected-text").first).to_be_visible()
    editor.evaluate(
        """el => {
          window.__workspaceEditor = el;
          window.__workspaceInput = el.querySelector('textarea');
        }"""
    )
    _capture(page, output_path, "busy-four-views-selection")
    _drag_view(page, "notes.py", "Chat A", "right")
    assert editor.evaluate(
        """el => el === window.__workspaceEditor &&
          el.querySelector('textarea') === window.__workspaceInput"""
    )
    expect(editor.locator(".selected-text").first).to_be_visible()
    divider = page.get_by_role("separator", name="Resize panes", exact=True).first
    before = divider.get_attribute("aria-valuenow")
    divider.focus()
    page.keyboard.press("ArrowRight")
    expect(divider).not_to_have_attribute("aria-valuenow", before or "")
    assert editor.evaluate("el => el === window.__workspaceEditor")
    expect(editor.locator(".selected-text").first).to_be_visible()
    # The request is owned by B even when A receives focus before acknowledgement.
    pending_send: list[Route] = []

    def capture_send(route: Route) -> None:
        if route.request.method != "POST":
            route.fallback()
            return
        second.event_posts.append({"url": route.request.url, "body": route.request.post_data_json})
        pending_send.append(route)

    second.contract.route(
        second.contract._matcher(f"/v1/sessions/{second.session_id}/events"), capture_send
    )
    with page.expect_request(
        lambda request: (
            request.method == "POST" and request.url.endswith(f"/{second.session_id}/events")
        )
    ):
        second_draft.press("Enter")
    first_draft.click()
    assert len(pending_send) == 1
    pending_send[0].fulfill(json=second.event_ack)
    expect(second_draft).to_have_value("")
    expect(first_draft).to_have_value("Draft only for A")
    assert len(second.event_posts) == 1
    assert first.event_posts == []
    assert "Send only to B" in json.dumps(second.event_posts[0]["body"])
    assert second.session_id in second.event_posts[0]["url"]
    _capture(page, output_path, "busy-moved-resized-targeted-send")
    assert journey.stops == []
    assert browser_errors == []


def test_saved_a_b_a_pin_composition_and_mobile_navigation(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, second = workspace_journey.chats
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(first.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("Saved A draft")
    _open(page, "Changes")
    expect(_view(page, "Changes")).to_be_visible()
    composer.click()
    saved_a = _saved_dock(page)["chats"][0]["layout"]
    _navigate_chat(page, second)
    _open(page, "Explorer")
    _action(page, "Explorer", "Keep open across chats")
    pinned = _saved_dock(page)["pins"]["views"][0]
    explorer_node = _view(page, "Explorer").element_handle()
    assert explorer_node
    _navigate_chat(page, first)
    expect(_view(page, "Changes")).to_be_visible()
    expect(_view(page, "Explorer")).to_be_visible()
    expect(composer).to_have_value("Saved A draft")
    assert explorer_node.evaluate("el => el.isConnected")
    stored = _saved_dock(page)
    assert (
        next(
            chat["layout"]
            for chat in stored["chats"]
            if chat["conversationId"] == first.session_id
        )
        == saved_a
    )
    assert stored["pins"]["views"][0] == pinned
    explorer_box = _view(page, "Explorer").bounding_box()
    changes_box = _view(page, "Changes").bounding_box()
    assert explorer_box and changes_box
    assert explorer_box["x"] >= changes_box["x"] + changes_box["width"] - 2
    page.get_by_role("button", name="Close navigation", exact=True).click()
    _assert_transcript_painted_at_top(page, "Chat A", output_path, "saved-chat-a")
    _capture(page, output_path, "saved-a-global-explorer")
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("tab", name="Explorer", exact=True).click()
    expect(_view(page, "Explorer")).to_be_visible()
    page.get_by_role("tab", name="Chat A", exact=True).click()
    expect(composer).to_have_value("Saved A draft")
    assert explorer_node.evaluate("el => el.isConnected")
    assert (
        page.locator(".dock-tabs:visible").evaluate("el => getComputedStyle(el).overflowY")
        == "hidden"
    )
    _capture(page, output_path, "mobile-saved-a-draft")
    page.reload()
    expect(composer).to_have_value("Saved A draft")
    assert _saved_dock(page)["pins"]["views"][0] == pinned
    assert browser_errors == []


def test_closing_shell_view_detaches_without_stopping_process(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    journey.chats[0].contract.json("/v1/workbench-workspaces", list_payload([journey.workspace]))
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(journey.chats[0].url)
    expect(_view(page, "Chat A").get_by_label("Message the agent")).to_be_visible()
    _open(page, "Manual terminal")
    terminal = _view(page, "shell · fixture")
    expect(terminal.locator(".xterm")).to_be_visible(timeout=30_000)
    expect(terminal.get_by_role("button", name="Stop shell", exact=True)).to_be_enabled()
    assert len(journey.attachments) == 1
    _capture(page, output_path, "manual-shell-attached")
    page.get_by_role("button", name="Close shell · fixture", exact=True).click()
    expect(terminal).to_have_count(0)
    expect(page.get_by_role("dialog")).to_have_count(0)
    assert journey.stops == []
    _open(page, "Orchestration")
    history = _view(page, "Orchestration")
    history.get_by_role("button", name="Choose orchestration source", exact=False).click()
    page.get_by_role("option", name="Browser host", exact=True).click()
    expect(history.get_by_role("button", name="shell · fixture", exact=True)).to_be_visible()
    assert journey.stops == []
    _capture(page, output_path, "shell-history-after-view-close")
    assert browser_errors == []


def test_file_deeplink_keeps_explicit_workspace_ownership(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    chat = journey.chats[0]
    contract = chat.contract
    linked = {**journey.workspace, "id": "workspace-linked", "root": "/linked"}
    content = "linked_workspace_target = 'explicit URL owner'\n"
    environment = "/v1/workbench-workspaces/workspace-linked/resources/environments/default"
    contract.json("/v1/workbench-workspaces/workspace-linked", linked)
    contract.json(environment, {"metadata": {"root": "/linked"}})
    contract.json(
        f"{environment}/git",
        {**list_payload([]), "repositories": [], "source": "git", "root_is_repository": False},
    )
    contract.json(f"{environment}/changes", list_payload([]))
    contract.json(
        f"{environment}/filesystem/notes.py",
        {
            "object": "session.environment.filesystem.file_content",
            "path": "notes.py",
            "content": content,
            "encoding": "utf-8",
            "content_type": "text/x-python",
            "bytes": len(content),
        },
    )
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(f"{chat.url}?file=notes.py&workspace=workspace-linked")
    preview = _view(page, "notes.py")
    expect(preview.locator(".view-lines")).to_contain_text(
        "linked_workspace_target", timeout=30_000
    )
    expect(preview.locator(".view-lines")).not_to_contain_text("selection_target")
    layout = next(
        saved["layout"]
        for saved in _saved_dock(page)["chats"]
        if saved["conversationId"] == chat.session_id
    )
    references = [view for view in layout["views"] if view["kind"] == "preview"]
    assert len(references) == 1, references
    assert references[0]["resource"]["workspace"]["id"] == linked["id"]
    assert references[0]["resource"]["conversationId"] == chat.session_id
    assert references[0]["resource"]["path"] == "notes.py"
    _capture(page, output_path, "explicit-workspace-file-deeplink")
    page.reload()
    expect(preview.locator(".view-lines")).to_contain_text(
        "linked_workspace_target", timeout=30_000
    )
    restored_layout = next(
        saved["layout"]
        for saved in _saved_dock(page)["chats"]
        if saved["conversationId"] == chat.session_id
    )
    restored = [view for view in restored_layout["views"] if view["kind"] == "preview"]
    assert len(restored) == 1, restored
    assert restored[0]["id"] == references[0]["id"]
    assert journey.writes == []
    assert browser_errors == []


def test_retained_dirty_navigation_preserves_editor_and_close_guard(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
) -> None:
    journey = workspace_journey
    first, second = journey.chats
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(second.url)
    expect(_view(page, "Chat B").get_by_label("Message the agent")).to_be_visible()
    _navigate_chat(page, first)
    composer = _view(page, "Chat A").get_by_label("Message the agent")
    composer.fill("A draft must not be redirected")
    _open(page, "Explorer")
    _view(page, "Explorer").get_by_text("notes.py", exact=True).click()
    preview = _view(page, "notes.py")
    expect(preview.locator(".view-lines")).to_contain_text("selection_target", timeout=30_000)
    composer.click()
    journey.reject_writes = True
    original_content = journey.files["notes.py"]
    editor = preview.locator(".monaco-editor").first
    editor.click()
    page.keyboard.press("Control+End")
    with page.expect_response(
        lambda response: (
            response.request.method == "PUT" and "/filesystem/notes.py" in response.url
        )
    ) as failed_write:
        page.keyboard.insert_text("\n# keep this unsaved change")
    assert failed_write.value.status == 503
    expect(preview.locator(".view-lines")).to_contain_text("keep this unsaved change")
    editor_handle = editor.element_handle()
    assert editor_handle
    _navigate_chat(page, second)
    dialog = page.get_by_role("dialog", name="Unsaved changes")
    expect(dialog).not_to_be_visible()
    expect(preview).not_to_be_visible()
    assert editor_handle.evaluate("element => element.isConnected")
    _navigate_chat(page, first)
    expect(preview.locator(".view-lines")).to_contain_text("keep this unsaved change")
    expect(composer).to_have_value("A draft must not be redirected")
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    assert editor_handle.evaluate("element => element.isConnected")
    close = page.get_by_role("button", name="Close notes.py", exact=True)
    close.click()
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Keep editing", exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(preview.locator(".view-lines")).to_contain_text("keep this unsaved change")
    _capture(page, output_path, "retained-dirty-editor-and-close-guard")
    close.click()
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Discard changes", exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.get_by_role("tab", name="notes.py", exact=True)).to_have_count(0)
    _navigate_chat(page, second)
    assert _saved_dock(page)["activeConversationId"] == second.session_id
    assert journey.files["notes.py"] == original_content
    assert first.event_posts == [] and second.event_posts == []
    assert browser_errors == []
