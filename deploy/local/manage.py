"""Modified for Triune: build and stage this host's custom releases.

The change register and operating instructions live in the shared KB:
infrastructure/omnigent/custom-builds.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import tempfile
import time
import tomllib
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2]
INSTALL = Path.home() / "apps/omnigent"
RELEASES = INSTALL / "releases"
RUNTIME = SOURCE / "deploy/local/runtime.txt"


def run(*command: str, capture: bool = False, cwd: Path = SOURCE) -> str:
    """Run a command and stop on failure."""
    result = subprocess.run(command, cwd=cwd, check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else ""


def digest(path: Path) -> str:
    """Identify an artifact by its bytes."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_release(path: Path) -> dict:
    """Require an intact, verified build inside the release directory."""
    path = path.resolve(strict=True)
    if path.parent != RELEASES.resolve():
        raise ValueError("release must be directly inside the releases directory")
    manifest = json.loads((path / "release.json").read_text())
    if manifest["release"] != path.name or not manifest["verified"]:
        raise ValueError("release has not passed its verification")
    wheels = path / "wheels"
    if wheels.resolve().parent != path:
        raise ValueError("wheel directory escapes the release")
    names = {Path(filename).name.split("-")[0] for filename in manifest["artifacts"]}
    if names not in (
        {"triune", "omnigent_client", "omnigent_ui_sdk"},
        {"omnigent", "omnigent_client", "omnigent_ui_sdk"},
    ):
        raise ValueError("release must contain all three application wheels")
    for filename, expected in manifest["artifacts"].items():
        artifact = path / filename
        if artifact.resolve().parent != wheels:
            raise ValueError("invalid artifact path")
        if digest(artifact) != expected:
            raise ValueError(f"artifact has changed: {filename}")
    if digest(path / "runtime.txt") != manifest["runtime_sha256"]:
        raise ValueError("runtime inventory has changed")
    return manifest


