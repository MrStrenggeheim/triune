# Modified for Triune.
"""A small host adapter over the existing file, search, Git and provider services."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import ntpath
import posixpath
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException, Request, Response
from starlette.responses import StreamingResponse

from omnigent.runner.filesystem_operations import operation_paths
from omnigent.runner.workspace_git import parse_git_directories
from omnigent.server.routes._host_filesystem import (
    HostFsError,
    HostFsUnavailableError,
    read_workspace_from_host,
    write_workspace_from_host,
)
from omnigent.server.routes._workspace_validation import (
    WorkspaceValidationError,
    validate_workspace,
)
from omnigent.server.workbench_workspace_service import WorkbenchWorkspaceService
from omnigent.stores.workbench_workspace_store import WorkbenchWorkspace

_PROVIDER_READS = {
    "": "github_info",
    "changes": "github_changes",
    "diff": "github_pr_diff",
    "labels": "github_labels",
    "merge-options": "github_merge_options",
    "reviewers": "github_reviewers",
}
_PROVIDER_WRITES = {
    ("POST", "prs"): "github_prs_update",
    ("PATCH", "preferences"): "github_set_preference",
    ("POST", "preferences"): "github_set_preference",
    ("POST", "labels"): "github_labels_update",
    ("POST", "reviewers"): "github_reviewers_update",
    ("POST", "comments"): "github_comment_create",
    ("PATCH", "details"): "github_details_update",
    ("POST", "details"): "github_details_update",
    ("POST", "merge"): "github_merge",
    ("POST", "disable-auto-merge"): "github_disable_auto_merge",
    ("POST", "attachments"): "github_attachment_upload",
}


def relative_path(workspace: WorkbenchWorkspace, value: str) -> str:
    """Validate a remote path without resolving it on the server filesystem."""
    if "\x00" in value or len(value) > 8192:
        raise HTTPException(400, "Invalid workspace path")
    windows = bool(ntpath.splitdrive(workspace.root)[0])
    paths = ntpath if windows else posixpath
    if ".." in value.replace("\\", "/").split("/"):
        raise HTTPException(400, "Parent path segments are not permitted")
    if paths.isabs(value):
        try:
            value = paths.relpath(value, workspace.root)
        except ValueError as exc:
            raise HTTPException(403, "Path is outside workspace roots") from exc
        if value == ".." or value.startswith(("../", "..\\")):
            raise HTTPException(403, "Path is outside workspace roots")
    elif ntpath.isabs(value):
        raise HTTPException(403, "Path belongs to another filesystem")
    return "" if value == "." else value


class HostWorkspaceResources:
    def __init__(self, service: WorkbenchWorkspaceService, workspace: WorkbenchWorkspace) -> None:
        self.service = service
        self.workspace = workspace

    async def call(
        self,
        op: str,
        params: dict[str, Any],
        *,
        write: bool = False,
        root: str | None = None,
        namespace: str | None = None,
    ) -> dict[str, Any]:
        conn = await self.service.host_connection(self.workspace)
        operation = write_workspace_from_host if write else read_workspace_from_host
        try:
            result = await operation(
                host_registry=self.service.host_registry,
                host_conn=conn,
                op=op,
                workspace=root or self.workspace.root,
                session_id=namespace or self.workspace.id,
                params=params,
            )
        except HostFsError as exc:
            raise HTTPException(
                exc.status, {"error": {"code": exc.code, "message": exc.message}}
            ) from exc
        except HostFsUnavailableError as exc:
            detail = "Workspace host unavailable"
            if write:
                detail = "Workspace write lost its response; refresh before retrying"
            raise HTTPException(502 if write else 503, detail) from exc
        status = result.get("status")
        if isinstance(status, int) and status >= 400:
            raise HTTPException(
                status, result.get("error") or result.get("detail") or "Workspace operation failed"
            )
        return result

    async def filesystem_operation(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            paths = operation_paths(body)
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        for path, _ in paths:
            relative_path(self.workspace, path)
        clean = {key: value for key, value in body.items() if not key.startswith("_")}
        clean.update(
            _owner=self.workspace.owner_user_id or "local-owner",
            _roots=[{"path": self.workspace.root, "kind": "tree", "access": "write"}],
            _unconfined=False,
        )
        return await self.call("filesystem_operation", clean, write=True)

    async def write_file(self, path: str, content: str) -> dict[str, Any]:
        """Reuse the checked upload protocol, including atomic conflict detection."""
        data = content.encode()
        started = await self.filesystem_operation(
            {"operation": "upload_begin", "path": path, "size": len(data), "overwrite": True}
        )
        upload_id = started["upload_id"]
        for offset in range(0, len(data), 65536):
            await self.filesystem_operation(
                {
                    "operation": "upload_chunk",
                    "path": path,
                    "upload_id": upload_id,
                    "offset": offset,
                    "content_base64": base64.b64encode(data[offset : offset + 65536]).decode(),
                }
            )
        await self.filesystem_operation(
            {"operation": "upload_finish", "path": path, "upload_id": upload_id}
        )
        return {"object": "file_write", "path": path, "bytes_written": len(data)}

    async def download_file(self, path: str, *, max_bytes: int | None = None) -> StreamingResponse:
        """Stream checked raw chunks without the JSON read cap or archive size limit."""
        begun = await self.filesystem_operation({"operation": "download_begin", "paths": [path]})
        download_id = begun["download_id"]
        if max_bytes is not None and begun["size"] > max_bytes:
            await self.filesystem_operation(
                {"operation": "download_cancel", "paths": [path], "download_id": download_id}
            )
            raise HTTPException(413, "Attachment exceeds 50 MB; download it from Files")

        async def chunks():
            offset = 0
            try:
                while offset < begun["size"]:
                    chunk = await self.filesystem_operation(
                        {
                            "operation": "download_read",
                            "paths": [path],
                            "download_id": download_id,
                            "offset": offset,
                        }
                    )
                    try:
                        data = base64.b64decode(chunk["content_base64"], validate=True)
                    except (KeyError, TypeError, ValueError) as exc:
                        raise HTTPException(
                            502, "Workspace download returned an invalid chunk"
                        ) from exc
                    if not data or offset + len(data) > begun["size"]:
                        raise HTTPException(502, "Workspace download returned an invalid chunk")
                    offset += len(data)
                    yield data
            finally:
                try:
                    await self.filesystem_operation(
                        {
                            "operation": "download_cancel",
                            "paths": [path],
                            "download_id": download_id,
                        }
                    )
                except HTTPException:
                    logging.getLogger(__name__).warning("Workspace download cleanup failed")

        return StreamingResponse(
            chunks(),
            media_type="application/octet-stream",
            headers={
                "Content-Length": str(begun["size"]),
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(posixpath.basename(path), safe=""),
            },
        )

    async def dispatch(self, request: Request, resource: str, body: dict[str, Any]) -> Any:
        query: dict[str, Any] = dict(request.query_params)
        method = request.method
        if resource.startswith("github"):
            folder = relative_path(self.workspace, str(query.pop("folder", "")))
            root = None
            if folder:
                if self.workspace.host_id is None:
                    raise HTTPException(409, "Workspace has no host filesystem target")
                paths = ntpath if ntpath.splitdrive(self.workspace.root)[0] else posixpath
                try:
                    root = await validate_workspace(
                        host_registry=self.service.host_registry,
                        host_id=self.workspace.host_id,
                        workspace=paths.join(self.workspace.root, folder),
                        spec_cwd=self.workspace.root,
                    )
                except WorkspaceValidationError as exc:
                    raise HTTPException(400, exc.message) from exc
            namespace = (
                self.workspace.id + ":" + hashlib.sha256(root.encode()).hexdigest()[:16]
                if root
                else None
            )
            suffix = resource.removeprefix("github").strip("/")
            if method == "GET":
                op = _PROVIDER_READS.get(suffix)
                if suffix.startswith("diff/"):
                    op = "github_diff"
                    query["path"] = relative_path(self.workspace, suffix[5:])
                if op:
                    return await self.call(op, query, root=root, namespace=namespace)
            op = _PROVIDER_WRITES.get((method, suffix))
            if op:
                return await self.call(
                    op, {**query, **body}, write=True, root=root, namespace=namespace
                )
            raise HTTPException(404, "Workspace provider operation is unsupported")
        if resource == "environments" and method == "GET":
            return {"object": "list", "data": [await self.environment()], "has_more": False}
        parts = resource.split("/", 3)
        if len(parts) < 2 or parts[0] != "environments" or parts[1] != "default":
            raise HTTPException(404, "Workspace resource not found")
        if len(parts) == 2:
            if method != "GET":
                raise HTTPException(405, "Workspace environment metadata is read-only")
            return await self.environment()
        kind = parts[2]
        path = parts[3] if len(parts) > 3 else ""
        if query.get("base") == "host" and kind in {"filesystem", "search"}:
            path = "/" + path.lstrip("/")
        path = relative_path(self.workspace, path)
        if kind == "filesystem":
            if method == "GET":
                if query.get("download") == "true":
                    return await self.download_file(path)
                return await self.call("list_or_read", {**query, "path": path})
            if method == "PUT":
                if not isinstance(body.get("content"), str):
                    raise HTTPException(400, "Expected text content")
                return await self.write_file(path, body["content"])
            if method == "PATCH":
                result = await self.filesystem_operation(
                    {**body, "operation": "edit_file", "path": path}
                )
                return {
                    **result,
                    "object": "session.environment.filesystem.edit_result",
                    "operation": "edit",
                    "path": path,
                }
            if method == "DELETE":
                return await self.filesystem_operation(
                    {
                        "operation": "delete",
                        "paths": [path],
                        "recursive": query.get("recursive") == "true",
                    }
                )
        if kind == "filesystem-operations" and method == "POST":
            return await self.filesystem_operation(body)
        if kind in {"search", "content-search"} and method == "GET":
            q = query.get("q", "")
            if not q.strip() or len(q) > 4096:
                raise HTTPException(400, "Expected a search query of 1–4096 characters")
            try:
                query["limit"] = min(500, max(1, int(query.get("limit", 500))))
            except ValueError as exc:
                raise HTTPException(400, "Invalid search limit") from exc
            if kind == "content-search":
                path = relative_path(self.workspace, str(query.get("path", "")))
                query.update(query=q, path_prefix=path)
                for flag in ("case_sensitive", "regex", "whole_word", "use_ignore"):
                    query[flag] = (
                        query.get(flag, "true" if flag == "use_ignore" else "false") == "true"
                    )
            root = posixpath.join(self.workspace.root, path) if path else self.workspace.root
            return await self.call(
                "search" if kind == "search" else "content_search", query, root=root
            )
        if kind == "content-replace" and method == "POST":
            body = {key: value for key, value in body.items() if not key.startswith("_")}
            path = relative_path(self.workspace, str(body.get("path", "")))
            body["_actor"] = self.workspace.owner_user_id or "local-owner"
            root = posixpath.join(self.workspace.root, path) if path else self.workspace.root
            return await self.call("content_replace", body, write=True, root=root)
        if kind == "git" and method == "GET":
            try:
                directories = json.loads(query.get("directories", "[]"))
                if not isinstance(directories, list) or not all(
                    isinstance(item, str) for item in directories
                ):
                    raise ValueError("Expected directory paths")
            except (ValueError, TypeError) as exc:
                raise HTTPException(400, "Invalid Git directories") from exc
            query["directories"] = [relative_path(self.workspace, item) for item in directories]
            for key in ("path", "scope", "folder"):
                if key in query:
                    query[key] = relative_path(self.workspace, query[key])
            return await self.call("git_inspect", query)
        if kind == "changes" and method == "GET":
            return await self.call("git_inspect", {"operation": "changes", **query})
        if kind == "diff" and method == "GET":
            return await self.call("git_inspect", {"operation": "diff", **query, "path": path})
        raise HTTPException(404, "Workspace operation is unsupported")

    async def environment(self) -> dict[str, Any]:
        return {
            "id": "default",
            "object": "environment",
            "type": "environment",
            "workspace": self.workspace.root,
            "metadata": {
                "cwd": self.workspace.root,
                "available": (await self.service.metadata(self.workspace))["available"],
                "root": self.workspace.root,
                "reachable": {
                    "roots": [
                        {
                            "path": self.workspace.root,
                            "kind": "tree",
                            "access": "write",
                            "origin": "cwd",
                        }
                    ],
                    "unconfined": False,
                },
                "workspace_id": self.workspace.id,
                "reachable_roots": [
                    {"path": self.workspace.root, "kind": "tree", "access": "write"}
                ],
                "unconfined": False,
            },
        }


class RunnerWorkspaceResources:
    """Reach only the pinned source environment; never select a chat or another runner."""

    def __init__(self, service: WorkbenchWorkspaceService, workspace: WorkbenchWorkspace) -> None:
        self.service = service
        self.workspace = workspace

    async def dispatch(self, request: Request, resource: str, body: dict[str, Any]) -> Response:
        source = self.workspace.source_environment_id
        if not source or not source.endswith("/default"):
            raise HTTPException(409, "Workspace has no pinned environment source")
        # Only resource kinds implemented by this boundary can cross the runner tunnel.
        parts = resource.split("/", 3)
        environment = parts[:2] == ["environments", "default"]
        kind = parts[2] if len(parts) > 2 else ""
        allowed = {
            "filesystem",
            "filesystem-operations",
            "content-search",
            "content-replace",
            "search",
            "git",
            "changes",
            "diff",
        }
        if not (
            resource == "environments"
            or (environment and (kind in allowed or len(parts) == 2))
            or resource == "github"
            or resource.startswith("github/")
        ):
            raise HTTPException(404, "Workspace operation is unsupported")
        conn = self.service.runner_connection(self.workspace)
        session_id = source.removesuffix("/default")
        prefix = f"/v1/sessions/{quote(session_id, safe='')}/resources/"
        before = await self.service.runner_request(
            self.workspace.target_id, conn, "GET", prefix + "environments/default"
        )
        if before.json().get("metadata", {}).get("root") != self.workspace.root:
            raise HTTPException(409, "Workspace source filesystem changed; resolve again")
        # Strip internal transport grants; workspace authorization supplies the actor.
        body = {key: value for key, value in body.items() if not key.startswith("_")}
        if kind == "filesystem-operations":
            for path, _ in operation_paths(body):
                relative_path(self.workspace, path)
            body["_owner"] = self.workspace.owner_user_id or "local-owner"
        for key in ("path", "scope", "folder"):
            if key in request.query_params:
                relative_path(self.workspace, request.query_params[key])
        if "directories" in request.query_params:
            try:
                for directory in parse_git_directories(request.query_params["directories"]):
                    relative_path(self.workspace, directory)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        if kind == "content-replace":
            relative_path(self.workspace, str(body.get("path", "")))
            body["_actor"] = self.workspace.owner_user_id or "local-owner"
        if len(parts) > 3 and kind in {"filesystem", "search", "diff"}:
            relative_path(self.workspace, parts[3])
        params = dict(request.query_params)
        if request.query_params.get("base") == "host":
            raise HTTPException(403, "Runner workspaces are confined to their original root")
        payload: dict[str, Any] = (
            {"json": body} if request.method in {"PUT", "POST", "PATCH"} else {}
        )
        if resource == "github/attachments" and request.method == "POST":
            payload = {
                "data": {"pr_url": body["pr_url"]},
                "files": {"file": (body["name"], base64.b64decode(body["content_base64"]))},
            }
        response = await self.service.runner_request(
            self.workspace.target_id,
            conn,
            request.method,
            prefix + quote(resource, safe="/"),
            params=params,
            **payload,
        )
        return Response(
            response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "application/json"),
        )
