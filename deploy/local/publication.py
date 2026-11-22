"""Owner decisions for GitHub Releases of locally activated Triune builds."""

from __future__ import annotations

import argparse
import fcntl
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import manage

REPO = "MrStrenggeheim/triune"


def release_tag(release: str) -> str:
    """Return the public tag of a build: one ``triune-v<version>`` release per version."""
    return f"triune-v{release.rsplit('-', 1)[0]}"


REMOTE = f"git@github.com:{REPO}.git"
LOCK = Path("/run/lock/stable-updates.lock")


def identity(release: str) -> dict:
    current = (manage.INSTALL / "current").resolve(strict=True)
    if current.parent != manage.RELEASES.resolve() or release != current.name:
        raise ValueError("requested version is not the active release")
    manifest = manage.read_release(current)
    commit = manifest["commit"]
    version = manifest["version"]
    if not (
        manifest["verified"] is True
        and re.fullmatch(r"[0-9][0-9A-Za-z.]*", version)
        and re.fullmatch(r"[0-9a-f]{40}", commit)
        and release == f"{version}-{commit[:12]}"
    ):
        raise ValueError("release id, version and full commit must agree")
    # Only the three regular package wheels from this verified build may leave the host.
    artifacts = manifest["artifacts"]
    if len(artifacts) != 3 or (current / "wheels").is_symlink():
        raise ValueError("expected three release wheels")
    for filename in artifacts:
        wheel = current / filename
        if (
            not re.fullmatch(
                rf"wheels/(triune|omnigent|omnigent_client|omnigent_ui_sdk)-{re.escape(version)}"
                r"-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl",
                filename,
            )
            or wheel.is_symlink()
            or not wheel.is_file()
        ):
            raise ValueError(f"unsafe release asset: {filename}")
    return {
        "origin": manifest.get("origin"),
        "release": release,
        "commit": commit,
        "manifest_sha256": manage.digest(current / "release.json"),
        "wheels": {Path(name).name: sha for name, sha in artifacts.items()},
    }


def receipt_path(release: str, *, downstream: bool = False) -> Path:
    directory = "published-activations" if downstream else "publication-decisions"
    return manage.INSTALL / directory / f"{release}.json"


