# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Session restart inventory, ownership grouping and acknowledged recovery."""

import importlib.util
import json
import stat
from pathlib import Path

import pytest


@pytest.fixture
def restart():
    path = Path(__file__).resolve().parents[2] / "deploy/local/session_restart.py"
    spec = importlib.util.spec_from_file_location("session_restart", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_capture_groups_active_children_and_preserves_waiting_state(
    restart, tmp_path, monkeypatch
):
    pages = [
        {"data": [{"id": "parent", "status": "idle"}], "has_more": True, "last_id": "parent"},
        {
            "data": [
                {
                    "id": "child",
                    "status": "running",
                    "parent_session_id": "parent",
                    "kind": "sub_agent",
                },
                {
                    "id": "independent",
                    "status": "running",
                    "parent_session_id": "parent",
                    "host_id": "other-host",
                },
                {"id": "question", "status": "waiting", "pending_elicitations_count": 1},
                {"id": "terminal", "status": "idle", "runner_online": True},
                {"id": "cold", "status": "idle"},
            ],
            "has_more": False,
        },
    ]
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return pages.pop(0)

    monkeypatch.setattr(restart, "request", request)
    path = tmp_path / "restart.json"
    restart.capture(path, "candidate")
    manifest = json.loads(path.read_text())
    assert manifest["candidate"] == "candidate"
    assert {entry["id"] for entry in manifest["sessions"]} == {
        "parent",
        "independent",
        "question",
        "terminal",
    }
    assert manifest["sessions"][0]["running"] is True
    assert (
        next(entry for entry in manifest["sessions"] if entry["id"] == "question")["pending"]
        is True
    )
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert calls[1][2]["params"]["after"] == "parent"


def test_resume_rejects_another_releases_inventory(restart, tmp_path, monkeypatch):
    path = tmp_path / "restart.json"
    restart.save(path, {"version": 1, "candidate": "old", "sessions": [{"id": "a"}]})
    calls = []
    monkeypatch.setattr(restart, "_resume", lambda entry: calls.append(entry))
    with pytest.raises(ValueError, match="another release"):
        restart.resume(path, "new")
    assert not calls


@pytest.mark.parametrize(
    "page",
    [
        {"data": [], "has_more": True},
        {"data": [], "has_more": "unknown"},
        {"data": [{"id": 42}], "has_more": False},
    ],
)
def test_bad_inventory_never_overwrites_a_saved_restart_plan(restart, tmp_path, monkeypatch, page):
    path = tmp_path / "restart.json"
    path.write_text("existing recovery inventory")
    monkeypatch.setattr(restart, "request", lambda *args, **kwargs: page)
    with pytest.raises(ValueError):
        restart.capture(path, "candidate")
    assert path.read_text() == "existing recovery inventory"


def test_resume_uses_control_events_without_replaying_inputs_or_approving(
    restart, tmp_path, monkeypatch
):
    path = tmp_path / "restart.json"
    entries = [
        {"id": "active/path", "running": True, "pending": False, "restored": False},
        {"id": "approval", "running": True, "pending": True, "restored": False},
        {"id": "done", "running": True, "pending": False, "restored": True},
    ]
    restart.save(path, {"version": 1, "sessions": entries})
    calls = {}

    def request(method, route, **kwargs):
        assert method == "POST"
        calls[route] = kwargs["body"]
        return {"recovered": True}

    monkeypatch.setattr(restart, "request", request)
    assert restart.resume(path)
    assert calls == {
        "/v1/sessions/active%2Fpath/events": {
            "type": "retry_session",
            "data": {"resume_interrupted_turn": True},
        },
        "/v1/sessions/approval/events": {
            "type": "retry_session",
            "data": {"resume_interrupted_turn": False},
        },
    }
    assert all(entry["restored"] for entry in json.loads(path.read_text())["sessions"])
    assert restart.resume(path)
    assert len(calls) == 2


def test_partial_recovery_keeps_failures_for_retry_and_does_not_repeat_success(
    restart, tmp_path, monkeypatch
):
    path = tmp_path / "restart.json"
    restart.save(path, {"version": 1, "sessions": [{"id": "a"}, {"id": "b"}]})
    calls = []

    def recover(entry):
        calls.append(entry["id"])
        return "Host unavailable" if entry["id"] == "b" else None

    monkeypatch.setattr(restart, "_resume", recover)
    assert not restart.resume(path)
    assert json.loads(path.read_text())["sessions"][0]["restored"]
    monkeypatch.setattr(restart, "_resume", lambda entry: calls.append(entry["id"]))
    assert restart.resume(path)
    assert calls.count("a") == 1
    assert calls.count("b") == 2
