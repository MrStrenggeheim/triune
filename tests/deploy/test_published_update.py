"""Exercise the downstream consumer against a loopback GitHub Release fixture."""

import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from zipfile import ZipFile

import pytest

VERSION = "0.20.0"
COMMIT = "b" * 40
RELEASE = VERSION + "-" + COMMIT[:12]
PACKAGES = ("triune", "omnigent_client", "omnigent_ui_sdk")


def wheel(package):
    data = io.BytesIO()
    info = f"{package}-{VERSION}.dist-info"
    with ZipFile(data, "w") as archive:
        archive.writestr(
            f"{info}/METADATA", f"Metadata-Version: 2.1\nName: {package}\nVersion: {VERSION}\n"
        )
        archive.writestr(
            f"{info}/WHEEL",
            "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        )
        archive.writestr(f"{info}/RECORD", "")
        if package == "triune":
            archive.writestr("omnigent/__init__.py", "")
            archive.writestr("omnigent/_build_info.py", f"COMMIT_SHA={COMMIT!r}")
            archive.writestr(
                f"{info}/entry_points.txt",
                "[console_scripts]\nomnigent = omnigent.fixture_preview:serve\n",
            )
            archive.writestr(
                "omnigent/fixture_preview.py",
                "import os, sys\nfrom pathlib import Path\n"
                "from http.server import HTTPServer, SimpleHTTPRequestHandler\n"
                "def serve():\n"
                "    os.chdir(Path(__file__).parent / 'static')\n"
                "    port = int(sys.argv[sys.argv.index('--port') + 1])\n"
                "    HTTPServer(('127.0.0.1', port), SimpleHTTPRequestHandler).serve_forever()\n",
            )
            archive.writestr("omnigent/static/health", '{"status":"ok"}')
            archive.writestr(
                "omnigent/static/api/version",
                json.dumps({"version": VERSION, "release_admission": "draining"}),
            )
            archive.writestr("omnigent/static/index.html", '<link href="/style.css">')
            archive.writestr("omnigent/static/style.css", ":root{--chat-prose-width:100%}")
    return data.getvalue()


@pytest.fixture
def downstream(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "deploy/local"))
    import manage
    import published_update as updater
    import release_origin as origin

    app = tmp_path / "install"
    releases = app / "releases"
    current = releases / (VERSION + "-" + "a" * 12)
    (current / "wheels").mkdir(parents=True)
    (current / "venv/bin").mkdir(parents=True)
    (current / "venv/bin/python").symlink_to(sys.executable)
    runtime = current / "runtime.txt"
    runtime.write_text("")
    artifacts = {}
    for package in PACKAGES:
        path = current / "wheels" / f"{package}-{VERSION}-py3-none-any.whl"
        path.write_bytes(wheel(package))
        artifacts[str(path.relative_to(current))] = manage.digest(path)
    (current / "release.json").write_text(
        json.dumps(
            {
                "release": current.name,
                "commit": "a" * 40,
                "version": VERSION,
                "verified": True,
                "artifacts": artifacts,
                "runtime_sha256": manage.digest(runtime),
            }
        )
    )
    (app / "current").symlink_to(current)
    monkeypatch.setattr(manage, "INSTALL", app)
    monkeypatch.setattr(manage, "RELEASES", releases)
    monkeypatch.setattr(manage, "LOCK", tmp_path / "deployment.lock")
    manage.LOCK.touch()
    monkeypatch.setattr(manage, "RUNTIME", runtime)
    monkeypatch.setattr(updater, "STATE", tmp_path)
    monkeypatch.setattr(updater, "prerequisites", lambda: None)
    monkeypatch.setattr(updater, "require_admission", lambda expected: None)
    monkeypatch.setattr(updater, "unit_state", lambda: "inactive")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("UV_OFFLINE", "true")
    monkeypatch.setenv("UV_CACHE_DIR", str(tmp_path / "cache"))
    with sqlite3.connect(tmp_path / "chat.db") as db:
        db.execute("CREATE TABLE conversations(workspace_id, id)")
        db.execute(
            "CREATE TABLE omnigent_conversation_metadata(live_status, pending_elicitation_count, "
            "runner_id, host_id, terminal_launch_args, workspace_transition, workspace_id, id)"
        )
        db.execute("CREATE TABLE scheduled_task_runs(status)")
        db.execute("CREATE TABLE conversation_items(response_id)")
        db.execute("CREATE TABLE omnigent_message_queues(payload)")
    public = tmp_path / "origin"
    tag = "triune-" + RELEASE
    for directory in ("releases/assets", "git/ref/tags", "git/tags", "compare"):
        (public / directory).mkdir(parents=True)
    (public / "git/ref/tags" / tag).write_text(
        json.dumps({"object": {"type": "tag", "sha": "c" * 40}})
    )
    (public / "git/tags" / ("c" * 40)).write_text(
        json.dumps({"object": {"type": "commit", "sha": COMMIT}})
    )
    (public / "compare" / ("a" * 40 + "..." + COMMIT)).write_text('{"status":"ahead"}')
    assets = {p.name: p.read_bytes() for p in (current / "wheels").iterdir()}
    assets["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(assets[n]).hexdigest()}  {n}\n" for n in sorted(assets)
    ).encode()
    rows = []
    for i, (name, data) in enumerate(assets.items(), 1):
        (public / f"releases/assets/{i}").write_bytes(data)
        rows.append(
            {
                "id": i,
                "name": name,
                "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                "size": len(data),
                "state": "uploaded",
            }
        )
    (public / "releases/latest").write_text(
        json.dumps(
            {
                "tag_name": tag,
                "draft": False,
                "prerelease": False,
                "published_at": "2026-11-19",
                "assets": rows,
                "body": f"Activated Triune build {RELEASE}\nCommit: {COMMIT}\nManifest SHA-256: "
                + "d" * 64,
            }
        )
    )
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(public))
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(origin, "API", f"http://127.0.0.1:{server.server_port}")
    try:
        yield updater, public
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@pytest.fixture
def admission_fd(downstream):
    updater, _ = downstream
    fd = os.open(updater.manage.INSTALL, os.O_DIRECTORY)
    try:
        yield fd
    finally:
        os.close(fd)


