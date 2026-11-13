# Modified for Triune.
"""Workspace authorization and target resolution independent of chat lifetime."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Any

import httpx
from fastapi import HTTPException, Request

from omnigent.runner.transports.ws_tunnel.registry import RunnerSession, TunnelRegistry
from omnigent.runner.transports.ws_tunnel.transport import WSTunnelTransport
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.auth import LEVEL_OWNER, AuthProvider
from omnigent.server.host_registry import HostConnection, HostRegistry
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.server.routes._host_launch import resolve_host_owner
from omnigent.server.routes._workspace_validation import (
    WorkspaceValidationError,
    validate_workspace,
)
from omnigent.stores import AgentStore, ConversationStore
from omnigent.stores.host_store import Host, HostStore
from omnigent.stores.permission_store import PermissionStore
from omnigent.stores.workbench_workspace_store import WorkbenchWorkspace, WorkbenchWorkspaceStore


def host_generation(host: Host) -> str:
    if host.sandbox_provider:
        if not host.sandbox_id:
            raise HTTPException(409, "Sandbox has no active filesystem generation")
        return host.sandbox_id
    return f"{host.created_at}:{host.account_generation or 'external'}"


class WorkbenchWorkspaceService:
    def __init__(
        self,
        *,
        store: WorkbenchWorkspaceStore,
        host_store: HostStore | None,
        host_registry: HostRegistry,
        conversation_store: ConversationStore,
        agent_store: AgentStore,
        agent_cache: AgentCache,
        auth_provider: AuthProvider | None = None,
        permission_store: PermissionStore | None = None,
        tunnel_registry: TunnelRegistry | None = None,
    ) -> None:
        self.store = store
        self.host_store = host_store
        self.host_registry = host_registry
        self.conversation_store = conversation_store
        self.agent_store = agent_store
        self.agent_cache = agent_cache
        self.auth_provider = auth_provider
        self.permission_store = permission_store
        self.tunnel_registry = tunnel_registry

    async def require_workspace(
        self, request: Request, workspace_id: str, write: bool = False
    ) -> WorkbenchWorkspace:
        """Owner-only initially; chat grants never authorize workspace operations."""
        del write  # Both read and write require independent ownership in this version.
        user_id = require_user(request, self.auth_provider)
        workspace = await asyncio.to_thread(self.store.get, workspace_id, user_id)
        if workspace is None:
            raise HTTPException(404, "Workspace not found")
        if workspace.host_id:
            if self.host_store is None:
                raise HTTPException(503, "Host workspace support is unavailable")
            host = await asyncio.to_thread(
                resolve_host_owner,
                user_id=user_id,
                host_id=workspace.host_id,
                host_store=self.host_store,
            )
            if host_generation(host) != workspace.generation:
                raise HTTPException(409, "Workspace filesystem generation changed; resolve again")
        return workspace

    async def host_connection(self, workspace: WorkbenchWorkspace) -> HostConnection:
        if workspace.target_kind not in {"host", "sandbox"} or not workspace.host_id:
            raise HTTPException(409, "Workspace requires its original environment adapter")
        if self.host_store is None:
            raise HTTPException(503, "Host workspace support is unavailable")
        host = await asyncio.to_thread(
            resolve_host_owner,
            user_id=workspace.owner_user_id,
            host_id=workspace.host_id,
            host_store=self.host_store,
        )
        if host_generation(host) != workspace.generation:
            raise HTTPException(409, "Workspace filesystem generation changed; resolve again")
        conn = self.host_registry.get(workspace.host_id)
        if conn is None:
            raise HTTPException(503, "Workspace host is offline")
        if conn.owner != host.user_id and conn.owner is not None:
            raise HTTPException(403, "Workspace host connection owner changed")
        if conn.account_generation != host.account_generation:
            raise HTTPException(409, "Workspace host account generation changed")
        return conn

    async def create_host(
        self, request: Request, host_id: str, root: str, source_session_id: str | None = None
    ) -> WorkbenchWorkspace:
        user_id = require_user(request, self.auth_provider)
        if self.host_store is None:
            raise HTTPException(503, "Host workspace support is unavailable")
        host = await asyncio.to_thread(
            resolve_host_owner, user_id=user_id, host_id=host_id, host_store=self.host_store
        )
        generation = host_generation(host)
        try:
            canonical = await validate_workspace(
                host_registry=self.host_registry, host_id=host_id, workspace=root, spec_cwd=None
            )
        except WorkspaceValidationError as exc:
            raise HTTPException(400, exc.message) from exc
        # Validation crossed the tunnel; never persist a different sandbox's path.
        current = await asyncio.to_thread(self.host_store.get_host, host_id)
        if (
            current is None
            or current.user_id != host.user_id
            or host_generation(current) != generation
        ):
            raise HTTPException(409, "Workspace target changed during resolution")
        return await asyncio.to_thread(
            self.store.resolve,
            owner_user_id=user_id,
            host_id=host_id,
            target_kind="sandbox" if host.sandbox_provider else "host",
            target_id=host_id,
            generation=generation,
            root=canonical,
            source_session_id=source_session_id,
        )

    async def resolve_session(
        self,
        request: Request,
        session_id: str,
        *,
        allow_missing_root: bool = False,
        captured: dict[str, Any] | None = None,
    ) -> WorkbenchWorkspace:
        user_id = require_user(request, self.auth_provider)
        await require_access(
            user_id, session_id, LEVEL_OWNER, self.permission_store, self.conversation_store
        )
        conv = await asyncio.to_thread(self.conversation_store.get_conversation, session_id)
        if conv is None:
            raise HTTPException(404, "Session not found")
        if captured is not None:
            from dataclasses import replace

            conv = replace(
                conv,
                host_id=captured.get("host_id"),
                workspace=captured.get("workspace"),
                runner_id=captured.get("runner_id"),
                workspace_transition=None,
            )
        if conv.workspace_transition and conv.workspace_transition.get("blocked"):
            raise HTTPException(
                409, "Workspace change in progress; finish or recover it before opening files"
            )
        spec = None
        if conv.agent_id:
            agent = await asyncio.to_thread(self.agent_store.get, conv.agent_id)
            if agent:
                loaded = await asyncio.to_thread(
                    self.agent_cache.load,
                    agent.id,
                    agent.bundle_location,
                    expand_env=agent.operator_authored,
                )
                spec = loaded.spec
        os_env = getattr(spec, "os_env", None)
        sandbox = getattr(os_env, "sandbox", None)
        isolated = (
            getattr(getattr(spec, "sandbox", None), "container_image", None)
            or getattr(os_env, "type", "caller_process") != "caller_process"
            or getattr(os_env, "fork", False)
            or getattr(os_env, "start_in_scratch", False)
            or any(
                getattr(path, "copy_on_write", False)
                for path in getattr(sandbox, "write_path_specs", [])
            )
        )
        # A host path alone does not prove a container/fork shares those files.
        if isolated:
            raise HTTPException(
                409,
                "Environment needs filesystem identity and generation; host fallback disabled",
            )
        restricted_view = sandbox is not None and getattr(sandbox, "type", "none") != "none"
        if not conv.host_id or not conv.workspace or restricted_view:
            if not conv.runner_id or not self.tunnel_registry:
                raise HTTPException(409, "Workspace has no connected filesystem target")
            connection = self.tunnel_registry.get(conv.runner_id)
            if connection is None:
                raise HTTPException(503, "Workspace runner is offline")
            if user_id is not None and connection.owner != user_id:
                raise HTTPException(403, "Workspace runner is not owned by caller")
            generation = f"{connection.connected_at}:{connection.generation}"
            source = f"{session_id}/default"
            response = await self.runner_request(
                conv.runner_id,
                connection,
                "GET",
                f"/v1/sessions/{session_id}/resources/environments/default",
            )
            metadata = response.json().get("metadata", {})
            root = metadata.get("root")
            if not isinstance(root, str) or not root:
                raise HTTPException(409, "Runner has not reported its filesystem root")
            return await asyncio.to_thread(
                self.store.resolve,
                owner_user_id=user_id,
                host_id=None,
                target_kind="runneronly",
                target_id=conv.runner_id,
                generation=generation,
                root=root,
                source_session_id=session_id,
                source_environment_id=source,
            )
        if allow_missing_root:
            if self.host_store is None:
                raise HTTPException(503, "Host workspace support is unavailable")
            host = await asyncio.to_thread(
                resolve_host_owner,
                user_id=user_id,
                host_id=conv.host_id,
                host_store=self.host_store,
            )
            return await asyncio.to_thread(
                self.store.resolve,
                owner_user_id=user_id,
                host_id=conv.host_id,
                target_kind="sandbox" if host.sandbox_provider else "host",
                target_id=conv.host_id,
                generation=host_generation(host),
                root=conv.workspace,
                source_session_id=session_id,
            )
        return await self.create_host(request, conv.host_id, conv.workspace, session_id)

    def runner_connection(self, workspace: WorkbenchWorkspace) -> RunnerSession:
        conn = self.tunnel_registry.get(workspace.target_id) if self.tunnel_registry else None
        if conn is None:
            raise HTTPException(503, "Workspace runner is offline")
        if f"{conn.connected_at}:{conn.generation}" != workspace.generation:
            raise HTTPException(409, "Workspace runner generation changed; resolve again")
        if workspace.owner_user_id is not None and conn.owner != workspace.owner_user_id:
            raise HTTPException(403, "Workspace runner owner changed")
        return conn

    async def runner_request(
        self, runner_id: str, conn: RunnerSession, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        assert self.tunnel_registry is not None
        try:
            async with httpx.AsyncClient(
                transport=WSTunnelTransport(self.tunnel_registry, runner_id),
                base_url="http://runner",
                timeout=30,
            ) as client:
                response = await client.request(
                    method,
                    path,
                    extensions={"runner_tunnel_generation": conn.generation},
                    **kwargs,
                )
        except (httpx.HTTPError, ConnectionError, TimeoutError) as exc:
            raise HTTPException(
                503, "Workspace runner unavailable; operation was not retried"
            ) from exc
        if response.status_code >= 400:
            raise HTTPException(response.status_code, response.text)
        return response

    async def metadata_many(self, workspaces: list[WorkbenchWorkspace]) -> list[dict[str, Any]]:
        """Reuse availability checks for identical targets within one listing."""
        availability: dict[tuple[str | None, str, str, str, str | None], bool] = {}
        result = []
        for workspace in workspaces:
            key = (
                workspace.owner_user_id,
                workspace.target_kind,
                workspace.target_id,
                workspace.generation,
                workspace.host_id,
            )
            if key not in availability:
                availability[key] = await self._available(workspace)
            result.append(self._metadata(workspace, availability[key]))
        return result

    async def _available(self, workspace: WorkbenchWorkspace) -> bool:
        available = False
        try:
            if workspace.target_kind == "runneronly":
                self.runner_connection(workspace)
            else:
                await self.host_connection(workspace)
            available = True
        except HTTPException as exc:
            if exc.status_code not in {403, 404, 409, 503}:
                raise
        return available

    async def metadata(self, workspace: WorkbenchWorkspace) -> dict[str, Any]:
        return self._metadata(workspace, await self._available(workspace))

    @staticmethod
    def _metadata(workspace: WorkbenchWorkspace, available: bool) -> dict[str, Any]:
        return {
            **asdict(workspace),
            "roots": [workspace.root],
            "permission_level": LEVEL_OWNER,
            "available": available,
            "capabilities": ["files", "search", "git", "github"]
            + (["terminals"] if workspace.target_kind in {"host", "sandbox"} else []),
        }
