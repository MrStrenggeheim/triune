# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Six bounded journeys against the parent's frozen combined SPA, without a build."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree

import pytest
from playwright.sync_api import Locator, Page, expect

from tests.browser_ui.chat.conftest import chat_session_contract as chat_session_contract
from tests.browser_ui.chat.session_contract import list_payload, message_item
from tests.browser_ui.chat.test_transcript_rendering import (
    _SEPARATOR_MERMAID,
    _seed_assistant_message,
)
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import _BUILD_OUTPUT
from tests.browser_ui.files.test_file_line_navigation import (
    BrowserSession,
    _open_viewer,
)

pytestmark = pytest.mark.timeout(60)
_CHART = "flowchart LR\n  A[Load] --> B[Ready]"
_MARKDOWN = f"```mermaid\n{_CHART}\n```"


@pytest.fixture(scope="session")
def engine_path() -> str:
    owners = list((_BUILD_OUTPUT / "assets").glob("mermaidTheme-*.js"))
    assert len(owners) == 1, "Expected the frozen combined build's Mermaid owner chunk"
    targets = re.findall(r"import\(\s*[\"'`]([^\"'`]+)[\"'`]\s*\)", owners[0].read_text())
    assert len(targets) == 1, "Build must contain the new single deferred engine import"
    target = owners[0].parent / targets[0]
    assert target.is_file(), target
    return "/assets/" + target.name


def _requests(page: Page, engine: str) -> list[str]:
    requests: list[str] = []
    page.on(
        "request",
        lambda request: (
            requests.append(request.url) if urlparse(request.url).path == engine else None
        ),
    )
    page.set_default_timeout(8000)
    page.set_default_navigation_timeout(8000)
    expect.set_options(timeout=8000)
    return requests


def _evidence(output_path: str, name: str, value: dict) -> None:
    output = Path(output_path)
    output.mkdir(parents=True, exist_ok=True)
    (output / f"{name}.json").write_text(json.dumps(value, indent=2) + "\n")


def _controls(page: Page, frame: Locator, output_path: str, name: str) -> None:
    svg = frame.locator('svg[id^="mermaid-"]').first
    original = svg.evaluate("element => element.outerHTML")
    frame.get_by_role("button", name="View fullscreen", exact=True).click()
    close = page.get_by_role("button", name="Exit fullscreen", exact=True)
    expect(close).to_be_visible(timeout=8000)
    expanded = close.locator("xpath=..").locator('svg[id^="mermaid-"]')
    assert expanded.evaluate("element => element.outerHTML") == original
    page.keyboard.press("Escape")
    expect(close).to_have_count(0)
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    frame.get_by_role("button", name="Copy Code", exact=True).click()
    assert page.evaluate("navigator.clipboard.readText()").rstrip("\n") == _CHART
    for label in ("MMD", "SVG"):
        frame.get_by_role("button", name="Download diagram", exact=True).click()
        with page.expect_download(timeout=8000) as pending:
            page.get_by_role("button", name=label, exact=True).click()
        target = Path(output_path) / f"{name}.{label.lower()}"
        pending.value.save_as(target)
        if label == "MMD":
            assert target.read_text().rstrip("\n") == _CHART
        else:
            exported = ElementTree.fromstring(target.read_bytes())
            assert exported.tag.endswith("svg")
            assert "Ready" in "".join(exported.itertext())
            assert not any(
                node.tag.rsplit("}", 1)[-1] in {"script", "iframe"} for node in exported.iter()
            )


