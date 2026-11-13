# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Real Codex tools cross the native bridge before appearing in the composer shelf."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from playwright.sync_api import Page, expect

from tests._helpers.native_session import create_native_session
from tests._helpers.polling import poll_until
from tests._helpers.session import bind_session_runner
from tests.e2e_ui.conftest import (
    _ensure_runner_online,
    _server_state,
    _temp_omnigent_mock_config,
    configure_mock_llm,
    reset_mock_llm,
    set_fallback_mock_llm,
)
from tests.e2e_ui.messages.test_message_render_parity import (
    _ASSISTANT,
    _WORKING,
    _ensure_chat_view,
    _send,
)


def _requests(mock_url: str) -> list[dict[str, Any]]:
    response = httpx.get(f"{mock_url}/mock/requests", timeout=10)
    response.raise_for_status()
    return response.json()["requests"]


@pytest.fixture
def native_capability_evidence(
    request: pytest.FixtureRequest, tmp_path: Path, mock_llm_server_url: str
):
    """Preserve provider requests even when a native boundary assertion fails."""
    evidence = Path(os.environ.get("OMNIGENT_NATIVE_CAPABILITY_EVIDENCE", str(tmp_path)))
    evidence /= re.sub(r"[^\w-]", "-", request.node.name)
    evidence.mkdir(parents=True, exist_ok=True)
    cli = "claude" if "claude" in request.node.name else "codex"
    metadata = {
        "test": request.node.nodeid,
        "cli": subprocess.check_output([cli, "--version"], text=True).strip(),
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "backend": "generic mock Responses/Messages with real native CLI",
        "feature_map": "feature-map/native-harnesses.md",
    }
    (evidence / "metadata.json").write_text(json.dumps(metadata, indent=2))
    yield evidence
    (evidence / "final-requests.json").write_text(
        json.dumps(_requests(mock_llm_server_url), indent=2)
    )


@pytest.fixture
def native_capability_codex_session(
    request: pytest.FixtureRequest,
    live_server: str,
    mock_llm_server_url: str,
    tmp_path_factory: pytest.TempPathFactory,
    tmp_path: Path,
) -> Iterator[tuple[str, str]]:
    """Pin the model advertising async questions while preserving the shared mock provider."""
    capability = request.node.callspec.params["capability"]
    if capability not in {"questions", "plan", "agents-v2"}:
        yield request.getfixturevalue("native_codex_mock_session")
        return
    runner = _ensure_runner_online(live_server, tmp_path_factory)
    with _temp_omnigent_mock_config(
        mock_llm_server_url, "codex", workflow_owned=bool(_server_state.get("workflow_owned"))
    ):
        session = create_native_session(
            httpx,
            live_server,
            harness="codex",
            model="gpt-6.1-sol",
            metadata={
                "workspace": str(tmp_path),
                **(
                    {"terminal_launch_args": ["-c", "features.multi_agent_v2=true"]}
                    if capability == "agents-v2"
                    else {}
                ),
            },
        )
        session_id = str(session["session_id"])
        bind_session_runner(httpx.patch, live_server, session_id, str(_server_state["runner_id"]))
        try:
            yield live_server, session_id
        finally:
            httpx.delete(f"{live_server}/v1/sessions/{session_id}", timeout=10).raise_for_status()
            if runner is not None:
                runner.terminate()
                try:
                    runner.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    runner.kill()
                    runner.wait(timeout=5)


def _tools(request: dict[str, Any]) -> dict[str, dict[str, Any]]:
    tools = {}
    advertised = list(request.get("tools", []))
    for item in request.get("input", []):
        if item.get("type") == "additional_tools":
            advertised.extend(item.get("tools", []))
    for tool in advertised:
        if tool.get("type") == "namespace":
            for member in tool["tools"]:
                tools[member["name"]] = {**member, "namespace": tool["name"]}
        elif "name" in tool:
            tools[tool["name"]] = tool
    return tools


def _call(tools: dict[str, dict[str, Any]], name: str, call_id: str, **arguments: Any) -> dict:
    executor = tools.get("exec", {})
    if name not in tools and f"{{ {name}(" in executor.get("description", ""):
        return {
            "type": "custom_tool_call",
            "call_id": call_id,
            "name": "exec",
            "namespace": executor["namespace"],
            "input": f"text(await tools.{name}({json.dumps(arguments)}));",
        }
    assert name in tools, (
        f"Native capability blocked: {name} not advertised; tools={sorted(tools)}"
    )
    call = {"call_id": call_id, "name": name, "arguments": json.dumps(arguments)}
    if namespace := tools[name].get("namespace"):
        call["namespace"] = namespace
    return call


