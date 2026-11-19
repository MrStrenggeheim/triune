# Modified for Triune: preserve verified deployment and rollback.
"""Custom release validation and deployment failure recovery."""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
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
        '            mkdir -p "${@: -2:1}"\n'
        '            : > "${@: -2:1}/chat.db"\n'
        "            exit 1\n"
        "        fi\n"
        '    elif [[ "$payload" == *"expected = json.loads"* ]]; then\n'
        '        echo health-check >> "$COMMAND_LOG"\n'
        '        [[ "$MODE" =~ ^(success|busy|resume-fail|receipt-fail)$ ]]\n'
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
        'stop) echo stopped > "$RUNNING"; [[ "$MODE" != partial-stop ]] ;;\n'
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
    for runtime in (previous, candidate):
        _executable(
            runtime / "venv/bin/python",
            "#!/bin/bash\n"
            'echo "sessions $2" >> "$COMMAND_LOG"\n'
            'if [[ "$2" == capture ]]; then\n'
            '    [[ "$MODE" != capture-fail ]] || exit 1\n'
            '    printf \'{"version":1,"sessions":[{"id":"busy","running":true}]}\\n\' > "$3"\n'
            'elif [[ "$2" == resume && "$MODE" == resume-fail ]]; then\n'
            "    exit 75\n"
            "fi\n",
        )
    _executable(
        source / ".venv/bin/python",
        '#!/bin/bash\necho "manager $2" >> "$COMMAND_LOG"\n'
        'if [[ "$2" == verify ]]; then echo "{\\"origin\\":\\"$MODE\\"}"; fi\n'
        '[[ "$2" != activation-complete || "$MODE" != receipt-fail ]]\n',
    )
    original = (_ROOT / "deploy/local/omnigent-stable-update").read_text()
    script = tmp_path / "deploy"
    lock = tmp_path / "stable.lock"
    lock.touch()
    original = original.replace("/run/lock/stable-updates.lock", str(lock))
    original = original.replace("/home/agent/apps/omnigent", str(app))
    original = original.replace("source=/home/agent/projects/triune", f"source={source}")
    original = original.replace("/home/agent", str(home))
    lines = original.splitlines()
    lines = [
        f"export PATH={fake_bin}:/usr/bin:/bin" if line.startswith("export PATH=") else line
        for line in lines
    ]
    _executable(script, "\n".join(lines) + "\n")
    return app, database, log, env, script


def test_default_unit_refuses_an_interrupted_published_stage(deployment) -> None:
    app, _database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="github-release"), capture_output=True, text=True
    )
    assert "requires fenced activation" in result.stderr
    assert result.returncode != 0
    assert (app / "current").resolve().name == "previous"
    assert "systemctl stop" not in log.read_text()


def test_busy_deployment_restarts_sessions_instead_of_deferring(deployment) -> None:
    app, database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="busy"), capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert (app / "current").resolve().name == "candidate"
    commands = log.read_text().splitlines()
    assert commands.index("sessions capture") < commands.index(
        "systemctl stop omnigent.target omnigent-host.service omnigent-server.service"
    )
    assert commands.index("health-check") < commands.index("sessions resume")
    assert next((app / "backups").glob("*/session-restart.json")).exists()
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)


def test_failed_capture_leaves_live_services_and_code_untouched(deployment) -> None:
    app, _database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="capture-fail"), capture_output=True, text=True
    )
    assert result.returncode == 1
    assert (app / "current").resolve().name == "previous"
    assert "systemctl stop" not in log.read_text()
    assert not (app / "backups").exists()


