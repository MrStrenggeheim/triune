"""Pending startup messages reuse item status, ordering, encryption and deletion."""

import base64
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import event, insert, select, text

from omnigent.db.db_models import SqlConversationItem, workspace_scope
from omnigent.entities.conversation import MessageData, NewConversationItem, StartupInputOptions
from omnigent.errors import OmnigentError
from omnigent.stores.conversation_store import MAX_PENDING_INPUTS, PENDING_INPUT_RESPONSE_ID
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


def _input(message="saved prompt", **kwargs):
    stable_id = kwargs.pop("stable_id", uuid4().hex)
    return NewConversationItem(
        type="message",
        response_id=PENDING_INPUT_RESPONSE_ID,
        status="in_progress",
        stable_id=stable_id,
        data=MessageData(role="user", content=[{"type": "input_text", "text": message}]),
        **kwargs,
    )


@pytest.fixture(params=["conversation_store", "split_db_conversation_store"])
def pending_store(request: pytest.FixtureRequest) -> SqlAlchemyConversationStore:
    return request.getfixturevalue(request.param)


def test_restart_and_concurrent_submission_claims(db_uri):
    first = SqlAlchemyConversationStore(db_uri)
    second = SqlAlchemyConversationStore(db_uri)
    session = first.create_conversation()
    item = first.append(session.id, [_input()])[0]
    assert second.list_pending_inputs(session.id) == [item]
    assert second.list_items(session.id).data == []
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(
            pool.map(
                lambda store: store.transition_pending_input(
                    session.id, item.id, expected="in_progress", status="incomplete"
                ),
                [first, second],
            )
        )
    assert sum(claims) == 1
    assert second.list_pending_inputs(session.id)[0].status == "incomplete"