def _script(
    mock_url: str, marker: str, calls: list[dict], done: str, *, match: str | None = None
) -> None:
    reset_mock_llm(mock_url)
    incremental = calls[0].get("type") == "custom_tool_call"
    configure_mock_llm(
        mock_url,
        [{"native_items" if incremental else "tool_calls": calls}, {"text": done}],
        key=marker,
        match=match or marker,
        # The full native user-history boundary excludes title requests when
        # incremental declarations prevent the mock's top-level tool guard.
        required_tools=[] if match else [calls[0].get("namespace", calls[0]["name"])],
    )


def _settled(page: Page, done: str) -> None:
    expect(page.locator(_ASSISTANT, has_text=done)).to_have_count(1, timeout=90_000)
    expect(page.locator(_WORKING)).to_have_count(0, timeout=60_000)


def _output(mock_url: str, call_id: str) -> str:
    requests = _requests(mock_url)
    for request in reversed(requests):
        outputs = [
            item
            for item in request.get("input", [])
            if item.get("type") in {"function_call_output", "custom_tool_call_output"}
            and item.get("call_id") == call_id
        ]
        if outputs:
            assert len(outputs) == 1, f"Native tool result was delivered twice: {call_id}"
            return str(outputs[0]["output"])
    raise AssertionError(f"No native tool result reached the mock Responses provider: {call_id}")


def _claude_output(mock_url: str, call_id: str) -> str:
    for request in reversed(_requests(mock_url)):
        for message in reversed(request.get("messages", [])):
            content = message.get("content")
            if not isinstance(content, list):
                continue
            results = [
                item
                for item in content
                if item.get("type") == "tool_result" and item.get("tool_use_id") == call_id
            ]
            if results:
                assert len(results) == 1, f"Native Claude returned a tool result twice: {call_id}"
                assert not results[0].get("is_error"), results[0]
                return str(results[0].get("content"))
    raise AssertionError(f"Claude did not execute the scripted native tool: {call_id}")


def _capture(page: Page, evidence: Path, name: str) -> None:
    shelf = page.get_by_test_id("composer-attention-shelf")
    opened = shelf.locator('button[aria-expanded="true"]').first
    opened_name = opened.get_attribute("aria-label") if opened.count() else None
    for device, viewport in (
        ("desktop", {"width": 1365, "height": 1000}),
        ("mobile", {"width": 390, "height": 844}),
    ):
        page.set_viewport_size(viewport)
        navigation = page.get_by_role("button", name="Close navigation", exact=True)
        if navigation.is_visible():
            navigation.click()
        if opened_name:
            trigger = shelf.get_by_role("button", name=opened_name, exact=True)
            if trigger.get_attribute("aria-expanded") != "true":
                trigger.click()
        page.screenshot(path=str(evidence / f"{name}-{device}.png"), animations="disabled")
    page.set_viewport_size({"width": 1365, "height": 1000})


def _bootstrap(page: Page, session: tuple[str, str], mock_url: str, evidence: Path) -> tuple:
    base_url, session_id = session
    reset_mock_llm(mock_url)
    marker = f"native-shelf-{uuid.uuid4().hex}"
    configure_mock_llm(
        mock_url, [{"text": "NATIVE_SHELF_READY"}] * 4, key=marker, match=marker, required_tools=[]
    )
    page.goto(f"{base_url}/c/{session_id}")
    _ensure_chat_view(page)
    navigation = page.get_by_role("button", name="Close navigation", exact=True)
    if navigation.is_visible():
        navigation.click()
    _send(page, f"Reply NATIVE_SHELF_READY. {marker}")
    _settled(page, "NATIVE_SHELF_READY")
    requests = _requests(mock_url)
    (evidence / "bootstrap-requests.json").write_text(json.dumps(requests, indent=2))
    native_request = next(
        request
        for request in requests
        if marker in str(request.get("input", request.get("messages"))) and _tools(request)
    )
    tools = _tools(native_request)
    (evidence / "advertised-tools.json").write_text(json.dumps(tools, indent=2))
    return tools, marker