def test_stage_verified_wheels_offline_and_reject_tampering(downstream, admission_fd):
    updater, public = downstream
    manage = updater.manage
    state = updater.check()
    assert state["status"] == "available" and state["can_install"]
    updater.write(
        updater.REQUEST,
        {"release": RELEASE, "fingerprint": state["fingerprint"], "automatic": False},
    )
    path = public / "releases/assets/1"
    data = path.read_bytes()
    path.write_bytes(b"x" * len(data))
    with manage.LOCK.open("rb") as lock:
        with pytest.raises(ValueError, match="SHA-256"):
            updater.apply(lock, admission_fd)
        assert not (manage.INSTALL / "pending").exists()
        assert not (manage.RELEASES / RELEASE).exists()
        path.write_bytes(data)

        release, digest = updater.apply(lock, admission_fd)
        target = (manage.INSTALL / "pending").resolve()
        assert target == manage.RELEASES / release
        assert digest == manage.digest(target / "release.json")
        assert manage.read_release(target)["origin"] == "github-release"
        with pytest.raises(BlockingIOError):
            manage.stage(release)
        assert (manage.INSTALL / "current").resolve() != target


@pytest.mark.parametrize(
    "change", ["draft", "prerelease", "missing_digest", "path", "bad_tag", "checksum"]
)
def test_unverified_metadata_cannot_offer_install(downstream, change):
    updater, public = downstream
    path = public / "releases/latest"
    row = json.loads(path.read_text())
    if change in ("draft", "prerelease"):
        row[change] = True
    elif change == "bad_tag":
        (public / "git/tags" / ("c" * 40)).write_text(
            json.dumps({"object": {"type": "commit", "sha": "e" * 40}})
        )
    elif change == "checksum":
        (public / "releases/assets/4").write_text("unsafe checksum\n")
    elif change == "path":
        row["assets"][0]["name"] = "../outside.whl"
    else:
        row["assets"][0].pop("digest")
    path.write_text(json.dumps(row))
    result = updater.check()
    assert result["status"] == "unknown" and not result["can_install"]
    assert not (updater.manage.INSTALL / "pending").exists()


