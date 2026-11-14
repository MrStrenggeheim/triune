# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Observe Codex account quota without responding to native dialogs or account actions."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from uuid import uuid4

import httpx

_logger = logging.getLogger(__name__)


class CodexRuntimeNotices:
    def __init__(
        self,
        server_client: httpx.AsyncClient,
        native_client: Any,
        session_id: str,
        source_instance: str,
    ):
        self.server_client = server_client
        self.native_client = native_client
        self.session_id = session_id
        self.source_instance = source_instance
        self.account: dict[str, Any] | None = None
        self.workspace_routing: dict[str, Any] | None = None
        self.scope_epoch = uuid4().hex
        self.sequence = time.time_ns()

    async def _publish(self, kind: str, state: dict[str, Any]) -> None:
        self.sequence += 1
        response = await self.server_client.post(
            f"/v1/sessions/{self.session_id}/events",
            json={
                "type": "external_runtime_notice",
                "data": {
                    "provider": "codex",
                    "source_instance": self.source_instance,
                    "scope_kind": "captured_parent",
                    "scope_epoch": self.scope_epoch,
                    "account": self.account,
                    "workspace_routing": self.workspace_routing,
                    "kind": kind,
                    "sequence": self.sequence,
                    "observed_at": time.time(),
                    "state": state,
                },
            },
            timeout=10.0,
        )
        response.raise_for_status()

    async def _clear(self) -> str:
        self.account = None
        self.workspace_routing = None
        self.scope_epoch = uuid4().hex
        epoch = self.scope_epoch
        await self._publish("account", {})
        return epoch

    async def snapshot(self) -> None:
        """Refresh documented auth and quota snapshots; GET never calls this."""
        epoch = await self._clear()
        try:
            response = await asyncio.wait_for(
                self.native_client.request("account/read", {"refreshToken": False}), timeout=10.0
            )
            if not isinstance(response, dict):
                return
            result = response.get("result", {})
            account = result.get("account") if isinstance(result, dict) else None
            if (
                epoch != self.scope_epoch
                or response.get("error")
                or not isinstance(account, dict)
                or account.get("type") != "chatgpt"
                or not (account.get("email") is None or isinstance(account.get("email"), str))
            ):
                return
            routing = result.get("workspaceRouting")
            self.account = {key: account.get(key) for key in ("type", "email", "planType")}
            self.workspace_routing = (
                {
                    key: routing.get(key)
                    for key in ("chatgptAccountId", "backendOrigin", "accountRoutingOverride")
                }
                if isinstance(routing, dict)
                else None
            )
            quota = await asyncio.wait_for(
                self.native_client.request("account/rateLimits/read", {}), timeout=10.0
            )
        except (RuntimeError, TimeoutError) as error:
            # Older app-servers and API-key accounts may not expose these reads.
            _logger.debug("Codex account quota snapshot unavailable: %s", type(error).__name__)
            return
        if epoch != self.scope_epoch:
            return
        if not isinstance(quota, dict):
            return
        result = quota.get("result", {})
        if not isinstance(result, dict) or quota.get("error"):
            return
        await self._publish("rate_limit", self._quota_state(result))

    @staticmethod
    def _quota_state(params: dict[str, Any]) -> dict[str, Any]:
        # Preserve only observed quota fields; purchase and credit actions are not capabilities.
        return {
            key: params[key]
            for key in ("rateLimits", "rateLimitsByLimitId", "ordinaryUsageAllowed")
            if key in params
        }

    async def handle(self, method: str, params: dict[str, Any]) -> bool:
        if method == "account/updated":
            if params.get("authMode") is None:
                await self._clear()
            else:
                await self.snapshot()
            return True
        if method == "account/rateLimits/updated":
            if self.account is not None:
                await self._publish("rate_limit", self._quota_state(params))
            return True
        return False
