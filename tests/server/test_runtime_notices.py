# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Saved provider facts, sparse updates, scope changes, and bounded notifications."""

import pytest

from omnigent.server.runtime_notices import (
    observe_runtime_notice,
    runtime_notices,
    runtime_quotas,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


def test_quota_sparse_revision_reset_and_account_scope(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()
    other = store.create_conversation()
    base = {
        "provider": "codex",
        "source_instance": "server-a",
        "kind": "rate_limit",
        "scope_kind": "captured_parent",
        "scope_epoch": "login-a",
        "account": {"type": "chatgpt", "email": None, "planType": "plus"},
        "workspace_routing": None,
        "sequence": 1,
        "observed_at": 100,
    }
    state = {
        "rateLimits": {
            "primary": {"usedPercent": 95, "resetsAt": 200},
            "secondary": {"usedPercent": 20, "resetsAt": 900},
        }
    }
    assert observe_runtime_notice(store, conv.id, {**base, "state": state})
    rows = runtime_notices(store.get_conversation(conv.id), now=150)
    assert len(rows) == 1
    assert rows[0].severity == "warning" and not rows[0].requires_action
    revision = rows[0].revision
    quotas = runtime_quotas(store.get_conversation(conv.id))
    assert [(row.window, row.used_percent) for row in quotas] == [
        ("quota:primary", 95.0),
        ("quota:secondary", 20.0),
    ]
    assert all(row.source_kind == "unknown" for row in quotas)
    store.set_session_state(conv.id, {"policy": "kept"})
    store.set_session_todos(conv.id, [])
    restored = store.get_conversation(conv.id)
    assert restored.session_state == {"policy": "kept"}
    assert len(runtime_notices(restored, now=150)) == 1
    assert observe_runtime_notice(
        store,
        conv.id,
        {
            **base,
            "sequence": 2,
            "state": {
                "rateLimits": {"primary": {"usedPercent": 96}},
            },
        },
    )
    assert runtime_notices(store.get_conversation(conv.id), now=150)[0].revision == revision
    assert runtime_notices(store.get_conversation(other.id)) == []
    assert observe_runtime_notice(
        store,
        conv.id,
        {
            **base,
            "sequence": 3,
            "state": {
                "rateLimits": {"primary": {"usedPercent": 100, "resetsAt": None}},
            },
        },
    )
    rows = runtime_notices(store.get_conversation(conv.id), now=250)
    assert rows[0].id == runtime_notices(store.get_conversation(conv.id), now=150)[0].id
    assert rows[0].revision != revision and rows[0].reset_at == 200
    assert "unconfirmed" in rows[0].message and rows[0].severity == "error"
    assert len(rows) == 1
    escalation_revision = rows[0].revision
    assert observe_runtime_notice(
        store,
        conv.id,
        {**base, "sequence": 4, "state": {"rateLimits": {"primary": {"resetsAt": 600}}}},
    )
    assert (
        runtime_notices(store.get_conversation(conv.id), now=250)[0].revision
        != escalation_revision
    )
    assert not observe_runtime_notice(store, conv.id, {**base, "state": state})
    assert observe_runtime_notice(
        store, conv.id, {**base, "sequence": 5, "kind": "account", "account": None}
    )
    assert runtime_notices(store.get_conversation(conv.id)) == []
    assert observe_runtime_notice(
        store,
        conv.id,
        {
            **base,
            "sequence": 6,
            "scope_epoch": "login-b",
            "account": {"type": "chatgpt", "email": "next@example.test", "planType": "plus"},
            "state": {"rateLimits": {"primary": {"usedPercent": 10}}},
        },
    )
    assert runtime_notices(store.get_conversation(conv.id)) == []
    assert runtime_quotas(store.get_conversation(conv.id))[0].used_percent == 10
    store.set_runner_id(conv.id, "new-runner")
    assert runtime_notices(store.get_conversation(conv.id)) == []
    assert runtime_quotas(store.get_conversation(conv.id)) == []


def test_unknown_account_and_claude_notifications_are_bounded(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()
    observe_runtime_notice(
        store,
        conv.id,
        {
            "provider": "codex",
            "source_instance": "s",
            "kind": "rate_limit",
            "sequence": 1,
            "state": {"rateLimits": {"primary": {"usedPercent": 100}}},
        },
    )
    assert runtime_notices(store.get_conversation(conv.id)) == []
    for index in range(40):
        observe_runtime_notice(
            store,
            conv.id,
            {
                "provider": "claude",
                "source_instance": "claude-native:claude-s",
                "native_session_id": "native-a",
                "kind": "nativeNotification",
                "sequence": index,
                "observed_at": 100 + index,
                "source_event_id": str(index),
                "state": {
                    "message": f"Observed {index}",
                    "notification_type": "permission_prompt",
                    "request_id": f"request-{index}",
                    "blocking": index == 39,
                },
            },
        )
    rows = runtime_notices(store.get_conversation(conv.id))
    assert len(rows) == 32 and rows[-1].message == "Observed 39"
    assert rows[-1].native_subtype == "permission_prompt"
    assert rows[-1].request_id == "request-39"
    assert rows[-1].blocking is True and rows[-1].requires_action
    assert rows[-1].source_kind == "native" and rows[-1].observed_at == 139
    assert rows[-1].reset_at is None
    observe_runtime_notice(
        store,
        conv.id,
        {
            "provider": "claude",
            "source_instance": "claude-native:claude-s",
            "native_session_id": "native-b",
            "kind": "nativeNotification",
            "sequence": 40,
            "state": {"message": "New session"},
        },
    )
    assert [row.message for row in runtime_notices(store.get_conversation(conv.id))] == [
        "New session"
    ]


def test_claude_healthy_quota_is_not_a_notice_and_preserves_sdk_provenance(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()
    base = {
        "provider": "claude",
        "source_instance": "claude-sdk:native-a",
        "source_kind": {},
        "native_session_id": "native-a",
        "kind": "rate_limit",
        "sequence": 1,
        "observed_at": 123.5,
    }
    assert observe_runtime_notice(
        store,
        conv.id,
        {
            **base,
            "state": {
                "status": "allowed",
                "rate_limit_type": "five_hour",
                "utilization": 0.42,
                "resets_at": 456,
            },
        },
    )
    saved = store.get_conversation(conv.id)
    assert runtime_notices(saved) == []
    [quota] = runtime_quotas(saved)
    assert quota.window == "five_hour"
    assert quota.used_percent == 42
    assert quota.reset_at == 456
    assert quota.status == "allowed"
    assert quota.observed_at == 123.5
    assert quota.source_kind == "sdk"

    assert observe_runtime_notice(
        store,
        conv.id,
        {
            **base,
            "sequence": 2,
            "state": {"status": "allowed_warning", "utilization": float("inf")},
        },
    )
    [notice] = runtime_notices(store.get_conversation(conv.id))
    assert notice.category == "quota" and notice.blocking is None
    assert not notice.requires_action
    [quota] = runtime_quotas(store.get_conversation(conv.id))
    assert quota.used_percent is None


@pytest.mark.parametrize(
    "phase,expected",
    [
        ("commentary", "commentary"),
        ("final_answer", "final_answer"),
        ("partial_answer", None),
        (None, None),
        ({}, None),
    ],
)
def test_message_phase_retains_only_known_boundaries(phase, expected):
    from omnigent.entities.conversation import MessageData

    assert MessageData(role="assistant", agent="test", content=[], phase=phase).phase == expected