def test_native_receipt_replaces_pending_row_once_and_keeps_order(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    session = store.create_conversation()
    first, second = store.append(session.id, [_input("first"), _input("second")])
    native = NewConversationItem(
        type="message",
        response_id="native-turn",
        stable_id=uuid4().hex,
        replaces_pending_id=first.id,
        data=first.data,
    )
    committed = store.append(session.id, [native])[0]
    assert committed.created_at == first.created_at
    assert store.get_item(session.id, first.id) is None
    assert store.list_pending_inputs(session.id) == [second]
    # A mirror retry must neither delete the next input nor append another item.
    assert store.append(session.id, [native])[0].deduplicated
    assert store.list_pending_inputs(session.id) == [second]
    assert store.list_items(session.id).data == [committed]
    with store._conv_session("test_input_positions") as db:
        assert list(
            db.scalars(select(SqlConversationItem.id).order_by(SqlConversationItem.position))
        ) == [committed.id, second.id]


def test_sdk_activation_keeps_stable_id_and_becomes_history(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    session = store.create_conversation()
    saved = store.append(session.id, [_input()])[0]
    item = NewConversationItem(
        type="message",
        response_id="sdk-turn",
        stable_id=saved.id,
        replaces_pending_id=saved.id,
        data=saved.data,
    )
    committed = store.append(session.id, [item])[0]
    assert committed.id == saved.id and not committed.deduplicated
    assert store.list_pending_inputs(session.id) == []
    assert store.list_items(session.id).data == [committed]
    assert store.append(session.id, [item])[0].deduplicated


def test_bound_pending_read_and_failed_claim_does_not_change_history(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    session = store.create_conversation()
    saved = store.append(session.id, [_input() for _ in range(MAX_PENDING_INPUTS)])
    with pytest.raises(OmnigentError, match="Too many messages"):
        store.append(session.id, [_input()])
    assert not store.transition_pending_input(
        session.id, saved[0].id, expected="failed", status="completed"
    )
    assert len(store.list_pending_inputs(session.id)) == MAX_PENDING_INPUTS
    assert store.list_items(session.id).data == []
    if not db_uri.startswith("sqlite"):
        return  # The plan check below uses SQLite's EXPLAIN syntax.
    with store._conv_session("test_pending_query_plan") as db:
        plan = db.execute(
            text(
                "EXPLAIN QUERY PLAN SELECT id FROM conversation_items "
                "WHERE workspace_id=0 AND conversation_id=:id AND response_id=:response LIMIT 100"
            ),
            {"id": bytes.fromhex(session.id), "response": PENDING_INPUT_RESPONSE_ID},
        ).all()
    assert "ix_conversation_items_pending_position" in str(plan)


def test_host_pagination_and_workspace_isolation(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    host_id = uuid4().hex
    ids = sorted(store.create_conversation().id for _ in range(3))
    for session_id in ids:
        store.set_host_id(session_id, host_id, "/tmp/workspace")
        store.append(session_id, [_input()])
    assert store.list_host_conversation_ids(host_id, limit=2) == ids[:2]
    assert store.list_host_conversation_ids(host_id, after=ids[1], limit=2) == ids[2:]
    with workspace_scope(17):
        assert store.list_host_conversation_ids(host_id) == []
        assert store.list_pending_inputs(ids[0]) == []
    if not db_uri.startswith("sqlite"):
        return  # The plan check below uses SQLite's EXPLAIN syntax.
    with store._session("test_host_query_plan") as db:
        plan = db.execute(
            text(
                "EXPLAIN QUERY PLAN SELECT id FROM omnigent_conversation_metadata "
                "WHERE workspace_id=0 AND host_id=:host AND id>:after ORDER BY id LIMIT 2"
            ),
            {"host": bytes.fromhex(host_id), "after": bytes.fromhex(ids[0])},
        ).all()
    assert "ix_conversation_metadata_host_id" in str(plan)


def test_host_startup_work_selects_only_unarchived_sessions_with_work(pending_store):
    store = pending_store
    host_id = uuid4().hex

    def host_session(labels=None, inputs=(), archived=False):
        session_id = store.create_conversation().id
        store.set_host_id(session_id, host_id, "/tmp/workspace")
        if labels:
            store.set_labels(session_id, labels)
        if inputs:
            saved = store.append(session_id, [_input() for _ in inputs])
            for item, status in zip(saved, inputs, strict=True):
                if status != "in_progress":
                    store.transition_pending_input(
                        session_id, item.id, expected="in_progress", status=status
                    )
        if archived:
            store.update_conversation(session_id, archived=True)
        return session_id

    idle = [host_session() for _ in range(3)]
    working = sorted(
        [
            host_session({"omnigent.startup": "pending"}),
            host_session({"omnigent.startup": "ready"}),
            host_session({"omnigent.startup": "cancelled"}),
            host_session(inputs=["in_progress"]),
            host_session(inputs=["failed", "incomplete"]),
        ]
    )
    host_session({"omnigent.startup": "failed"})
    host_session(inputs=["failed"])
    host_session({"omnigent.startup": "pending"}, inputs=["in_progress"], archived=True)
    store.set_labels(store.create_conversation().id, {"omnigent.startup": "pending"})

    assert store.list_host_startup_work_ids(host_id) == (working, None)
    found, after = [], None
    while True:
        page, after = store.list_host_startup_work_ids(host_id, after=after, limit=3)
        found.extend(page)
        if after is None:
            break
    assert found == working
    assert not set(idle) & set(found)
    with workspace_scope(17):
        assert store.list_host_startup_work_ids(host_id) == ([], None)


@pytest.mark.asyncio
async def test_deleting_conversation_deletes_pending_input(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    session = store.create_conversation()
    store.append(session.id, [_input()])
    assert await store.delete_conversation(session.id)
    assert store.list_pending_inputs(session.id) == []


@pytest.mark.parametrize("cancelled", [False, True])
def test_fork_does_not_copy_undelivered_messages(db_uri, cancelled):
    store = SqlAlchemyConversationStore(db_uri)
    session = store.create_conversation()
    store.set_labels(session.id, {"omnigent.startup": "pending"})
    [saved] = store.append(session.id, [_input()])
    if cancelled:
        assert store.transition_pending_input(
            session.id,
            saved.id,
            expected="in_progress",
            status=None,
        )
        assert store.get_item(session.id, saved.id) is None
    assert store.list_items(session.id).data == []
    fork = store.fork_conversation(session.id)
    assert store.list_pending_inputs(fork.id) == []
    assert store.list_items(fork.id).data == []
    assert "omnigent.startup" not in fork.labels


def test_pending_payload_and_options_use_item_encoding_hooks(db_uri):
    class EncodedStore(SqlAlchemyConversationStore):
        def _encode_item_data(self, data_json: str) -> str:
            return base64.b64encode(data_json.encode()).decode("ascii")

        def _decode_item_data_batch(self, stored: list[str]) -> list[str]:
            return [base64.b64decode(value).decode() for value in stored]

    store = EncodedStore(db_uri)
    session = store.create_conversation()
    item = _input("private startup instruction")
    item.data.startup_options = StartupInputOptions(model_override="chosen-model", tools=[])
    [saved] = store.append(session.id, [item])
    with store._conv_session("test_encoded_pending_payload") as db:
        encoded = db.scalar(select(SqlConversationItem.data))
        assert "private startup instruction" not in encoded
        assert "chosen-model" not in encoded
    restarted = EncodedStore(db_uri)
    assert restarted.list_pending_inputs(session.id) == [saved]
    assert restarted.transition_pending_input(
        session.id, saved.id, expected="in_progress", status="incomplete"
    )
    [claimed] = restarted.list_pending_inputs(session.id)
    assert claimed.data == saved.data and claimed.status == "incomplete"
    [receipt] = restarted.append(
        session.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                stable_id=saved.id,
                replaces_pending_id=saved.id,
                data=saved.data.model_copy(update={"startup_options": None}),
            )
        ],
    )
    assert restarted.list_pending_inputs(session.id) == []
    assert restarted.list_items(session.id).data == [receipt]


def test_pending_input_pages_continue_in_submission_order(pending_store):
    store = pending_store
    session = store.create_conversation()
    saved = store.append(session.id, [_input() for _ in range(5)])
    first, cursor = store.list_pending_inputs_page(session.id, limit=2)
    second, cursor = store.list_pending_inputs_page(session.id, after=cursor, limit=2)
    third, end = store.list_pending_inputs_page(session.id, after=cursor, limit=2)
    assert end is None
    assert [item.id for item in first + second + third] == [item.id for item in saved]
    exact, end = store.list_pending_inputs_page(session.id, limit=5)
    assert len(exact) == 5 and end is None
    assert [item.id for item in store.list_pending_inputs(session.id)] == [
        item.id for item in saved
    ]


def test_pending_pages_preserve_states_retries_and_same_ids_across_tenants(pending_store):
    store = pending_store
    conversation_id = uuid4().hex
    inputs = [_input(str(i), stable_id=f"{i + 1:032x}") for i in range(8)]
    expected = {}
    for workspace in (0, 17):
        with workspace_scope(workspace):
            store.create_conversation(conversation_id=conversation_id)
            # Interleave history so pending cursors traverse dense, shared positions.
            saved = []
            for item in inputs:
                store.append(
                    conversation_id,
                    [NewConversationItem(type="message", response_id="history", data=item.data)],
                )
                saved.extend(store.append(conversation_id, [item]))
            assert all(item.deduplicated for item in store.append(conversation_id, inputs))
            for item, status in zip(
                saved[1:4], ("incomplete", "failed", "completed"), strict=True
            ):
                assert store.transition_pending_input(
                    conversation_id, item.id, expected="in_progress", status=status
                )
            expected[workspace] = store.list_pending_inputs(conversation_id)
            assert [item.status for item in expected[workspace]][:4] == [
                "in_progress",
                "incomplete",
                "failed",
                "completed",
            ]
    with workspace_scope(17):
        assert store.transition_pending_input(
            conversation_id, inputs[2].stable_id, expected="failed", status="in_progress"
        )
        assert not store.transition_pending_input(
            conversation_id, inputs[2].stable_id, expected="failed", status="in_progress"
        )
        expected[17] = store.list_pending_inputs(conversation_id)
    for workspace in (17, 0, 17):
        with workspace_scope(workspace):
            actual, cursor = [], None
            for _ in range(4):
                page, cursor = store.list_pending_inputs_page(
                    conversation_id, after=cursor, limit=3
                )
                actual.extend(page)
                if cursor is None:
                    break
            assert cursor is None and actual == expected[workspace]
            assert [item.id for item in actual] == [item.stable_id for item in inputs]
            assert len(store.list_items(conversation_id).data) == len(inputs)
            assert store.list_pending_inputs_page(conversation_id, after=15) == ([], None)
    with workspace_scope(99):
        assert store.list_pending_inputs_page(conversation_id) == ([], None)


def test_retained_and_legacy_completed_pending_pages_stay_separate(pending_store):
    store = pending_store
    sid = store.create_conversation().id
    original = [_input(f"entry {n}") for n in range(6)]
    for n in [0, 2, 4]:
        original[n] = original[n].model_copy(update={"status": "completed"})
    rows = store.append(sid, original)
    journal = store.transcript_journal
    assert journal is not None and journal.revision(sid) == 0
    assert store.transition_pending_input(
        sid, rows[3].id, expected="in_progress", status="incomplete"
    )
    assert set(store.cancel_startup_inputs(sid, reason="stop")) == {rows[n].id for n in [1, 3, 5]}
    assert journal.changes(sid, 0) == []
    legacy, cursor = store.list_pending_inputs_page(sid, limit=2)
    assert [row.id for row in legacy] == [rows[0].id, rows[2].id] and cursor == rows[2].position
    assert store.list_pending_inputs_page(sid, after=cursor, limit=2) == ([rows[4]], None)
    receipts = store.list_startup_receipts(sid, before=None, limit=2)
    assert [(row.id, row.data.startup_options.receipt.state) for row in receipts] == [
        (rows[5].id, "cancelled_before_sending"),
        (rows[3].id, "delivery_unknown"),
    ]
    assert [
        row.id for row in store.list_startup_receipts(sid, before=receipts[-1].position, limit=2)
    ] == [rows[1].id]
    assert store.cancel_startup_inputs(sid, reason="interrupt") == []
    assert store.transition_pending_input(sid, rows[0].id, expected="completed", status="failed")
    assert not store.transition_pending_input(
        sid, rows[3].id, expected="incomplete", status="in_progress"
    )
    assert store.list_items(sid).data == [] and store.item_checkpoint(sid)["item_count"] == 0
    forked = store.fork_conversation(sid)
    assert store.list_items(forked.id).data == []
    assert store.list_pending_inputs(forked.id) == []
    assert store.list_startup_receipts(forked.id, before=None, limit=2) == []


def test_pending_page_index_bounds_history_scan(pending_store):
    store = pending_store
    if store._conv_engine.dialect.name != "sqlite":
        pytest.skip("SQLite EXPLAIN and VM instruction check")
    conversation = store.create_conversation()
    with store._conv_engine.begin() as connection:
        connection.execute(
            insert(SqlConversationItem),
            [
                {
                    "conversation_id": conversation.id,
                    "id": f"{i:032x}",
                    "created_at": i,
                    "response_id": PENDING_INPUT_RESPONSE_ID if i >= 29990 else "history",
                    "position": i,
                    "status": 2,
                    "type": 1,
                    "data": '{"role":"user","content":[]}',
                    "search_text": "",
                }
                for i in range(30000)
            ],
        )
    steps, queries, drivers = [0], [], []

    def tick():
        steps[0] += 1
        return 0

    def before(connection, cursor, statement, params, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append((statement, params))
            drivers.append(cursor.connection)
            cursor.connection.set_progress_handler(tick, 1)

    event.listen(store._conv_engine, "before_cursor_execute", before)
    try:
        first, cursor = store.list_pending_inputs_page(conversation.id, limit=6)
        second, end = store.list_pending_inputs_page(conversation.id, after=cursor, limit=6)
    finally:
        event.remove(store._conv_engine, "before_cursor_execute", before)
        for driver in drivers:
            driver.set_progress_handler(None, 0)
    assert cursor == 29995 and end is None
    assert [item.id for item in first + second] == [f"{i:032x}" for i in range(29990, 30000)]
    assert len(queries) == 2 and steps[0] < 1000, f"Unbounded pending page: {steps[0]} VM steps"
    with store._conv_engine.connect() as connection:
        plans = [
            str(connection.exec_driver_sql("EXPLAIN QUERY PLAN " + sql, params).all())
            for sql, params in queries
        ]
    assert all("ix_conversation_items_pending_position" in plan for plan in plans)
    assert all("TEMP B-TREE" not in plan for plan in plans)
