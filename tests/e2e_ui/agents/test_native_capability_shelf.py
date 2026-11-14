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
from playwright.sync_api import Locator, Page, expect

from tests._helpers.native_session import create_native_session
from tests._helpers.polling import poll_until
from tests._helpers.session import bind_session_runner
from tests.e2e_ui.approvals.test_ask_user_question import _pending_elicitations
from tests.e2e_ui.approvals.test_stop_control_pending_elicitation import _session_snapshot
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
    _USER,
    _WORKING,
    _ensure_chat_view,
    _item_text,
    _ordered_message_items,
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


def _claude_output(mock_url: str, call_id: str, *, is_error: bool = False) -> str:
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
                assert bool(results[0].get("is_error")) is is_error, results[0]
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


def _question_resolutions(page: Page) -> list[dict[str, Any]]:
    resolutions = []

    def record(request):
        if (
            request.method == "POST"
            and "/elicitations/" in request.url
            and request.url.endswith("/resolve")
        ):
            resolutions.append({"url": request.url, "body": request.post_data_json})

    page.on("request", record)
    return resolutions


def _navigate_question_form(page: Page, panel: Locator, response: str, title: str) -> None:
    """Exercise the same carousel interaction on real Codex and Claude requests."""
    progress = panel.get_by_test_id("ask-user-question-progress")
    expect(progress).to_have_text("Question 1 of 2")
    expect(progress.locator("..")).to_contain_text(title)
    expect(panel.get_by_role("button", name="Previous", exact=True)).to_be_disabled()
    expect(panel.get_by_test_id("ask-user-question-submit")).to_be_enabled()
    forward = panel.get_by_test_id("ask-user-question-next")
    expect(forward).to_have_text("Skip")
    if response in {"full", "declined"}:
        panel.get_by_role("radio", name=re.compile(r"^Bravo\b")).check()
        expect(forward).to_have_text("Next")
    forward.click()
    expect(progress).to_have_text("Question 2 of 2")
    expect(panel.get_by_test_id("ask-user-question-submit")).to_be_enabled()
    if response in {"full", "partial"}:
        panel.get_by_role("radio", name=re.compile(r"^Delta\b")).check()
    panel.get_by_role("button", name="Previous", exact=True).click()
    expect(progress).to_have_text("Question 1 of 2")
    page.keyboard.press("Escape")
    expect(panel).not_to_be_visible()
    page.get_by_test_id("composer-attention-shelf").get_by_role(
        "button", name="Questions: 1", exact=True
    ).click()
    expect(progress).to_have_text("Question 1 of 2")
    expect(panel.get_by_role("radio", name=re.compile(r"^Bravo\b"))).to_be_checked(
        checked=response in {"full", "declined"}
    )
    expect(forward).to_have_text("Next" if response in {"full", "declined"} else "Skip")
    forward.click()
    expect(panel.get_by_role("radio", name=re.compile(r"^Delta\b"))).to_be_checked(
        checked=response in {"full", "partial"}
    )
    panel.get_by_role("button", name="Previous", exact=True).click()
    expect(panel.get_by_test_id("ask-user-question-submit")).to_be_enabled()


