"""Exercise the downstream consumer against a loopback GitHub Release fixture."""

import hashlib
import io
import json
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
            archive.writestr("omnigent/static/api/version", json.dumps({"version": VERSION}))
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
    monkeypatch.setattr(updater, "unit_state", lambda: "inactive")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("UV_OFFLINE", "true")
    monkeypatch.setenv("UV_CACHE_DIR", str(tmp_path / "cache"))
    with sqlite3.connect(tmp_path / "chat.db") as db:
        db.execute(
            "CREATE TABLE omnigent_conversation_metadata(live_status, pending_elicitation_count)"
        )
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


def test_stage_verified_wheels_offline_and_reject_tampering(downstream):
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
            updater.apply(lock)
        assert not (manage.INSTALL / "pending").exists()
        assert not (manage.RELEASES / RELEASE).exists()
        path.write_bytes(data)

        release, digest = updater.apply(lock)
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


def test_current_missing_offline_busy_and_changed_request(downstream, monkeypatch):
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
            updater.apply(lock)
        with sqlite3.connect(updater.STATE / "chat.db") as db:
            db.execute("INSERT INTO omnigent_conversation_metadata VALUES (2, 0)")
        result = updater.check()
        assert not result["can_install"]
        updater.write(
            updater.REQUEST,
            {"release": RELEASE, "fingerprint": result["fingerprint"], "automatic": False},
        )
        with pytest.raises(ValueError, match="Active"):
            updater.apply(lock)
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


def test_prerequisites_and_automatic_mode_fail_closed(downstream, monkeypatch):
    updater, _ = downstream
    state = updater.check()
    updater.write(
        updater.REQUEST,
        {"release": RELEASE, "fingerprint": state["fingerprint"], "automatic": True},
    )
    with updater.manage.LOCK.open("rb") as lock, pytest.raises(ValueError, match="disabled"):
        updater.apply(lock)
    assert not (updater.manage.INSTALL / "pending").exists()
    assert not (updater.manage.RELEASES / RELEASE).exists()

    def missing_unit():
        raise ValueError("fixture unit is unavailable")

    monkeypatch.setattr(updater, "prerequisites", missing_unit)
    monkeypatch.setattr(updater, "latest", lambda: pytest.fail("unprovisioned origin lookup"))
    state = updater.check()
    assert state["status"] == "unsupported" and not state["can_install"]
