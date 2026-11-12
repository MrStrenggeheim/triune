"""Triune display defaults and compatibility boundaries."""

from __future__ import annotations

import importlib.metadata
from io import StringIO
from pathlib import Path
from unittest.mock import Mock

import pytest
from click.testing import CliRunner
from rich.cells import cell_len
from rich.console import Console

from omnigent import update_check
from omnigent import version as version_module
from omnigent.cli import cli
from omnigent.cli_invocation import cli_invocation
from omnigent.inner import wordmark
from omnigent.onboarding import extra_install
from omnigent.server.server_config import load_branding_snapshot


@pytest.mark.parametrize("app_name", [None, "", "   ", "Custom Workspace", "Omnigent"])
def test_backend_branding_preserves_custom_names(app_name: str | None) -> None:
    snapshot = load_branding_snapshot(
        {"branding": {"app_name": app_name, "heading": "", "powered_by": False}}
    )
    public = snapshot.config()
    assert public["app_name"] == (app_name.strip() if app_name and app_name.strip() else "Triune")
    assert public["heading"] == ""
    assert public["powered_by"] is False
    assert snapshot.server_name is None
    assert load_branding_snapshot({}).config()["app_name"] == "Triune"


@pytest.mark.parametrize("available", ["triune", "omnigent", None])
def test_installed_branding_metadata_prefers_triune(
    monkeypatch: pytest.MonkeyPatch, available: str | None
) -> None:
    calls: list[str] = []
    dist = Mock(version="9.8.7")

    def lookup(name: str) -> importlib.metadata.Distribution:
        calls.append(name)
        if name == available:
            return dist
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(version_module.importlib.metadata, "distribution", lookup)
    assert version_module.installed_version() == ("9.8.7" if available else version_module.VERSION)
    assert calls == (["triune"] if available == "triune" else ["triune", "omnigent"])
    assert update_check._get_distribution() is (dist if available else None)


@pytest.mark.parametrize("command", [[], ["server"], ["run"], ["claude"], ["codex"], ["upgrade"]])
def test_cli_help_uses_triune_branding(command: list[str]) -> None:
    result = CliRunner().invoke(cli, [*command, "--help"], prog_name="triune")
    assert result.exit_code == 0, result.output
    assert "triune" in result.output.lower()
    assert "Omnigent" not in result.output


def test_compact_and_block_branding() -> None:
    stream = StringIO()
    wordmark.render_compact(Console(file=stream, no_color=True))
    assert "Triune" in stream.getvalue()
    assert wordmark._build_wordmark("triune") == wordmark.WORDMARK_LINES
    assert len({cell_len(row) for row in wordmark.WORDMARK_LINES}) == 1
    assert cli_invocation(env={}) == "triune"
    assert cli_invocation(env={"OMNIGENT_WRAPPER_COMMAND": "custom wrapper"}) == "custom wrapper"


@pytest.mark.parametrize(
    "options",
    [[], ["--check"], ["--dry-run"], ["--nightly"], ["--force"], ["--target-version", "99.0"]],
)
def test_upgrade_branding_never_queries_or_installs_upstream(
    monkeypatch: pytest.MonkeyPatch, options: list[str]
) -> None:
    run = Mock(side_effect=AssertionError("An update must not launch a process"))
    cache = Mock(side_effect=AssertionError("Legacy upstream cache must not be read"))
    monkeypatch.setattr(update_check.subprocess, "run", run)
    monkeypatch.setattr(update_check, "_read_cache", cache)
    result = CliRunner().invoke(cli, ["upgrade", *options])
    assert result.exit_code == (0 if options in (["--check"], ["--dry-run"]) else 1)
    assert "disabled for Triune" in result.output
    assert "github.com/MrStrenggeheim/triune" in result.output
    run.assert_not_called()
    cache.assert_not_called()
    update_check.maybe_show_update_notice()
    update_check.refresh_update_cache()
    assert update_check.fetch_latest_version() is None
    assert update_check._latest_nightly_version() is None
    suggestion = update_check._build_upgrade_suggestion(Mock())
    assert not suggestion.runnable
    assert (
        update_check._run_upgrade_command("uv tool upgrade omnigent", Console(file=StringIO()))
        == -1
    )
    run.assert_not_called()
    cache.assert_not_called()


@pytest.mark.parametrize(
    "legacy_source", [None, "git+https://github.com/omnigent-ai/omnigent.git"]
)
def test_extra_install_branding_uses_triune_source(
    monkeypatch: pytest.MonkeyPatch, legacy_source: str | None
) -> None:
    monkeypatch.setattr(update_check, "_find_repo_root", lambda: None)
    monkeypatch.setattr(extra_install, "_installed_vcs_url", lambda: legacy_source)
    monkeypatch.setattr(extra_install, "_is_uv_tool_install", lambda: True)
    command = extra_install.extra_install_command("cursor")
    assert command == [
        "uv",
        "tool",
        "install",
        "--force",
        "triune[cursor] @ git+https://github.com/MrStrenggeheim/triune@main",
    ]


def test_extra_install_branding_preserves_local_checkout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(update_check, "_find_repo_root", lambda: tmp_path)
    monkeypatch.setattr(extra_install, "_installed_vcs_url", lambda: None)
    command = extra_install.extra_install_command("cursor")
    assert command[-1] == f"triune[cursor] @ {tmp_path.as_uri()}"
