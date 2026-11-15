# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Canonical catalog projection and real instruction composition boundaries."""

from __future__ import annotations

from omnigent.runtime.prompt import build_instructions_nullable, raw_author_instructions
from omnigent.runtime.ui_contract import (
    UI_CONTRACT_VERSION,
    append_ui_contract,
    native_ui_contract,
    ui_capabilities,
)
from omnigent.spec import AgentSpec
from omnigent.spec.types import ExecutorSpec


def test_complete_catalog_is_gated_by_actual_advertised_tools() -> None:
    catalog = ui_capabilities(
        "codex-native", tool_names=["mcp__omnigent__upload_file", "sys_read_inbox"]
    )
    assert set(catalog["groups"]) == {
        "formatting",
        "questions",
        "plans",
        "agents",
        "shells",
        "files",
        "artifacts",
        "context",
        "workspace",
        "background",
        "notices",
    }
    assert catalog["groups"]["files"]["tools"] == ["mcp__omnigent__upload_file"]
    assert catalog["groups"]["background"]["tools"] == ["sys_read_inbox"]
    assert catalog["groups"]["questions"]["tools"] == []
    assert catalog["groups"]["questions"]["availability"] == "conditional"
    assert all(
        group.get("scope")
        and group.get("input")
        and group.get("output")
        and group.get("lifecycle")
        and group.get("persistence")
        and group.get("limits")
        and group.get("fallback")
        for group in catalog["groups"].values()
    )


def test_flags_and_permissions_do_not_grant_hidden_operations() -> None:
    catalog = ui_capabilities(
        tool_names=["upload_file"],
        feature_flags={"inline_html_artifacts": False},
        permissions={"files": False},
    )
    assert catalog["groups"]["artifacts"]["availability"] == "unavailable"
    assert catalog["groups"]["files"]["availability"] == "unavailable"
    assert catalog["groups"]["agents"]["availability"] == "unavailable"
    assert catalog["groups"]["agents"]["tools"] == []


def test_native_attachment_command_uses_captured_context_not_ambient_defaults() -> None:
    result = native_ui_contract(
        "codex-native", session_id="chat-1", server_url="https://server.example/custom-prefix"
    )
    assert (
        "triune attach-file PATH --session chat-1 --server https://server.example/custom-prefix"
        in result
    )
    assert "triune attach-file PATH" not in native_ui_contract("codex-native")
    assert "password" not in native_ui_contract(
        "codex-native", session_id="chat", server_url="https://user:password@example.com"
    )


def test_fresh_spec_receives_catalog_with_original_author_text_preserved() -> None:
    author = "  Preserve this author role.  "
    spec = AgentSpec(spec_version=1, name="fresh", instructions=author, executor=ExecutorSpec())
    text = build_instructions_nullable(
        spec, "Request rule", [{"type": "function", "function": {"name": "sys_ui_capabilities"}}]
    )
    assert text is not None and text.startswith(author + "\n\nRequest rule\n\n")
    assert f"Triune UI contract {UI_CONTRACT_VERSION}" in text
    assert "Call sys_ui_capabilities" in text
    assert raw_author_instructions(spec) == author
    captured = build_instructions_nullable(
        spec, None, [], session_id="chat-actual", server_url="https://server.example/prefix"
    )
    assert "--session chat-actual --server https://server.example/prefix" in (captured or "")
    plain = AgentSpec(spec_version=1, name="fresh", executor=ExecutorSpec())
    assert "Triune UI contract" in (build_instructions_nullable(plain, None, []) or "")


def test_static_startup_contract_is_additive_and_repeatable() -> None:
    first = append_ui_contract("AUTHOR", "claude-native")
    assert first.startswith("AUTHOR\n\n")
    assert append_ui_contract(first, "claude-native") == first
    assert "triune-artifact" in first and 'data-triune-kit="1"' in first
    assert "no external CDN" in first
    assert "sys_read_inbox to collect" not in first
    assert len(first) < 4096