@pytest.mark.parametrize(
    "entry", ["chat", "reasoning", "file-preview", "editor", "escaped-recovery"]
)
def test_lazy_mermaid_entrypoints(
    page: Page, request: pytest.FixtureRequest, engine_path: str, output_path: str, entry: str
) -> None:
    """Plain/source content stays engine-free, then each existing renderer loads it."""
    requests = _requests(page, engine_path)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    output = Path(output_path)
    output.mkdir(parents=True, exist_ok=True)
    if entry in {"file-preview", "editor"}:
        journey = request.getfixturevalue("workspace_journey")
        chat = journey.chats[0]
        session = BrowserSession(chat.contract, session_id=chat.session_id)
        path = "loading-audit.md"
        environment = (
            f"/v1/workbench-workspaces/{journey.workspace['id']}/resources/environments/default"
        )
        listing = list_payload(
            [{"path": path, "name": path, "type": "file", "bytes": len(_MARKDOWN)}]
        )
        for suffix in ("", "/", "/workspace"):
            chat.contract.json(f"{environment}/filesystem{suffix}", listing)
        chat.contract.json(
            f"{environment}/filesystem/{path}",
            {
                "object": "session.environment.filesystem.file_content",
                "path": path,
                "content": _MARKDOWN,
                "encoding": "utf-8",
                "content_type": "text/markdown",
                "bytes": len(_MARKDOWN),
            },
        )
        viewer = _open_viewer(
            page, session, path, {"diffActive": False, "previewableViewMode": "source"}
        )
        expect(viewer).to_contain_text("flowchart LR", timeout=8000)
        assert not requests, "Mermaid engine loaded in the file's Source mode"
        viewer.get_by_role("button", name=re.compile(r"^View mode")).click()
        page.get_by_role(
            "menuitem", name="Preview" if entry == "file-preview" else "Edit", exact=True
        ).click()
        frame = viewer.locator(".chat-mermaid").first
        if entry == "editor":
            expect(viewer.locator(".tiptap pre")).to_contain_text(_CHART, timeout=8000)
    else:
        chat = request.getfixturevalue("chat_session_contract")
        _seed_assistant_message(chat, "Loading audit ready")
        page.goto(chat.url)
        expect(page.get_by_text("Loading audit ready", exact=True)).to_be_visible(timeout=8000)
        assert not requests, "Mermaid engine loaded for a plain transcript"
        if entry == "reasoning":
            chat.set_items(
                [
                    message_item("result", "assistant", "Review reasoning", response_id="diagram"),
                    {
                        "id": "reasoning",
                        "response_id": "diagram",
                        "type": "reasoning",
                        "status": "completed",
                        "summary": [{"type": "summary_text", "text": _MARKDOWN}],
                    },
                ]
            )
        else:
            _seed_assistant_message(
                chat, _SEPARATOR_MERMAID if entry == "escaped-recovery" else _MARKDOWN
            )
        page.reload()
        if entry == "reasoning":
            disclosure = page.get_by_role(
                "button", name=re.compile(r"^(Worked|Thought|Thinking)")
            ).first
            expect(disclosure).to_be_visible(timeout=8000)
            if disclosure.inner_text().startswith("Worked"):
                disclosure.click()
            page.get_by_role("button", name=re.compile(r"^(Thought|Thinking)")).first.click()
        frame = (
            page.get_by_test_id("mermaid-escaped")
            if entry == "escaped-recovery"
            else page.locator(".chat-mermaid").first
        )
    expect(frame.locator('svg[id^="mermaid-"]').first).to_be_visible(timeout=8000)
    assert len(requests) == 1, requests
    if entry == "escaped-recovery":
        expect(frame).to_contain_text("one semicolon escaped", timeout=8000)
        expect(frame.locator("details")).to_contain_text("punctuation; retry me")
    else:
        _controls(page, frame, output_path, entry)
    assert len(requests) == 1, "Source/export/fullscreen fetched the engine again"
    assert not errors, errors
    page.screenshot(path=str(output / f"{entry}.png"))
    _evidence(
        output_path,
        entry,
        {
            "entry": entry,
            "enginePath": engine_path,
            "engineRequests": requests,
            "pageErrors": errors,
            "controlsApplicable": entry != "escaped-recovery",
        },
    )


def test_failed_engine_chunk_shows_error_then_reload_recovers(
    page: Page, chat_session_contract, engine_path: str, output_path: str
) -> None:
    """The existing error UI contains a failed import; a fresh document can recover."""
    requests = _requests(page, engine_path)
    chat = chat_session_contract
    _seed_assistant_message(chat, "Loading audit ready")
    page.goto(chat.url)
    expect(page.get_by_text("Loading audit ready", exact=True)).to_be_visible(timeout=8000)
    assert not requests
    matcher = re.compile(re.escape(chat.base_url + engine_path) + r"$")

    def unavailable(route):
        route.fulfill(status=503, content_type="text/javascript", body="Engine unavailable")

    page.context.route(matcher, unavailable)
    _seed_assistant_message(chat, _MARKDOWN)
    page.reload()
    card = page.get_by_test_id("mermaid-error")
    expect(card).to_contain_text("Mermaid couldn't render this diagram", timeout=8000)
    expect(card).to_contain_text("Failed to fetch dynamically imported module")
    expect(card.locator("details")).to_contain_text(_CHART)
    expect(page.get_by_label("Message the agent")).to_be_editable(timeout=8000)
    page.context.unroute(matcher, unavailable)
    # No native same-document retry is claimed for a rejected ES module.
    page.reload()
    expect(page.locator('.chat-mermaid svg[id^="mermaid-"]').first).to_be_visible(timeout=8000)
    expect(page.get_by_test_id("mermaid-error")).to_have_count(0)
    _evidence(
        output_path,
        "failed-chunk",
        {
            "engineRequests": requests,
            "recoveredAfterAssetRestoredAndReloaded": True,
            "nativeSameDocumentRetryClaimed": False,
        },
    )