@pytest.mark.parametrize(
    "capability", ["shells", "approvals", "agents", "blocking-questions", "questions", "plan"]
)
@pytest.mark.timeout(240)
def test_native_codex_capability_shelf(
    capability: str,
    page: Page,
    native_capability_codex_session: tuple[str, str],
    mock_llm_server_url: str,
    tmp_path: Path,
    native_capability_evidence: Path,
) -> None:
    """Native shell, approval, child and question lifecycles drive desktop/mobile shelves."""
    base_url, session_id = native_capability_codex_session
    evidence = native_capability_evidence
    set_fallback_mock_llm(mock_llm_server_url, "gpt-4o", "")
    set_fallback_mock_llm(mock_llm_server_url, "gpt-6.1-sol", "")
    tools, bootstrap_marker = _bootstrap(
        page, native_capability_codex_session, mock_llm_server_url, evidence
    )
    shelf = page.get_by_test_id("composer-attention-shelf")
    if capability == "shells":
        release, started, finished = (
            tmp_path / name for name in ("release", "started", "finished")
        )
        code = (
            "from pathlib import Path; import time; "
            f"Path({str(started)!r}).write_text('started'); "
            f"release=Path({str(release)!r}); deadline=time.monotonic()+55\n"
            "while not release.exists() and time.monotonic()<deadline: time.sleep(.1)\n"
            f"Path({str(finished)!r}).write_text('finished')"
        )
        try:
            marker = f"shell-{uuid.uuid4().hex}"
            _script(
                mock_llm_server_url,
                marker,
                [
                    _call(
                        tools,
                        "exec_command",
                        "shelf_shell",
                        cmd=f"{sys.executable} -c {shlex.quote(code)}",
                        yield_time_ms=1000,
                    )
                ],
                "NATIVE_SHELL_STARTED",
            )
            _send(page, f"Run the bounded background command. {marker}")
            poll_until(started.exists, timeout_s=30)
            shells = shelf.get_by_test_id("background-task-pill")
            expect(shells).to_be_visible(timeout=30_000)
            expect(shells).to_have_accessible_name("1 background task still running")
            assert not finished.exists(), (
                "Shell count appeared only after the native command exited"
            )
            shells.click()
            expect(page.get_by_role("dialog", name="1 background task")).to_contain_text(
                "time.monotonic"
            )
            _capture(page, evidence, "codex-live-shell")
            page.keyboard.press("Escape")
            _settled(page, "NATIVE_SHELL_STARTED")
            shell_output = _output(mock_llm_server_url, "shelf_shell")
            (evidence / "shell-requests.json").write_text(
                json.dumps(_requests(mock_llm_server_url), indent=2)
            )
            handle = re.search(r"session ID (\d+)", shell_output)
            assert handle, f"Native command did not yield a live process handle: {shell_output}"
        finally:
            release.touch()
        poll_until(finished.exists, timeout_s=15)
        marker = f"wait-shell-{uuid.uuid4().hex}"
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "write_stdin",
                    "shelf_shell_exit",
                    session_id=int(handle[1]),
                    chars="",
                    yield_time_ms=1000,
                )
            ],
            "NATIVE_SHELL_EXITED",
        )
        _send(page, f"Collect the finished native command. {marker}")
        _settled(page, "NATIVE_SHELL_EXITED")
        assert "code 0" in _output(mock_llm_server_url, "shelf_shell_exit")
        expect(shelf.get_by_test_id("background-task-pill")).to_have_count(0, timeout=30_000)

        return
    if capability == "approvals":
        response = httpx.patch(
            f"{base_url}/v1/sessions/{session_id}",
            json={"approval_mode": "ask-for-approval"},
            timeout=45,
        )
        response.raise_for_status()
        side_effect = tmp_path / "approved-once"
        marker = f"approve-{uuid.uuid4().hex}"
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "exec_command",
                    "shelf_approval",
                    cmd=f"printf 'approved\\n' >> {shlex.quote(str(side_effect))}",
                    sandbox_permissions="require_escalated",
                    justification="Verify one approved write.",
                )
            ],
            "NATIVE_APPROVAL_FINISHED",
        )
        _send(page, f"Run the command after I approve it once. {marker}")
        approvals = shelf.get_by_role("button", name="Approvals: 1", exact=True)
        expect(approvals).to_be_visible(timeout=45_000)
        assert not side_effect.exists(), "Native command ran before approval"
        approvals.click()
        approval = page.get_by_role("dialog", name="Approvals", exact=True)
        expect(approval.get_by_test_id("approval-card")).to_have_count(1)
        _capture(page, evidence, "codex-pending-approval")
        approval.get_by_role("button", name="Approve", exact=True).click()
        _settled(page, "NATIVE_APPROVAL_FINISHED")
        assert side_effect.read_text() == "approved\n"
        assert "code 0" in _output(mock_llm_server_url, "shelf_approval")
        (evidence / "approval-requests.json").write_text(
            json.dumps(_requests(mock_llm_server_url), indent=2)
        )
        page.reload()
        _ensure_chat_view(page)
        expect(shelf.get_by_role("button", name="Approvals: 1", exact=True)).to_have_count(0)
        assert side_effect.read_text() == "approved\n"

        return
    if capability == "agents":
        marker = f"spawn-{uuid.uuid4().hex}"
        child_marker = f"private-child-{uuid.uuid4().hex}"
        child_answer = f"CHILD_RESULT_{uuid.uuid4().hex}"
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "spawn_agent",
                    "shelf_spawn",
                    message=f"Return your result. {child_marker}",
                )
            ],
            "NATIVE_CHILD_DISPATCHED",
        )
        configure_mock_llm(
            mock_llm_server_url,
            [{"text": child_answer, "delay": 18}],
            key=child_marker,
            match=child_marker,
            required_tools=["exec_command"],
        )
        _send(page, f"Delegate one bounded native task. {marker}")
        agents = shelf.get_by_test_id("subagent-task-pill")
        expect(agents).to_be_visible(timeout=30_000)
        expect(agents).to_contain_text("1")
        agents.click()
        expect(page.get_by_role("dialog", name=re.compile("1 sub-agent"))).to_be_visible()
        _capture(page, evidence, "codex-live-child")
        page.keyboard.press("Escape")
        _settled(page, "NATIVE_CHILD_DISPATCHED")
        spawn_output = json.loads(_output(mock_llm_server_url, "shelf_spawn"))
        child_id = spawn_output.get("agent_id") or spawn_output.get("id")
        assert child_id, f"Native spawn returned no child handle: {spawn_output}"
        marker = f"wait-child-{uuid.uuid4().hex}"
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "wait_agent",
                    "shelf_child_return",
                    targets=[child_id],
                    timeout_ms=30_000,
                )
            ],
            "NATIVE_CHILD_RETURNED",
        )
        _send(page, f"Read the native child's completed answer. {marker}")
        _settled(page, "NATIVE_CHILD_RETURNED")
        assert child_answer in _output(mock_llm_server_url, "shelf_child_return")
        child_response = httpx.get(
            f"{base_url}/v1/sessions/{session_id}/child_sessions", timeout=10
        )
        child_response.raise_for_status()
        children = child_response.json()["data"]
        assert len(children) == 1, children
        card = page.get_by_test_id("subagent-activity")
        expect(card).to_have_count(1, timeout=30_000)
        expect(card).to_have_attribute("data-child-session-id", children[0]["id"])
        reply = page.get_by_test_id("subagent-reply")
        expect(reply).to_have_count(1, timeout=30_000)
        expect(reply).to_contain_text(child_answer)
        expect(agents).to_have_count(0, timeout=30_000)
        _capture(page, evidence, "codex-child-returned")
        (evidence / "child-requests.json").write_text(
            json.dumps(_requests(mock_llm_server_url), indent=2)
        )

        return
    if capability == "plan":
        entries = [
            "Inspect the native capability",
            "Verify the browser shelf",
            "Record the result",
        ]
        marker = f"codex-plan-{uuid.uuid4().hex}"
        prompt = f"Update the three native plan entries. {marker}"
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "update_plan",
                    "shelf_codex_plan",
                    plan=[
                        {"step": entry, "status": "completed" if index == 0 else "pending"}
                        for index, entry in enumerate(entries)
                    ],
                )
            ],
            "NATIVE_CODEX_PLAN_UPDATED",
            match=f"{bootstrap_marker} {prompt}",
        )
        _send(page, prompt)
        _settled(page, "NATIVE_CODEX_PLAN_UPDATED")
        _output(mock_llm_server_url, "shelf_codex_plan")
        plan = shelf.get_by_role("button", name="Plan: 1 of 3 completed", exact=True)
        expect(plan).to_be_visible(timeout=30_000)
        plan.click()
        panel = page.get_by_role("dialog", name="Plan", exact=True)
        for entry in entries:
            expect(panel.get_by_text(entry, exact=True)).to_be_visible()
        _capture(page, evidence, "codex-native-plan")
        page.keyboard.press("Escape")
        page.reload()
        _ensure_chat_view(page)
        expect(plan).to_be_visible(timeout=30_000)
        return
    if capability in {"questions", "blocking-questions"}:
        asynchronous = capability == "questions"
        if not asynchronous:
            response = httpx.patch(
                f"{base_url}/v1/sessions/{session_id}",
                json={"collaboration_mode": "plan"},
                timeout=45,
            )
            response.raise_for_status()
        marker = f"question-{uuid.uuid4().hex}"
        prompt = f"Ask me one native clarification and wait for my answer. {marker}"
        question_input = (
            {"title": "Which native result should I use?", "options": ["Alpha", "Bravo"]}
            if asynchronous
            else {
                "id": "native_choice",
                "header": "Choice",
                "question": "Which native result should I use?",
                "options": [
                    {"label": "Alpha", "description": "Use the first result."},
                    {"label": "Bravo", "description": "Use the second result."},
                ],
            }
        )
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "request_user_input_async" if asynchronous else "request_user_input",
                    "shelf_question",
                    questions=[question_input],
                )
            ],
            "NATIVE_QUESTION_PENDING" if asynchronous else "NATIVE_QUESTION_ANSWERED",
            match=f"{bootstrap_marker} {prompt}" if asynchronous else None,
        )
        resolutions = []
        page.on(
            "request",
            lambda request: (
                resolutions.append(request.url)
                if request.method == "POST"
                and "/elicitations/" in request.url
                and request.url.endswith("/resolve")
                else None
            ),
        )
        _send(page, prompt)
        questions = shelf.get_by_role("button", name="Questions: 1", exact=True)
        expect(questions).to_be_visible(timeout=45_000)
        if asynchronous:
            _settled(page, "NATIVE_QUESTION_PENDING")
            composer = page.get_by_placeholder("Send a message…")
            expect(composer).to_be_editable()
            composer.fill("Keep this draft while answering the native async question.")
            expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled()
            page.reload()
            _ensure_chat_view(page)
            expect(questions).to_be_visible(timeout=30_000)
            expect(composer).to_have_value(
                "Keep this draft while answering the native async question."
            )
            expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled()
        else:
            expect(
                page.get_by_placeholder("Respond to the pending request above to continue")
            ).to_be_visible()
        questions.click()
        question = page.get_by_role("dialog", name="Questions", exact=True)
        expect(question.get_by_test_id("ask-user-question-form")).to_have_count(1)
        _capture(page, evidence, "codex-pending-question")
        if asynchronous:
            configure_mock_llm(
                mock_llm_server_url,
                [{"text": "NATIVE_QUESTION_ANSWERED"}],
                key=marker,
                match=f"{bootstrap_marker} {prompt}",
                required_tools=[],
            )
        question.get_by_role("radio", name=re.compile(r"^Bravo\b")).check()
        question.get_by_test_id("ask-user-question-submit").click()
        _settled(page, "NATIVE_QUESTION_ANSWERED")
        if asynchronous:
            requests = _requests(mock_llm_server_url)
            native_answers = [
                item
                for item in requests[-1].get("input", [])
                if item.get("role") == "user" and "Bravo" in str(item.get("content"))
            ]
            assert len(native_answers) == 1, native_answers
        else:
            assert "Bravo" in _output(mock_llm_server_url, "shelf_question")
        page.reload()
        _ensure_chat_view(page)
        expect(questions).to_have_count(0)
        if asynchronous:
            expect(composer).to_have_value(
                "Keep this draft while answering the native async question."
            )
        assert len(resolutions) == 1, resolutions
        (evidence / "question-requests.json").write_text(
            json.dumps(_requests(mock_llm_server_url), indent=2)
        )
        _capture(page, evidence, "codex-settled")

        return


