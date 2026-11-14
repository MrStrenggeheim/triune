# Modified for Triune.
"""Message search shares session ACLs while keeping source offsets and paging stable."""

from __future__ import annotations

import hashlib
import sqlite3
from functools import partial
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from omnigent.db.db_models import workspace_scope
from omnigent.entities import FunctionCallOutputData, MessageData, NewConversationItem
from omnigent.server.auth import LEVEL_OWNER, LEVEL_READ
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.stores.conversation_store.message_search import (
    MAX_SEARCH_OCCURRENCES,
    MAX_SEARCH_TEXT,
    decode_search_cursor,
    encode_search_cursor,
    literal_matcher,
    sqlite_message_search,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore


@pytest.fixture(params=["conversation_store", "split_db_conversation_store"])
def store(request: pytest.FixtureRequest) -> SqlAlchemyConversationStore:
    return request.getfixturevalue(request.param)


def _message(text: str, role: str = "user", **metadata) -> NewConversationItem:
    return NewConversationItem(
        type="message",
        response_id="search-response",
        data=MessageData.model_validate(
            {
                "role": role,
                **({"agent": "Actual actor"} if role == "assistant" else {}),
                "content": [
                    {"type": "input_text" if role == "user" else "output_text", "text": text}
                ],
                **metadata,
            }
        ),
    )


def test_message_search_unicode_ranges_raw_blocks_and_bounded_text(store, monkeypatch) -> None:
    monkeypatch.setattr(
        "omnigent.stores.conversation_store.sqlalchemy_store.now_epoch", lambda: 100
    )
    conv = store.create_conversation(title="Notes", agent_id="a" * 32)
    message = _message("😀 **Écho**\n")
    message.data.content.append({"type": "input_text", "text": "éCHO İ i"})
    items = store.append(conv.id, [message, _message("😀" + "x" * 40_000 + "😀 écho end")])
    page = store.search_messages("ÉCHO", conversation_id=conv.id)
    first, last = page.data
    assert first.item_id == items[0].id
    assert first.text == "😀 **Écho**\n éCHO İ i"
    assert [(r.start, r.end) for r in first.ranges] == [(5, 9), (13, 17)]
    assert first.occurrence_count == 2
    assert first.text_start == 0 and not first.text_truncated
    assert first.content_hash == hashlib.sha256(first.text.encode()).hexdigest()
    assert (
        first.text.encode("utf-16-le")[first.snippet_start * 2 :]
        .decode("utf-16-le")
        .startswith(first.snippet)
    )
    assert last.item_id == items[1].id and last.text_truncated
    assert len(last.text) <= MAX_SEARCH_TEXT
    full_text = "😀" + "x" * 40_000 + "😀 écho end"
    assert (
        full_text.encode("utf-16-le")[last.text_start * 2 :]
        .decode("utf-16-le")
        .startswith(last.text)
    )
    assert last.occurrence_count == 1
    assert store.search_messages("i", conversation_id=conv.id).data[0].occurrence_count == 2
    assert "total" not in page.model_dump()


@pytest.mark.parametrize(
    "query,decoy", [("50%", "500"), ("a_b", "a-b"), ("x/y", "xy"), ("[a].*", "aaa")]
)
def test_message_search_literal_special_characters(store, query, decoy) -> None:
    conv = store.create_conversation(agent_id="a" * 32)
    items = store.append(conv.id, [_message(f"{query} and {query}"), _message(decoy)])
    page = store.search_messages(query)
    assert [hit.item_id for hit in page.data] == [items[0].id]
    assert page.data[0].occurrence_count == 2


def test_message_search_pages_all_messages_not_history_window(store, monkeypatch) -> None:
    monkeypatch.setattr(
        "omnigent.stores.conversation_store.sqlalchemy_store.now_epoch", lambda: 100
    )
    convs = [store.create_conversation(title=str(i), agent_id="a" * 32) for i in range(3)]
    expected = []
    for conv in sorted(convs, key=lambda c: c.id):
        items = store.append(conv.id, [_message(f"needle {i}") for i in range(45)])
        expected.extend(item.id for item in items)
        store.append(
            conv.id,
            [
                NewConversationItem(
                    type="function_call_output",
                    response_id="tool",
                    data=FunctionCallOutputData(call_id="call", output="needle tool output"),
                )
            ],
        )
    store.append(convs[0].id, [_message("unmatched newer tail") for _ in range(110)])
    found, cursor = [], None
    statements = []

    def record(_conn, _cursor, statement, _params, _context, _many):
        if "conversation_items" in statement and statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(store._conv_engine, "before_cursor_execute", record)
    try:
        while True:
            page = store.search_messages("needle", limit=7, cursor=cursor)
            found.extend(hit.item_id for hit in page.data)
            if not page.has_more:
                assert page.next_cursor is None
                break
            assert page.next_cursor and page.next_cursor != cursor
            cursor = page.next_cursor
            # Mutable session-list timestamps cannot reorder message pages.
            store.update_conversation(convs[0].id, title="renamed")
    finally:
        event.remove(store._conv_engine, "before_cursor_execute", record)
    assert found == expected
    assert all("LIMIT" in statement and "COUNT(" not in statement for statement in statements)
    assert len(store.search_messages("needle", conversation_id=convs[0].id, limit=100).data) == 45


@pytest.mark.parametrize("include_titles", [False, True])
def test_message_search_acl_cursor_binding_and_revocation(store, include_titles) -> None:
    search = partial(store.search_messages, include_titles=include_titles)
    perms = SqlAlchemyPermissionStore(str(store._engine.url))
    for user in ("alice", "bob"):
        perms.ensure_user(user)
    owned = store.create_conversation(title="needle", agent_id="a" * 32)
    shared = store.create_conversation(title="needle", agent_id="a" * 32)
    private = store.create_conversation(title="needle", agent_id="a" * 32)
    archived = store.create_conversation(title="needle", agent_id="a" * 32)
    for conv in (owned, shared, private, archived):
        store.append(conv.id, [_message("needle") for _ in range(3)])
        perms.grant("alice" if conv == owned else "bob", conv.id, LEVEL_OWNER)
    for conv in (shared, archived):
        perms.grant("alice", conv.id, LEVEL_READ)
    store.update_conversation(archived.id, archived=True)
    visible = search("needle", accessible_by="alice")
    assert {hit.session_id for hit in visible.data} == {owned.id, shared.id}
    assert {hit.session_id for hit in search("needle", owned_by="alice").data} == {owned.id}
    assert {
        hit.session_id for hit in search("needle", accessible_by="alice", shared_only=True).data
    } == {shared.id}
    assert {
        hit.session_id for hit in search("needle", accessible_by="alice", archived_only=True).data
    } == {archived.id}
    assert search("needle", accessible_by="alice", conversation_id=private.id).data == []
    page = search("needle", accessible_by="alice", limit=1)
    assert page.next_cursor
    for changed in (
        {"query": "other"},
        {"accessible_by": "bob"},
        {"conversation_id": owned.id},
        {"include_archived": True},
        {"shared_only": True},
    ):
        params = {
            "query": "needle",
            "accessible_by": "alice",
            "cursor": page.next_cursor,
            **changed,
        }
        with pytest.raises(ValueError, match="cursor"):
            search(**params)
    with workspace_scope(42):
        with pytest.raises(ValueError, match="cursor"):
            search("needle", accessible_by="alice", cursor=page.next_cursor)
    for conv in (owned, shared):
        perms.revoke("alice", conv.id)
    assert search("needle", accessible_by="alice", cursor=page.next_cursor).data == []


def test_message_search_child_access_follows_parent_on_every_page(store) -> None:
    perms = SqlAlchemyPermissionStore(store.storage_location)
    for user in ("alice", "bob"):
        perms.ensure_user(user)
    parent = store.create_conversation(agent_id="a" * 32)
    child = store.create_conversation(agent_id="a" * 32, parent_conversation_id=parent.id)
    nested = store.create_conversation(agent_id="a" * 32, parent_conversation_id=child.id)
    perms.grant("bob", parent.id, LEVEL_OWNER)
    perms.grant("alice", parent.id, LEVEL_READ)
    # Bundled child creation can leave a direct grant after parent access ends.
    perms.grant("alice", child.id, LEVEL_OWNER)
    for conv in (child, nested):
        store.append(conv.id, [_message("needle") for _ in range(3)])
    pages = {
        conv.id: store.search_messages(
            "needle", conversation_id=conv.id, accessible_by="alice", limit=1
        )
        for conv in (child, nested)
    }
    assert all(len(page.data) == 1 and page.next_cursor for page in pages.values())
    assert store.search_messages("needle", conversation_id=child.id, owned_by="alice").data == []
    assert store.search_messages(
        "needle", conversation_id=child.id, accessible_by="alice", shared_only=True
    ).data
    perms.revoke("alice", parent.id)
    for conv in (child, nested):
        for cursor in (None, pages[conv.id].next_cursor):
            assert (
                store.search_messages(
                    "needle", conversation_id=conv.id, accessible_by="alice", cursor=cursor
                ).data
                == []
            )


def test_message_search_explicit_chat_supports_public_and_admin_access(store) -> None:
    from omnigent.server.auth import RESERVED_USER_PUBLIC

    perms = SqlAlchemyPermissionStore(store.storage_location)
    for user in ("alice", "bob", RESERVED_USER_PUBLIC):
        perms.ensure_user(user)
    parent = store.create_conversation(agent_id="a" * 32)
    child = store.create_conversation(agent_id="a" * 32, parent_conversation_id=parent.id)
    store.append(child.id, [_message("needle")])
    perms.grant("bob", parent.id, LEVEL_OWNER)
    perms.grant(RESERVED_USER_PUBLIC, parent.id, LEVEL_READ)
    assert store.search_messages("needle", conversation_id=child.id, accessible_by="alice").data
    perms.revoke(RESERVED_USER_PUBLIC, parent.id)
    assert (
        store.search_messages("needle", conversation_id=child.id, accessible_by="alice").data == []
    )
    perms.set_admin("alice", True)
    assert store.search_messages("needle", conversation_id=child.id, accessible_by="alice").data


@pytest.mark.parametrize(
    "prefix", ["😀\x00", "😀\x00" + "x\x00" * 40_000], ids=["nul-prefix", "bounded-nul-prefix"]
)
def test_message_search_offsets_address_raw_source_with_nuls(store, prefix) -> None:
    conv = store.create_conversation(agent_id="a" * 32)
    raw = prefix + "needle"
    store.append(conv.id, [_message(raw)])
    hit = store.search_messages("needle", conversation_id=conv.id).data[0]
    source = raw.encode("utf-16-le")
    assert source[hit.text_start * 2 :].decode("utf-16-le").startswith(hit.text)
    match = hit.ranges[0]
    assert (
        source[(hit.text_start + match.start) * 2 : (hit.text_start + match.end) * 2].decode(
            "utf-16-le"
        )
        == "needle"
    )
    assert hit.content_hash == hashlib.sha256(hit.text.encode()).hexdigest()


@pytest.mark.parametrize(
    "position,created_at",
    [(2**31, 0), (10**100, 0), (-1, 0), (True, 0), (0, 2**31), (0, -(2**31) - 1), (0, 10**100)],
)
def test_message_search_cursor_rejects_unrepresentable_integers(position, created_at) -> None:
    cursor = encode_search_cursor("scope", "a" * 32, position, "b" * 32, created_at)
    with pytest.raises(ValueError, match="cursor"):
        decode_search_cursor(cursor, "scope")


@pytest.mark.parametrize("cursor", ["invalid", "W10", "e30", "x" * 1025])
def test_message_search_rejects_bad_cursor(store, cursor) -> None:
    with pytest.raises(ValueError, match="cursor"):
        store.search_messages("needle", cursor=cursor)


def test_message_search_scope_workspace_and_query_bounds(store) -> None:
    conv = store.create_conversation(agent_id="a" * 32)
    store.append(conv.id, [_message("needle")])
    with workspace_scope(42):
        assert store.search_messages("needle").data == []
    assert store.search_messages("").data == []
    for query in ("x" * 513, "nul\x00query"):
        with pytest.raises(ValueError, match="query"):
            store.search_messages(query)
    for limit in (0, 101):
        with pytest.raises(ValueError, match="limit"):
            store.search_messages("needle", limit=limit)


def test_message_search_dense_matches_are_explicitly_truncated(store) -> None:
    conv = store.create_conversation(agent_id="a" * 32)
    store.append(conv.id, [_message("😀a" * (MAX_SEARCH_OCCURRENCES + 20))])
    hit = store.search_messages("a").data[0]
    assert hit.text_truncated and hit.text_start == 0
    assert hit.occurrence_count == len(hit.ranges) == MAX_SEARCH_OCCURRENCES
    assert hit.ranges[0].start == 2 and hit.ranges[0].end == 3
    assert hit.text.count("a") == MAX_SEARCH_OCCURRENCES


def test_message_search_all_chat_scope_includes_side_chats_and_children(store) -> None:
    parent = store.create_conversation(agent_id="a" * 32)
    child = store.create_conversation(agent_id="a" * 32, parent_conversation_id=parent.id)
    side = store.create_conversation(agent_id="a" * 32)
    store.set_labels(side.id, {SIDE_CHAT_LABEL_KEY: "1"})
    for conv in (parent, child, side):
        store.append(conv.id, [_message("needle")])
    assert {hit.session_id for hit in store.search_messages("needle").data} == {
        parent.id,
        child.id,
        side.id,
    }
    assert store.search_messages("needle", conversation_id=child.id).data[0].session_id == child.id
    assert store.search_messages("needle", conversation_id=side.id).data[0].session_id == side.id


def test_sqlite_message_search_deadline_and_connection_cleanup() -> None:
    with sqlite3.connect(":memory:") as connection:
        with pytest.raises(sqlite3.OperationalError, match="interrupted"):
            with sqlite_message_search(connection, literal_matcher("needle"), timeout_ms=0):
                connection.execute(
                    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) "
                    "SELECT SUM(x) FROM n"
                ).fetchone()
        # Neither the timeout nor the query closure may leak to the pooled connection.
        assert connection.execute(
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) "
            "SELECT MAX(x) FROM n"
        ).fetchone() == (10000,)


