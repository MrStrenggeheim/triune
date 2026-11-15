"""Tests for the shared native startup-additive raw-instruction resolution.

``_native_startup_raw_instructions_from_spec`` is the seam that turns a
session's ``AgentSpec.instructions`` into the value passed to the
managed-host launch paths' startup-additive channels: claude-native's
``--append-system-prompt`` (``_auto_create_claude_terminal``) and
codex-native's ``developer_instructions`` (``_auto_create_codex_terminal``).
It must return the verbatim author text only — never the framework-composed
per-turn string. Terminal launch is not tied to any one turn, while the
composed string is assembled per conversation for the turn about to run, so
carrying one turn's composition would address every later turn with it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from omnigent.runner.app import ResolvedSpec, _native_startup_raw_instructions_from_spec
from omnigent.spec.types import AgentSpec, ExecutorSpec


def _spec(instructions: str | None) -> AgentSpec:
    """Build a minimal agent spec carrying *instructions*."""
    return AgentSpec(
        spec_version=1,
        name="claude_code",
        instructions=instructions,
        executor=ExecutorSpec(),
    )


@pytest.mark.parametrize(
    ("instructions", "expected"),
    [
        ("Be a concise assistant.", "Be a concise assistant."),
        (None, None),
        ("   \n  ", None),
    ],
    ids=["present", "absent", "whitespace-only"],
)
def test_native_startup_raw_instructions_from_spec(
    instructions: str | None, expected: str | None
) -> None:
    """Verbatim author text is returned; absent/whitespace-only resolves to None."""
    assert _native_startup_raw_instructions_from_spec(_spec(instructions)) == expected


def test_native_startup_raw_instructions_from_spec_none_spec() -> None:
    """A missing spec yields no instructions (neither channel is injected)."""
    assert _native_startup_raw_instructions_from_spec(None) is None


def test_native_startup_raw_instructions_from_spec_resolved_wrapper() -> None:
    """A ResolvedSpec wrapper unwraps to the same instructions text."""
    wrapped = ResolvedSpec(spec=_spec("Be a concise assistant."), workdir=Path("/tmp"))
    assert _native_startup_raw_instructions_from_spec(wrapped) == "Be a concise assistant."


def test_native_startup_raw_instructions_from_spec_never_returns_stripped_form() -> None:
    """The original resolved text is preserved verbatim, not the stripped form."""
    padded = "  Keep leading/trailing whitespace exactly.  "
    assert _native_startup_raw_instructions_from_spec(_spec(padded)) == padded


@pytest.mark.parametrize("harness", ["goose", "qwen", "hermes", "kimi"])
async def test_final_native_launch_receives_real_ui_contract(
    harness: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Capture the actual final terminal request before any process is created."""
    import importlib
    import json
    from typing import Any

    import yaml

    from omnigent.runner.native import orchestration
    from omnigent.runtime.ui_contract import UI_CONTRACT_VERSION
    from tests.runner.native_helpers import _harness_spec

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("RUNNER_SERVER_URL", "https://server.example/prefix")
    monkeypatch.setenv("GOOSE_MOIM_MESSAGE_TEXT", "ENV AUTHOR")
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("KIMI_CODE_HOME", str(home / ".kimi"))
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda **_kwargs: None)
    bridge = importlib.import_module(f"omnigent.harnesses.{harness}_native.bridge")
    main = importlib.import_module(f"omnigent.harnesses.{harness}_native.main")
    monkeypatch.setattr(bridge, "_BRIDGE_ROOT", tmp_path / "bridges")
    monkeypatch.setattr(main, f"resolve_{harness}_executable", lambda: "/mock/vendor")

    async def launch_config(**_kwargs: Any) -> Any:
        return orchestration._PiNativeLaunchConfig(
            workspace=tmp_path,
            server_url="https://server.example/prefix",
            terminal_launch_args=[],
            external_session_id=None,
        )

    async def cancel(_session: str) -> None:
        return None

    monkeypatch.setattr(orchestration, "_pi_native_launch_config", launch_config)
    monkeypatch.setattr(orchestration, "_cancel_auto_forwarder_task", cancel)

    class Captured(Exception):
        pass

    captured: dict[str, Any] = {}

    class Registry:
        terminal_registry = None

        async def launch_required_terminal(self, **kwargs: Any) -> Any:
            captured.update(kwargs)
            raise Captured

    spec = _harness_spec(f"{harness}-native")
    spec.instructions = "AGENT AUTHOR"
    launch = getattr(orchestration, f"_auto_create_{harness}_terminal")
    with pytest.raises(Captured):
        await launch(
            "chat-contract", Registry(), lambda *_args: None, server_client=None, agent_spec=spec
        )
    terminal = captured["spec"]
    if harness == "goose":
        text = terminal.env["GOOSE_MOIM_MESSAGE_TEXT"]
        assert text.startswith("ENV AUTHOR\n\nAGENT AUTHOR\n\n")
    elif harness == "qwen":
        text = terminal.args[terminal.args.index("--append-system-prompt") + 1]
    elif harness == "hermes":
        config = yaml.safe_load((Path(terminal.env["HERMES_HOME"]) / "config.yaml").read_text())
        text = config["platform_hints"]["tui"]["append"]
        assert config["platform_hints"]["cli"]["append"] == text
    else:
        plugin_root = (
            Path(terminal.env["KIMI_CODE_HOME"]) / "plugins" / "managed" / "triune-ui-contract"
        )
        manifest = json.loads((plugin_root / "kimi.plugin.json").read_text())
        text = (plugin_root / manifest["systemPromptPath"]).read_text()
    assert "AGENT AUTHOR" in text
    assert f"Triune UI contract {UI_CONTRACT_VERSION}" in text
    assert "--session chat-contract --server https://server.example/prefix" in text
