"""Browser authority and nonblocking checks for the managed update interface."""

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from omnigent.server.accounts_config import AccountsConfig
from omnigent.server.auth import UnifiedAuthProvider
from omnigent.server.oidc import mint_session_cookie
from omnigent.server.routes.server_update import ServerUpdate, create_server_update_router

ORIGIN = "https://triune.example.test"
BASE = "/api/server-update"
RELEASE = "0.20.0-bbbbbbbbbbbb"


@pytest.mark.asyncio
async def test_signed_admin_origin_mode_and_bound_install(monkeypatch):
    config = AccountsConfig(b"s" * 32, 1, ORIGIN, None, 86400, 600)
    provider = UnifiedAuthProvider("accounts", accounts_config=config)
    update = ServerUpdate(None)
    invoked = []

    async def run(*args):
        invoked.append(args)
        if args[0] == "install":
            return {**update.state, "status": "installing", "can_install": False}
        return {**update.state, "status": "up_to_date", "current_release": RELEASE}

    monkeypatch.setattr(update, "run", run)
    app = FastAPI()
    roster = SimpleNamespace(is_admin=lambda user: user == "admin")
    app.include_router(create_server_update_router(update, provider, None, roster))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        assert (await client.get(BASE, headers={"X-Forwarded-Email": "admin"})).status_code == 401

        def login(user):
            client.cookies.set(
                config.session_cookie_name,
                mint_session_cookie(user, config.cookie_secret, 1, "accounts"),
            )

        login("member")
        assert (await client.get(BASE)).status_code == 403
        login("admin")
        assert (await client.get(BASE)).json()["automatic_idle_supported"] is False
        update.state.update(
            status="available", release=RELEASE, fingerprint="a" * 64, can_install=True
        )
        for headers in (
            {},
            {"Origin": ORIGIN + ":8080"},
            {"Origin": "https://other.test", "Host": "other.test"},
            {"Origin": "http://127.0.0.1"},
            {"Origin": "omnigent://internal"},
        ):
            assert (
                await client.post(BASE + "/install", headers=headers, json={"release": RELEASE})
            ).status_code == 403
        headers = {"Origin": ORIGIN}
        assert (
            await client.put(BASE + "/mode", headers=headers, json={"mode": "automatic_idle"})
        ).status_code == 409
        assert (
            await client.post(
                BASE + "/install", headers=headers, json={"release": "0.20.0-eeeeeeeeeeee"}
            )
        ).status_code == 409
        assert (
            await client.post(
                BASE + "/install", headers=headers, json={"release": RELEASE, "command": "test"}
            )
        ).status_code == 422
        assert invoked == []
        assert (
            await client.post(BASE + "/install", headers=headers, json={"release": RELEASE})
        ).json()["status"] == "installing"
        await update.task
        assert invoked == [("install", RELEASE, "a" * 64), ("check",)]
        assert (await client.get(BASE)).json()["current_release"] == RELEASE


@pytest.mark.asyncio
async def test_local_fallback_and_header_admin_have_no_update_authority():
    app = FastAPI()
    provider = UnifiedAuthProvider("header", local_single_user=True)
    app.include_router(
        create_server_update_router(
            ServerUpdate(None), provider, None, SimpleNamespace(is_admin=lambda _: True)
        )
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        for headers in ({}, {"X-Forwarded-Email": "admin", "Origin": ORIGIN}):
            assert (await client.get(BASE, headers=headers)).status_code == 403


@pytest.mark.asyncio
async def test_background_check_deduplicates_and_closes(monkeypatch):
    update = ServerUpdate(None)
    waiting = asyncio.Event()

    async def run(*args):
        waiting.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(update, "run", run)
    update.start()
    task = update.task
    assert update.state["status"] == "checking" and not waiting.is_set()
    await waiting.wait()
    update.start()
    assert update.task is task
    await update.close()
    assert task.cancelled()