def test_sqlite_message_search_checks_deadline_inside_matcher(monkeypatch) -> None:
    from omnigent.stores.conversation_store import message_search

    # A single-row query never reaches the SQLite VM's progress callback.
    ticks = iter([0.0, 0.0, 0.0, 0.002])
    monkeypatch.setattr(message_search, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    with sqlite3.connect(":memory:") as connection:
        with pytest.raises(sqlite3.OperationalError, match="interrupted"):
            with sqlite_message_search(connection, literal_matcher("needle"), timeout_ms=1):
                connection.execute(
                    "SELECT omnigent_message_matches(?)", ("x" * (2 * MAX_SEARCH_TEXT),)
                ).fetchone()
        assert connection.execute("SELECT 1").fetchone() == (1,)


def test_sqlite_message_search_matches_across_chunk_boundary() -> None:
    with sqlite3.connect(":memory:") as connection:
        with sqlite_message_search(connection, literal_matcher("😀écho"), timeout_ms=1000):
            assert connection.execute(
                "SELECT omnigent_message_matches(?)", ("x" * (MAX_SEARCH_TEXT - 2) + "😀ÉCHO",)
            ).fetchone() == (1,)


def test_all_chat_search_authorizes_branch_and_delegate_roots_on_every_page(store) -> None:
    """Branches keep independent grants; nested delegates follow root access after revocation."""
    perms = SqlAlchemyPermissionStore(store.storage_location)
    for user in ("alice", "bob"):
        perms.ensure_user(user)
    shared = store.create_conversation(title="shared root", agent_id="a" * 32)
    private = store.create_conversation(title="private root", agent_id="a" * 32)
    perms.grant("bob", shared.id, LEVEL_OWNER)
    perms.grant("bob", private.id, LEVEL_OWNER)
    perms.grant("alice", shared.id, LEVEL_READ)
    child = store.create_conversation(agent_id="a" * 32, parent_conversation_id=shared.id)
    nested = store.create_conversation(agent_id="a" * 32, parent_conversation_id=child.id)
    inaccessible_child = store.create_conversation(
        title="private delegate",
        agent_id="a" * 32,
        parent_conversation_id=private.id,
    )
    # A stale direct child grant never replaces root access.
    perms.grant("alice", inaccessible_child.id, LEVEL_OWNER)
    branch = store.fork_conversation(private.id, title="independently shared branch")
    hidden_branch = store.fork_conversation(shared.id, title="private branch")
    for conv in (branch, hidden_branch):
        store.set_labels(conv.id, {SIDE_CHAT_LABEL_KEY: "1"})
        perms.grant("bob", conv.id, LEVEL_OWNER)
    perms.grant("alice", branch.id, LEVEL_READ)
    for conv in (shared, private, child, nested, inaccessible_child, branch, hidden_branch):
        store.append(conv.id, [_message("needle " + (conv.title or conv.id))])
    expected = {shared.id, child.id, nested.id, branch.id}
    for scope in ({"accessible_by": "alice"}, {"accessible_by": "alice", "shared_only": True}):
        seen, cursor = set(), None
        while True:
            page = store.search_messages("needle", limit=1, cursor=cursor, **scope)
            seen.update(hit.session_id for hit in page.data)
            assert not any(
                "private" in hit.text or "private" in (hit.title or "") for hit in page.data
            )
            if not page.has_more:
                break
            assert page.next_cursor and page.next_cursor != cursor
            cursor = page.next_cursor
        assert seen == expected
    assert store.search_messages("needle", owned_by="alice").data == []
    first = store.search_messages("needle", accessible_by="alice", limit=1)
    assert first.next_cursor
    perms.grant("alice", child.id, LEVEL_OWNER)
    perms.revoke("alice", shared.id)
    assert {
        hit.session_id for hit in store.search_messages("needle", accessible_by="alice").data
    } == {branch.id}
    perms.revoke("alice", branch.id)
    for cursor in (None, first.next_cursor):
        assert store.search_messages("needle", accessible_by="alice", cursor=cursor).data == []


def test_search_newest_date_and_stable_ties_across_message_and_title_pages(store, monkeypatch):
    clock = [100]
    monkeypatch.setattr(
        "omnigent.stores.conversation_store.sqlalchemy_store.now_epoch", lambda: clock[0]
    )
    convs = [store.create_conversation(title="needle", agent_id="a" * 32) for _ in range(2)]
    clock[0] = 300
    first = store.append(convs[0].id, [_message("needle newest")])[0]
    other = store.append(convs[1].id, [_message("needle tie")])[0]
    clock[0] = 200
    older = store.append(convs[0].id, [_message("needle older, later position")])[0]
    expected = sorted(
        [
            (300, convs[0].id, 0, first.id, "message"),
            (300, convs[1].id, 0, other.id, "chat"),
            (300, convs[1].id, 0, other.id, "message"),
            (200, convs[0].id, 1, older.id, "chat"),
            (200, convs[0].id, 1, older.id, "message"),
        ],
        key=lambda value: (-value[0], *value[1:]),
    )
    seen, cursor = [], None
    while True:
        page = store.search_messages("needle", include_titles=True, limit=1, cursor=cursor)
        seen.extend((hit.created_at, hit.session_id, hit.item_id, hit.kind) for hit in page.data)
        if not page.has_more:
            assert page.next_cursor is None
            break
        cursor = page.next_cursor
        # Updated-at changes cannot move either kind through the date cursor.
        clock[0] = 900
        store.update_conversation(convs[0].id, title="needle renamed")
    assert seen == [(date, cid, item_id, kind) for date, cid, _pos, item_id, kind in expected]
    for change in ({"message_filter": "user"}, {"include_titles": False}):
        first_page = store.search_messages("needle", include_titles=True, limit=1)
        with pytest.raises(ValueError, match="cursor"):
            store.search_messages(
                "needle", cursor=first_page.next_cursor, **{"include_titles": True, **change}
            )


def test_search_filters_trusted_humans_final_agents_and_legacy_history(store):
    conv = store.create_conversation(title="No title match", agent_id="a" * 32)
    peer = {
        "kind": "peer",
        "message_id": "peer-message",
        "destination_conversation_id": conv.id,
        "source_agent_name": "Peer actor",
    }
    cases = [
        ("legacy user", "user", {}, False, False),
        ("human quoting System: final_answer", "user", {"user_authored": True}, True, True),
        ("legacy assistant", "assistant", {}, False, False),
        ("progress", "assistant", {"phase": "commentary"}, False, False),
        ("answer", "assistant", {"phase": "final_answer"}, False, True),
        ("interrupted", "assistant", {"phase": "final_answer", "interrupted": True}, False, False),
        ("meta", "user", {"user_authored": True, "is_meta": True}, False, False),
        ("peer", "user", {"user_authored": True, "communication": peer}, False, False),
        ("peer answer", "user", {"phase": "final_answer", "communication": peer}, False, True),
        (
            "system",
            "user",
            {"user_authored": True, "communication": {**peer, "kind": "system"}},
            False,
            False,
        ),
        (
            "external",
            "user",
            {"user_authored": True, "communication": {**peer, "kind": "external"}},
            False,
            False,
        ),
    ]
    messages = [
        _message("needle " + label, role, **metadata) for label, role, metadata, *_ in cases
    ]
    for message in messages:
        message.created_by = "alice@example.test"
    items = store.append(conv.id, messages)
    # More than one decode batch of ineligible messages cannot hide older eligible hits.
    tail = store.append(conv.id, [_message("needle unknown tail") for _ in range(70)])
    for message_filter, expected in (
        ("all", {item.id for item in [*items, *tail]}),
        ("user", {item.id for item, case in zip(items, cases, strict=True) if case[3]}),
        ("final", {item.id for item, case in zip(items, cases, strict=True) if case[4]}),
    ):
        found, cursor = [], None
        while True:
            page = store.search_messages(
                "needle", message_filter=message_filter, limit=1, cursor=cursor
            )
            found.extend(page.data)
            if not page.has_more:
                break
            assert page.data and page.next_cursor
            cursor = page.next_cursor
        selected = {hit.item_id for hit in found}
        assert selected == expected
        by_id = {hit.item_id: hit for hit in found}
        if message_filter == "all":
            assert by_id[items[0].id].user_authored is False
            assert by_id[items[1].id].sender_name == "alice@example.test"
            assert by_id[items[4].id].sender_name == "Actual actor"
            assert by_id[items[4].id].phase == "final_answer"
            assert by_id[items[7].id].sender_name == "Peer actor"
    with pytest.raises(ValueError, match="filter"):
        store.search_messages("needle", message_filter="unknown")


def test_search_title_utf16_latest_preview_empty_fallback_and_one_batch(store, monkeypatch):
    clock = [100]
    monkeypatch.setattr(
        "omnigent.stores.conversation_store.sqlalchemy_store.now_epoch", lambda: clock[0]
    )
    convs = [store.create_conversation(title="😀 ÉCHO 50%_/", agent_id="a" * 32) for _ in range(4)]
    latest = {}
    for conv in convs[:-1]:
        store.append(conv.id, [_message("old preview")])
        clock[0] += 10
        latest[conv.id] = store.append(
            conv.id,
            [
                _message(
                    "😀 Latest **raw** beginning " + "x" * 400, "assistant", phase="commentary"
                )
            ],
        )[0]
    statements = []

    def record(_conn, _cursor, statement, _params, _context, _many):
        if "conversation_items" in statement:
            statements.append(statement)

    event.listen(store._conv_engine, "before_cursor_execute", record)
    try:
        page = store.search_messages("écho 50%_/", include_titles=True)
    finally:
        event.remove(store._conv_engine, "before_cursor_execute", record)
    assert len(statements) == 1
    assert len(page.data) == 4 and all(hit.kind == "chat" for hit in page.data)
    assert [hit.created_at for hit in page.data] == [130, 120, 110, 100]
    for hit in page.data:
        assert [(r.start, r.end) for r in hit.title_ranges] == [(3, 13)]
        assert hit.ranges == [] and hit.occurrence_count == 0 and hit.text_start == 0
        if hit.session_id in latest:
            assert hit.item_id == latest[hit.session_id].id
            assert hit.snippet == ("😀 Latest **raw** beginning " + "x" * 400)[:240]
            assert hit.sender_name == "Actual actor" and hit.phase == "commentary"
        else:
            assert hit.item_id == hit.session_id and hit.snippet == "" and hit.sender_name is None
    # Title identity remains searchable independently of a message-content filter.
    assert (
        len(store.search_messages("écho 50%_/", include_titles=True, message_filter="user").data)
        == 4
    )
    assert store.search_messages("écho 50%_/").data == []


def test_search_filters_and_title_preview_decode_encoded_payloads(store, monkeypatch):
    monkeypatch.setattr(store, "_encode_item_data", lambda value: "encoded:" + value[::-1])
    monkeypatch.setattr(
        store,
        "_decode_item_data_batch",
        lambda values: [value[len("encoded:") :][::-1] for value in values],
    )
    conv = store.create_conversation(title="needle title", agent_id="a" * 32)
    human, answer = store.append(
        conv.id,
        [
            _message("needle human", user_authored=True),
            _message("needle answer", "assistant", phase="final_answer"),
        ],
    )
    page = store.search_messages("needle", message_filter="final", include_titles=True)
    assert {(hit.kind, hit.item_id) for hit in page.data} == {
        ("message", human.id),
        ("message", answer.id),
        ("chat", answer.id),
    }
    assert next(hit for hit in page.data if hit.kind == "chat").snippet == "needle answer"