def test_current_missing_offline_busy_and_changed_request(downstream, monkeypatch, admission_fd):
    updater, public = downstream
    manage = updater.manage
    compare = public / "compare" / ("a" * 40 + "..." + COMMIT)
    compare.write_text('{"status":"behind"}')
    assert updater.check()["status"] == "up_to_date"
    compare.write_text('{"status":"ahead"}')
    with manage.LOCK.open("rb") as lock:
        updater.write(
            updater.REQUEST, {"release": RELEASE, "fingerprint": "0" * 64, "automatic": False}
        )
        with pytest.raises(ValueError, match="changed"):
            updater.apply(lock, admission_fd)
        with sqlite3.connect(updater.STATE / "chat.db") as db:
            db.execute(
                "INSERT INTO omnigent_conversation_metadata "
                "(live_status, pending_elicitation_count) VALUES (2, 0)"
            )
        result = updater.check()
        assert not result["can_install"]
        updater.write(
            updater.REQUEST,
            {"release": RELEASE, "fingerprint": result["fingerprint"], "automatic": False},
        )
        with pytest.raises(ValueError, match="Active"):
            updater.apply(lock, admission_fd)
    (public / "releases/latest").unlink()
    assert "No published stable" in updater.check()["detail"]

    def offline():
        raise URLError("fixture offline")

    monkeypatch.setattr(updater, "latest", offline)
    assert updater.check()["status"] == "offline"
    assert not (manage.INSTALL / "pending").exists()


def test_root_interface_only_probes_or_starts_the_fixed_unit(tmp_path):
    local = Path(__file__).resolve().parents[2] / "deploy/local"
    script = tmp_path / "control"
    systemctl = tmp_path / "systemctl"
    systemctl.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
    systemctl.chmod(0o755)
    script.write_text(
        (local / "triune-release-control")
        .read_text()
        .replace("/usr/bin/id -u", "echo 0")
        .replace("/usr/bin/systemctl", str(systemctl))
    )

    def run(action, *args):
        return subprocess.run(
            ["/bin/sh", script, *args], input=action + "\n", text=True, capture_output=True
        )

    assert run("probe").stdout.strip() == "triune-release-control-v1"
    assert run("start").stdout.splitlines() == [
        "--no-block",
        "start",
        "triune-release-update.service",
    ]
    for result in (run("other"), run("start", "other.service")):
        assert result.returncode == 2 and not result.stdout


def test_prerequisites_and_automatic_mode_fail_closed(downstream, monkeypatch, admission_fd):
    updater, _ = downstream
    state = updater.check()
    updater.write(
        updater.REQUEST,
        {"release": RELEASE, "fingerprint": state["fingerprint"], "automatic": True},
    )
    with updater.manage.LOCK.open("rb") as lock, pytest.raises(ValueError, match="disabled"):
        updater.apply(lock, admission_fd)
    assert not (updater.manage.INSTALL / "pending").exists()
    assert not (updater.manage.RELEASES / RELEASE).exists()

    def missing_unit():
        raise ValueError("fixture unit is unavailable")

    monkeypatch.setattr(updater, "prerequisites", missing_unit)
    monkeypatch.setattr(updater, "latest", lambda: pytest.fail("unprovisioned origin lookup"))
    state = updater.check()
    assert state["status"] == "unsupported" and not state["can_install"]


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO conversations VALUES (0, 'missing-metadata')",
        "INSERT INTO omnigent_conversation_metadata "
        "(live_status, pending_elicitation_count, runner_id) VALUES (1, 0, 'offline-runner')",
        "INSERT INTO omnigent_conversation_metadata "
        "(live_status, pending_elicitation_count) VALUES (NULL, 0)",
        "INSERT INTO conversation_items VALUES ('pending_input')",
        "INSERT INTO scheduled_task_runs VALUES (6)",
        """INSERT INTO omnigent_message_queues VALUES ('{"messages":[],"inflight":"turn"}')""",
    ],
)
def test_uncertain_or_pending_work_blocks_install(downstream, sql):
    updater, _ = downstream
    with sqlite3.connect(updater.STATE / "chat.db") as db:
        db.execute(sql)
    assert not updater.check()["can_install"]


