# Modified for Triune: preserve verified deployment and rollback.
"""Custom release validation and deployment failure recovery."""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    spec = importlib.util.spec_from_file_location(
        "local_release", _ROOT / "deploy/local/manage.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "INSTALL", tmp_path / "app")
    monkeypatch.setattr(module, "RELEASES", module.INSTALL / "releases")
    return module


@pytest.fixture(params=["triune", "omnigent"])
def release(manager, request):
    path = manager.RELEASES / "0.20.0-test"
    (path / "wheels").mkdir(parents=True)
    (path / "runtime.txt").write_text("starlette==1.10.0\n")
    artifacts = {}
    for package in (request.param, "omnigent_client", "omnigent_ui_sdk"):
        wheel = path / "wheels" / f"{package}-0.20.0-py3-none-any.whl"
        wheel.write_bytes(package.encode())
        artifacts[str(wheel.relative_to(path))] = manager.digest(wheel)
    manifest = {
        "release": path.name,
        "version": "0.20.0",
        "commit": "a" * 40,
        "verified": True,
        "artifacts": artifacts,
        "runtime_sha256": manager.digest(path / "runtime.txt"),
    }
    (path / "release.json").write_text(json.dumps(manifest))
    return path


def test_release_rejects_a_changed_wheel(manager, release: Path) -> None:
    wheel = next((release / "wheels").iterdir())
    wheel.write_bytes(b"changed after verification")
    with pytest.raises(ValueError, match="artifact"):
        manager.read_release(release)


@pytest.mark.parametrize("name", ["../outside", "/tmp/outside"])
def test_stage_rejects_paths_before_reading_release(manager, name: str) -> None:
    with pytest.raises(ValueError, match="release name"):
        manager.stage(name)
    assert not manager.INSTALL.exists()


def test_release_rejects_an_empty_artifact_inventory(manager, release: Path) -> None:
    manifest_path = release / "release.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["artifacts"] = {}
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        manager.read_release(release)


def test_release_rejects_wheels_outside_its_directory(manager, release: Path) -> None:
    wheels = release / "wheels"
    outside = manager.INSTALL / "outside-wheels"
    wheels.rename(outside)
    wheels.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        manager.read_release(release)


def test_build_refuses_dirty_source_before_creating_a_release(
    manager, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = []

    def run(*command: str, **_kwargs) -> str:
        calls.append(command)
        assert command == ("git", "status", "--porcelain")
        return " M changed.py"

    monkeypatch.setattr(manager, "run", run)
    with pytest.raises(ValueError, match="commit all source changes"):
        manager.build()
    assert len(calls) == 1
    assert not manager.RELEASES.exists()


def _executable(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


def test_legacy_upgrade_requests_the_guarded_custom_deployment(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    calls = tmp_path / "calls"
    _executable(fake_bin / "id", "#!/bin/sh\nprintf '0\\n'\n")
    _executable(fake_bin / "systemctl", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n')
    for command in ("sudo", "uv"):
        _executable(fake_bin / command, "#!/bin/sh\nexit 99\n")
    result = subprocess.run(
        ["/bin/sh", str(_ROOT / "deploy/local/omni-ctl"), "upgrade"],
        env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "COMMAND_LOG": str(calls)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert calls.read_text().splitlines() == ["start omnigent-stable-update.service"]


@pytest.fixture
def deployment(tmp_path: Path):
    home = tmp_path / "home"
    app = home / "apps/omnigent"
    source = tmp_path / "source"
    fake_bin = tmp_path / "bin"
    state = home / ".omnigent"
    state.mkdir(parents=True)
    (home / ".local/bin").mkdir(parents=True)
    previous = app / "releases/previous"
    candidate = app / "releases/candidate"
    previous.mkdir(parents=True)
    candidate.mkdir()
    (app / "current").symlink_to(previous)
    (app / "pending").symlink_to(candidate)
    database = state / "chat.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE state (value TEXT)")
        connection.execute("INSERT INTO state VALUES ('original')")
    log = tmp_path / "commands.log"
    running = tmp_path / "running"
    running.write_text("running")
    env = dict(os.environ, HOME=str(home), COMMAND_LOG=str(log), RUNNING=str(running))
    env["TEST_DATABASE"] = str(database)
    env["FAILED_START"] = str(tmp_path / "failed-start")
    fake_bin.mkdir()
    _executable(
        fake_bin / "runuser",
        "#!/bin/bash\n"
        "shift 3\n"
        'if [[ "$*" == *"/usr/bin/python3 - "* ]]; then\n'
        "    payload=$(cat)\n"
        '    if [[ "$payload" == *"original.backup"* ]]; then\n'
        '        echo backup >> "$COMMAND_LOG"\n'
        '        if [[ "$MODE" == backup-fail ]]; then\n'
        '            mkdir -p "${@: -1}"\n'
        '            : > "${@: -1}/chat.db"\n'
        "            exit 1\n"
        "        fi\n"
        '    elif [[ "$payload" == *"expected = json.loads"* ]]; then\n'
        '        echo health-check >> "$COMMAND_LOG"\n'
        '        [[ "$MODE" == success ]]\n'
        "        exit $?\n"
        "    else\n"
        '        echo restore >> "$COMMAND_LOG"\n'
        '        [[ $(cat "$RUNNING") == stopped ]] || exit 9\n'
        "    fi\n"
        '    printf "%s\\n" "$payload" | "$@"\n'
        "else\n"
        '    exec "$@"\n'
        "fi\n",
    )
    _executable(
        fake_bin / "systemctl",
        "#!/bin/bash\n"
        'echo "systemctl $*" >> "$COMMAND_LOG"\n'
        'case "$1" in\n'
        "is-active) exit 0 ;;\n"
        'stop) echo stopped > "$RUNNING" ;;\n'
        "start)\n"
        '    echo running > "$RUNNING"\n'
        '    if [[ "$MODE" == start-fail && ! -f "$FAILED_START" ]]; then\n'
        '        touch "$FAILED_START"\n'
        "        /usr/bin/python3 - <<'PY'\n"
        "import os, sqlite3\n"
        "with sqlite3.connect(os.environ['TEST_DATABASE']) as c:\n"
        "    c.execute(\"UPDATE state SET value = 'candidate'\")\n"
        "PY\n"
        "        exit 1\n"
        "    fi ;;\n"
        "esac\n",
    )
    _executable(
        fake_bin / "idle-check",
        '#!/bin/bash\necho idle >> "$COMMAND_LOG"\n[[ "$MODE" != busy ]] || exit 75\n',
    )
    _executable(source / ".venv/bin/python", "#!/bin/bash\nexit 0\n")
    original = (_ROOT / "deploy/local/omnigent-stable-update").read_text()
    script = tmp_path / "deploy"
    original = original.replace("/home/agent/apps/omnigent", str(app))
    original = original.replace(str(_ROOT), str(source))
    original = original.replace("/home/agent", str(home))
    original = original.replace(
        "/usr/local/sbin/omnigent-idle-check", str(fake_bin / "idle-check")
    )
    lines = original.splitlines()
    lines = [
        f"export PATH={fake_bin}:/usr/bin:/bin" if line.startswith("export PATH=") else line
        for line in lines
    ]
    _executable(script, "\n".join(lines) + "\n")
    return app, database, log, env, script


def test_busy_deployment_defers_before_mutating_code_or_state(deployment) -> None:
    app, database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="busy"), capture_output=True, text=True
    )
    assert result.returncode == 75, result.stderr
    assert (app / "current").resolve().name == "previous"
    assert not (app / "backups").exists()
    assert "systemctl stop" not in log.read_text()
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)


def test_failed_start_stops_services_before_restoring_database(deployment) -> None:
    app, database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="start-fail"), capture_output=True, text=True
    )
    assert result.returncode == 1, result.stderr
    assert (app / "current").resolve().name == "previous"
    commands = log.read_text().splitlines()
    failed_start = commands.index(
        "systemctl start omnigent.target omnigent-server.service omnigent-host.service"
    )
    restore = commands.index("restore")
    assert (
        "systemctl stop omnigent.target omnigent-host.service omnigent-server.service"
        in commands[failed_start + 1 : restore]
    )
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)


def test_failed_backup_never_restores_an_incomplete_snapshot(deployment) -> None:
    app, database, _log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="backup-fail"), capture_output=True, text=True
    )
    assert result.returncode == 1, result.stderr
    assert (app / "current").resolve().name == "previous"
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)


def test_successful_deployment_waits_for_both_services_before_switching(deployment) -> None:
    app, database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="success"), capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert (app / "current").resolve().name == "candidate"
    assert (app / "previous").resolve().name == "previous"
    assert not (app / "pending").exists()
    commands = log.read_text().splitlines()
    stop = commands.index(
        "systemctl stop omnigent.target omnigent-host.service omnigent-server.service"
    )
    backup = commands.index("backup")
    start = commands.index(
        "systemctl start omnigent.target omnigent-server.service omnigent-host.service"
    )
    assert stop < backup < start < commands.index("health-check")
    assert "restore" not in commands
    saved_database = next((app / "backups").glob("*/chat.db"))
    with sqlite3.connect(saved_database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)