@pytest.mark.parametrize(
    "capability, question_response",
    [
        *[
            pytest.param(capability, "full", id=capability)
            for capability in ["shells", "approvals", "agents", "plan"]
        ],
        *[
            pytest.param(capability, response, id=f"{capability}-{response}")
            for capability in ["blocking-questions", "questions"]
            for response in ["full", "partial", "empty", "declined"]
        ],
    ],
)
@pytest.mark.timeout(240)
def test_native_codex_capability_shelf(
    capability: str,
    question_response: str,
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
        initial_marker = f"Native shell initial {uuid.uuid4().hex[:8]}"
        output_marker = f"Native shell output {uuid.uuid4().hex[:8]}"
        release, started, finished, emit_live = (
            tmp_path / name for name in ("release", "started", "finished", "emit-live")
        )
        code = (
            "from pathlib import Path; import time; "
            f"Path({str(started)!r}).write_text('started'); "
            f"print({initial_marker!r}, flush=True); "
            f"release=Path({str(release)!r}); emit=Path({str(emit_live)!r}); "
            "deadline=time.monotonic()+120; time.sleep(2)\n"
            "while not emit.exists() and not release.exists() and time.monotonic()<deadline: "
            "time.sleep(.1)\n"
            f"if emit.exists(): print({output_marker!r}, flush=True)\n"
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
            _settled(page, "NATIVE_SHELL_STARTED")
            shell_output = _output(mock_llm_server_url, "shelf_shell")
            assert initial_marker in shell_output, shell_output
            assert output_marker not in shell_output, shell_output
            # Codex omits the first-yield buffer from outputDelta; exercise a real later delta.
            emit_live.touch()
            shells.click()
            popup = page.get_by_role("dialog", name="1 background task", exact=True)
            expect(popup).to_contain_text("time.monotonic")
            expect(popup.locator("[data-resource-row]")).to_have_count(1)
            expect(popup.locator(".resource-description")).to_have_text(
                output_marker, timeout=30_000
            )
            expect(page.locator(_WORKING)).to_have_count(0)
            _capture(page, evidence, "codex-live-shell")
            page.keyboard.press("Escape")
            (evidence / "shell-requests.json").write_text(
                json.dumps(_requests(mock_llm_server_url), indent=2)
            )
            handle = re.search(r"session ID (\d+)", shell_output)
            assert handle, f"Native command did not yield a live process handle: {shell_output}"
            inventory_url = f"{base_url}/v1/sessions/{session_id}/resources/shells"

            def shell_resources():
                response = httpx.get(inventory_url, timeout=15)
                response.raise_for_status()
                return response.json()["data"]

            resources = shell_resources()
            native = [resource for resource in resources if resource["source"] == "codex_native"]
            assert len(native) == 1, resources
            resource = native[0]
            assert resource["output_preview"] == output_marker, resource
            assert resource["can_open"] is True, resource
            resource_url = f"{base_url}{resource['resource_url']}"
            focus_id = f"{resource['source']}:{resource['resource_id']}"
            (evidence / "shell-resource.json").write_text(json.dumps(resource, indent=2))
            stops = []
            page.on(
                "request",
                lambda request: (
                    stops.append(request.url)
                    if request.method == "POST" and request.url.endswith("/stop")
                    else None
                ),
            )
            shells.click()
            row = popup.locator("[data-resource-row]")
            expect(row).to_have_count(1)
            expect(row.locator(".resource-description")).to_have_text(output_marker)
            stop = row.get_by_role("button", name=re.compile(r"^Actions for "))
            expect(stop).to_have_count(1 if resource["can_stop"] is True else 0)
            row.get_by_role("button", name=re.compile(r"^Open shell beside ·")).click()
            page.keyboard.press("Escape")
            output = page.get_by_role("region", name="Shell output", exact=True)
            expect(output.get_by_label("Retained shell output")).to_contain_text(output_marker)
            expect(page.get_by_placeholder("Send a message…")).to_be_visible()
            shell_tabs = page.get_by_role("tab").filter(has_text=output_marker)
            expect(shell_tabs).to_have_count(1)
            refresh = output.get_by_role("button", name="Refresh shell output", exact=True)
            expect(refresh).to_be_enabled()
            with page.expect_response(
                lambda response: response.url == resource_url and response.request.method == "GET"
            ) as opened:
                refresh.click()
            assert opened.value.ok, opened.value.text()
            captured = opened.value.json()
            assert captured["source"] == resource["source"], captured
            assert captured["resource_id"] == resource["resource_id"], captured
            assert output_marker in captured["output"], captured
            assert not finished.exists(), "Opening captured output ended the native command"
            shells.click()
            row.get_by_role(
                "button", name=re.compile(r"^Show .* in Orchestration$", re.DOTALL)
            ).click()
            page.keyboard.press("Escape")
            orchestration = page.get_by_role("tabpanel", name="Orchestration", exact=True)
            shell_list = orchestration.get_by_role("list", name="Shells", exact=True)
            # The row identity comes from the native resource, not command matching.
            target = shell_list.locator(f"[data-shell-id={json.dumps(focus_id)}]")
            expect(target).to_have_count(1)
            expect(target).to_have_attribute("data-shell-id", focus_id)
            expect(target.locator("[data-resource-row]")).to_have_class(re.compile(r"\bring-1\b"))
            expect(
                orchestration.get_by_role("button", name="Shells", exact=True)
            ).to_have_attribute("aria-pressed", "true")
            expect(
                shell_list.locator("[data-resource-row]").filter(has_text=output_marker)
            ).to_have_count(1)
            expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(1)
            expect(shell_tabs).to_have_count(1)
            page.wait_for_function(
                """viewId => Object.keys(localStorage)
                  .filter(key => key.startsWith('omnigent:dock:v1:'))
                  .some(key => {
                    const saved = JSON.parse(localStorage.getItem(key));
                    const layouts = [saved.shared, saved.pins,
                      ...(saved.chats ?? []).map(chat => chat.layout)];
                    const view = layouts.flatMap(layout => layout?.views ?? [])
                      .find(view => view.id === viewId);
                    return view && !view.resource.focusShellId && !view.resource.linkRequestId;
                  })""",
                arg=orchestration.get_attribute("data-dock-view"),
            )
            with page.expect_response(
                lambda response: response.url == inventory_url and response.request.method == "GET"
            ) as refreshed:
                orchestration.get_by_role("button", name="All", exact=True).click()
            assert refreshed.value.ok, refreshed.value.text()
            expect(orchestration.get_by_role("button", name="All", exact=True)).to_have_attribute(
                "aria-pressed", "true"
            )
            expect(
                shell_list.locator("[data-resource-row]").filter(has_text=output_marker)
            ).to_have_count(1)
            assert not stops, "Navigation stopped a native resource"
            assert (
                len([row for row in shell_resources() if row["source"] == "codex_native"]) == 1
            ), "Opening output created another native shell"
            _capture(page, evidence, "codex-shell-orchestration")
            if resource["can_stop"] is True:
                assert resource["stop_method"] == "POST", resource
                assert resource["stop_url"] == f"{resource['resource_url']}/stop", resource
                target.hover()
                status = target.get_by_role("button", name=re.compile(r"^Actions for "))
                expect(status).to_have_count(1)
                with page.expect_response(
                    lambda response: (
                        response.url == f"{base_url}{resource['stop_url']}"
                        and response.request.method == "POST"
                    )
                ) as stopped:
                    status.click()
                assert stopped.value.ok, stopped.value.text()
                result = stopped.value.json()
                assert result["source"] == resource["source"], result
                assert result["resource_id"] == resource["resource_id"], result
                assert result["status"] == "stopped", result
                expect(shelf.get_by_test_id("background-task-pill")).to_have_count(
                    0, timeout=30_000
                )
                assert stops == [f"{base_url}{resource['stop_url']}"], stops
                assert not finished.exists(), (
                    "The supposedly stopped process reached its normal completion"
                )
                ended = httpx.get(resource_url, timeout=15)
                ended.raise_for_status()
                assert ended.json()["can_stop"] is False, ended.text

                def complete_output():
                    response = httpx.get(resource_url, timeout=15)
                    response.raise_for_status()
                    return (response.json().get("output") or "").splitlines() == [
                        initial_marker,
                        output_marker,
                    ]

                poll_until(complete_output)
                shell_tabs.click()
                expect(output.get_by_label("Retained shell output")).to_contain_text(
                    initial_marker, timeout=30_000
                )
                assert output.get_by_label(
                    "Retained shell output"
                ).text_content().splitlines() == [initial_marker, output_marker]
                _capture(page, evidence, "codex-targeted-shell-stopped")
                return
            expect(target.get_by_role("button", name=re.compile(r"^Actions for "))).to_have_count(
                0
            )
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
        completed = httpx.get(resource_url, timeout=15)
        completed.raise_for_status()
        assert (completed.json().get("output") or "").splitlines() == [
            initial_marker,
            output_marker,
        ], completed.text

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
        prompt = f"Ask me two native clarifications and wait for my answers. {marker}"
        titles = ["Which native result should I use?", "Which native follow-up should I use?"]
        options = [["Alpha", "Bravo"], ["Charlie", "Delta"]]
        question_inputs = [
            {"title": title, "options": labels}
            if asynchronous
            else {
                "id": f"native_choice_{index}",
                "header": "Choice",
                "question": title,
                "options": [{"label": label, "description": f"Use {label}."} for label in labels],
            }
            for index, (title, labels) in enumerate(zip(titles, options, strict=True))
        ]
        answers = {
            f"question_{index}" if asynchronous else f"native_choice_{index}": answer
            for index, answer in enumerate(["Bravo", "Delta"])
            if question_response == "full" or (question_response == "partial" and index == 1)
        }
        _script(
            mock_llm_server_url,
            marker,
            [
                _call(
                    tools,
                    "request_user_input_async" if asynchronous else "request_user_input",
                    "shelf_question",
                    questions=question_inputs,
                )
            ],
            "NATIVE_QUESTION_PENDING" if asynchronous else "NATIVE_QUESTION_ANSWERED",
            match=f"{bootstrap_marker} {prompt}" if asynchronous else None,
        )
        resolutions = _question_resolutions(page)
        _send(page, prompt)
        questions = shelf.get_by_role("button", name="Questions: 1", exact=True)
        expect(questions).to_be_visible(timeout=45_000)
        pending = _pending_elicitations(base_url, session_id)
        assert len(pending) == 1, pending
        native_params = pending[0]["params"]
        assert len(native_params["ask_user_question"]["questions"]) == 2, native_params
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
        _navigate_question_form(page, question, question_response, "Codex needs input")
        assert not resolutions, "Question navigation or dismissal submitted a verdict"
        assert _pending_elicitations(base_url, session_id), (
            "Navigation resolved the native request"
        )
        if asynchronous:
            configure_mock_llm(
                mock_llm_server_url,
                [{"text": "NATIVE_QUESTION_ANSWERED"}],
                key=marker,
                match=f"{bootstrap_marker} {prompt}",
                required_tools=[],
            )
        action = "decline" if question_response == "declined" else "accept"
        with page.expect_response(
            lambda response: (
                "/elicitations/" in response.url
                and response.url.endswith("/resolve")
                and response.request.method == "POST"
            )
        ) as acknowledgement:
            question.get_by_role(
                "button",
                name="Decline" if question_response == "declined" else "Submit",
                exact=True,
            ).click()
        assert acknowledgement.value.ok, acknowledgement.value.text()
        assert len(resolutions) == 1, resolutions
        assert resolutions[0]["body"]["action"] == action
        assert resolutions[0]["body"].get("content", {}) == answers
        blocking_decline = not asynchronous and question_response == "declined"
        if blocking_decline:
            interrupted = page.get_by_test_id("assistant-interrupted-indicator")
            expect(interrupted).to_have_count(1, timeout=30_000)
            expect(
                interrupted.locator("xpath=ancestor::*[@data-testid='message-bubble'][1]")
            ).to_have_attribute("data-message-id", f"codex_{native_params['turn_id']}")
            expect(page.locator(_WORKING)).to_have_count(0, timeout=30_000)
            expect(page.get_by_placeholder("Send a message…")).to_be_editable()
            expect(page.locator(_ASSISTANT, has_text="NATIVE_QUESTION_ANSWERED")).to_have_count(0)
            poll_until(lambda: _session_snapshot(base_url, session_id)["status"] == "idle")
            assert not any(
                item.get("call_id") == "shelf_question"
                and item.get("type") in {"function_call_output", "custom_tool_call_output"}
                for request in _requests(mock_llm_server_url)
                for item in request.get("input", [])
            ), "Cancelled native questions must not invent a tool answer"
        else:
            _settled(page, "NATIVE_QUESTION_ANSWERED")
        if asynchronous:
            requests = _requests(mock_llm_server_url)
            if answers:
                expected_text = "\n\n".join(
                    f"{title}\n{answer}"
                    for index, (title, answer) in enumerate(
                        zip(titles, ["Bravo", "Delta"], strict=True)
                    )
                    if f"question_{index}" in answers
                )
                native_request = next(
                    request
                    for request in reversed(requests)
                    if request.get("client_metadata", {}).get("thread_id")
                    == native_params["thread_id"]
                    and any(
                        item.get("role") == "user" and _item_text(item) == expected_text
                        for item in request.get("input", [])
                    )
                )
                native_answers = [
                    item
                    for item in native_request["input"]
                    if item.get("role") == "user" and _item_text(item) == expected_text
                ]
                assert len(native_answers) == 1, native_answers
                poll_until(
                    lambda: any(
                        item.get("role") == "user" and _item_text(item) == expected_text
                        for item in _ordered_message_items(base_url, session_id)
                    )
                )
                saved = [
                    item
                    for item in _ordered_message_items(base_url, session_id)
                    if item.get("role") == "user" and _item_text(item) == expected_text
                ]
                assert len(saved) == 1, saved
                assert saved[0].get("user_authored") is True, saved[0]
                assert saved[0].get("communication") is None, saved[0]
                expect(page.locator(_USER).filter(has_text=expected_text)).to_have_count(1)
            else:
                label = (
                    "Question request declined"
                    if action == "decline"
                    else "Questions submitted without answers"
                )

                def controls():
                    return [
                        item
                        for item in _ordered_message_items(base_url, session_id)
                        if (item.get("communication") or {}).get("kind") == "system"
                        and (item.get("communication") or {}).get("source_title") == label
                    ]

                poll_until(
                    lambda: any(
                        item["communication"].get("delivery_state") == "confirmed"
                        and item["communication"].get("receipt") == "transcript"
                        for item in controls()
                    )
                )
                saved = controls()
                assert len(saved) == 1, saved
                origin = saved[0]["communication"]
                assert re.fullmatch(r"[0-9a-f]{32}", origin["message_id"]), origin
                assert saved[0]["id"] == origin["message_id"], saved[0]
                assert origin["source_agent_name"] == "System", origin
                assert origin["delivery_state"] == "confirmed", origin
                assert origin["receipt"] == "transcript", origin
                assert origin["destination_conversation_id"] == session_id, origin
                assert saved[0].get("user_authored") is not True, saved[0]
                event = json.loads(_item_text(saved[0]))
                assert event == {
                    "event": "question_submission",
                    "item_id": native_params["item_id"],
                    "action": action,
                    "answers": {},
                }, event
                native_request = next(
                    request
                    for request in reversed(requests)
                    if request.get("client_metadata", {}).get("thread_id")
                    == native_params["thread_id"]
                    and any(
                        item.get("role") == "user"
                        and f"event_id={origin['message_id']}" in _item_text(item)
                        for item in request.get("input", [])
                    )
                )
                native_controls = [
                    item
                    for item in native_request["input"]
                    if item.get("role") == "user"
                    and f"event_id={origin['message_id']}" in _item_text(item)
                ]
                assert len(native_controls) == 1, native_controls
                assert "not authored by the user" in _item_text(native_controls[0])
                assert json.dumps(event) in _item_text(native_controls[0])
                expect(page.get_by_test_id("system-message").filter(has_text=label)).to_have_count(
                    1
                )
                expect(page.locator(_USER).filter(has_text="question_submission")).to_have_count(0)
        elif not blocking_decline:
            output = json.loads(_output(mock_llm_server_url, "shelf_question"))
            assert output == {
                "answers": {key: {"answers": [value]} for key, value in answers.items()}
            }, output
        page.reload()
        _ensure_chat_view(page)
        expect(questions).to_have_count(0)
        if asynchronous:
            expect(composer).to_have_value(
                "Keep this draft while answering the native async question."
            )
            if answers:
                expect(page.locator(_USER).filter(has_text=expected_text)).to_have_count(1)
                reloaded = [
                    item
                    for item in _ordered_message_items(base_url, session_id)
                    if item.get("role") == "user" and _item_text(item) == expected_text
                ]
                assert len(reloaded) == 1 and reloaded[0]["id"] == saved[0]["id"], reloaded
                assert reloaded[0].get("user_authored") is True, reloaded
            else:
                reloaded = controls()
                assert len(reloaded) == 1 and reloaded[0]["id"] == saved[0]["id"], reloaded
                assert reloaded[0]["communication"] == origin, reloaded
                expect(page.get_by_test_id("system-message").filter(has_text=label)).to_have_count(
                    1
                )
                expect(page.locator(_USER).filter(has_text="question_submission")).to_have_count(0)
        assert not _pending_elicitations(base_url, session_id), (
            "Native request remained parked after the model acknowledged its response"
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


@pytest.mark.parametrize("question_response", ["full", "partial", "empty", "declined"])
@pytest.mark.timeout(480)
def test_native_claude_capability_shelf(
    question_response: str,
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
    titles = [
        "Which native Claude result should I use?",
        "Which native Claude follow-up should I use?",
    ]
    answers = {
        title: answer
        for index, (title, answer) in enumerate(zip(titles, ["Bravo", "Delta"], strict=True))
        if question_response == "full" or (question_response == "partial" and index == 1)
    }
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
                        "question": title,
                        "multiSelect": False,
                        "options": [
                            {"label": label, "description": f"Use {label}."} for label in labels
                        ],
                    }
                    for title, labels in zip(
                        titles, [["Alpha", "Bravo"], ["Charlie", "Delta"]], strict=True
                    )
                ],
            )
        ],
        "NATIVE_CLAUDE_QUESTION_ANSWERED",
    )
    resolutions = _question_resolutions(page)
    _send(page, f"Ask me two native clarifications and wait for the answers. {marker}")
    questions = shelf.get_by_role("button", name="Questions: 1", exact=True)
    expect(questions).to_be_visible(timeout=45_000)
    questions.click()
    question = page.get_by_role("dialog", name="Questions", exact=True)
    expect(question.get_by_test_id("ask-user-question-form")).to_have_count(1)
    _capture(page, evidence, "native-question")
    _navigate_question_form(page, question, question_response, "Claude has questions")
    assert not resolutions, "Question navigation or dismissal submitted a verdict"
    assert _pending_elicitations(base_url, session_id), "Navigation resolved the native request"
    with page.expect_response(
        lambda response: (
            "/elicitations/" in response.url
            and response.url.endswith("/resolve")
            and response.request.method == "POST"
        )
    ) as acknowledgement:
        question.get_by_role(
            "button", name="Decline" if question_response == "declined" else "Submit", exact=True
        ).click()
    assert acknowledgement.value.ok, acknowledgement.value.text()
    assert len(resolutions) == 1, resolutions
    assert resolutions[0]["body"]["action"] == (
        "decline" if question_response == "declined" else "accept"
    )
    assert resolutions[0]["body"].get("content", {}) == answers
    _settled(page, "NATIVE_CLAUDE_QUESTION_ANSWERED")
    output = _claude_output(
        mock_llm_server_url, "shelf_claude_question", is_error=question_response == "declined"
    )
    for title, answer in zip(titles, ["Bravo", "Delta"], strict=True):
        assert (f'"{title}"=' in output) == (title in answers), output
        if title in answers:
            assert f'"{title}"="{answer}"' in output, output
    (evidence / "question-requests.json").write_text(
        json.dumps(_requests(mock_llm_server_url), indent=2)
    )
    page.reload()
    _ensure_chat_view(page)
    expect(questions).to_have_count(0)
    assert not _pending_elicitations(base_url, session_id), (
        "Claude left its question pending after the native tool result"
    )

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
