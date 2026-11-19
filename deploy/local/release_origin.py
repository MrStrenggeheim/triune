"""Read stable releases from the canonical Triune GitHub repository."""

from __future__ import annotations

import hashlib
import json
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZipFile

from packaging.version import Version

REPO = "MrStrenggeheim/triune"
API = f"https://api.github.com/repos/{REPO}"
RELEASE = r"([0-9][0-9A-Za-z.]{0,63})-([0-9a-f]{12})"
SHA = r"[0-9a-f]{64}"


class AssetRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urlsplit(newurl)
        if url.scheme != "https" or url.netloc != "release-assets.githubusercontent.com":
            raise ValueError("Unexpected GitHub release redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(path: str, *, asset: bool = False, limit: int = 2**20) -> bytes:
    accept = "application/octet-stream" if asset else "application/vnd.github+json"
    request = Request(API + path, headers={"Accept": accept, "User-Agent": "triune-updater"})
    with build_opener(AssetRedirect()).open(request, timeout=15) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Release data exceeds its size limit")
    return data


@dataclass(frozen=True)
class Asset:
    id: int
    sha: str
    size: int


@dataclass(frozen=True)
class Published:
    release: str
    version: str
    commit: str
    notes: str
    assets: dict[str, Asset]

    @property
    def fingerprint(self):
        inventory = {name: asset.sha for name, asset in self.assets.items()}
        data = json.dumps([self.notes, inventory], sort_keys=True).encode()
        return hashlib.sha256(data).hexdigest()

    def download(self, name):
        asset = self.assets[name]
        data = fetch(f"/releases/assets/{asset.id}", asset=True, limit=asset.size)
        if len(data) != asset.size or hashlib.sha256(data).hexdigest() != asset.sha:
            raise ValueError("Downloaded asset failed GitHub SHA-256 verification")
        return data

    def checksums(self):
        expected = "".join(
            f"{self.assets[name].sha}  {name}\n"
            for name in sorted(self.assets)
            if name != "SHA256SUMS"
        ).encode("ascii")
        if self.download("SHA256SUMS") != expected:
            raise ValueError("SHA256SUMS differs from the expected wheel inventory")

    def download_wheels(self, directory: Path):
        self.checksums()
        for name in self.assets:
            if name != "SHA256SUMS":
                path = directory / name
                path.write_bytes(self.download(name))
                with ZipFile(path) as archive:
                    if sum(member.file_size for member in archive.infolist()) > 512 * 2**20:
                        raise ValueError("Expanded wheel exceeds its size limit")
                    for member in archive.infolist():
                        parts = member.filename.rstrip("/").split("/")
                        if (
                            stat.S_IFMT(member.external_attr >> 16)
                            not in (0, stat.S_IFDIR, stat.S_IFREG)
                            or any(p in {"", ".", ".."} for p in parts)
                            or "\\" in member.filename
                            or ":" in member.filename
                        ):
                            raise ValueError("Unsafe wheel member path")


def latest() -> Published | None:
    try:
        row = json.loads(fetch("/releases/latest"))
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    tag = row["tag_name"]
    match = re.fullmatch("triune-" + RELEASE, tag)
    if (
        not match
        or row["draft"] is not False
        or row["prerelease"] is not False
        or not row["published_at"]
    ):
        raise ValueError("Expected a published stable Triune release")
    version, short = match.groups()
    release = f"{version}-{short}"
    body = re.fullmatch(
        rf"Activated Triune build {re.escape(release)}\n"
        rf"Commit: ([0-9a-f]{{40}})\nManifest SHA-256: {SHA}",
        row["body"].replace("\r\n", "\n"),
    )
    if not body or not body[1].startswith(short):
        raise ValueError("Release notes and tag identity disagree")
    obj = json.loads(fetch(f"/git/ref/tags/{tag}"))["object"]
    for _ in range(8):
        if obj["type"] != "tag":
            break
        if not re.fullmatch(r"[0-9a-f]{40}", obj["sha"]):
            raise ValueError("Invalid annotated tag")
        obj = json.loads(fetch("/git/tags/" + obj["sha"]))["object"]
    if obj["type"] != "commit" or obj["sha"] != body[1]:
        raise ValueError("Published tag does not resolve to the declared commit")
    assets = {}
    packages = set()
    for entry in row["assets"]:
        name = entry["name"]
        digest = entry.get("digest") or ""
        if name != "SHA256SUMS":
            wheel = re.fullmatch(
                rf"(triune|omnigent|omnigent_client|omnigent_ui_sdk)-{re.escape(version)}-py3-none-any\.whl",
                name,
            )
            if not wheel:
                raise ValueError("Unexpected or unsupported wheel")
            packages.add(wheel[1])
        if (
            name in assets
            or entry["state"] != "uploaded"
            or not re.fullmatch("sha256:" + SHA, digest)
            or type(entry["id"]) is not int
            or entry["id"] < 1
            or type(entry["size"]) is not int
            or not 0 < entry["size"] <= (4096 if name == "SHA256SUMS" else 128 * 2**20)
        ):
            raise ValueError("Invalid release asset metadata")
        assets[name] = Asset(entry["id"], digest[7:], entry["size"])
    if (
        len(assets) != 4
        or "SHA256SUMS" not in assets
        or packages
        not in (
            {"triune", "omnigent_client", "omnigent_ui_sdk"},
            {"omnigent", "omnigent_client", "omnigent_ui_sdk"},
        )
    ):
        raise ValueError("Incomplete release asset inventory")
    return Published(release, version, body[1], body[0], assets)


def update_status(current: dict, published: Published) -> str:
    if current["commit"] == published.commit:
        if current["release"] != published.release:
            raise ValueError("Active release identity conflicts with the published tag")
        return "up_to_date"
    if Version(current["version"]) > Version(published.version):
        return "up_to_date"
    if not re.fullmatch(r"[0-9a-f]{40}", current["commit"]):
        raise ValueError("Invalid installed commit")
    compare = json.loads(fetch(f"/compare/{current['commit']}...{published.commit}?per_page=1"))
    if compare["status"] == "behind":
        return "up_to_date"
    if compare["status"] != "ahead":
        raise ValueError("Cannot establish a forward update from the installed commit")
    return "available"
