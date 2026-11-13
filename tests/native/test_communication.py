"""Native provenance requires structured origins, independently of human text."""

from omnigent.native.communication import native_message_text, native_peer_metadata


def test_peer_name_and_clean_report_are_preserved() -> None:
    origin = {
        "kind": "peer",
        "name": "Curie",
        "from": "native-agent",
        "senderTaskId": "task-1",
        "handback": True,
        "handbackReportText": "Clean result",
    }
    metadata = native_peer_metadata(origin, "message-1")["communication"]
    assert metadata["source_agent_name"] == "Curie"
    assert metadata["source_agent_id"] == "task-1"
    assert metadata["task_id"] == "task-1"
    assert metadata["source_conversation_id"] is None
    assert native_message_text(origin, "generic wrapper") == "Clean result"


def test_task_notification_is_context_but_literal_human_markup_is_unchanged() -> None:
    text = "<task-notification>quoted by the user</task-notification>"
    assert native_peer_metadata({"kind": "task-notification", "runId": "shell-1"}, "m1") == {
        "is_meta": True
    }
    assert native_peer_metadata(None, "m2") == {}
    assert native_message_text(None, text) == text
