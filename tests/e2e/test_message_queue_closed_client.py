"""A real runner completes queued turns with every submitting client closed.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from tests._helpers.polling import poll_until
from tests._helpers.server_runner import server_runner
from tests.e2e.conftest import (
    configure_mock_llm,
    create_runner_bound_session,
    register_inline_agent,
    release_mock_gate,
    send_user_message_to_session,
)

# This uploaded-agent journey does not need unrelated native CLI picker seeding.
_UPLOADED_AGENT_BOOTSTRAP = """
import omnigent.server.app as server_app
server_app._ensure_default_native_agents = lambda *args: None
from omnigent.cli import main
main()
"""


@pytest.mark.timeout(120)
def test_queue_delivers_fifo_after_every_submitting_client_closes(
    tmp_path: Path,
    isolated_mock_llm_server_url: str,
) -> None:
    mock = isolated_mock_llm_server_url
    model = f"queue-closed-{uuid4().hex}"
    configure_mock_llm(
        mock,
        [
            {"block": True, "text": "Initial completed"},
            {"block": True, "text": "First follow-up completed"},
            {"text": "Second follow-up completed"},
        ],
        key=model,
    )
    with server_runner(tmp_path / "stack", server_bootstrap=_UPLOADED_AGENT_BOOTSTRAP) as stack:
        stack.start_runner()
        with httpx.Client(base_url=stack.base_url, trust_env=False, timeout=30) as client:
            name = register_inline_agent(
                client,
                name=model,
                harness="openai-agents",
                model=model,
                profile="",
                prompt="Answer each message briefly.",
                mock_llm_base_url=f"{mock}/v1",
            )
            session_id = create_runner_bound_session(
                client, agent_name=name, runner_id=stack.runner_id
            )
            send_user_message_to_session(
                client, session_id=session_id, content="initial gated turn"
            )
            poll_until(
                lambda: httpx.get(f"{mock}/gate/pending").json().get("pending"),
                timeout_s=30,
                interval_s=0.1,
            )
            upload = client.post(
                f"/v1/sessions/{session_id}/resources/files",
                files={"file": ("context.txt", b"exact queued attachment bytes", "text/plain")},
            )
            upload.raise_for_status()
            file_id = upload.json()["id"]
            ids = [uuid4().hex, uuid4().hex]
            for index, stable_id in enumerate(ids):
                text = f"queued follow-up {index + 1}"
                content = (
                    [{"type": "input_file", "file_id": file_id, "filename": "context.txt"}]
                    if index == 0
                    else []
                ) + [{"type": "input_text", "text": text}]
                response = client.post(
                    f"/v1/sessions/{session_id}/queued-messages",
                    json={
                        "queueId": f"q_{stable_id}",
                        "stableId": stable_id,
                        "text": text,
                        "event": {
                            "type": "message",
                            "data": {"role": "user", "content": content, "stable_id": stable_id},
                        },
                    },
                )
                assert response.status_code == 201, response.text
        # No stream, browser, app or HTTP submitting client remains open.
        release_mock_gate(mock)
        with httpx.Client(base_url=stack.base_url, trust_env=False, timeout=10) as observer:

            def items():
                response = observer.get(f"/v1/sessions/{session_id}/items", params={"limit": 1000})
                response.raise_for_status()
                return response.json()["data"]

            poll_until(
                lambda: any(item["id"] == ids[0] for item in items()), timeout_s=40, interval_s=0.1
            )
            poll_until(
                lambda: httpx.get(f"{mock}/gate/pending").json().get("pending"),
                timeout_s=30,
                interval_s=0.1,
            )
            assert not any(item["id"] == ids[1] for item in items())
            release_mock_gate(mock)
            try:
                poll_until(
                    lambda: any(item["id"] == ids[1] for item in items()),
                    timeout_s=20,
                    interval_s=0.1,
                )
            except AssertionError:
                import sqlite3

                with sqlite3.connect(stack.database_uri.removeprefix("sqlite:///")) as database:
                    state = database.execute(
                        "SELECT payload FROM omnigent_message_queues"
                    ).fetchall()
                pytest.fail(f"Queue stalled: {state}\n{stack.log_tail()}")
            saved = items()
            selected = [item for item in saved if item["id"] in ids]
            assert len(selected) == 2, json.dumps(saved)
            assert [item["id"] for item in selected] == ids
            content = observer.get(f"/v1/sessions/{session_id}/resources/files/{file_id}/content")
            assert content.content == b"exact queued attachment bytes"