@pytest.mark.asyncio
async def test_request_handoff_excludes_work_until_unit_exits(downstream, monkeypatch):
    import asyncio

    from omnigent import release_admission
    from omnigent.server.message_queue import QueuedStartupInputs
    from omnigent.server.scheduled.dispatch_scheduler import PersistentTaskScheduler

    updater, _ = downstream
    monkeypatch.setattr(release_admission, "MANAGED", True)
    monkeypatch.setattr(release_admission, "INSTALL", updater.manage.INSTALL)
    state = updater.check()
    entered = asyncio.Event()
    finish = asyncio.Event()

    async def work(scope, receive, send):
        entered.set()
        await finish.wait()

    middleware = release_admission.ReleaseAdmissionMiddleware(work)
    scope = {"type": "http", "method": "POST", "path": "/v1/sessions/chat/events"}
    running = asyncio.create_task(middleware(scope, None, None))
    await asyncio.wait_for(entered.wait(), 2)
    with pytest.raises(BlockingIOError):
        updater.request_install(RELEASE, state["fingerprint"])
    assert updater.read(updater.REQUEST, None) is None
    finish.set()
    await running

    def start_mock_unit(*args, stdin):
        assert stdin == "start\n"
        with release_admission.admit_work() as admitted:
            assert not admitted  # requester owns the first fence
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import sys,fcntl,os; fd=os.open(sys.argv[1], os.O_DIRECTORY); "
                "fcntl.flock(fd,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()",
                str(updater.manage.INSTALL),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        processes.append(process)

    processes = []
    monkeypatch.setattr(updater, "command", start_mock_unit)
    try:
        result = await asyncio.to_thread(updater.request_install, RELEASE, state["fingerprint"])
        assert result["status"] == "installing"
        assert processes[0].stdout.readline().strip() == "ready"
        replies = []

        async def send(frame):
            replies.append(frame)

        await middleware(scope, None, send)
        assert replies[0]["status"] == 503
        await middleware({"type": "websocket", "path": "/v1/runners/runner/tunnel"}, None, send)
        assert replies[-1] == {"type": "websocket.close", "code": 1013}
        # These real background entry points would access their stores if admitted.
        await PersistentTaskScheduler.poll_once(None)
        assert await QueuedStartupInputs._recover_session(None, None, "chat", None) is False
        assert await QueuedStartupInputs._deliver(None, None, "chat", None) is None
        assert release_admission.start_admitted_task(work(None, None, None), "fire") is None
        with release_admission.admit_work() as admitted:
            assert not admitted
    finally:
        for process in processes:
            process.communicate(timeout=5)
    with release_admission.admit_work() as admitted:
        assert admitted


