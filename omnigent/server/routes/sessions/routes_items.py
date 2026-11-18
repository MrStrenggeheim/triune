# Modified for Triune.

"""Items and child-session routes."""

from __future__ import annotations

import asyncio
import hashlib

from fastapi import (
    APIRouter,
    Query,
    Request,
)
from fastapi.responses import StreamingResponse

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runtime.policies.approval import _ELICITATION_MODE
from omnigent.server._elicitation_registry import (
    _harness_elicitation_owners,
    _harness_elicitation_registry,
    _harness_parked_elicitations,
    _harness_pre_resolved_elicitations,
    _ParkedHarnessElicitation,
    _PreResolvedHarnessElicitation,
)
from omnigent.server.auth import (
    LEVEL_READ,
    AuthProvider,
)
from omnigent.server.background_session_titles import (
    BackgroundSessionTitleCoordinator,
    background_session_titles_enabled,
)
from omnigent.server.routes._auth_helpers import (
    get_user_id as _get_user_id,
)
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.server.routes._errors import (
    STALE_CURSOR_RESPONSE,
)
from omnigent.server.routes._errors import session_not_found as _session_not_found
from omnigent.server.routes._sessions.common import (
    get_server_runner_router,
    set_server_runner_router,
)
from omnigent.server.routes._sessions.orchestration import (
    _child_session_summaries_from_conversations,
    _schedule_missing_child_task_summaries,
)
from omnigent.server.schemas import (
    ChildSessionList,
    PaginatedList,
)
from omnigent.server.session_recovery import saved_item_bytes
from omnigent.server.subagent_activity import recover_subagent_activity
from omnigent.stores import AgentStore, ConversationStore
from omnigent.stores.permission_store import PermissionStore


