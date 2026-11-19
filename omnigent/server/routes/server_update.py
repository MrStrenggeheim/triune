"""Admin interface to the fixed managed release helper."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from contextlib import suppress
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.server.auth import UnifiedAuthProvider
from omnigent.server.routes._auth_helpers import get_user_id

logger = logging.getLogger(__name__)
HOME = Path("/home/agent")
SOURCE = HOME / "projects/triune"
CURRENT = HOME / "apps/omnigent/current"
HELPER = SOURCE / "deploy/local/published_update.py"
PYTHON = SOURCE / ".venv/bin/python"
UNSUPPORTED = "Published-release installation requires the managed Linux systemd deployment."


class UpdateStatus(BaseModel):
    status: Literal[
        "unknown",
        "checking",
        "up_to_date",
        "offline",
        "available",
        "unsupported",
        "installing",
        "failed",
    ]
    current_release: str | None
    release: str | None
    release_notes: str | None
    detail: str
    can_install: bool
    mode: Literal["manual", "automatic_idle"]
    automatic_idle_supported: bool


class InstallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    release: str = Field(pattern=r"^[0-9][0-9A-Za-z.]{0,63}-[0-9a-f]{12}$")


class ModeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["manual", "automatic_idle"]


class ServerUpdate:
    def __init__(self, store):
        self.store = store
        self.lock = asyncio.Lock()
        self.task: asyncio.Task | None = None
        self.state = {
            "status": "unknown",
            "current_release": None,
            "release": None,
            "release_notes": None,
            "detail": "The startup check has not finished.",
            "can_install": False,
            "mode": "manual",
            "automatic_idle_supported": False,
        }

    def managed(self):
        database = f"sqlite:///{HOME}/.omnigent/chat.db"
        return (
            sys.platform == "linux"
            and Path.home() == HOME
            and CURRENT.is_symlink()
            and Path(sys.prefix).resolve() == (CURRENT / "venv").resolve()
            and getattr(self.store, "storage_location", None) == database
            and getattr(self.store, "conversation_storage_location", None) in (None, database)
            and HELPER.is_file()
            and PYTHON.is_file()
        )

    async def run(self, *args):
        if not self.managed():
            return {
                **self.state,
                "status": "unsupported",
                "detail": UNSUPPORTED,
                "can_install": False,
            }
        proc = await asyncio.create_subprocess_exec(
            str(PYTHON),
            str(HELPER),
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), 120)
        finally:
            if proc.returncode is None:
                with suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
        if proc.returncode:
            logger.warning(
                "Managed release helper failed: %s", err.decode(errors="replace")[-1000:]
            )
            raise ValueError(
                "The managed update request failed. Check the deployment journal and refresh."
            )
        return json.loads(out)

    async def refresh(self):
        async with self.lock:
            try:
                self.state = await self.run("check")
            except (OSError, TimeoutError, ValueError):
                logger.exception("Published release check failed")
                self.state = {
                    **self.state,
                    "status": "unknown",
                    "detail": "The managed release check failed.",
                    "can_install": False,
                }

    async def check_until_settled(self):
        await self.refresh()
        while self.state["status"] == "installing":
            await asyncio.sleep(5)
            await self.refresh()

    def start(self):
        if self.task is None or self.task.done():
            self.state = {**self.state, "status": "checking", "can_install": False}
            self.task = asyncio.create_task(self.check_until_settled())

    async def close(self):
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task

    async def install(self, release):
        async with self.lock:
            if self.state["release"] != release or not self.state["can_install"]:
                raise HTTPException(409, "The requested release is not ready to install.")
            try:
                self.state = await self.run("install", release, self.state["fingerprint"])
            except (OSError, TimeoutError, ValueError) as error:
                self.start()
                raise HTTPException(
                    409, "The release could not be installed. Refresh its status."
                ) from error
            if self.state["status"] != "installing":
                raise HTTPException(409, self.state["detail"])
            if self.task is None or self.task.done():
                self.task = asyncio.create_task(self.check_until_settled())
            return self.state


def create_server_update_router(update, auth_provider, permission_store, admin_list):
    async def admin(request: Request):
        if (
            not isinstance(auth_provider, UnifiedAuthProvider)
            or not auth_provider.signed_browser_origin
        ):
            raise HTTPException(403, "Updates require signed HTTPS administrator sessions.")
        cookie = auth_provider.session_cookie_name
        if not cookie or not request.cookies.get(cookie) or request.headers.get("authorization"):
            raise HTTPException(401, "Sign in through the administrator browser session.")
        if request.method != "GET" and request.headers.getlist("origin") != [
            auth_provider.signed_browser_origin
        ]:
            raise HTTPException(403, "The configured browser origin is required.")
        user = get_user_id(request, auth_provider)
        if user is None:
            raise HTTPException(401, "Authentication required.")
        if not (
            admin_list.is_admin(user)
            or (permission_store and await asyncio.to_thread(permission_store.is_admin, user))
        ):
            raise HTTPException(403, "Administrator access required.")

    router = APIRouter(prefix="/api/server-update", dependencies=[Depends(admin)])

    @router.get("", response_model=UpdateStatus)
    async def status():
        return update.state

    @router.post("/check", response_model=UpdateStatus)
    async def check():
        update.start()
        return update.state

    @router.put("/mode", response_model=UpdateStatus)
    async def mode(body: ModeRequest):
        if body.mode != "manual":
            raise HTTPException(409, "Automatic updates require a server admission drain.")
        return update.state

    @router.post("/install", response_model=UpdateStatus)
    async def install(body: InstallRequest):
        return await update.install(body.release)

    return router