@pytest.mark.parametrize("healthy", [True, False])
def test_shell_holds_admission_through_health_or_rollback(tmp_path, healthy):
    """Run the tracked shell against fixture command recorders and pre-made symlinks."""
    local = Path(__file__).resolve().parents[2] / "deploy/local"
    app = tmp_path / "app"
    candidate = app / "releases" / RELEASE
    candidate.mkdir(parents=True)
    (app / "pending").symlink_to(candidate)
    (app / "current").symlink_to(app / "releases" / "previous")
    lock = tmp_path / "deployment.lock"
    lock.touch()
    commands = tmp_path / "bin"
    commands.mkdir()
    log = tmp_path / "calls"
    stub = commands / "record"
    stub.write_text(
        f"#!{sys.executable}\n"
        "import os, sys, fcntl\nfrom pathlib import Path\n"
        f"app = Path({str(app)!r})\n"
        "fd = os.open(app, os.O_DIRECTORY)\n"
        "try:\n    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)\n    state = 'open'\n"
        "except BlockingIOError:\n    state = 'draining'\n"
        "args = sys.argv[1:]\ncmd = Path(sys.argv[0]).name\n"
        "if cmd == 'systemctl': phase = args[0]\n"
        "elif cmd == 'sleep': sys.exit(0)\n"
        "elif 'apply' in args:\n"
        "    assert os.path.samestat(os.fstat(3), app.stat())\n"
        "    phase = 'apply'\n"
        f"    print({RELEASE!r}, 'a' * 64)\n"
        "elif 'sha256sum' in args: phase = 'digest'; print('a' * 64, 'release.json')\n"
        "elif 'verify' in args: phase = 'verify'; print('{}')\n"
        "elif 'capture' in args: phase = 'capture'\n"
        "elif 'resume' in args: phase = 'resume'\n"
        "elif 'activation-complete' in args: phase = 'receipt'\n"
        "elif 'rm' in args: phase = 'cleanup'\n"
        "elif '/usr/bin/python3' in args:\n"
        "    body = sys.stdin.read()\n"
        "    if 'urlopen' in body: phase = 'health'\n"
        "    elif 'current.recover' in body: phase = 'rollback'\n"
        "    else: phase = 'switch'\n"
        "else: raise AssertionError(args)\n"
        f"with open({str(log)!r}, 'a') as output: print(phase, state, file=output)\n"
        f"sys.exit(1 if phase == 'health' and not {healthy!r} else 0)\n"
    )
    stub.chmod(0o755)
    for command in ("runuser", "systemctl", "sleep"):
        (commands / command).symlink_to(stub)
    script = (local / "omnigent-stable-update").read_text()
    script = script.replace("export PATH=", f"export PATH={commands}:")
    script = script.replace("app=/home/agent/apps/omnigent", f"app={app}")
    script = script.replace("/run/lock/stable-updates.lock", str(lock))
    result = subprocess.run(
        ["bash", "-c", script, "fixture", "--published"],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert (result.returncode == 0) == healthy, result.stderr
    phases = log.read_text().splitlines()
    for phase in ("apply", "capture", "stop", "switch", "start", "health"):
        assert f"{phase} draining" in phases
    if not healthy:
        assert "rollback draining" in phases
    assert "resume open" in phases


def test_native_runner_wins_or_defers_before_harness_start(downstream, monkeypatch):
    import fcntl
    from concurrent.futures import ThreadPoolExecutor

    from omnigent import release_admission
    from omnigent.runner import _entry

    updater, _ = downstream
    monkeypatch.setattr(release_admission, "MANAGED", True)
    monkeypatch.setattr(release_admission, "INSTALL", updater.manage.INSTALL)
    monkeypatch.setattr(
        "omnigent.process_logging.configure_process_logging", lambda *a, **kw: None
    )
    monkeypatch.setattr(_entry, "_install_crash_logging", lambda: None)
    monkeypatch.setattr(_entry, "_maybe_prewarm_ambient_detection", lambda: None)
    entered, finish = threading.Event(), threading.Event()

    async def harness():
        entered.set()
        assert finish.wait(5)

    monkeypatch.setattr(_entry, "_run_tunnel_from_env", harness)
    with ThreadPoolExecutor(max_workers=1) as pool:
        runner = pool.submit(_entry.main)
        try:
            assert entered.wait(5)
            with pytest.raises(BlockingIOError):
                updater.request_install(RELEASE, "a" * 64)
        finally:
            finish.set()
        runner.result(timeout=5)

    fd = os.open(updater.manage.INSTALL, os.O_DIRECTORY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        entered.clear()
        with pytest.raises(SystemExit, match="activation"):
            _entry.main()
        assert not entered.is_set()
    finally:
        os.close(fd)


@pytest.mark.asyncio
async def test_queue_worker_already_reading_holds_request_fence(downstream, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from omnigent import release_admission
    from omnigent.server.message_queue import DurableMessageQueue

    updater, _ = downstream
    monkeypatch.setattr(release_admission, "MANAGED", True)
    monkeypatch.setattr(release_admission, "INSTALL", updater.manage.INSTALL)
    reading, finish = threading.Event(), threading.Event()

    def read(session_id):
        reading.set()
        assert finish.wait(5)
        return {"messages": []}

    async def retire(app, session_id):
        return None

    worker = SimpleNamespace(
        _closing=False, store=SimpleNamespace(read=read), retire_if_empty=retire
    )
    recovery = asyncio.create_task(DurableMessageQueue.recover(worker, None, "chat"))
    try:
        assert await asyncio.to_thread(reading.wait, 5)
        with pytest.raises(BlockingIOError):
            updater.request_install(RELEASE, "a" * 64)
    finally:
        finish.set()
        await recovery


def test_failed_control_request_reopens_runtime(downstream, monkeypatch):
    from omnigent import release_admission

    updater, _ = downstream
    monkeypatch.setattr(release_admission, "MANAGED", True)
    monkeypatch.setattr(release_admission, "INSTALL", updater.manage.INSTALL)
    ready = updater.check()

    def unavailable(*args, stdin):
        raise OSError("fixture unit unavailable")

    monkeypatch.setattr(updater, "command", unavailable)
    with pytest.raises(OSError, match="unavailable"):
        updater.request_install(RELEASE, ready["fingerprint"])
    with release_admission.admit_work() as admitted:
        assert admitted