def save(record: dict) -> None:
    path = receipt_path(record["release"], downstream=record.get("origin") == "github-release")
    path.parent.mkdir(mode=0o700, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as temp:
        json.dump(record, temp, indent=2)
        temp.write("\n")
    Path(temp.name).replace(path)


def question(record: dict) -> str:
    build = f"{record['release']} ({record['commit']})"
    return f"Publish activated {build} as a GitHub Release of {REPO}?"


def activated(release: str) -> None:
    # The service holds LOCK until the receipt is saved and pending is cleared.
    record = identity(release)
    if record.get("origin") == "github-release":
        save(dict(record, activation="successful"))
        status()
        return
    path = receipt_path(release)
    if path.exists():
        previous = json.loads(path.read_text())
        if any(previous.get(k) != v for k, v in record.items()):
            raise ValueError("release id already recorded with different build bytes")
    else:
        save(dict(record, decision="pending"))
    status()


def status() -> None:
    current = (manage.INSTALL / "current").resolve()
    release = current.name
    manifest = current / "release.json"
    downstream = (
        manifest.is_file() and json.loads(manifest.read_text()).get("origin") == "github-release"
    )
    path = receipt_path(release, downstream=downstream)
    if downstream:
        if path.is_file() and json.loads(path.read_text())["manifest_sha256"] == manage.digest(
            manifest
        ):
            print(
                f"{release}: activation successful; already published at https://github.com/{REPO}/releases/tag/{release_tag(release)}"
            )
            print(path)
        else:
            print(f"{release}: GitHub Release installation awaiting an activation receipt.")
        return
    if path.is_file():
        record = json.loads(path.read_text())
        print(
            question(record)
            if record["decision"] == "pending"
            else f"{release}: {record['decision']}"
        )
        print(path)
    else:
        print(f"No publication decision recorded for {release}.")


def gh(*args: str) -> str:
    return manage.run("gh", *args, capture=True)


def releases(tag: str) -> list[dict]:
    result = gh(
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        f"repos/{REPO}/releases?per_page=100",
        "--jq",
        f'.[] | select(.tag_name == "{tag}") | @json',
    )
    rows = [json.loads(line) for line in result.splitlines()]
    for row in rows:
        row["body"] = (row["body"] or "").replace("\r\n", "\n")
    return rows


def remote_commit(tag: str) -> str | None:
    ref = f"refs/tags/{tag}"
    listing = manage.run("git", "ls-remote", REMOTE, ref, ref + "^{}", capture=True)
    refs = {name: sha for sha, name in (line.split() for line in listing.splitlines())}
    return refs.get(ref + "^{}", refs.get(ref))


def publish(record: dict, directory: Path) -> None:
    release, commit = record["release"], record["commit"]
    tag = release_tag(release)
    repo_args = ("--repo", f"github.com/{REPO}")
    if len(release.rsplit("-", 1)[0]) > 64:
        raise ValueError("version exceeds the downstream release limit")
    # Snapshot and rehash the actual upload bytes before the first remote mutation.
    expected = dict(record["wheels"])
    for name, sha in expected.items():
        wheel = directory / name
        source = manage.RELEASES / release / "wheels" / name
        if not name.endswith("-py3-none-any.whl") or not 0 < source.stat().st_size <= 128 * 2**20:
            raise ValueError(f"wheel outside downstream install contract: {name}")
        shutil.copyfile(source, wheel)
        if manage.digest(wheel) != sha:
            raise ValueError(f"wheel changed during preparation: {name}")
    checksums = directory / "SHA256SUMS"
    checksums.write_text("".join(f"{expected[name]}  {name}\n" for name in sorted(expected)))
    expected[checksums.name] = manage.digest(checksums)

    if manage.run("git", "rev-parse", "--verify", commit + "^{commit}", capture=True) != commit:
        raise ValueError("verified source commit is unavailable")
    permissions = json.loads(gh("api", "--hostname", "github.com", f"repos/{REPO}"))["permissions"]
    if not (permissions.get("admin") or permissions.get("maintain")):
        raise PermissionError(f"maintainer access required on {REPO}")

    notes = (
        f"Activated Triune build {release}\nCommit: {commit}\n"
        f"Manifest SHA-256: {record['manifest_sha256']}"
    )
    matches = releases(tag)
    if len(matches) > 1 or (matches and matches[0]["body"] != notes):
        raise ValueError("conflicting release for this tag")
    remote = remote_commit(tag)
    if remote is None and not matches:
        manage.run("git", "push", "--no-follow-tags", REMOTE, f"{commit}:refs/tags/{tag}")
        remote = remote_commit(tag)
    if remote != commit:
        raise ValueError("remote tag does not identify the activated commit")
    if not matches:
        gh(
            "release",
            "create",
            tag,
            *repo_args,
            "--draft",
            "--verify-tag",
            "--target",
            commit,
            "--title",
            f"Triune {release.rsplit('-', 1)[0]}",
            "--notes",
            notes,
        )
        matches = releases(tag)
    if (
        len(matches) != 1
        or matches[0]["body"] != notes
        or matches[0].get("prerelease") is not False
    ):
        raise ValueError("expected one matching release")
    release_api = f"repos/{REPO}/releases/{int(matches[0]['id'])}"

    def missing_assets() -> set[str]:
        rows = gh(
            "api",
            "--hostname",
            "github.com",
            "--paginate",
            release_api + "/assets",
            "--jq",
            ".[] | @json",
        )
        missing = set(expected)
        for line in rows.splitlines():
            asset = json.loads(line)
            name = asset["name"]
            if (
                name not in missing
                or asset["state"] != "uploaded"
                or asset.get("digest") != "sha256:" + expected[name]
            ):
                raise ValueError(f"conflicting or unverifiable remote asset: {name}")
            missing.remove(name)
        return missing

    missing = missing_assets()
    if matches[0]["draft"]:
        if missing:
            gh(
                "release",
                "upload",
                tag,
                *repo_args,
                *(str(directory / n) for n in sorted(missing)),
            )
        if missing_assets() or remote_commit(tag) != commit:
            raise ValueError("incomplete draft or changed tag")
        gh(
            "api",
            "--hostname",
            "github.com",
            "-X",
            "PATCH",
            release_api,
            "-f",
            f"tag_name={tag}",
            "-f",
            f"target_commitish={commit}",
            "-F",
            "draft=false",
            "-F",
            "prerelease=false",
        )
    elif missing:
        raise ValueError("existing published release has missing assets")
    final = releases(tag)
    if (
        len(final) != 1
        or final[0]["id"] != matches[0]["id"]
        or final[0].get("draft") is not False
        or final[0].get("prerelease") is not False
        or not final[0].get("published_at")
        or final[0]["body"] != notes
        or remote_commit(tag) != commit
        or missing_assets()
    ):
        raise ValueError("published release could not be verified")
    print(f"https://github.com/{REPO}/releases/tag/{tag}")


def decide(release: str, *, approve: bool) -> None:
    with LOCK.open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = identity(release)
        if current.get("origin") == "github-release":
            raise ValueError("this build was installed from an existing GitHub Release")
        record = json.loads(receipt_path(release).read_text())
        if any(record.get(k) != v for k, v in current.items()):
            raise ValueError("activation receipt differs from verified files")
        if (manage.INSTALL / "pending").resolve() == manage.RELEASES / release:
            raise ValueError("activation has not finished")
        if approve:
            if record["decision"] != "published":
                save(dict(current, decision="approved"))
            with tempfile.TemporaryDirectory(prefix="triune-release-") as tmp:
                publish(current, Path(tmp))
            save(dict(current, decision="published"))
        elif record["decision"] == "published":
            raise ValueError("release is already published")
        else:
            save(dict(current, decision="declined"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("publication-status")
    for name in ("activation-complete", "decline", "publish"):
        command = sub.add_parser(name)
        command.add_argument("release")
        if name == "publish":
            command.add_argument("--owner-approved", action="store_true", required=True)
    args = parser.parse_args()
    try:
        if args.command == "activation-complete":
            activated(args.release)
        elif args.command == "publication-status":
            status()
        else:
            decide(args.release, approve=args.command == "publish")
    except subprocess.CalledProcessError as exc:
        parser.exit(1, (exc.stderr or str(exc)) + "\n")
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