@pytest.mark.parametrize("capability", ["agents-v2"])
@pytest.mark.timeout(240)
def test_native_codex_v2_named_task_survives_steer(
    capability: str,
    page: Page,
    native_capability_codex_session: tuple[str, str],
    mock_llm_server_url: str,
    native_capability_evidence: Path,
) -> None:
    """A real V2 agent path supplies the missing task name without a full prompt."""
    base_url, session_id = native_capability_codex_session
    evidence = native_capability_evidence
    set_fallback_mock_llm(mock_llm_server_url, "gpt-6.1-sol", "")
    tools, bootstrap = _bootstrap(
        page, native_capability_codex_session, mock_llm_server_url, evidence
    )
    spawn = tools.get("spawn_agent", {})
    parameters = spawn.get("parameters", {}).get("properties", {})
    assert spawn.get("namespace") == "collaboration", spawn
    assert {"task_name", "fork_turns"} <= parameters.keys(), spawn
    assert "targets" not in tools["wait_agent"]["parameters"]["properties"]
    snapshot = httpx.get(f"{base_url}/v1/sessions/{session_id}", timeout=10)
    snapshot.raise_for_status()
    assert "features.multi_agent_v2=true" in snapshot.json()["terminal_launch_args"]

    task_name = "sleep_three_minutes"
    marker = f"v2-parent-{uuid.uuid4().hex}"
    child_marker = f"v2-child-task-{uuid.uuid4().hex}"
    child_answer = f"V2_CHILD_REPORT_{uuid.uuid4().hex}"
    prompt = f"Delegate one bounded native named task and wait for my steering message. {marker}"
    route = f"{bootstrap} {prompt}"
    reset_mock_llm(mock_llm_server_url)
    configure_mock_llm(
        mock_llm_server_url,
        [
            {
                "tool_calls": [
                    _call(
                        tools,
                        "spawn_agent",
                        "v2_spawn",
                        task_name=task_name,
                        fork_turns="all",
                        message=f"Return your bounded report. {child_marker}",
                    )
                ]
            },
            # Full-history V2 forks share user text; NEW_TASK is agent_message
            # content. Identical delayed replies hold both native requests
            # until steering gives the parent a distinct user-history route.
            {"text": child_answer, "delay": 35},
            {"text": child_answer, "delay": 35},
        ],
        key=marker,
        match=route,
        required_tools=[],
    )
    _send(page, prompt)
    card = page.get_by_test_id("subagent-activity")
    expect(card).to_have_count(1, timeout=30_000)
    expect(card).to_contain_text(task_name)
    expect(page.locator(_WORKING)).to_be_visible(timeout=30_000)
    shelf = page.get_by_test_id("composer-attention-shelf")
    agents = shelf.get_by_test_id("subagent-task-pill")
    expect(agents).to_be_visible(timeout=30_000)
    agents.click()
    expect(page.get_by_role("dialog", name=re.compile("1 sub-agent"))).to_contain_text(task_name)
    _capture(page, evidence, "v2-named-task-running")
    page.keyboard.press("Escape")

    children_response = httpx.get(
        f"{base_url}/v1/sessions/{session_id}/child_sessions", timeout=10
    )
    children_response.raise_for_status()
    children = children_response.json()["data"]
    assert len(children) == 1, children
    child = children[0]
    assert child["task_summary"] == task_name, child
    assert not child.get("task_input"), child
    child_id = child["id"]
    (evidence / "v2-child-without-prompt.json").write_text(json.dumps(child, indent=2))
    assert task_name in _output(mock_llm_server_url, "v2_spawn")

    steer_marker = f"v2-steer-{uuid.uuid4().hex}"
    before_steer = next(
        request
        for request in reversed(_requests(mock_llm_server_url))
        if json.loads(request.get("client_metadata", {}).get("x-codex-turn-metadata", "{}")).get(
            "agent_name"
        )
        == "/root"
        and request.get("model") == "gpt-6.1-sol"
    )
    active_turn = before_steer["client_metadata"]["turn_id"]
    steer_prompt = f"Keep the same named task and report its result. {steer_marker}"
    steer_route = f"{route} {steer_prompt}"
    configure_mock_llm(
        mock_llm_server_url,
        [{"text": "V2_PARENT_STEER_ACCEPTED"}],
        key=steer_marker,
        match=steer_route,
        required_tools=[],
    )
    expect(page.locator(_WORKING)).to_be_visible()
    composer = page.get_by_role("textbox", name="Message the agent", exact=True)
    composer.fill(steer_prompt)
    page.get_by_role("button", name="Send", exact=True).click()
    queued = page.get_by_role("button", name="Send queued message now", exact=True)
    if queued.is_visible():
        queued.click()
    _settled(page, "V2_PARENT_STEER_ACCEPTED")
    requests = _requests(mock_llm_server_url)
    after_steer = next(
        request
        for request in reversed(requests)
        if request.get("client_metadata", {}).get("thread_id")
        == before_steer["client_metadata"]["thread_id"]
        and any(
            steer_marker in str(item.get("content"))
            for item in request.get("input", [])
            if item.get("role") == "user"
        )
    )
    assert after_steer["client_metadata"]["turn_id"] == active_turn, (
        "The follow-up started a later turn instead of steering the active native turn"
    )
    assert (
        sum(
            steer_marker in str(item.get("content"))
            for item in after_steer.get("input", [])
            if item.get("role") == "user"
        )
        == 1
    )
    expect(card).to_have_count(1)
    expect(card).to_have_attribute("data-child-session-id", child_id)
    expect(card).to_contain_text(task_name)
    (evidence / "v2-steer-requests.json").write_text(json.dumps(requests, indent=2))
    _capture(page, evidence, "v2-named-task-after-steer")
    reply = page.get_by_test_id("subagent-reply")
    expect(reply).to_have_count(1, timeout=60_000)
    expect(reply).to_contain_text(child_answer)

    configure_mock_llm(
        mock_llm_server_url,
        [
            {"tool_calls": [_call(tools, "wait_agent", "v2_wait_for_report", timeout_ms=30_000)]},
            {"text": "V2_NAMED_TASK_COMPLETED"},
        ],
        key=steer_marker,
        match=steer_route,
        required_tools=[],
    )
    _send(page, f"Collect the same native named task's final report. {uuid.uuid4().hex}")
    _settled(page, "V2_NAMED_TASK_COMPLETED")
    requests = _requests(mock_llm_server_url)
    assert any(
        item.get("type") == "agent_message"
        and item.get("author") == f"/root/{task_name}"
        and child_answer in json.dumps(item)
        for request in requests
        for item in request.get("input", [])
    ), "The V2 child's private report never reached the native parent model input"
    expect(reply).to_have_count(1, timeout=30_000)
    expect(reply).to_contain_text(child_answer)
    expect(card).to_have_count(1)
    expect(card).to_contain_text(task_name)
    expect(agents).to_have_count(0, timeout=30_000)
    _capture(page, evidence, "v2-named-task-returned")
    page.reload()
    _ensure_chat_view(page)
    expect(card).to_have_count(1, timeout=30_000)
    expect(card).to_contain_text(task_name)
    expect(reply).to_have_count(1)
    expect(reply).to_contain_text(child_answer)