def test_failed_session_recovery_retries_without_restarting_healthy_release(deployment) -> None:
    app, _database, log, env, script = deployment
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="resume-fail"), capture_output=True, text=True
    )
    assert result.returncode == 75
    assert (app / "current").resolve().name == "candidate"
    assert (app / "pending").exists()
    assert "restore" not in log.read_text()
    before = log.read_text()
    result = subprocess.run(
        [str(script)], env=dict(env, MODE="success"), capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert not (app / "pending").exists()
    added = log.read_text()[len(before) :]
    assert "sessions resume" in added
    assert "systemctl stop" not in added
    assert "sessions capture" not in added
    assert "manager activation-complete" not in before
    assert added.index("sessions resume") < added.index("manager activation-complete")


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
    assert commands.index("sessions resume") < commands.index("manager activation-complete")
    assert "restore" not in commands
    saved_database = next((app / "backups").glob("*/chat.db"))
    with sqlite3.connect(saved_database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM state").fetchone() == ("original",)


@pytest.fixture
def publication(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(_ROOT / "deploy/local"))
    import publication

    app = tmp_path / "app"
    releases = app / "releases"
    monkeypatch.setattr(publication.manage, "INSTALL", app)
    monkeypatch.setattr(publication.manage, "RELEASES", releases)
    monkeypatch.setattr(publication, "LOCK", tmp_path / "lock")
    publication.LOCK.touch()
    commit = "a" * 40
    path = releases / f"0.20.0-{commit[:12]}"
    (path / "wheels").mkdir(parents=True)
    (app / "current").symlink_to(path)
    artifacts = {}
    for name in ("triune", "omnigent_client", "omnigent_ui_sdk"):
        wheel = path / "wheels" / f"{name}-0.20.0-py3-none-any.whl"
        wheel.write_bytes(name.encode())
        artifacts[str(wheel.relative_to(path))] = publication.manage.digest(wheel)
    (path / "runtime.txt").write_text("local inventory")
    (path / "private.log").write_text("private")
    (path / "release.json").write_text(
        json.dumps(
            {
                "release": path.name,
                "version": "0.20.0",
                "commit": commit,
                "verified": True,
                "artifacts": artifacts,
                "runtime_sha256": publication.manage.digest(path / "runtime.txt"),
            }
        )
    )

    # Every subprocess path through the release helper is sealed by default.
    def unexpected(*cmd, **kwargs):
        pytest.fail(f"unexpected subprocess: {cmd}")

    monkeypatch.setattr(publication.manage, "run", unexpected)
    return publication, path


def test_owner_decision_is_local_and_activation_specific(publication, capsys):
    pub, path = publication
    pub.activated(path.name)
    pub.status()
    assert f"Publish activated {path.name}" in capsys.readouterr().out
    pub.decide(path.name, approve=False)
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "declined"
    with pytest.raises(ValueError, match="not the active"):
        pub.decide("old", approve=True)
    capsys.readouterr()
    pub.activated(path.name)
    assert "Publish activated" not in capsys.readouterr().out
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "declined"


@pytest.mark.parametrize(
    "change", ["wheel", "manifest", "runtime", "commit", "pending", "sidecar"]
)
def test_publication_rejects_changed_or_unfinished_activation(publication, change):
    pub, path = publication
    pub.activated(path.name)
    manifest = path / "release.json"
    if change == "wheel":
        next((path / "wheels").iterdir()).write_bytes(b"changed")
    elif change == "runtime":
        (path / "runtime.txt").write_text("changed")
    elif change == "manifest":
        manifest.write_text(manifest.read_text() + "\n")
    elif change == "pending":
        (pub.manage.INSTALL / "pending").symlink_to(path)
    else:
        data = json.loads(manifest.read_text())
        if change == "commit":
            data["commit"] = "b" * 40
        else:
            source = next((path / "wheels").glob("triune-*"))
            unsafe = source.with_suffix(".log")
            source.rename(unsafe)
            data["artifacts"][str(unsafe.relative_to(path))] = data["artifacts"].pop(
                str(source.relative_to(path))
            )
        manifest.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        pub.decide(path.name, approve=True)


def test_cli_requires_explicit_yes(publication, monkeypatch):
    pub, path = publication
    monkeypatch.setattr("sys.argv", ["omni-custom", "publish", path.name])
    with pytest.raises(SystemExit) as result:
        pub.main()
    assert result.value.code == 2


def test_publish_exact_tag_resumes_verified_draft_and_rejects_conflicts(publication, monkeypatch):
    pub, path = publication
    pub.activated(path.name)
    commit = "a" * 40
    tag = f"triune-{path.name}"
    ref = f"refs/tags/{tag}"
    assets = {}
    remote_releases = []
    mutations = []
    remote = None
    maintainer = False
    interrupted = False
    prerelease_on_final_read = False
    listed = False

    def command(*cmd, capture=False):
        nonlocal remote, interrupted, listed
        if cmd[0] == "git":
            if cmd[1] == "rev-parse":
                assert cmd[2:] == ("--verify", commit + "^{commit}")
                return commit
            if cmd[1] == "ls-remote":
                assert cmd[2:] == (pub.REMOTE, ref, ref + "^{}")
                return f"{remote}\t{ref}" if remote else ""
            assert cmd == ("git", "push", "--no-follow-tags", pub.REMOTE, f"{commit}:{ref}")
            mutations.append("push")
            remote = commit
        elif cmd[:2] == ("gh", "api"):
            assert cmd[2:4] == ("--hostname", "github.com")
            api = f"repos/{pub.REPO}"
            if cmd[4:] == (api,):
                return json.dumps({"permissions": {"maintain": maintainer}})
            if "--paginate" in cmd:
                if cmd[5] == api + "/releases/1/assets":
                    return "\n".join(map(json.dumps, assets.values()))
                assert cmd[5] == api + "/releases?per_page=100"
                assert tag in cmd[-1]
                if prerelease_on_final_read and listed:
                    return json.dumps(dict(remote_releases[0], prerelease=True))
                listed = True
                return "\n".join(map(json.dumps, remote_releases))
            assert cmd[4:] == (
                "-X",
                "PATCH",
                api + "/releases/1",
                "-f",
                f"tag_name={tag}",
                "-f",
                f"target_commitish={commit}",
                "-F",
                "draft=false",
                "-F",
                "prerelease=false",
            )
            assert len(assets) == 4
            mutations.append("publish")
            remote_releases[0].update(draft=False, published_at="2026-11-19T00:00:00Z")
            raise OSError("publish reply lost")
        else:
            assert cmd[:2] == ("gh", "release")
            assert cmd[3:6] == (tag, "--repo", f"github.com/{pub.REPO}")
            if cmd[2] == "create":
                assert "--draft" in cmd and "--verify-tag" in cmd
                assert cmd[cmd.index("--target") + 1] == commit
                mutations.append("draft")
                remote_releases.append(
                    {
                        "id": 1,
                        "draft": True,
                        "prerelease": False,
                        "body": cmd[-1],
                        "target_commitish": commit,
                    }
                )
            else:
                assert cmd[2] == "upload"
                for filename in cmd[6:]:
                    asset = Path(filename)
                    assert asset.name not in assets
                    assert asset.name == "SHA256SUMS" or asset.suffix == ".whl"
                    if asset.name == "SHA256SUMS":
                        expected_lines = [
                            f"{sha}  {name}\n"
                            for name, sha in sorted(pub.identity(path.name)["wheels"].items())
                        ]
                        assert asset.read_bytes() == "".join(expected_lines).encode("ascii")
                        for line in asset.read_text().splitlines():
                            sha, name = line.split("  ")
                            assert sha == pub.manage.digest(path / "wheels" / name)
                    assets[asset.name] = {
                        "name": asset.name,
                        "state": "uploaded",
                        "digest": "sha256:" + pub.manage.digest(asset),
                    }
                    mutations.append(asset.name)
                    if not interrupted:
                        interrupted = True
                        raise OSError("interrupted upload")
        return ""

    monkeypatch.setattr(pub.manage, "run", command)
    with pytest.raises(PermissionError):
        pub.decide(path.name, approve=True)
    assert not mutations
    maintainer = True
    with pytest.raises(OSError, match="interrupted upload"):
        pub.decide(path.name, approve=True)
    assert remote_releases[0]["draft"]
    with pytest.raises(OSError, match="publish reply lost"):
        pub.decide(path.name, approve=True)
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "approved"
    listed = False
    prerelease_on_final_read = True
    with pytest.raises(ValueError, match="could not be verified"):
        pub.decide(path.name, approve=True)
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "approved"
    prerelease_on_final_read = False
    pub.decide(path.name, approve=True)
    pub.activated(path.name)
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "published"
    assert mutations[:2] == ["push", "draft"] and mutations[-1] == "publish"
    assert len(mutations) == 7
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "published"
    pub.decide(path.name, approve=True)
    assert len(mutations) == 7
    remote = "b" * 40
    with pytest.raises(ValueError, match="remote tag"):
        pub.decide(path.name, approve=True)
    remote = commit
    assets["SHA256SUMS"]["digest"] = "sha256:" + "0" * 64
    with pytest.raises(ValueError, match="conflicting"):
        pub.decide(path.name, approve=True)
    assert len(mutations) == 7


def test_activation_receipt_failure_keeps_pending_until_retry(deployment):
    app, _, log, env, script = deployment
    check = subprocess.run([script, "--check"], env=dict(env, MODE="success"), check=False)
    assert check.returncode == 0
    assert "activation-complete" not in log.read_text()
    failure = subprocess.run([script], env=dict(env, MODE="receipt-fail"), check=False)
    assert failure.returncode == 75
    assert (app / "current").resolve() == (app / "pending").resolve()
    before = log.read_text()
    subprocess.run([script], env=dict(env, MODE="success"), check=True)
    assert "systemctl stop" not in log.read_text()[len(before) :]
    assert not (app / "pending").exists()


def test_same_release_id_cannot_replace_the_approved_build_identity(publication):
    pub, path = publication
    pub.activated(path.name)
    receipt = pub.receipt_path(path.name).read_bytes()
    manifest = path / "release.json"
    manifest.write_text(manifest.read_text() + "\n")
    with pytest.raises(ValueError, match="different build bytes"):
        pub.activated(path.name)
    assert pub.receipt_path(path.name).read_bytes() == receipt


def test_publication_uses_the_activation_lock_until_remote_operations_finish(
    publication, monkeypatch
):
    pub, path = publication
    pub.activated(path.name)

    def inspect_lock(*_):
        with pub.LOCK.open("rb") as contender, pytest.raises(BlockingIOError):
            pub.fcntl.flock(contender, pub.fcntl.LOCK_EX | pub.fcntl.LOCK_NB)

    monkeypatch.setattr(pub, "publish", inspect_lock)
    pub.decide(path.name, approve=True)
    with pub.LOCK.open("rb") as contender:
        pub.fcntl.flock(contender, pub.fcntl.LOCK_EX | pub.fcntl.LOCK_NB)


def test_unattended_prompt_survives_until_next_operator_process(publication, tmp_path):
    pub, path = publication
    pub.activated(path.name)
    # Reopen the CLI with a separate HOME and interpreter, as on operator resume.
    home = tmp_path / "operator"
    (home / "apps").mkdir(parents=True)
    (home / "apps/omnigent").symlink_to(pub.manage.INSTALL)
    resumed = subprocess.run(
        [sys.executable, str(_ROOT / "deploy/local/publication.py"), "publication-status"],
        env=dict(os.environ, HOME=str(home)),
        capture_output=True,
        text=True,
        check=True,
    )
    assert f"Publish activated {path.name} ({'a' * 40})" in resumed.stdout
    assert "MrStrenggeheim/triune?" in resumed.stdout
    assert json.loads(pub.receipt_path(path.name).read_text())["decision"] == "pending"


@pytest.mark.parametrize("kind", ["platform", "empty"])
def test_publisher_rejects_wheels_the_installer_cannot_consume(publication, kind):
    pub, path = publication
    manifest = path / "release.json"
    data = json.loads(manifest.read_text())
    wheel = next((path / "wheels").glob("triune-*.whl"))
    del data["artifacts"][str(wheel.relative_to(path))]
    if kind == "empty":
        wheel.write_bytes(b"")
    else:
        wheel = wheel.rename(wheel.with_name(wheel.name.replace("-any.whl", "-win_amd64.whl")))
    data["artifacts"][str(wheel.relative_to(path))] = pub.manage.digest(wheel)
    manifest.write_text(json.dumps(data))
    pub.activated(path.name)
    with pytest.raises(ValueError, match="downstream install contract"):
        pub.decide(path.name, approve=True)


def test_stable_updater_separates_root_and_agent_command_paths():
    script = (_ROOT / "deploy/local/omnigent-stable-update").read_text()
    (root_path,) = [
        line.removeprefix("export PATH=")
        for line in script.splitlines()
        if line.startswith("export PATH=")
    ]
    assert set(root_path.split(":")) <= {
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
    }
    helper = script.split("as_agent() {", 1)[1].split("\n}", 1)[0]
    assert helper.index("runuser -u agent --") < helper.index("PATH=/home/agent/.local/bin:")
    assert "/home/agent/.local/bin" not in script.replace(helper, "")


@pytest.mark.parametrize("previous", ["none", "pending", "declined", "legacy-downstream"])
def test_downstream_activation_skips_publication_and_preserves_prior_receipts(
    publication, previous, capsys
):
    pub, path = publication
    if previous in ("pending", "declined"):
        pub.activated(path.name)
        if previous == "declined":
            pub.decide(path.name, approve=False)
    manifest_path = path / "release.json"
    local_manifest = manifest_path.read_bytes()
    manifest = json.loads(local_manifest)
    manifest_path.write_text(json.dumps(dict(manifest, origin="github-release")))
    decision_path = pub.receipt_path(path.name)
    if previous == "legacy-downstream":
        # Earlier success hooks created a publication question for this installed build.
        decision_path.parent.mkdir()
        legacy = dict(pub.identity(path.name), decision="pending")
        del legacy["origin"]
        decision_path.write_text(json.dumps(legacy))
    old_decision = decision_path.read_bytes() if decision_path.exists() else None
    capsys.readouterr()
    pub.status()
    for _ in range(2):
        pub.activated(path.name)
        pub.status()
        downstream_path = pub.receipt_path(path.name, downstream=True)
        assert json.loads(downstream_path.read_text()) == {
            **pub.identity(path.name),
            "origin": "github-release",
            "activation": "successful",
        }
    output = capsys.readouterr().out
    assert "Publish activated" not in output
    assert f"{path.name}: activation successful; already published" in output
    assert f"https://github.com/{pub.REPO}/releases/tag/triune-{path.name}" in output
    for approve in (True, False):
        with pytest.raises(ValueError, match="existing GitHub Release"):
            pub.decide(path.name, approve=approve)
    assert (decision_path.read_bytes() if decision_path.exists() else None) == old_decision

    # A receipt for earlier manifest bytes cannot attest to a fresh activation.
    manifest_path.write_bytes(manifest_path.read_bytes() + b"\n")
    pub.status()
    assert "awaiting an activation receipt" in capsys.readouterr().out

    if previous != "legacy-downstream":
        manifest_path.write_bytes(local_manifest)
        pub.activated(path.name)
        result = capsys.readouterr().out
        if previous == "declined":
            assert f"{path.name}: declined" in result
        else:
            assert f"Publish activated {path.name}" in result


def test_partial_stop_restores_services_without_completing_activation(deployment):
    app, _, log, env, script = deployment
    result = subprocess.run([script], env=dict(env, MODE="partial-stop"), check=False)
    assert result.returncode != 0
    assert (app / "current").resolve().name == "previous"
    assert (app / "pending").resolve().name == "candidate"
    commands = log.read_text().splitlines()
    restart = commands.index(
        "systemctl start omnigent.target omnigent-server.service omnigent-host.service"
    )
    for unit in ("omnigent.target", "omnigent-server.service", "omnigent-host.service"):
        assert f"systemctl is-active --quiet {unit}" in commands[restart + 1 :]
    assert Path(env["RUNNING"]).read_text().strip() == "running"
    assert "manager activation-complete" not in commands
    assert "backup" not in commands


@pytest.mark.parametrize("mismatch", ["candidate", "manifest"])
def test_published_stage_binding_fails_before_stopping_services(deployment, tmp_path, mismatch):
    app, _, log, env, script = deployment
    release = "0.20.0-bbbbbbbbbbbb"
    target = app / "releases" / release
    target.mkdir()
    (target / "release.json").write_text("{}")
    if mismatch == "manifest":
        (app / "pending").unlink()
        (app / "pending").symlink_to(target)
    manager = tmp_path / "source/.venv/bin/python"
    _executable(manager, f"#!/bin/sh\necho '{release} {'f' * 64}'\n")
    result = subprocess.run([script, "--published"], env=env, capture_output=True, text=True)
    assert result.returncode != 0
    assert "Staged" in result.stderr
    assert (app / "current").resolve().name == "previous"
    assert (app / "pending").exists() == (mismatch == "candidate")
    assert not log.exists() or "systemctl stop" not in log.read_text()


def test_stable_unit_inherits_existing_flock_and_direct_stage_cannot_overlap(deployment, tmp_path):
    import fcntl

    _, _, log, env, script = deployment
    lock = tmp_path / "stable.lock"
    with lock.open("rb") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        result = subprocess.run([script, "--check"], env=env, capture_output=True)
        assert result.returncode != 0 and not log.exists()
    result = subprocess.run(
        ["/usr/bin/flock", "--nonblock", lock, script, "--check"], env=env, capture_output=True
    )
    assert result.returncode == 0, result.stderr
    assert "systemctl stop" not in log.read_text()
