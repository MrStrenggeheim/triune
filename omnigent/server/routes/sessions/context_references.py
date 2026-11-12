"""Read-only, bounded cross-chat snapshots; capturing never starts a runner."""

from __future__ import annotations

# Modified for Triune.
import asyncio
import hashlib
import json
import time
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from omnigent.errors import OmnigentError
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ
from omnigent.server.routes._auth_helpers import require_access_and_level, require_user
from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID
from omnigent.util.uuid import InvalidUuidError, normalize_uuid, uuid_to_bytes

MAX_REFERENCE_ITEMS = 500
MAX_REFERENCE_BYTES = 128_000
REFERENCE_START = "[Chat context snapshot]\n"
REFERENCE_END = "\n[/Chat context snapshot]"


class CaptureReference(BaseModel):
    destination_id: str | None = Field(default=None, min_length=1, max_length=128)
    scope: Literal["whole", "last_answer", "messages", "quote"]
    boundary_id: str | None = Field(default=None, max_length=128)
    message_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        default_factory=list, max_length=100
    )
    quote: str | None = Field(default=None, max_length=32_000)


def capture_items(
    store: Any, source_id: str, capture: CaptureReference, *, active_response_id: str | None = None
) -> list[dict[str, Any]]:
    """Freeze a concrete boundary and reject incomplete/oversized projections."""
    items: list[dict[str, Any]] = []
    boundary_id = normalize_uuid(capture.boundary_id)
    boundary_found = boundary_id is None
    last_response = None
    incomplete_responses: set[str] = {active_response_id} if active_response_id else set()
    selected = {normalize_uuid(item_id) or item_id for item_id in capture.message_ids}
    if capture.scope == "messages" and not selected:
        raise HTTPException(400, "Choose at least one message")
    if capture.scope == "quote" and (not capture.quote or not capture.quote.strip()):
        raise HTTPException(400, "Select text to quote")
    targets = selected or ({boundary_id} if boundary_id else set())
    if capture.scope == "quote" and not targets:
        raise HTTPException(400, "Choose a source message")
    # Point lookups and cursors are scoped to the authorized conversation.
    # Seek old item boundaries directly instead of scanning newer history.
    anchor_id = boundary_id
    if anchor_id is None and capture.scope in ("messages", "quote") and len(targets) == 1:
        anchor_id = next(iter(targets))

    def lookup_item(item_id: str):
        try:
            uuid_to_bytes(item_id)
        except InvalidUuidError:
            # Response ids can be arbitrary strings; item ids are UUIDs.
            return None
        stored = store.get_item(source_id, item_id)
        return (
            stored
            if stored is not None and stored.response_id != PENDING_INPUT_RESPONSE_ID
            else None
        )

    anchor = lookup_item(anchor_id) if anchor_id else None
    response_targets = {target for target in targets if lookup_item(target) is None}
    found: set[str] = set()

    def history():
        cursor = None
        if anchor is not None:
            yield [anchor]
            cursor = anchor.id
        for _ in range(100):
            page = store.list_items(source_id, limit=100, after=cursor, order="desc")
            yield page.data
            if not page.has_more:
                return
            cursor = page.last_id
        raise HTTPException(
            413, "History scan limit reached. Choose a more recent source boundary."
        )

    complete = False
    size = 0
    for batch in history():
        for stored in batch:
            item = stored.to_api_dict()
            if not boundary_found:
                boundary_found = boundary_id in (item["id"], item["response_id"])
                if not boundary_found:
                    continue
            if (
                capture.scope in ("messages", "quote")
                and targets <= found
                and item["response_id"] not in response_targets
            ):
                complete = True
                break
            if capture.scope == "last_answer":
                if item.get("interrupted") or item["status"] in (
                    "in_progress",
                    "incomplete",
                    "failed",
                ):
                    incomplete_responses.add(item["response_id"])
                completed = (
                    item.get("role") == "assistant"
                    and item["status"] == "completed"
                    and not item.get("interrupted")
                    and not item.get("is_meta")
                    and item["response_id"] not in incomplete_responses
                )
                if last_response is None:
                    if not completed:
                        continue
                    last_response = item["response_id"]
                if item["response_id"] != last_response:
                    return list(reversed(items))
                if not completed:
                    continue
            elif capture.scope in ("messages", "quote"):
                if not targets.intersection((item["id"], item["response_id"])):
                    continue
            if capture.scope != "quote" and any(
                not isinstance(block.get("text", block.get("refusal")), str)
                for block in item.get("content", [])
            ):
                raise HTTPException(
                    422,
                    "This context contains media or file attachments that cannot be copied as text. "
                    "Choose text messages or quote selected text, and attach original files explicitly.",
                )
            if capture.scope == "quote":
                item = {key: value for key, value in item.items() if key != "content"}
            encoded = json.dumps(item, ensure_ascii=False)
            size += len(encoded.encode())
            items.append(item)
            found.update((item["id"], item["response_id"]))
            if len(items) > MAX_REFERENCE_ITEMS or size > MAX_REFERENCE_BYTES:
                raise HTTPException(
                    413,
                    "Context is too large. Choose messages or Last completed answer; nothing was summarized.",
                )
            if (
                capture.scope in ("messages", "quote")
                and targets <= found
                and not response_targets
            ):
                complete = True
                break
        if complete:
            break
    if not boundary_found:
        raise HTTPException(409, "Source boundary is no longer available")
    found = {key for item in items for key in (item["id"], item["response_id"])}
    if selected - found:
        raise HTTPException(409, "A selected message is no longer available")
    if not items:
        raise HTTPException(409, "No completed content is available for this scope")
    return list(reversed(items))


