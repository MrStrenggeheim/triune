# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Unified search rows, filters and commands through the built workspace SPA."""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Locator, Page, Request, expect

from tests.browser_ui.chat._geometry_helpers import assert_within_viewport, box
from tests.browser_ui.chat.session_contract import list_payload, message_item
from tests.browser_ui.chat.test_unified_workspace import WorkspaceJourney, _capture, _view
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract


def _assert_rows(
    surface: Locator, hits: list[dict[str, Any]], *, current: bool
) -> list[dict[str, Any]]:
    rows = surface.locator("[data-search-result]")
    expect(rows).to_have_count(len(hits))
    expect(rows).to_contain_text([hit["snippet"] for hit in hits])
    snapshot = rows.evaluate_all(
        """rows => rows.map(row => {
        const header = row.firstElementChild;
        const excerpt = row.lastElementChild;
        const time = row.querySelector('time');
        const marks = [...row.querySelectorAll('mark')];
        return {
            kind: row.dataset.searchResult,
            header: header.firstElementChild.textContent.trim(),
            timestamp: time?.dateTime,
            date: time?.textContent,
            excerpt: excerpt.textContent,
            matches: marks.map(mark => mark.textContent),
            singleLine: getComputedStyle(excerpt).whiteSpace === 'nowrap'
                && getComputedStyle(excerpt).textOverflow === 'ellipsis',
            emphasized: marks.every(mark => {
                const style = getComputedStyle(mark);
                return Number(style.fontWeight) >= 600
                    && style.backgroundColor === 'rgba(0, 0, 0, 0)'
                    && style.color !== getComputedStyle(row).color;
            }),
        };
    })"""
    )
    dates = surface.evaluate(
        """(_, hits) => hits.map(hit => new Date(hit.created_at * 1000)
            .toLocaleString(undefined, {dateStyle: 'short', timeStyle: 'short'}))""",
        hits,
    )
    for actual, hit, date in zip(snapshot, hits, dates, strict=True):
        prefix = "" if current else f"{hit['title']}: "
        assert actual["header"] == prefix + hit["sender_name"]
        assert actual["kind"] == hit["kind"]
        assert actual["timestamp"] == (
            datetime.fromtimestamp(hit["created_at"], UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        assert actual["date"] == date
        assert actual["excerpt"] == hit["snippet"]
        source = hit["title"] if hit["kind"] == "chat" else hit["text"]
        ranges = hit["title_ranges"] if hit["kind"] == "chat" else hit["ranges"]
        assert actual["matches"] == [source[span["start"] : span["end"]] for span in ranges]
        assert actual["singleLine"] and actual["emphasized"]
    return snapshot


@pytest.mark.parametrize(
    ("viewport_kind", "theme"),
    [("desktop", "light"), ("desktop", "dark"), ("mobile", "light"), ("mobile", "dark")],
    ids=lambda value: value,
)
def test_unified_search_results_filters_and_commands(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
    viewport_kind: str,
    theme: str,
) -> None:
    first, second = workspace_journey.chats
    second.update_session(title="Needle archive")
    samples = [
        (first, "human", "user", "Owner", "Human needle request.", 50, True, None),
        (first, "final", "assistant", "Orion", "Final needle answer.", 40, False, "final_answer"),
        (
            first,
            "progress",
            "assistant",
            "Orion",
            "Progress needle update.",
            30,
            False,
            "commentary",
        ),
        (first, "unknown", "user", "External input", "Imported needle input.", 20, None, None),
        (
            second,
            "other",
            "assistant",
            "Mira",
            "Archived needle answer.",
            10,
            False,
            "final_answer",
        ),
    ]
    messages: dict[str, list[dict[str, Any]]] = {first.session_id: [], second.session_id: []}
    hits = []
    for chat, item_id, role, sender, text, offset, human, phase in samples:
        created_at = 1_736_935_500 + offset * 60
        messages[chat.session_id].append(
            {
                **message_item(item_id, role, text, response_id=f"turn-{item_id}"),
                "created_at": created_at,
                "user_authored": human,
                "phase": phase,
            }
        )
        start = text.index("needle")
        hits.append(
            {
                "kind": "message",
                "session_id": chat.session_id,
                "title": chat.session_snapshot()["title"],
                "item_id": item_id,
                "role": role,
                "sender_name": sender,
                "user_authored": human,
                "phase": phase,
                "created_at": created_at,
                "text": text,
                "text_start": 0,
                "text_truncated": False,
                "content_hash": hashlib.sha256(text.encode()).hexdigest(),
                "snippet": text,
                "snippet_start": 0,
                "ranges": [{"start": start, "end": start + 6}],
                "occurrence_count": 1,
            }
        )
    preview = "Latest archive preview."
    preview_time = 1_736_935_500 + 60 * 60
    messages[second.session_id].insert(
        0,
        {
            **message_item("latest", "assistant", preview, response_id="turn-latest"),
            "created_at": preview_time,
            "phase": "final_answer",
        },
    )
    title_hit = {
        **hits[-1],
        "kind": "chat",
        "item_id": "latest",
        "created_at": preview_time,
        "text": preview,
        "snippet": preview,
        "content_hash": hashlib.sha256(preview.encode()).hexdigest(),
        "ranges": [],
        "title_ranges": [{"start": 0, "end": 6}],
        "occurrence_count": 0,
    }
    by_filter = {
        "all": [title_hit, *hits],
        "final": [title_hit, hits[0], hits[1], hits[-1]],
        "user": [title_hit, hits[0]],
    }
    requests: list[dict[str, str]] = []

    def search_results(request: Request) -> dict[str, Any]:
        params = {key: values[0] for key, values in parse_qs(urlparse(request.url).query).items()}
        requests.append(params)
        rows = by_filter.get(params.get("message_filter", ""), [])
        if params.get("query") != "needle":
            rows = []
        if session_id := params.get("session_id"):
            rows = [hit for hit in rows if hit["session_id"] == session_id]
        return {"data": rows, "has_more": False, "next_cursor": None}

    browser_contract.json("/v1/sessions/search/messages", search_results)
    for chat in (first, second):
        chat.set_items(messages[chat.session_id])
        browser_contract.json(
            f"/v1/sessions/{chat.session_id}/resources/environments/default/search",
            list_payload([]),
        )
    page.set_viewport_size(
        {
            "width": 390 if viewport_kind == "mobile" else 1440,
            "height": 844 if viewport_kind == "mobile" else 1000,
        }
    )
    page.emulate_media(color_scheme=theme)
    page.goto(first.url)
    if theme == "dark":
        expect(page.locator("html")).to_have_class(re.compile(r"\bdark\b"))
    else:
        expect(page.locator("html")).not_to_have_class(re.compile(r"\bdark\b"))
    composer = _view(page, "Chat A").get_by_label("Message the agent", exact=True)
    expect(composer).to_be_visible(timeout=20_000)
    draft = "Keep my unsent search journey draft"
    composer.fill(draft)
    composer.press("ControlOrMeta+f")
    sidebar = page.get_by_test_id("context-search-sidebar")
    query = sidebar.get_by_role("textbox", name="Search chats", exact=True)
    sidebar.get_by_role("button", name="All chats", exact=True).click()
    query.fill("needle")
    palette = page.get_by_role("dialog", name="Command palette", exact=True)
    filters = [
        ("All", "all", "Entire chat history"),
        ("Final", "final", "User messages and final agent replies; no intermediate updates"),
        ("User", "user", "User messages only"),
    ]
    for scope in ("All chats", "Current chat"):
        sidebar.get_by_role("button", name=scope, exact=True).click()
        current = scope == "Current chat"
        for label, message_filter, tooltip in filters:
            expected = by_filter[message_filter]
            if current:
                expected = [hit for hit in expected if hit["session_id"] == first.session_id]
            control = sidebar.get_by_role("button", name=label, exact=True)
            control.click()
            if not current:
                query.hover()
                control.hover()
                expect(page.get_by_role("tooltip")).to_have_text(tooltip)
                query.click()
            sidebar_rows = _assert_rows(sidebar, expected, current=current)
            expect(sidebar.get_by_role("group", name="Search categories")).to_have_count(0)
            expect(sidebar.get_by_text("Actions", exact=True)).to_have_count(0)
            expect(_view(page, "Chat A")).to_be_visible()
            if not current and message_filter == "all":
                _capture(page, output_path, f"{viewport_kind}-{theme}-search-sidebar")
            page.keyboard.press("ControlOrMeta+k")
            palette_query = palette.get_by_test_id("command-palette-input")
            palette_query.fill("needle")
            expect(palette.get_by_role("button", name=label, exact=True)).to_have_attribute(
                "aria-pressed", "true"
            )
            assert _assert_rows(palette, expected, current=current) == sidebar_rows
            expect(
                palette.locator("[cmdk-group]:has([data-search-result]) [cmdk-group-heading]")
            ).to_have_count(0)
            expect(palette.get_by_role("listbox")).to_have_attribute("data-scrollbar", "hidden")
            assert_within_viewport(box(palette), 390 if viewport_kind == "mobile" else 1440)
            if not current:
                palette_query.hover()
                palette.get_by_role("button", name=label, exact=True).hover()
                expect(page.get_by_role("tooltip")).to_have_text(tooltip)
                palette_query.click()
            if not current and message_filter == "all":
                _capture(page, output_path, f"{viewport_kind}-{theme}-search-palette")
            if current and message_filter == "user":
                palette.get_by_role("button", name="Final", exact=True).click()
                expected = [hits[0], hits[1]]
                _assert_rows(palette, expected, current=True)
            palette_query.press("Escape")
            expect(palette).to_have_count(0)
            expect(query).to_have_value("needle")
            _assert_rows(sidebar, expected, current=current)
    expect(sidebar.get_by_role("button", name="Final", exact=True)).to_have_attribute(
        "aria-pressed", "true"
    )
    expect(page.get_by_role("tab", name="Needle archive", exact=True)).to_have_count(0)
    sidebar.get_by_role("button", name="All chats", exact=True).click()
    sidebar.get_by_role("button", name="All", exact=True).click()
    _assert_rows(sidebar, by_filter["all"], current=False)
    sidebar.locator('[data-search-result="chat"]').click()
    expect(_view(page, "Needle archive")).to_be_visible()
    expect(
        _view(page, "Needle archive").get_by_test_id("context-search-bar").get_by_role("status")
    ).to_have_text("1 matches")
    page.wait_for_function("!CSS.highlights.get('chat-search-active')?.size")

    page.keyboard.press("ControlOrMeta+k")
    palette.get_by_test_id("command-palette-input").fill("needle")
    _assert_rows(palette, by_filter["all"], current=False)
    palette.locator('[data-search-result="message"]').filter(has_text=hits[1]["snippet"]).click()
    expect(palette).to_have_count(0)
    expect(_view(page, "Chat A")).to_be_visible()
    page.wait_for_function(
        """() => {
        const range = [...(CSS.highlights.get('chat-search-active') ?? [])][0];
        return range?.toString() === 'needle'
            && range.startContainer.parentElement.closest('[data-search-item-id]')
                ?.dataset.searchItemId === 'final';
    }""",
        timeout=5_000,
    )
    expect(composer).to_have_value(draft)
    bar = _view(page, "Chat A").get_by_test_id("context-search-bar")
    expect(bar).not_to_contain_text(re.compile(r"In this chat|unavailable", re.IGNORECASE))
    bar.get_by_role("button", name="Close search", exact=True).click()

    page.get_by_role("button", name="Search or run a command", exact=True).click()
    palette.get_by_test_id("command-palette-input").fill("Orchestration")
    palette.get_by_role("option", name="Orchestration", exact=True).click()
    expect(_view(page, "Orchestration")).to_be_visible()
    page.get_by_role("tab", name="Chat A", exact=True).click()
    expect(composer).to_have_value(draft)
    assert first.event_posts == []
    assert browser_errors == []
    needle_requests = [params for params in requests if params.get("query") == "needle"]
    assert all(params.get("include_titles") == "true" for params in needle_requests)
    assert {
        (params.get("session_id"), params.get("message_filter")) for params in needle_requests
    } >= {
        (session_id, value) for session_id in (None, first.session_id) for _, value, _ in filters
    }
