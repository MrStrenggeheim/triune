# Modified for Triune.
"""Docked workspace journeys through the built SPA and sealed backend contracts."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Locator, Page, Route, WebSocketRoute, expect

from tests._helpers.picker_routes import OWN_AGENTS
from tests.browser_ui.chat._geometry_helpers import (
    TOLERANCE,
    assert_same_vertical_center,
    assert_symmetric_insets,
    box,
)
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
            "/v1/sessions/search/messages", {"data": [], "has_more": False, "next_cursor": None}
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
        contract.json(f"{environment}/search", list_payload([]))
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


def _assert_workspace_search_centered(
    page: Page, title: str, item_id: str, source_offset: int
) -> None:
    """Measure the matched view rather than an earlier retained, hidden chat."""
    view = _view(page, title)
    expect(view).to_be_visible()
    page.wait_for_function(
        """({view, item, offset}) => {
          const range = [...(CSS.highlights.get('chat-search-active') ?? [])]
            .find(range => view.contains(range.startContainer));
          if (!range || range.toString() !== 'needle') return false;
          const owner = range.startContainer.parentElement.closest('[data-search-item-id]');
          if (owner?.dataset.searchItemId !== item) return false;
          const body = owner.querySelector('.message-markdown, [data-chat-plain-text]');
          const before = document.createRange(); before.selectNodeContents(body);
          before.setEnd(range.startContainer, range.startOffset);
          if (before.toString().length !== offset) return false;
          const rect = range.getBoundingClientRect();
          const viewport = view.querySelector('[role="log"] > div').getBoundingClientRect();
          return rect.height > 0 && viewport.height > 0 &&
            Math.abs(rect.top + rect.height/2 - viewport.top - viewport.height/2) <= 1;
        }""",
        arg={"view": view.element_handle(), "item": item_id, "offset": source_offset},
        timeout=5_000,
    )
    drift = view.evaluate("""view => new Promise(resolve => {
      const samples = [];
      function tick() {
        const range = [...CSS.highlights.get('chat-search-active')]
          .find(range => view.contains(range.startContainer));
        const rect = range.getBoundingClientRect();
        const viewport = view.querySelector('[role="log"] > div').getBoundingClientRect();
        samples.push(rect.top + rect.height/2 - viewport.top - viewport.height/2);
        if (samples.length < 30) requestAnimationFrame(tick); else resolve(samples);
      }
      requestAnimationFrame(tick);
    })""")
    assert max(drift) - min(drift) < 1, drift


def _navigate_chat(page: Page, chat: ChatSessionContract) -> None:
    if page.get_by_role("button", name="Open navigation", exact=True).is_visible():
        page.get_by_role("button", name="Open navigation", exact=True).click()
    page.locator(f'aside [data-sidebar-session-id="{chat.session_id}"]').click()
    expect(page).to_have_url(chat.url)
    expect(_view(page, chat.session_snapshot()["title"])).to_be_visible()


def _open(page: Page, title: str) -> None:
    page.get_by_role("button", name="Open view", exact=True).click()
    page.get_by_role("menuitem", name=title, exact=True).click()


def _command(page: Page, label: str) -> None:
    palette = page.get_by_role("dialog", name="Command palette", exact=True)
    expect(palette).to_have_count(0)
    page.get_by_role("button", name="Search or run a command", exact=True).click()
    page.get_by_test_id("command-palette-input").fill(label)
    page.get_by_role("option", name=label, exact=True).click()
    expect(palette).to_have_count(0)


def _assert_open_padding(page: Page) -> None:
    button = page.get_by_role("banner", name="Application").get_by_role(
        "button", name="Open view", exact=True
    )
    glyph = button.locator("svg")
    expect(glyph).to_have_css("padding", "0px")
    assert box(glyph)["width"] == pytest.approx(16, abs=TOLERANCE)
    assert_same_vertical_center(box(button), box(glyph))
    content = box(glyph)
    label = button.get_by_text("Open", exact=True)
    if label.is_visible():
        end = box(label)
        content["width"] = end["x"] + end["width"] - content["x"]
    assert_symmetric_insets(content, box(button))
    padding = button.evaluate("""el => {
      const s = getComputedStyle(el);
      return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat);
    }""")
    assert min(padding) > 0
    assert max(padding) - min(padding) <= TOLERANCE, padding


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


def _admission_payload(route: Route) -> dict[str, Any]:
    request = route.request
    content_type = request.headers["content-type"]
    if content_type.startswith("application/json"):
        return request.post_data_json
    message = BytesParser(policy=email_policy).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
        + (request.post_data_buffer or b"")
    )
    metadata = next(
        part
        for part in message.iter_parts()
        if part.get_param("name", header="content-disposition") == "metadata"
    )
    return json.loads(metadata.get_content())


@pytest.mark.parametrize("density", ["comfortable", "compact"])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_unified_chat_draft_layout_and_global_commands(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
    density: str,
    theme: str,
) -> None:
    chat = workspace_journey.chats[0]
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(chat.url)
    page.evaluate(
        """({density, theme}) => {
      document.documentElement.dataset.listDensity = density;
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }""",
        {"density": density, "theme": theme},
    )
    expect(page.get_by_role("banner", name="Application")).to_be_visible()
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible()
    composer.fill("A draft retained through layout changes")
    expect(composer).to_have_value("A draft retained through layout changes")
    # Palette actions prove command wiring without claiming delivery of reserved browser chords.
    _command(page, "New view")
    page.get_by_role("menuitem", name="Explorer", exact=True).click()
    expect(page.locator(".dock-pane:not([hidden])")).to_have_count(1)
    expect(_view(page, "Explorer")).to_be_visible()
    _command(page, "Previous view")
    expect(composer).to_be_visible()
    _command(page, "Next view")
    expect(_view(page, "Explorer")).to_be_visible()
    _command(page, "Close focused view")
    expect(page.get_by_role("tab", name="Explorer", exact=True)).to_have_count(0)
    _command(page, "Reopen closed view")
    expect(_view(page, "Explorer")).to_be_visible()
    page.get_by_role("tab", name="Chat A", exact=True).click()
    page.get_by_role("button", name="Search or run a command").click()
    page.get_by_test_id("command-palette-input").fill("Orchestration")
    expect(page.get_by_role("option", name="Orchestration", exact=True)).to_be_visible()
    _capture(page, output_path, "palette-before-escape")
    page.get_by_test_id("command-palette-input").press("Escape")
    expect(page.get_by_role("dialog", name="Command palette")).to_have_count(0)
    expect(composer).to_have_value("A draft retained through layout changes")
    page.get_by_role("button", name="Close navigation", exact=True).click()
    _assert_open_padding(page)
    _capture(page, output_path, "workspace-desktop")
    page.set_viewport_size({"width": 390, "height": 844})
    _assert_open_padding(page)
    expect(page.get_by_role("tab", name="Chat A", exact=True)).to_be_visible()
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


def test_contained_child_breadcrumb_and_middle_click_keep_layout_owner(
    page: Page,
    workspace_journey: WorkspaceJourney,
    chat_session_contract: ChatSessionContract,
    output_path: str,
    browser_errors: list[str],
) -> None:
    first, child = workspace_journey.chats
    source = chat_session_contract
    source.update_session(title="Chat X", workspace="/workspace")
    child.update_session(
        agent_name="Chat B",
        parent_session_id=first.session_id,
        branch={
            "source_conversation_id": source.session_id,
            "reference_only": True,
            "recovery": "replay",
        },
    )
    contract = first.contract
    chats = [first, child, source]
    contract.json("/v1/sessions", list_payload([chat.session_snapshot() for chat in chats]))
    contract.json(
        "/health",
        {
            "sessions": {
                chat.session_id: {"runner_online": True, "host_online": True} for chat in chats
            }
        },
    )
    contract.json("/v1/workbench-workspaces/resolve", workspace_journey.workspace, method="POST")
    for endpoint in ("peer-messages", "branches", "resources/shells"):
        contract.json(f"/v1/sessions/{source.session_id}/{endpoint}", list_payload([]))
    contract.json(f"/v1/sessions/{source.session_id}/runtime-notices", {"data": []})
    contract.json(f"/v1/sessions/{source.session_id}/comments", [])
    first.contract.json(
        f"/v1/sessions/{first.session_id}/child_sessions",
        list_payload([{**child.session_snapshot(), "session_name": "Chat B", "busy": False}]),
    )
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(child.url)
    _open(page, "Changes")
    _navigate_chat(page, first)
    _open(page, "Orchestration")
    _view(page, "Orchestration").get_by_role("button", name="Chat B", exact=True).click()
    expect(_view(page, "Chat B")).to_be_visible()
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    expect(
        page.locator(f'aside [data-sidebar-session-id="{first.session_id}"] [aria-current="page"]')
    ).to_be_visible()
    ancestry = _view(page, "Chat B").get_by_role("navigation", name="Conversation ancestry")
    for button in ("left", "middle"):
        page.get_by_role("tab", name="Chat B", exact=True).click()
        ancestry.get_by_role("button", name="Chat X", exact=True).click(button=button)
        expect(_view(page, "Chat X")).to_be_visible()
        expect(page.get_by_role("tab", name="Chat X", exact=True)).to_have_count(1)
        assert _saved_dock(page)["activeConversationId"] == first.session_id
    root = page.locator(f'aside [data-sidebar-session-id="{source.session_id}"]')
    expand = root.get_by_role("button", name="Expand subchats of Chat X", exact=True)
    if expand.is_visible():
        expand.click()
    row = page.locator(f'aside [data-sidebar-session-id="{child.session_id}"]')
    expect(row).to_be_visible()
    row.click(button="middle")
    expect(_view(page, "Chat B")).to_be_visible()
    expect(page.get_by_role("tab", name="Chat B", exact=True)).to_have_count(1)
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    assert len(page.context.pages) == 1
    _capture(page, output_path, "contained-child-and-breadcrumb-owner-a")
    _navigate_chat(page, child)
    expect(_view(page, "Changes")).to_be_visible()
    expect(page.get_by_role("tab", name="Chat A", exact=True)).to_have_count(0)
    assert _saved_dock(page)["activeConversationId"] == child.session_id
    expect(row.locator('[aria-current="page"]')).to_be_visible()
    page.reload()
    expect(_view(page, "Changes")).to_be_visible()
    assert _saved_dock(page)["activeConversationId"] == child.session_id
    _navigate_chat(page, first)
    expect(page.get_by_role("tab", name="Chat B", exact=True)).to_be_visible()
    expect(page.get_by_role("tab", name="Chat X", exact=True)).to_be_visible()
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    assert browser_errors == []


@pytest.mark.parametrize("completion", ["active", "switched", "closed"])
def test_pane_draft_admission_retry_and_late_owner(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    browser_errors: list[str],
    completion: str,
) -> None:
    journey = workspace_journey
    first, second = journey.chats
    contract = first.contract
    with ExitStack() as stack:
        fresh, global_chat = [
            stack.enter_context(
                contextmanager(chat_session_handle)(page, contract, session_id=sid)
            )
            for sid in ("pane-admitted", "global-admitted")
        ]
        for chat, title in ((fresh, "Pane accepted"), (global_chat, "Global accepted")):
            chat.update_session(title=title, workspace="/workspace")
            for endpoint in ("peer-messages", "branches", "resources/shells"):
                contract.json(f"/v1/sessions/{chat.session_id}/{endpoint}", list_payload([]))
            contract.json(f"/v1/sessions/{chat.session_id}/runtime-notices", {"data": []})
            contract.json(f"/v1/sessions/{chat.session_id}/comments", [])
        admitted = list(journey.chats)
        contract.json(
            "/v1/sessions", lambda _: list_payload([c.session_snapshot() for c in admitted])
        )
        contract.json(
            "/health",
            lambda _: {
                "sessions": {
                    c.session_id: {"runner_online": True, "host_online": True} for c in admitted
                }
            },
        )
        contract.json("/v1/workbench-workspaces/resolve", journey.workspace, method="POST")
        contract.json(
            "/v1/info",
            {
                "accounts_enabled": False,
                "single_user": True,
                "needs_setup": False,
                "sharing_mode": "off",
                "features": {},
                "sandbox_providers": [],
                "managed_sandboxes_enabled": False,
                "sandbox_provider": None,
                "sandbox_provider_capabilities": {},
                "enabled_connections": [],
                "smart_routing_enabled": False,
                "harness_install_enabled": False,
                "installable_harnesses": [],
                "durable_host_initial_input": True,
            },
        )
        contract.json(OWN_AGENTS, list_payload([]))
        contract.json("/v1/skills", {"skills": []})
        pending: list[Route] = []
        handled: set[Route] = set()

        def abort_pending() -> None:
            for route in pending:
                if route not in handled:
                    route.abort()

        stack.callback(abort_pending)

        def create(route: Route) -> None:
            if route.request.method == "POST":
                pending.append(route)
            else:
                route.fallback()

        contract.route(contract._matcher("/v1/sessions"), create)
        page.add_init_script("""localStorage.setItem('omnigent:recent-workspaces',
          JSON.stringify({'browser-chat-host': ['/workspace']}));""")
        page.set_viewport_size({"width": 1600, "height": 1000})
        page.goto(first.url)
        original = _view(page, "Chat A").get_by_label("Message the agent")
        original.fill("Existing A draft")
        _open(page, "Explorer")
        pane = page.locator('.dock-pane[data-focused="true"]')
        pane_id = pane.get_attribute("data-pane-id")
        pane.get_by_role("button", name="Add view to pane", exact=True).click()
        page.get_by_role("menuitem", name="New chat", exact=True).click()
        draft = _view(page, "New chat")
        input_box = draft.get_by_test_id("new-chat-landing-input")
        expect(input_box).to_have_value("")
        input_box.fill("Pane startup input")
        draft.get_by_test_id("new-chat-landing-file-input").set_input_files(
            {
                "name": "context.txt",
                "mimeType": "text/plain",
                "buffer": b"pane attachment bytes",
            }
        )
        draft_id = next(
            v["id"]
            for v in _saved_dock(page)["chats"][0]["layout"]["views"]
            if "draftId" in v["resource"]
        )
        page.get_by_test_id("new-chat-button").click()
        global_input = page.locator('[data-testid="new-chat-landing-input"]:visible')
        expect(global_input).to_have_value("")
        global_input.fill("Global startup input")
        _navigate_chat(page, first)
        page.get_by_role("tab", name="New chat", exact=True).click()
        expect(input_box).to_have_value("Pane startup input")
        expect(original).to_have_value("Existing A draft")
        with page.expect_request(lambda r: r.method == "POST" and r.url.endswith("/v1/sessions")):
            draft.get_by_test_id("new-chat-landing-submit").click()
        expect(draft.get_by_test_id("new-chat-landing-submit")).to_be_disabled()
        assert len(pending) == 1
        payload = _admission_payload(pending[0])
        assert payload["initial_input"]["data"]["content"][0]["text"] == "Pane startup input"
        assert payload["workspace"] == "/workspace"
        assert payload["host_id"] == first.host_id
        assert "parent_session_id" not in payload
        handled.add(pending[0])
        pending[0].fulfill(status=503, json={"detail": "Admission temporarily unavailable"})
        expect(draft.get_by_test_id("new-chat-landing-error")).to_be_visible()
        page.reload()
        expect(input_box).to_have_value("Pane startup input")
        expect(draft.get_by_role("button", name="Remove context.txt", exact=True)).to_be_visible()
        assert draft_id in {
            v["id"] for c in _saved_dock(page)["chats"] for v in c["layout"]["views"]
        }
        with page.expect_request(lambda r: r.method == "POST" and r.url.endswith("/v1/sessions")):
            draft.get_by_test_id("new-chat-landing-submit").click()
        expect(draft.get_by_test_id("new-chat-landing-submit")).to_be_disabled()
        assert len(pending) == 2
        retry = _admission_payload(pending[1])
        assert (
            retry["labels"]["omnigent.client_create_token"]
            == payload["labels"]["omnigent.client_create_token"]
        )
        for request in pending:
            assert b"pane attachment bytes" in (request.request.post_data_buffer or b"")
        expect(page.get_by_role("tab", name="New chat", exact=True)).to_be_visible()
        assert _saved_dock(page)["activeConversationId"] == first.session_id
        if completion == "switched":
            _navigate_chat(page, second)
        elif completion == "closed":
            page.get_by_role("button", name="Close New chat", exact=True).click()
        admitted.append(fresh)
        handled.add(pending[1])
        pending[1].fulfill(json={"id": fresh.session_id})
        expect(
            page.locator(f'aside [data-sidebar-session-id="{fresh.session_id}"]')
        ).to_be_visible()
        expected_owner = second if completion == "switched" else first
        expect(page).to_have_url(expected_owner.url)
        assert _saved_dock(page)["activeConversationId"] == expected_owner.session_id
        if completion == "switched":
            expect(page.get_by_role("tab", name="Pane accepted", exact=True)).to_have_count(0)
            _navigate_chat(page, first)
        if completion != "closed":
            expect(_view(page, "Pane accepted")).to_be_visible()
        layout = next(
            c["layout"]
            for c in _saved_dock(page)["chats"]
            if c["conversationId"] == first.session_id
        )
        assert all(v["id"] != draft_id for v in layout["views"])
        assert len(layout["panes"]) == 2
        target = next(p for p in layout["panes"] if p["id"] == pane_id)
        assert (f"conversation:{fresh.session_id}" in target["viewIds"]) == (
            completion != "closed"
        )
        assert not any(c["conversationId"] == fresh.session_id for c in _saved_dock(page)["chats"])
        expect(page.get_by_role("tab", name="Explorer", exact=True)).to_have_count(1)
        expect(original).to_have_value("Existing A draft")
        _capture(page, output_path, f"pane-admission-{completion}")
        page.reload()
        if completion != "closed":
            expect(_view(page, "Pane accepted")).to_be_visible()
        else:
            expect(page.get_by_role("tab", name="New chat", exact=True)).to_have_count(0)
            expect(page.get_by_role("tab", name="Pane accepted", exact=True)).to_have_count(0)
        if completion == "active":
            page.get_by_test_id("new-chat-button").click()
            expect(global_input).to_have_value("Global startup input")
            with page.expect_request(
                lambda r: r.method == "POST" and r.url.endswith("/v1/sessions")
            ):
                page.locator('[data-testid="new-chat-landing-submit"]:visible').click()
            expect(page.get_by_role("banner", name="Application")).to_be_visible()
            assert len(pending) == 3
            assert (
                _admission_payload(pending[2])["initial_input"]["data"]["content"][0]["text"]
                == "Global startup input"
            )
            admitted.append(global_chat)
            handled.add(pending[2])
            input_id = "saved-first-message"
            global_chat.update_session(
                pending_inputs=[
                    {
                        "pending_id": "startup-queue-entry",
                        "item_id": input_id,
                        "position": 0,
                        "content": [{"type": "input_text", "text": "Global startup input"}],
                    }
                ]
            )
            pending[2].fulfill(json={"id": global_chat.session_id, "initial_input_id": input_id})
            expect(global_input).to_have_count(0)
            expect(page).to_have_url(global_chat.url)
            expect(_view(page, "Global accepted")).to_be_visible()
            assert _saved_dock(page)["activeConversationId"] == global_chat.session_id
            expect(page.get_by_role("tab", name="Pane accepted", exact=True)).to_have_count(0)
            initial = (
                _view(page, "Global accepted")
                .locator('[data-role="user"]')
                .filter(has_text="Global startup input")
            )
            expect(initial).to_have_count(1)
            page.reload()
            expect(initial).to_have_count(1)
            _navigate_chat(page, first)
            expect(_view(page, "Pane accepted")).to_be_visible()
        assert first.event_posts == [] and second.event_posts == []
        assert fresh.event_posts == [] and global_chat.event_posts == []
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
    expect(composer).to_have_value("A draft must not be redirected")
    page.get_by_role("tab", name="notes.py", exact=True).click()
    expect(preview.locator(".view-lines")).to_contain_text("keep this unsaved change")
    assert _saved_dock(page)["activeConversationId"] == first.session_id
    assert editor_handle.evaluate("element => element.isConnected")
    close = page.get_by_role("button", name="Close notes.py", exact=True)
    editor.click()
    _command(page, "Close focused view")
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
