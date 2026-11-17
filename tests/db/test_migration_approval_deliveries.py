"""Approval migration preserves prior state and refuses to discard delivery evidence."""

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory

from omnigent.db.utils import _build_alembic_config, get_or_create_engine
from omnigent.server.approval_delivery_store import ApprovalDeliveryStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


def test_approval_migration_roundtrip_preserves_parent_data_and_single_head(tmp_path: Path):
    uri = f"sqlite:///{tmp_path / 'approval-migration.db'}"
    engine = get_or_create_engine(uri)
    conversations = SqlAlchemyConversationStore(uri)
    conversation = conversations.create_conversation(title="preserved existing conversation")
    conversations.set_labels(conversation.id, {"preserved": "label value"})
    config = _build_alembic_config(uri)
    assert ScriptDirectory.from_config(config).get_heads() == ["pq1a2b3c4d5e"]
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "bq1a2b3c4d5e")
        assert "omnigent_approval_deliveries" not in sa.inspect(connection).get_table_names()
        assert "ix_conversation_labels_key_value" in {
            index["name"] for index in sa.inspect(connection).get_indexes("conversation_labels")
        }
        command.upgrade(config, "head")
    assert (
        conversations.get_conversation(conversation.id).title == "preserved existing conversation"
    )
    assert conversations.get_conversation(conversation.id).labels["preserved"] == "label value"
    store = ApprovalDeliveryStore(uri)
    payload = {
        "identity": {
            "session_id": conversation.id,
            "elicitation_id": "question",
            "attempt_id": "a" * 64,
        },
        "event": {
            "type": "response.elicitation_request",
            "elicitation_id": "question",
            "params": {},
        },
        "action": "decline",
        "question_receipt": None,
        "conversation_binding": None,
    }
    store.reserve(conversation.id, "question", payload, expected_runner_binding=None)
    with pytest.raises(RuntimeError, match="Preserve approval delivery records"):
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.downgrade(config, "bq1a2b3c4d5e")
    assert store.read(conversation.id, "question")["state"] == "held"
    # Delete only the synthetic fixture record to exercise the empty-journal rollback.
    with engine.begin() as connection:
        connection.execute(sa.text("DELETE FROM omnigent_approval_deliveries"))
        config.attributes["connection"] = connection
        command.downgrade(config, "bq1a2b3c4d5e")
        command.upgrade(config, "head")
    assert store.held(conversation.id) == []
    assert conversations.get_conversation(conversation.id).labels["preserved"] == "label value"