def register_items_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    agent_store: AgentStore,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
    background_title_coordinator: BackgroundSessionTitleCoordinator | None = None,
) -> None:
    """Register the items routes on router."""
    from .context_references import register_context_reference_routes

    register_context_reference_routes(
        router,
        conversation_store=conversation_store,
        auth_provider=auth_provider,
        permission_store=permission_store,
    )

    @router.get(
        "/sessions/{session_id}/items",
        response_model=None,
        responses={200: {"model": PaginatedList}, **STALE_CURSOR_RESPONSE},
    )
    async def list_session_items(
        request: Request,
        session_id: str,
        limit: int = Query(default=100, ge=1, le=1000),
        after: str | None = Query(default=None),
        before: str | None = Query(default=None),
        order: str = Query(default="asc", pattern="^(asc|desc)$"),
    ) -> PaginatedList:
        """
        List items in a session with cursor-based pagination.

        Delegates to the conversation items store — session_id is
        the conversation_id. Same pagination contract as
        ``GET /v1/conversations/{id}/items``.

        :param session_id: Session/conversation identifier,
            e.g. ``"conv_abc123"``.
        :param limit: Maximum number of items to return
            (1-1000, default 100).
        :param after: Cursor — return items after this item ID,
            e.g. ``"msg_abc123"``.
        :param before: Cursor — return items before this item ID.
        :param order: Sort order, ``"asc"`` (chronological,
            default) or ``"desc"``.
        :returns: A :class:`PaginatedList` of conversation items.
        :raises OmnigentError: 404 if no session exists.
        """
        user_id = _get_user_id(request, auth_provider)
        access = await _require_access_and_level(
            user_id, session_id, LEVEL_READ, permission_store, conversation_store
        )
        if access.conversation is None:
            conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
            if conv is None:
                raise _session_not_found()
        page = await asyncio.to_thread(
            conversation_store.list_items,
            session_id,
            limit=limit,
            after=after,
            before=before,
            order=order,
        )

        async def can_read(source_id: str) -> bool:
            try:
                await _require_access_and_level(
                    user_id, source_id, LEVEL_READ, permission_store, conversation_store
                )
                return True
            except OmnigentError as exc:
                if exc.code in {ErrorCode.FORBIDDEN, ErrorCode.NOT_FOUND}:
                    return False
                raise

        items = await recover_subagent_activity(
            session_id, page.data, conversation_store, can_read
        )
        data = [m.to_api_dict() for m in items]
        return PaginatedList(
            data=data,
            first_id=page.first_id,
            last_id=page.last_id,
            has_more=page.has_more,
        )

    @router.get(
        "/sessions/{session_id}/items/{item_id}/stream-content",
        response_model=None,
        responses={
            200: {
                "description": "Digest-verified JSON body for the advertised saved item.",
                "headers": {"ETag": {"schema": {"type": "string"}}},
            },
            409: {"description": "The advertised position or representation changed."},
        },
    )
    async def get_stream_item_content(
        request: Request,
        session_id: str,
        item_id: str,
        position: int = Query(ge=0),
        sha256: str = Query(pattern=r"^[0-9a-f]{64}$"),
        consumed: bool = False,
    ) -> StreamingResponse:
        """Read the exact authorized representation advertised to a transcript subscriber."""
        user_id = _get_user_id(request, auth_provider)

        async def authorize(source_id: str) -> None:
            await _require_access_and_level(
                user_id, source_id, LEVEL_READ, permission_store, conversation_store
            )

        await authorize(session_id)
        saved = await asyncio.to_thread(conversation_store.get_item, session_id, item_id)
        if saved is None or saved.position != position:
            raise OmnigentError("Saved item changed", code=ErrorCode.CONFLICT)
        sources = {session_id}

        async def can_read(source_id: str) -> bool:
            try:
                await authorize(source_id)
            except OmnigentError as exc:
                if exc.code in {ErrorCode.FORBIDDEN, ErrorCode.NOT_FOUND}:
                    return False
                raise
            sources.add(source_id)
            return True

        if consumed:
            body = saved_item_bytes(saved.data.model_dump())
        else:
            # A page may exhaust its optional enrichment budget and advertise the stored row.
            body = saved_item_bytes(saved.to_api_dict())
            if hashlib.sha256(body).hexdigest() != sha256:
                [projected] = await recover_subagent_activity(
                    session_id, [saved], conversation_store, can_read
                )
                body = saved_item_bytes(projected.to_api_dict())
        if hashlib.sha256(body).hexdigest() != sha256:
            raise OmnigentError("Saved item changed", code=ErrorCode.CONFLICT)
        for source_id in sources:
            await authorize(source_id)

        async def chunks():
            for start in range(0, len(body), 65536):
                yield body[start : start + 65536]

        return StreamingResponse(
            chunks(),
            media_type="application/json",
            headers={
                "Cache-Control": "no-store",
                "ETag": f'"{sha256}"',
                "Content-Length": str(len(body)),
                "Access-Control-Expose-Headers": "ETag",
            },
        )

    # ── GET /sessions/{session_id}/child_sessions ────────────────

    @router.get(
        "/sessions/{session_id}/child_sessions",
        response_model=None,
        responses={200: {"model": ChildSessionList}, **STALE_CURSOR_RESPONSE},
    )
    async def list_child_sessions(
        request: Request,
        session_id: str,
        limit: int = Query(default=20, ge=1, le=1000),
        after: str | None = Query(default=None),
        before: str | None = Query(default=None),
        order: str = Query(default="desc", pattern="^(asc|desc)$"),
        tool: str | None = Query(default=None),
        session_name: str | None = Query(default=None),
    ) -> PaginatedList:
        """
        List sub-agent (child) sessions under a parent session.

        Returns a page of :class:`ChildSessionSummary` objects
        derived from child conversations (``kind="sub_agent"``,
        ``parent_conversation_id=session_id``) plus each child's
        latest task. Powers the web / REPL debug surfaces' "child
        sessions" panel without parsing parent
        ``function_call_output`` JSON handles. Pagination contract
        matches :func:`list_session_items` so existing client code
        can reuse the same cursor logic.

        :param request: Inbound HTTP request; carries the caller
            identity used to authorize READ on the parent session.
        :param session_id: Parent session/conversation identifier,
            e.g. ``"conv_abc123"``.
        :param limit: Maximum number of children to return
            (1-1000, default 20 — sub-agent fan-out is typically
            sparse compared to conversation items).
        :param after: Cursor — return children whose id appears
            after this one in sort order,
            e.g. ``"conv_child123"``.
        :param before: Cursor — return children before this one.
        :param order: Sort direction, ``"desc"`` (newest-first,
            default) or ``"asc"``. Sort column is ``created_at``.
        :param tool: When set, only return children whose title
            starts with this agent type (the segment before the
            ``":"``). Combined with ``session_name`` to form the
            exact title ``"{tool}:{session_name}"`` for server-side
            filtering.
        :param session_name: When set alongside ``tool``, only
            return children whose title matches
            ``"{tool}:{session_name}"`` exactly.
        :returns: A :class:`PaginatedList` of
            :class:`ChildSessionSummary` objects.
        :raises OmnigentError: 403 if the caller lacks READ on
            ``session_id``; 404 if no session exists there.
        """
        user_id = _get_user_id(request, auth_provider)
        # Require READ on the parent before listing its children (no cross-user enumeration).
        access = await _require_access_and_level(
            user_id, session_id, LEVEL_READ, permission_store, conversation_store
        )
        parent = access.conversation
        if parent is None:
            parent = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if parent is None:
            raise _session_not_found()
        title_filter: str | None = None
        if tool and session_name:
            title_filter = f"{tool}:{session_name}"
        page = await asyncio.to_thread(
            conversation_store.list_conversations,
            limit=limit,
            after=after,
            before=before,
            kind="sub_agent",
            parent_conversation_id=session_id,
            order=order,
            sort_by="created_at",
            title=title_filter,
        )

        async def can_read_child(child_id: str) -> bool:
            try:
                await _require_access_and_level(
                    user_id, child_id, LEVEL_READ, permission_store, conversation_store
                )
                return True
            except OmnigentError as exc:
                if exc.code in {ErrorCode.FORBIDDEN, ErrorCode.NOT_FOUND}:
                    return False
                raise

        if background_session_titles_enabled(request.headers):
            await _schedule_missing_child_task_summaries(
                page.data, conversation_store, background_title_coordinator, can_read_child
            )
        data = await _child_session_summaries_from_conversations(
            page.data,
            session_id,
            conversation_store,
        )
        return PaginatedList(
            data=data,
            first_id=page.first_id,
            last_id=page.last_id,
            has_more=page.has_more,
        )