def preview(release: Path, expected_version: str, expected_commit: str) -> None:
    """Boot the packaged app against an isolated copy of the chat database."""
    python = release / "venv/bin/python"
    run(
        str(python),
        "-c",
        "from omnigent import _build_info; import sys; "
        "assert _build_info.COMMIT_SHA == sys.argv[1]",
        expected_commit,
        cwd=release,
    )
    with tempfile.TemporaryDirectory(prefix="omnigent-preview-") as directory:
        state = Path(directory)
        database = Path.home() / ".omnigent/chat.db"
        if database.exists():
            with (
                sqlite3.connect(f"file:{database}?mode=ro", uri=True) as original,
                sqlite3.connect(state / "chat.db") as copy,
            ):
                original.backup(copy)
        env = {key: value for key, value in os.environ.items() if not key.startswith("OMNIGENT_")}
        env.update(
            OMNIGENT_DATA_DIR=directory,
            OMNIGENT_CONFIG_HOME=directory,
            OMNIGENT_AUTH_PROVIDER="header",
            OMNIGENT_LOCAL_SINGLE_USER="1",
            OMNIGENT_DISABLE_CATALOG_LOOKUP="1",
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with (release / "preview.log").open("w") as log:
            process = subprocess.Popen(
                [
                    str(release / "venv/bin/omnigent"),
                    "server",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--no-open",
                ],
                cwd=release,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                for _ in range(60):
                    if process.poll() is not None:
                        raise RuntimeError("preview exited; inspect preview.log")
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}/health", timeout=2
                        ) as r:
                            healthy = json.load(r).get("status") == "ok"
                    except (OSError, ValueError):
                        healthy = False
                    if healthy:
                        break
                    time.sleep(0.5)
                else:
                    raise RuntimeError("preview did not become healthy; inspect preview.log")
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/version", timeout=5
                ) as r:
                    if json.load(r)["version"] != expected_version:
                        raise RuntimeError("preview version differs from the build")
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as r:
                    html = r.read().decode()
                css_paths = re.findall(r'href="([^"]+\.css)"', html)
                if not css_paths:
                    raise RuntimeError("packaged frontend has no stylesheet")
                for css_path in css_paths:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}{css_path}", timeout=5
                    ) as r:
                        css = r.read().decode()
                    if "--chat-prose-width:100%" in css:
                        break
                else:
                    raise RuntimeError("packaged frontend lacks the chat-width customization")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def build() -> None:
    """Build a clean commit with frozen frontend and runtime dependencies."""
    if run("git", "status", "--porcelain", capture=True):
        raise ValueError("commit all source changes before building")
    commit = run("git", "rev-parse", "HEAD", capture=True)
    version = tomllib.loads((SOURCE / "pyproject.toml").read_text())["project"]["version"]
    upstream = run("git", "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", capture=True)
    release = RELEASES / f"{version}-{commit[:12]}"
    if release.exists():
        if not (release / "release.json").exists():
            raise ValueError(
                f"incomplete build at {release}; inspect and remove it before retrying"
            )
        read_release(release)
        print(f"Already built and verified: {release}")
        return
    release.mkdir(parents=True)
    wheels = release / "wheels"
    wheels.mkdir()
    run(
        str(SOURCE / ".venv/bin/python"),
        "-m",
        "pytest",
        "tests/deploy/test_local_release.py",
        "tests/runner/test_environment_filesystem.py",
        "tests/test_workspace_fs.py",
        "-q",
        "--reruns",
        "0",
    )
    run(
        str(SOURCE / ".venv/bin/python"),
        "-m",
        "pytest",
        "tests/server/routes/test_gzip_route.py",
        "tests/server/routes/test_session_resources.py",
        "-k",
        "gzip",
        "-q",
        "--reruns",
        "0",
    )
    run("pnpm", "install", "--frozen-lockfile", "--filter", "web")
    run("pnpm", "--dir", "web", "exec", "prettier", "--check", "src/index.css")
    run(
        "pnpm",
        "--filter",
        "web",
        "test",
        "src/hooks/useWorkspaceChangedFiles.test.tsx",
        "src/shell/FolderTree.test.tsx",
        "src/shell/FilesPanel.test.tsx",
        "src/shell/RevealInFileManager.test.tsx",
    )
    run("pnpm", "--filter", "web", "run", "build")
    run("uv", "build", "--wheel", "--out-dir", str(wheels))
    run(
        str(SOURCE / ".venv/bin/python"),
        "scripts/build_subpackages.py",
        "--wheel",
        "--out-dir",
        str(wheels),
        "omnigent-client",
        "omnigent-ui-sdk",
    )
    run("uv", "venv", "--python", "3.12", str(release / "venv"))
    run(
        "uv",
        "pip",
        "install",
        "--python",
        str(release / "venv/bin/python"),
        "--requirement",
        str(RUNTIME),
        *map(str, sorted(wheels.glob("*.whl"))),
        cwd=release,
    )
    frozen = run("uv", "pip", "freeze", "--python", str(release / "venv/bin/python"), capture=True)
    (release / "runtime.txt").write_text(frozen + "\n")
    run("uv", "pip", "check", "--python", str(release / "venv/bin/python"))
    dev_site = run(
        str(SOURCE / ".venv/bin/python"),
        "-c",
        "import sysconfig; print(sysconfig.get_path('purelib'))",
        capture=True,
    )
    run(
        str(release / "venv/bin/python"),
        "-c",
        "import sys; sys.path.append(sys.argv.pop(1)); import pytest; "
        "raise SystemExit(pytest.main(sys.argv[1:]))",
        dev_site,
        "tests/server/routes/test_gzip_route.py",
        "-q",
        "--reruns",
        "0",
    )
    preview(release, version, commit)
    manifest = {
        "release": release.name,
        "version": version,
        "upstream": upstream,
        "commit": commit,
        "verified": True,
        "artifacts": {
            str(p.relative_to(release)): digest(p) for p in sorted(wheels.glob("*.whl"))
        },
        "runtime_sha256": digest(release / "runtime.txt"),
    }
    (release / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built and previewed: {release}")
    print(f"Stage with: omni-custom stage {release.name}")


def stage(release_id: str) -> None:
    """Select a verified release for the next idle deployment."""
    if Path(release_id).name != release_id:
        raise ValueError("supply a release name, not a path")
    target = RELEASES / release_id
    read_release(target)
    temporary = INSTALL / "pending.new"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(INSTALL / "pending")
    print(f"Staged {release_id}; deploy with: sudo systemctl start omnigent-stable-update.service")


def main() -> None:
    """Expose build, stage, verification, and status without changing live code."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build")
    sub.add_parser("status")
    for command in ("stage", "verify"):
        sub.add_parser(command).add_argument("release")
    args = parser.parse_args()
    if args.command == "build":
        build()
    elif args.command == "stage":
        stage(args.release)
    elif args.command == "verify":
        print(json.dumps(read_release(RELEASES / args.release), indent=2))
    else:
        for name in ("current", "pending", "previous"):
            path = INSTALL / name
            print(f"{name}: {path.resolve() if path.is_symlink() else '(none)'}")
        print(f"source: {SOURCE}")
        print(f"commit: {run('git', 'rev-parse', '--short', 'HEAD', capture=True)}")


if __name__ == "__main__":
    main()
