# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Card source order comes from exact child items, independent of capture time."""

from omnigent.entities.conversation import MessageData, NewConversationItem
from omnigent.entities.report_finality import replace_report_snapshot
from omnigent.server.subagent_activity import _refresh_task_input, _turn_report
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


def test_exact_child_positions_populate_instruction_and_atomic_report(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    child = store.create_conversation(title="Child")
    [initial, final, steering] = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "Initial instruction"}]
                ),
            ),
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(
                    role="assistant",
                    agent="claude-native-ui",
                    phase="final_answer",
                    content=[{"type": "output_text", "text": "Final answer"}],
                ),
            ),
            NewConversationItem(
                type="message",
                response_id="later",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "Later steering"}]
                ),
            ),
        ],
    )
    metadata = {"task_input_ref": {"conversation_id": child.id, "item_id": steering.id}}
    _refresh_task_input(metadata, store)
    report = _turn_report([initial, final, steering], child.id, "turn")
    assert metadata["task_input"] == "Later steering"
    assert metadata["task_input_position"] == steering.position
    assert report["result_position"] == final.position < steering.position
    assert report["result_refs"] == [{"conversation_id": child.id, "item_id": final.id}]
    replaced = replace_report_snapshot(
        {
            "dispatch_id": "dispatch",
            "turn_id": "turn",
            "result_text": "Old report",
            "result_finality": "unknown",
            "result_position": 999,
        },
        {"dispatch_id": "dispatch", "turn_id": "turn", **report},
    )
    assert replaced["result_text"] == "Final answer"
    assert replaced["result_position"] == final.position
    assert replaced["result_refs"] == report["result_refs"]
