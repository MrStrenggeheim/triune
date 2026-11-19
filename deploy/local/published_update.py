"""Fixed managed deployment interface. The published unit holds the activation lock."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path
from urllib.error import HTTPError, URLError

import manage
from release_origin import RELEASE, latest, update_status

LOCAL = Path(__file__).resolve().parent
UNIT = "triune-release-update.service"
CONTROL = Path("/usr/local/sbin/triune-release-control")
STATE = Path.home() / ".omnigent"
REQUEST = "published-update-request.json"


def write(name, value):
    with tempfile.NamedTemporaryFile(dir=manage.INSTALL, mode="w", delete=False) as output:
        json.dump(value, output)
    Path(output.name).replace(manage.INSTALL / name)


def read(name, default):
    try:
        return json.loads((manage.INSTALL / name).read_text())
    except FileNotFoundError:
        return default


def command(*args, stdin=None):
    return subprocess.run(
        args, input=stdin, capture_output=True, text=True, timeout=15, check=True
    ).stdout.strip()


def unit_state():
    return command("/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", UNIT)


def prerequisites():
    for installed, tracked in [
        (Path("/usr/local/sbin/omnigent-stable-update"), LOCAL / "omnigent-stable-update"),
        (Path("/etc/systemd/system") / UNIT, LOCAL / UNIT),
        (CONTROL, LOCAL / CONTROL.name),
    ]:
        if (
            not installed.is_file()
            or installed.stat().st_uid != 0
            or installed.stat().st_mode & 0o022
            or installed.read_bytes() != tracked.read_bytes()
        ):
            raise ValueError(
                "The administrator must provision the matching managed updater and release unit."
            )
    for path in (
        manage.RUNTIME,
        manage.LOCK,
        STATE / "chat.db",
        LOCAL / "session_restart.py",
        LOCAL / "publication.py",
    ):
        if not path.is_file():
            raise ValueError("A required managed runtime, database or recovery helper is missing.")
    if not shutil.which("uv") or not os.access(manage.RELEASES, os.W_OK):
        raise ValueError(
            "The managed wheel installer or writable release directory is unavailable."
        )
    if command("/usr/bin/systemctl", "show", UNIT, "-p", "LoadState", "--value") != "loaded":
        raise ValueError("The published release unit is unavailable.")
    if command("/usr/bin/systemctl", "show", UNIT, "-p", "NeedDaemonReload", "--value") != "no":
        raise ValueError("The managed unit requires daemon-reload.")
    if command(
        "/usr/bin/systemctl", "show", "omnigent-server.service", "-p", "MainPID", "--value"
    ) != str(os.getppid()):
        raise ValueError("This process does not own the managed server.")
    for unit in ("omnigent.target", "omnigent-server.service", "omnigent-host.service"):
        command("/usr/bin/systemctl", "is-active", "--quiet", unit)
    if (
        command("/usr/bin/sudo", "-n", "--", str(CONTROL), stdin="probe\n")
        != "triune-release-control-v1"
    ):
        raise ValueError("Passwordless release-unit authorization is unavailable.")
    from session_restart import request

    page = request("GET", "/v1/sessions", params={"limit": 1, "kind": "any", "visibility": "all"})
    if not isinstance(page.get("data"), list) or type(page.get("has_more")) is not bool:
        raise ValueError("The authenticated local session inventory is unavailable.")


def require_admission(expected):
    from session_restart import request

    if request("GET", "/api/version").get("release_admission") != expected:
        raise ValueError("The managed runtime did not confirm published-release admission.")


def idle():
    from omnigent.db.enum_codecs import SCHEDULED_TASK_RUN_STATUS, SESSION_LIVE_STATUS
    from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID

    with sqlite3.connect((STATE / "chat.db").as_uri() + "?mode=ro", uri=True) as db:
        db.execute("BEGIN")
        if db.execute(
            "SELECT 1 FROM conversations c WHERE NOT EXISTS "
            "(SELECT 1 FROM omnigent_conversation_metadata m "
            "WHERE m.workspace_id = c.workspace_id AND m.id = c.id) LIMIT 1"
        ).fetchone():
            return False
        if db.execute(
            "SELECT 1 FROM omnigent_conversation_metadata WHERE live_status IS NULL "
            "OR live_status NOT IN (?, ?) "
            "OR pending_elicitation_count IS NULL OR pending_elicitation_count != 0 "
            "OR runner_id IS NOT NULL OR host_id IS NOT NULL OR terminal_launch_args IS NOT NULL "
            "OR workspace_transition IS NOT NULL LIMIT 1",
            (SESSION_LIVE_STATUS["idle"], SESSION_LIVE_STATUS["failed"]),
        ).fetchone():
            return False
        if db.execute(
            "SELECT 1 FROM conversation_items WHERE response_id = ? LIMIT 1",
            (PENDING_INPUT_RESPONSE_ID,),
        ).fetchone():
            return False
        if db.execute(
            "SELECT 1 FROM scheduled_task_runs WHERE status IS NULL "
            "OR status NOT IN (?, ?, ?) LIMIT 1",
            tuple(SCHEDULED_TASK_RUN_STATUS[s] for s in ("succeeded", "failed", "skipped")),
        ).fetchone():
            return False
        for (payload,) in db.execute("SELECT payload FROM omnigent_message_queues"):
            queue = json.loads(payload)
            if queue["messages"] != [] or queue["inflight"] is not None:
                return False
    return True


def state(status, detail, *, current=None, published=None, ready=False):
    return {
        "status": status,
        "detail": detail,
        "current_release": current,
        "release": published.release if published else None,
        "release_notes": published.notes if published else None,
        "can_install": ready,
        "mode": "manual",
        "automatic_idle_supported": False,
        "fingerprint": published.fingerprint if published else None,
    }


def check(*, retry=False):
    try:
        current = manage.read_release(manage.INSTALL / "current")
        prerequisites()
    except (ValueError, RuntimeError, OSError, KeyError, subprocess.SubprocessError):
        return state(
            "unsupported",
            "The managed release unit, updater, runtime or start permission is unavailable.",
        )
    name = current["release"]
    if (
        current.get("verified") is not True
        or not re.fullmatch(r"[0-9a-f]{40}", current["commit"])
        or name != f"{current['version']}-{current['commit'][:12]}"
        or not re.fullmatch(RELEASE, name)
    ):
        return state("unknown", "The active managed build identity is inconsistent.")
    active_state = unit_state()
    if active_state in {"active", "activating", "deactivating", "reloading"}:
        return state("installing", "The managed release unit is running.", current=name)
    if active_state not in {"inactive", "failed"}:
        return state("unknown", "The release unit state is unavailable.", current=name)
    if os.path.lexists(manage.INSTALL / "pending"):
        return state(
            "unknown", "Another managed release is staged or awaiting recovery.", current=name
        )
    try:
        require_admission("draining" if retry else "open")
        published = latest()
        if published is None:
            return state("unknown", "No published stable Triune release was found.", current=name)
        status = update_status(current, published)
        published.checksums()
        if status == "up_to_date":
            return state(
                status, "The installed build is current.", current=name, published=published
            )
        if not idle():
            return state(
                "available",
                "Waiting for work to finish or for harness inactivity to be confirmed.",
                current=name,
                published=published,
            )
        if not retry and read(REQUEST, {}).get("release") == published.release:
            return state(
                "failed",
                "Activation failed. Review the release unit journal before retrying.",
                current=name,
                published=published,
                ready=True,
            )
        return state(
            status,
            "Published release verified and ready to install.",
            current=name,
            published=published,
            ready=True,
        )
    except HTTPError as error:
        return state(
            "unknown", f"GitHub could not confirm this release (HTTP {error.code}).", current=name
        )
    except (URLError, TimeoutError, ConnectionError):
        return state("offline", "Cannot reach the published release origin.", current=name)
    except (
        RuntimeError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        sqlite3.Error,
    ) as error:
        return state(
            "unknown", f"Release or idle-state verification failed: {error}", current=name
        )


def request_install(release, fingerprint):
    # Keep the request fence until the independent systemd process owns the unit fence.
    with ExitStack() as locks:
        request_fd = os.open(manage.RELEASES, os.O_DIRECTORY)
        locks.callback(os.close, request_fd)
        fcntl.flock(request_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        unit_fd = os.open(manage.INSTALL, os.O_DIRECTORY)
        locks.callback(os.close, unit_fd)
        result = check(retry=True)
        if (
            not result["can_install"]
            or result["release"] != release
            or result["fingerprint"] != fingerprint
        ):
            raise ValueError("The requested release is no longer eligible for installation.")
        write(REQUEST, {"release": release, "fingerprint": fingerprint, "automatic": False})
        command("/usr/bin/sudo", "-n", "--", str(CONTROL), stdin="start\n")
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(unit_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                break
            fcntl.flock(unit_fd, fcntl.LOCK_UN)
            if time.monotonic() >= deadline:
                raise ValueError("The release unit did not acquire admission.")
            time.sleep(0.05)
        return {
            **result,
            "status": "installing",
            "detail": "Managed activation requested.",
            "can_install": False,
        }


def build_environment(candidate, published):
    wheels = candidate / "wheels"
    wheels.mkdir()
    published.download_wheels(wheels)
    uv = "uv"
    python = str(candidate / "venv/bin/python")
    manage.run(
        uv,
        "venv",
        "--python",
        str(manage.INSTALL / "current/venv/bin/python"),
        str(candidate / "venv"),
    )
    manage.run(
        uv,
        "pip",
        "install",
        "--python",
        python,
        "--only-binary",
        ":all:",
        "--no-deps",
        "-r",
        str(manage.RUNTIME),
        *map(str, sorted(wheels.iterdir())),
        cwd=candidate,
    )
    manage.run(uv, "pip", "check", "--python", python)
    (candidate / "runtime.txt").write_text(
        manage.run(uv, "pip", "freeze", "--python", python, capture=True) + "\n"
    )
    manage.preview(candidate, published.version, published.commit, require_drain=True)
    manifest = {
        "release": published.release,
        "version": published.version,
        "commit": published.commit,
        "verified": True,
        "origin": "github-release",
        "artifacts": {f"wheels/{p.name}": manage.digest(p) for p in wheels.iterdir()},
        "runtime_sha256": manage.digest(candidate / "runtime.txt"),
    }
    (candidate / "release.json").write_text(json.dumps(manifest))


def apply(lock, admission_fd):
    if not os.path.samestat(os.fstat(admission_fd), manage.INSTALL.stat()):
        raise ValueError("The managed admission directory is required.")
    fcntl.flock(admission_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not os.path.samestat(os.fstat(lock.fileno()), manage.LOCK.stat()):
        raise ValueError("The managed deployment lock is required.")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    request = read(REQUEST, {})
    published = latest()
    current = manage.read_release(manage.INSTALL / "current")
    if (
        not published
        or published.release != request.get("release")
        or published.fingerprint != request.get("fingerprint")
        or update_status(current, published) != "available"
    ):
        raise ValueError("Release changed after the install request.")
    if os.path.lexists(manage.INSTALL / "pending"):
        raise ValueError("Another release is pending.")

    def require_idle():
        if request["automatic"] is not False:
            raise ValueError("Automatic updates are disabled.")
        if not idle():
            raise ValueError("Active sessions or queued messages prevent activation.")

    require_admission("draining")
    require_idle()
    published.checksums()
    candidate = manage.RELEASES / published.release
    if candidate.is_symlink():
        raise ValueError("Invalid release directory.")
    existing = candidate.exists()
    if not existing:
        candidate.mkdir()
        try:
            build_environment(candidate, published)
        except BaseException:
            shutil.rmtree(candidate)
            raise
    manifest = manage.read_release(candidate)
    expected = {
        "wheels/" + name: asset.sha
        for name, asset in published.assets.items()
        if name != "SHA256SUMS"
    }
    if (
        manifest.get("origin") != "github-release"
        or manifest["commit"] != published.commit
        or manifest["artifacts"] != expected
    ):
        raise ValueError("Existing local candidate conflicts with the published release.")
    if existing:
        manage.preview(candidate, published.version, published.commit, require_drain=True)
    require_idle()
    manage.stage_locked(published.release)
    return published.release, manage.digest(candidate / "release.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("check")
    sub.add_parser("apply")
    install = sub.add_parser("install")
    install.add_argument("release")
    install.add_argument("fingerprint")
    args = parser.parse_args()
    if args.action == "apply":
        # Reserve stdout for the exact activated identity. Build output goes to the journal.
        with os.fdopen(os.dup(1), "w") as result:
            os.dup2(2, 1)
            print(*apply(sys.stdin.buffer, 3), file=result)
    elif args.action == "check":
        print(json.dumps(check()))
    else:
        if not re.fullmatch(RELEASE, args.release) or not re.fullmatch(
            "[0-9a-f]{64}", args.fingerprint
        ):
            raise ValueError("Invalid release identity")
        print(json.dumps(request_install(args.release, args.fingerprint)))


if __name__ == "__main__":
    main()
