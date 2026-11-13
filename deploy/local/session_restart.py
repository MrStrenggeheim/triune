# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Remember live conversations across a local release's service restart."""

from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.parse import quote

SERVER = "http://127.0.0.1:6767"


def request(
    method: str,
    path: str,
    *,
    params: dict[str, str | int] | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Use the operator account's existing management authentication."""
    from omnigent.cli import _host_http_json

    result = _host_http_json(
        base_url=SERVER,
        method=method,
        path=path,
        params=params,
        json_body=body,
        timeout_s=120 if method == "POST" else 15,
    )
    if not 200 <= result.status_code < 300 or not isinstance(result.body, dict):
        raise RuntimeError(f"Session {method} failed (HTTP {result.status_code})")
    return result.body


def save(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(manifest, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def capture(path: Path, candidate: str) -> None:
    from omnigent.util.session_lifecycle import is_session_closed

    sessions: dict[str, dict[str, Any]] = {}
    after = None
    cursors = set()
    while True:
        params: dict[str, str | int] = {
            "limit": 1000,
            "include_archived": "true",
            "kind": "any",
            "visibility": "all",
        }
        if after is not None:
            params["after"] = after
        page = request("GET", "/v1/sessions", params=params)
        if not isinstance(page.get("data"), list) or type(page.get("has_more")) is not bool:
            raise ValueError("Session inventory is incomplete")
        for session in page["data"]:
            if not isinstance(session, dict) or not isinstance(session.get("id"), str):
                raise ValueError("Session inventory has an invalid entry")
            sessions[session["id"]] = session
        if not page["has_more"]:
            break
        after = page.get("last_id")
        if not page["data"] or not isinstance(after, str) or after in cursors:
            raise ValueError("Session inventory pagination made no progress")
        cursors.add(after)

    roots: dict[str, dict[str, Any]] = {}
    for session in sessions.values():
        if is_session_closed(session.get("labels", {}), session.get("title")):
            continue
        pending = session.get("pending_elicitations_count", 0) or 0
        running = session.get("status") == "running"
        if not (
            session.get("runner_online")
            or running
            or pending
            or session.get("status") == "waiting"
        ):
            continue
        owner = session
        visited = {owner["id"]}
        while owner.get("parent_session_id") in sessions:
            parent = sessions[owner["parent_session_id"]]
            shared_runner = not owner.get("host_id") and (
                owner.get("kind") == "sub_agent"
                or (owner.get("runner_id") and owner.get("runner_id") == parent.get("runner_id"))
            )
            if not shared_runner:
                break
            if parent["id"] in visited:
                raise ValueError("Session hierarchy contains a cycle")
            visited.add(parent["id"])
            owner = parent
        entry = roots.setdefault(
            owner["id"],
            {"id": owner["id"], "running": False, "pending": False, "restored": False},
        )
        entry["running"] |= running
        entry["pending"] |= pending > 0 or session.get("status") == "waiting"
    save(path, {"version": 1, "candidate": candidate, "sessions": list(roots.values())})
    print(f"Saved {len(roots)} session runtimes for restart.")


def _resume(entry: dict[str, Any]) -> str | None:
    deadline = time.monotonic() + 60
    while True:
        try:
            result = request(
                "POST",
                f"/v1/sessions/{quote(entry['id'], safe='')}/events",
                body={
                    "type": "retry_session",
                    "data": {"resume_interrupted_turn": entry["running"] and not entry["pending"]},
                },
            )
            if not (
                result.get("recovered") is True or result.get("recovery") == "already_connected"
            ):
                raise RuntimeError("Session did not acknowledge recovery")
            return None
        except (RuntimeError, OSError) as error:
            if time.monotonic() >= deadline:
                return str(error)
            time.sleep(2)


def resume(path: Path, candidate: str | None = None) -> bool:
    manifest = json.loads(path.read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("sessions"), list):
        raise ValueError("Invalid session restart inventory")
    if candidate is not None and manifest.get("candidate") != candidate:
        raise ValueError("Session restart inventory belongs to another release")
    pending = [entry for entry in manifest["sessions"] if not entry.get("restored")]
    failures = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        tasks = {pool.submit(_resume, entry): entry for entry in pending}
        for task in as_completed(tasks):
            entry = tasks[task]
            error = task.result()
            if error:
                failures += 1
                print(f"Session {entry['id']} needs recovery retry: {error}")
            else:
                entry["restored"] = True
            save(path, manifest)
    print(f"Session restart: {len(pending) - failures} restored, {failures} awaiting retry.")
    return failures == 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("capture", "resume"))
    parser.add_argument("path", type=Path)
    parser.add_argument("--candidate")
    args = parser.parse_args()
    if args.action == "capture":
        if not args.candidate:
            parser.error("capture requires --candidate")
        capture(args.path, args.candidate)
    elif not resume(args.path, args.candidate):
        raise SystemExit(75)


if __name__ == "__main__":
    main()