@pytest.mark.timeout(480)
def test_native_claude_capability_shelf(
    page: Page,
    native_claude_mock_session: tuple[str, str],
    mock_llm_server_url: str,
    tmp_path: Path,
    native_capability_evidence: Path,
) -> None:
    """Claude's actual plan, question and file tools reach the shared shelf through hooks."""
    base_url, session_id = native_claude_mock_session
    evidence = native_capability_evidence
    set_fallback_mock_llm(mock_llm_server_url, "claude-sonnet-4-20250514", "")
    tools, _ = _bootstrap(page, native_claude_mock_session, mock_llm_server_url, evidence)
    shelf = page.get_by_test_id("composer-attention-shelf")
    entries = ["Inspect the native capability", "Verify the browser shelf", "Record the result"]
    marker = f"claude-plan-{uuid.uuid4().hex}"
    if "TodoWrite" in tools:
        plan_calls = [
            _call(
                tools,
                "TodoWrite",
                "shelf_claude_plan",
                todos=[
                    {"content": entry, "activeForm": entry, "status": "pending"}
                    for entry in entries
                ],
            )
        ]
    else:
        plan_calls = [
            _call(
                tools, "TaskCreate", f"shelf_claude_plan_{index}", subject=entry, description=entry
            )
            for index, entry in enumerate(entries)
        ]
    _script(mock_llm_server_url, marker, plan_calls, "NATIVE_CLAUDE_PLAN_CREATED")
    _send(page, f"Create the three native plan entries. {marker}")
    _settled(page, "NATIVE_CLAUDE_PLAN_CREATED")
    for call in plan_calls:
        _claude_output(mock_llm_server_url, call["call_id"])
    plan = shelf.get_by_role("button", name="Plan: 0 of 3 completed", exact=True)
    expect(plan).to_be_visible(timeout=30_000)
    plan.click()
    panel = page.get_by_role("dialog", name="Plan", exact=True)
    for entry in entries:
        expect(panel.get_by_text(entry, exact=True)).to_be_visible()
    _capture(page, evidence, "native-plan-three-entries")
    page.keyboard.press("Escape")
    (evidence / "plan-requests.json").write_text(
        json.dumps(_requests(mock_llm_server_url), indent=2)
    )
    page.reload()
    _ensure_chat_view(page)
    expect(plan).to_be_visible(timeout=30_000)

    marker = f"claude-plan-update-{uuid.uuid4().hex}"
    if "TodoWrite" in tools:
        update = _call(
            tools,
            "TodoWrite",
            "shelf_claude_plan_update",
            todos=[
                {
                    "content": entry,
                    "activeForm": entry,
                    "status": "completed" if index == 0 else "pending",
                }
                for index, entry in enumerate(entries)
            ],
        )
    else:
        first_task = _claude_output(mock_llm_server_url, plan_calls[0]["call_id"])
        task_id = re.search(r"Task #(\d+)", first_task)
        assert task_id, f"Native TaskCreate returned no task id: {first_task}"
        update = _call(
            tools, "TaskUpdate", "shelf_claude_plan_update", taskId=task_id[1], status="completed"
        )
    _script(mock_llm_server_url, marker, [update], "NATIVE_CLAUDE_PLAN_UPDATED")
    _send(page, f"Complete the first native plan entry. {marker}")
    _settled(page, "NATIVE_CLAUDE_PLAN_UPDATED")
    _claude_output(mock_llm_server_url, "shelf_claude_plan_update")
    expect(shelf.get_by_role("button", name="Plan: 1 of 3 completed", exact=True)).to_be_visible(
        timeout=30_000
    )
    (evidence / "plan-update-requests.json").write_text(
        json.dumps(_requests(mock_llm_server_url), indent=2)
    )

    marker = f"claude-question-{uuid.uuid4().hex}"
    _script(
        mock_llm_server_url,
        marker,
        [
            _call(
                tools,
                "AskUserQuestion",
                "shelf_claude_question",
                questions=[
                    {
                        "header": "Choice",
                        "question": "Which native Claude result should I use?",
                        "multiSelect": False,
                        "options": [
                            {"label": "Alpha", "description": "Use the first result."},
                            {"label": "Bravo", "description": "Use the second result."},
                        ],
                    }
                ],
            )
        ],
        "NATIVE_CLAUDE_QUESTION_ANSWERED",
    )
    _send(page, f"Ask me a native clarification and wait for the answer. {marker}")
    questions = shelf.get_by_role("button", name="Questions: 1", exact=True)
    expect(questions).to_be_visible(timeout=45_000)
    questions.click()
    question = page.get_by_role("dialog", name="Questions", exact=True)
    expect(question.get_by_test_id("ask-user-question-form")).to_have_count(1)
    _capture(page, evidence, "native-question")
    question.get_by_role("radio", name=re.compile(r"^Bravo\b")).check()
    question.get_by_test_id("ask-user-question-submit").click()
    _settled(page, "NATIVE_CLAUDE_QUESTION_ANSWERED")
    assert "Bravo" in _claude_output(mock_llm_server_url, "shelf_claude_question")
    (evidence / "question-requests.json").write_text(
        json.dumps(_requests(mock_llm_server_url), indent=2)
    )
    page.reload()
    _ensure_chat_view(page)
    expect(questions).to_have_count(0)

    response = httpx.patch(
        f"{base_url}/v1/sessions/{session_id}", json={"permission_mode": "default"}, timeout=45
    )
    response.raise_for_status()
    side_effect = tmp_path / "claude-approved-once.txt"
    marker = f"claude-approval-{uuid.uuid4().hex}"
    _script(
        mock_llm_server_url,
        marker,
        [
            _call(
                tools,
                "Write",
                "shelf_claude_write",
                file_path=str(side_effect),
                content="approved\n",
            )
        ],
        "NATIVE_CLAUDE_APPROVAL_FINISHED",
    )
    _send(page, f"Write the file after I approve it once. {marker}")
    approvals = shelf.get_by_role("button", name="Approvals: 1", exact=True)
    expect(approvals).to_be_visible(timeout=45_000)
    assert not side_effect.exists(), "Native Claude wrote the file before approval"
    approvals.click()
    approval = page.get_by_role("dialog", name="Approvals", exact=True)
    expect(approval.get_by_test_id("approval-card")).to_have_count(1)
    _capture(page, evidence, "native-approval")
    approval.get_by_role("button", name="Approve", exact=True).click()
    _settled(page, "NATIVE_CLAUDE_APPROVAL_FINISHED")
    _claude_output(mock_llm_server_url, "shelf_claude_write")
    assert side_effect.read_text() == "approved\n"
    (evidence / "approval-requests.json").write_text(
        json.dumps(_requests(mock_llm_server_url), indent=2)
    )
    page.reload()
    _ensure_chat_view(page)
    expect(approvals).to_have_count(0)
    assert side_effect.read_text() == "approved\n"
    _capture(page, evidence, "native-settled")
