"""Prepared compiled-SPA acceptance; copy into tests/browser_ui after parent freeze."""

from __future__ import annotations

import json
import re
import time
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Page, WebSocketRoute, expect

from tests.browser_ui.conftest import BrowserContract
from tests.browser_ui.test_sessions_appearance import appearance_url as appearance_url


@pytest.mark.parametrize(
    "viewport",
    [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}],
    ids=["desktop", "phone"],
)
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_inbox_immediate_insert_keeps_reader(
    page: Page, browser_contract: BrowserContract, appearance_url: str, viewport: dict, theme: str
) -> None:
    page.set_viewport_size(viewport)
    page.emulate_media(color_scheme=theme)
    now = int(time.time())
    rows = [
        {
            "id": f"reader-{i}",
            "object": "conversation",
            "title": f"Reader {i}",
            "created_at": now - 1000,
            "updated_at": now - 60 - i,
            "labels": {},
            "permission_level": None,
            "pending_elicitations_count": 1,
            "status": "awaiting_input",
            "archived": False,
        }
        for i in range(12)
    ]

    def session_list(request):
        query = parse_qs(urlparse(request.url).query)
        assert query.get("visibility") in (["mine"], ["shared"])
        data = rows if query["visibility"] == ["mine"] and query.get("pinned") != ["true"] else []
        return {
            "object": "list",
            "data": data,
            "has_more": False,
            "first_id": data[0]["id"] if data else None,
            "last_id": data[-1]["id"] if data else None,
        }

    browser_contract.json("/v1/sessions", session_list)
    schema = {
        "type": "object",
        "properties": {
            "branch": {"type": "string", "title": "Branch"},
            **{f"extra_{i}": {"type": "string"} for i in range(14)},
        },
        "required": ["branch"],
    }
    for row in [*rows, {**rows[0], "id": "reader-new"}]:
        browser_contract.json(
            f"/v1/sessions/{row['id']}",
            lambda _request, row=row: {
                **row,
                "items": [],
                "pending_elicitations": [
                    {
                        "elicitation_id": row["id"] + "-prompt",
                        "params": {
                            "mode": "form",
                            "message": "Choose branch",
                            "requestedSchema": schema,
                        },
                    }
                ],
            },
        )
        browser_contract.json(f"/v1/sessions/{row['id']}/comments", [])
    sockets: list[WebSocketRoute] = []
    browser_contract.websocket("**/v1/sessions/updates*", lambda socket: sockets.append(socket))
    page.goto(appearance_url + "/inbox")
    field = page.get_by_role("textbox", name=re.compile("Branch"))
    expect(field).to_be_visible()
    # Make expansion explicit before entering the draft.
    toggle = page.get_by_role("button", name="Approval needed: Reader 0", exact=True)
    toggle.click()
    toggle.click()
    field.fill("owner draft")
    field.evaluate(
        """el => {
            el.focus(); el.setSelectionRange(2,5); window.readerField=el;
            window.readerCard=el.closest('[data-inbox-key]');
            window.readerScroll=el.closest('.overflow-y-auto');
            window.readerScroll.scrollTop=window.readerCard.offsetTop+60;
        }"""
    )
    before = field.evaluate(
        "() => ({key: readerCard.dataset.inboxKey, top: readerCard.getBoundingClientRect().top})"
    )
    # One pushed update immediately inserts a newest card and moves the active
    # card across the recency boundary without navigation or an approval POST.
    rows[0]["updated_at"] = now - 3600
    rows.insert(0, {**rows[1], "id": "reader-new", "title": "New prompt", "updated_at": now + 1})
    assert sockets
    sockets[-1].send(json.dumps({"type": "changed", "items": rows}))
    expect(page.get_by_test_id("inbox-item")).to_have_count(13)
    expect(page.get_by_test_id("inbox-item").first).to_have_attribute(
        "data-inbox-key",
        json.dumps(["approval", "reader-new", "reader-new-prompt"], separators=(",", ":")),
    )
    expect(field).to_have_value("owner draft")
    result = field.evaluate(
        """el => ({same: el===readerField, focus: document.activeElement===el,
            selection:[el.selectionStart,el.selectionEnd], key:readerCard.dataset.inboxKey,
            top:readerCard.getBoundingClientRect().top})"""
    )
    assert result["same"] and result["focus"]
    assert result["selection"] == [2, 5]
    assert result["key"] == before["key"]
    assert abs(result["top"] - before["top"]) <= 2
    # No allowed POST routes: BrowserContract rejects every unexpected backend write.