def register_context_reference_routes(
    router: APIRouter, *, conversation_store: Any, auth_provider: Any, permission_store: Any
) -> None:
    async def authorize(request: Request, source: str, destination: str | None):
        user = require_user(request, auth_provider)
        source_access = await require_access_and_level(
            user, source, LEVEL_READ, permission_store, conversation_store
        )
        if destination is not None:
            destination_access = await require_access_and_level(
                user, destination, LEVEL_EDIT, permission_store, conversation_store
            )
            if (
                destination_access.conversation is None
                and await asyncio.to_thread(conversation_store.get_conversation, destination)
                is None
            ):
                raise HTTPException(404, "Destination conversation not found")
        conv = source_access.conversation or await asyncio.to_thread(
            conversation_store.get_conversation, source
        )
        if conv is None:
            raise HTTPException(404, "Source conversation not found")
        return conv

    @router.get("/context-references/chats")
    async def reference_chats(
        request: Request,
        query: str = Query(default="", max_length=200),
        after: str | None = None,
        writable: bool = False,
        messages: bool = False,
    ):
        user = require_user(request, auth_provider)
        page = await asyncio.to_thread(
            conversation_store.list_conversations,
            limit=50,
            after=after,
            kind=None,
            accessible_by=user,
            search_query=None if messages else query or None,
            search_scope="title",
            sort_by="updated_at",
            order="desc",
        )
        rows = []
        for conv in page.data:
            try:
                await require_access_and_level(
                    user,
                    conv.id,
                    LEVEL_EDIT if writable else LEVEL_READ,
                    permission_store,
                    conversation_store,
                )
            except OmnigentError:
                continue
            row = {
                "id": conv.id,
                "title": conv.title or "Untitled",
                "parent_id": conv.parent_conversation_id,
            }
            if messages and query:
                hits = await asyncio.to_thread(
                    conversation_store.search_messages,
                    query,
                    conversation_id=conv.id,
                    accessible_by=user,
                    limit=5,
                )
                rows.extend(
                    {**row, "message_id": hit.item_id, "snippet": hit.snippet} for hit in hits.data
                )
            else:
                rows.append(row)
        return {"data": rows, "has_more": page.has_more, "next_cursor": page.last_id}

    @router.post("/sessions/{source_id}/context-reference")
    async def capture_reference(request: Request, source_id: str, body: CaptureReference):
        conv = await authorize(request, source_id, body.destination_id)
        from omnigent.server.routes._sessions.common import _session_active_response_cache

        items = await asyncio.to_thread(
            capture_items,
            conversation_store,
            source_id,
            body,
            active_response_id=_session_active_response_cache.get(source_id),
        )
        snapshot = {
            "version": 1,
            "source_id": source_id,
            "source_title": conv.title or "Untitled",
            "destination_id": body.destination_id,
            "scope": body.scope,
            "boundary_id": items[-1]["id"],
            "captured_at": int(time.time()),
            "items": items,
            "quote": body.quote if body.scope == "quote" else None,
            "audience": "The copied content will be visible to everyone with access to the destination chat, including future participants. Source permissions do not transfer.",
            "representation": "Exact stored items as JSON; media and file blocks are metadata, not attached bytes.",
        }
        encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode()
        if len(encoded) > MAX_REFERENCE_BYTES:
            raise HTTPException(
                413, "Context is too large. Choose fewer messages; nothing was summarized."
            )
        snapshot["snapshot_id"] = hashlib.sha256(encoded).hexdigest()
        return snapshot

    @router.post("/sessions/{source_id}/context-reference/check")
    async def check_reference(request: Request, source_id: str, body: CaptureReference):
        await authorize(request, source_id, body.destination_id)
        return {"ok": True}


async def validate_context_references(
    data: dict[str, Any],
    *,
    user_id: str | None,
    destination_id: str,
    conversation_store: Any,
    permission_store: Any,
) -> None:
    """Recheck copied source access at submission, including queued/replayed input."""
    count = 0
    total_bytes = 0
    for block in data.get("content", []):
        if not isinstance(block, dict):
            continue
        text = block.get("text", "")
        if not isinstance(text, str) or REFERENCE_START not in text:
            continue
        if len(text.encode()) > MAX_REFERENCE_BYTES * 8:
            raise HTTPException(413, "Combined references are too large")
        parts = text.split(REFERENCE_START)[1:]
        count += len(parts)
        total_bytes += len(text.encode())
        if count > 8 or total_bytes > MAX_REFERENCE_BYTES * 8:
            raise HTTPException(413, "Use at most eight chat references per message")
        for part in parts:
            payload, delimiter, _ = part.partition(REFERENCE_END)
            if not delimiter or len(payload.encode()) > MAX_REFERENCE_BYTES + 100:
                raise HTTPException(400, "Invalid context snapshot")
            try:
                snapshot = json.loads(payload)
                source_id = snapshot["source_id"]
                if not isinstance(source_id, str) or snapshot.get("version") != 1:
                    raise ValueError("Invalid source")
            except (ValueError, KeyError, TypeError) as exc:
                raise HTTPException(400, "Invalid context snapshot") from exc
            source_access = await require_access_and_level(
                user_id, source_id, LEVEL_READ, permission_store, conversation_store
            )
            if (
                source_access.conversation is None
                and await asyncio.to_thread(conversation_store.get_conversation, source_id) is None
            ):
                raise HTTPException(404, "Source conversation not found")
            await require_access_and_level(
                user_id, destination_id, LEVEL_EDIT, permission_store, conversation_store
            )
