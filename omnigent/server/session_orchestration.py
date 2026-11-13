"""Owner-authorized orchestration from private sessions using existing delivery."""

# Modified for Triune.

from typing import Any

from fastapi import Request

from omnigent.db.db_models import normalize_uuid
from omnigent.entities import Conversation, ConversationItem, MessageData, NewConversationItem
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.identity import (
    ORCHESTRATION_SOURCE_HEADER,
    RUNNER_TUNNEL_TOKEN_HEADER,
    token_bound_runner_id,
)
from omnigent.server.auth import LEVEL_OWNER
from omnigent.server.feature_flags import Feature
from omnigent.server.schemas import SessionStartupInput
from omnigent.stores.conversation_store import (
    SCHEDULED_TASK_ORIGIN_LABEL_KEY,
    SIDE_CHAT_LABEL_KEY,
    SIDE_CHAT_SOURCE_LABEL_KEY,
    ConversationStore,
)
from omnigent.stores.orchestration_preference_store import OrchestrationPreferenceStore
from omnigent.stores.permission_store import PermissionStore
from omnigent.util.session_lifecycle import is_session_closed


def require_owned_session(
    identifier: str,
    user_id: str,
    conversations: ConversationStore,
    permissions: PermissionStore,
    *,
    private: bool = False,
) -> Conversation:
    """Resolve actual ownership and inherited sharing, without administrator bypass."""
    session_id = normalize_uuid(identifier)
    session = conversations.get_conversation(session_id) if session_id else None
    current, seen = session, set()
    while current is not None:
        if current.id in seen or len(seen) >= 32 or current.archived:
            break
        if is_session_closed(current.labels, current.title):
            break
        if private and SCHEDULED_TASK_ORIGIN_LABEL_KEY in (current.labels or {}):
            raise OmnigentError(
                "Scheduled sessions cannot send messages or launch independent sessions",
                code=ErrorCode.FORBIDDEN,
            )
        seen.add(current.id)
        if current.parent_conversation_id is not None:
            current = conversations.get_conversation(current.parent_conversation_id)
            continue
        grant = permissions.get(user_id, current.id)
        if grant is None or grant.level != LEVEL_OWNER:
            break
        if private:
            # Child access comes from the root, including public/read-only grants.
            grants, cursor = permissions.list_for_session(current.id, limit=2)
            if cursor is not None or any(g.user_id != user_id for g in grants):
                raise OmnigentError(
                    "Shared sessions cannot send messages or launch independent sessions",
                    code=ErrorCode.FORBIDDEN,
                )
            if current.labels.get(SIDE_CHAT_LABEL_KEY) == "1":
                # Side chats keep their own grants but inherit source restrictions.
                source_id = current.labels.get(SIDE_CHAT_SOURCE_LABEL_KEY)
                current = conversations.get_conversation(source_id) if source_id else None
                continue
        assert session is not None
        return session
    raise OmnigentError("Session is not owned or available", code=ErrorCode.FORBIDDEN)


def require_orchestration_source(
    request: Request,
    user_id: str | None,
    conversations: ConversationStore,
    permissions: PermissionStore | None,
    *,
    target_id: str | None = None,
) -> Conversation:
    """Check the bound runner, private sender and optional same-owner destination."""
    if not request.app.state.feature_flags.enabled(Feature.SESSION_ORCHESTRATION):
        raise OmnigentError("Session orchestration is disabled", code=ErrorCode.FORBIDDEN)
    if not user_id or permissions is None:
        raise OmnigentError("Session orchestration requires ownership", code=ErrorCode.FORBIDDEN)
    preference_store: OrchestrationPreferenceStore | None = getattr(
        request.app.state, "orchestration_preference_store", None
    )
    if preference_store is not None and not preference_store.get_enabled(user_id=user_id):
        raise OmnigentError(
            "Session orchestration is disabled for this user", code=ErrorCode.FORBIDDEN
        )
    source = require_owned_session(
        request.headers.get(ORCHESTRATION_SOURCE_HEADER, ""),
        user_id,
        conversations,
        permissions,
        private=True,
    )
    token = (request.headers.get(RUNNER_TUNNEL_TOKEN_HEADER) or "").strip()
    if not token or not source.runner_id or token_bound_runner_id(token) != source.runner_id:
        raise OmnigentError(
            "Session orchestration requires the sender's bound runner", code=ErrorCode.FORBIDDEN
        )
    if target_id is not None:
        target = require_owned_session(target_id, user_id, conversations, permissions)
        if source.id == target.id:
            raise OmnigentError("Choose another session", code=ErrorCode.INVALID_INPUT)
    return source


PEER_STOP_LABEL = "omnigent.peer_messages.stopped"


def require_peer_replay(
    source_id: str,
    target_id: str,
    user_id: str | None,
    conversations: ConversationStore,
    permissions: PermissionStore | None,
) -> Conversation:
    """Recheck saved sender and destination authority before delayed delivery."""
    if not user_id or permissions is None:
        raise OmnigentError("Peer delivery requires ownership", code=ErrorCode.FORBIDDEN)
    source = require_owned_session(source_id, user_id, conversations, permissions, private=True)
    target = require_owned_session(target_id, user_id, conversations, permissions)
    if source.labels.get(PEER_STOP_LABEL) == "1" or target.labels.get(PEER_STOP_LABEL) == "1":
        raise OmnigentError(
            "Peer delivery is stopped; human input must resume the session",
            code=ErrorCode.CONFLICT,
        )
    return source


def _peer_message_input(
    source: Conversation,
    destination_id: str,
    data: dict[str, Any],
    conversations: ConversationStore,
) -> SessionStartupInput:
    """Build provenance exclusively from the authenticated source and saved reply."""
    import time
    from uuid import uuid4

    from omnigent.entities.communication import MessageCommunication
    from omnigent.entities.conversation import MessageData

    message = data.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > 8000:
        raise OmnigentError("Provide a message of 1–8000 characters", code=ErrorCode.INVALID_INPUT)
    identifier = data.get("message_id", uuid4().hex)
    message_id = normalize_uuid(identifier) if isinstance(identifier, str) else None
    if not message_id:
        raise OmnigentError("message_id must be a UUID", code=ErrorCode.INVALID_INPUT)
    reply_id = data.get("reply_to_message_id")
    task_id = data.get("task_id")
    for value in (reply_id, task_id):
        if value is not None and (not isinstance(value, str) or not value or len(value) > 256):
            raise OmnigentError("Invalid reply/task correlation", code=ErrorCode.INVALID_INPUT)
    hop_count = 0
    if reply_id is not None:
        reply = conversations.get_item(source.id, reply_id)
        origin = (
            reply.data.communication if reply and isinstance(reply.data, MessageData) else None
        )
        if origin is None or origin.source_conversation_id != destination_id:
            raise OmnigentError(
                "Reply must address the source of a received message", code=ErrorCode.INVALID_INPUT
            )
        hop_count = origin.hop_count + 1
        if hop_count > 16:
            raise OmnigentError("Peer reply hop limit reached", code=ErrorCode.CONFLICT)
    metadata = MessageCommunication(
        kind="peer",
        message_id=message_id,
        source_conversation_id=source.id,
        source_agent_id=source.agent_id,
        source_title=None,
        destination_conversation_id=destination_id,
        sent_at=int(time.time()),
        reply_to_message_id=reply_id,
        task_id=task_id,
        delivery_state="queued",
        receipt="accepted",
        hop_count=hop_count,
    )
    return SessionStartupInput(
        type="message",
        data={
            "role": "user",
            "content": [{"type": "input_text", "text": message}],
            "stable_id": message_id,
            "communication": metadata.model_dump(),
        },
    )


def peer_acknowledgement(item: ConversationItem) -> dict[str, bool | str]:
    """Distinguish durable acceptance from a proven native transcript receipt."""
    from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID

    assert isinstance(item.data, MessageData) and item.data.communication is not None
    origin = item.data.communication
    state = "unknown"
    if item.response_id == PENDING_INPUT_RESPONSE_ID:
        state = {"in_progress": "queued", "incomplete": "unknown", "failed": "failed"}.get(
            item.status, "failed"
        )
    elif origin.delivery_state == "confirmed":
        state = "confirmed"
    return {
        "queued": state in {"queued", "unknown", "confirmed"},
        "message_id": origin.message_id,
        "item_id": item.id,
        "delivery_state": state,
        "receipt": origin.receipt or "accepted",
    }


def correlate_native_peer_input(
    conversations: ConversationStore,
    session_id: str,
    item: NewConversationItem,
    input_id: object,
) -> NewConversationItem:
    """Resolve a bound runner's structured input identity against durable provenance."""
    import re

    from omnigent.native.communication import peer_model_content
    from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID

    if not isinstance(input_id, str) or re.fullmatch(r"[0-9a-f]{32}", input_id) is None:
        raise OmnigentError("Invalid native input identity", code=ErrorCode.INVALID_INPUT)
    saved = conversations.get_item(session_id, input_id)
    origin = saved.data.communication if saved and isinstance(saved.data, MessageData) else None
    if origin is None or origin.kind != "peer":
        return item
    assert saved is not None and isinstance(saved.data, MessageData)
    text_parts = [block["text"] for block in peer_model_content(saved.data.content, origin)]
    # Codex versions may combine the input blocks before emitting the user item.
    expected_content = [
        [{"type": "input_text", "text": separator.join(text_parts)}]
        for separator in ("\n", "\n\n")
    ]
    if (
        origin.message_id != input_id
        or origin.destination_conversation_id != session_id
        or saved.data.role != "user"
        or item.type != "message"
        or not isinstance(item.data, MessageData)
        or item.data.role != "user"
        or item.data.communication is not None
        or item.data.is_meta
        or item.data.content not in expected_content
        or (saved.response_id == PENDING_INPUT_RESPONSE_ID and saved.status != "incomplete")
        or (
            saved.response_id != PENDING_INPUT_RESPONSE_ID
            and (
                saved.response_id != item.response_id
                or origin.receipt != "transcript"
                or origin.delivery_state != "confirmed"
            )
        )
    ):
        raise OmnigentError("Native input does not match the saved peer", code=ErrorCode.CONFLICT)
    return item.model_copy(
        update={
            "stable_id": saved.id,
            "replaces_pending_id": (
                saved.id if saved.response_id == PENDING_INPUT_RESPONSE_ID else None
            ),
            "created_by": None,
            "data": item.data.model_copy(
                update={
                    "content": saved.data.content,
                    "communication": origin.model_copy(
                        update={"delivery_state": "confirmed", "receipt": "transcript"}
                    ),
                }
            ),
        }
    )


async def accept_peer_message(
    request: Request,
    source: Conversation,
    target: Conversation,
    data: dict[str, Any],
    user_id: str | None,
    conversations: ConversationStore,
    permissions: PermissionStore | None,
) -> dict[str, bool | str]:
    """Use durable startup inputs as the peer outbox, with at-most-once handoff."""
    import asyncio

    from omnigent.entities.conversation import MessageData

    await asyncio.to_thread(
        require_peer_replay, source.id, target.id, user_id, conversations, permissions
    )
    event = await asyncio.to_thread(_peer_message_input, source, target.id, data, conversations)
    agent_store = getattr(request.app.state, "agent_store", None)
    if agent_store is not None and source.agent_id:
        agent = await asyncio.to_thread(agent_store.get, source.agent_id)
        if agent is not None and agent.name:
            event.data["communication"]["source_agent_name"] = agent.name
    message_id = event.data["stable_id"]
    existing = await asyncio.to_thread(conversations.get_item, target.id, message_id)
    if existing is not None:
        origin = existing.data.communication if isinstance(existing.data, MessageData) else None
        expected = event.data["communication"]
        if (
            origin is None
            or not isinstance(existing.data, MessageData)
            or (
                existing.created_by != user_id
                and not (
                    existing.created_by is None
                    and origin.kind == "peer"
                    and origin.delivery_state == "confirmed"
                    and origin.receipt == "transcript"
                )
            )
            or existing.data.content != event.data["content"]
            or any(
                getattr(origin, key) != expected[key]
                for key in (
                    "source_conversation_id",
                    "destination_conversation_id",
                    "reply_to_message_id",
                    "task_id",
                )
            )
        ):
            raise OmnigentError(
                "message_id already names a different message", code=ErrorCode.CONFLICT
            )
        return peer_acknowledgement(existing)
    startup = getattr(request.app.state, "startup_inputs", None)
    if startup is None:
        raise OmnigentError("Durable peer delivery unavailable", code=ErrorCode.RUNNER_UNAVAILABLE)
    pending = await asyncio.to_thread(conversations.list_pending_inputs, target.id)
    if len(pending) >= 64:
        raise OmnigentError("Recipient peer queue is full", code=ErrorCode.CONFLICT)
    waiting = await startup.accepts(target, request.app)
    await asyncio.to_thread(
        require_peer_replay, source.id, target.id, user_id, conversations, permissions
    )
    from uuid import NAMESPACE_URL, uuid5

    from omnigent.entities.conversation import NewConversationItem
    from omnigent.server.routes._sessions.helpers import _publish_external_conversation_item

    # The sender's immutable outbox snapshot is an agent-authored message.
    # Its current receipt is resolved through the destination's durable input.
    [outgoing] = await asyncio.to_thread(
        conversations.append,
        source.id,
        [
            NewConversationItem(
                type="message",
                response_id=f"peer_{message_id}",
                stable_id=uuid5(NAMESPACE_URL, f"peer-outgoing:{source.id}:{message_id}").hex,
                data=MessageData(
                    role="assistant",
                    agent=source.agent_id or "agent",
                    content=[{"type": "output_text", "text": data["message"]}],
                    communication={
                        **event.data["communication"],
                        "delivery_state": "unknown",
                        "receipt": None,
                    },
                ),
            )
        ],
    )
    if (
        not isinstance(outgoing.data, MessageData)
        or outgoing.data.content != [{"type": "output_text", "text": data["message"]}]
        or outgoing.data.communication is None
        or any(
            getattr(outgoing.data.communication, key) != event.data["communication"][key]
            for key in ("destination_conversation_id", "reply_to_message_id", "task_id")
        )
    ):
        raise OmnigentError(
            "message_id already names a different outgoing message", code=ErrorCode.CONFLICT
        )
    if not outgoing.deduplicated:
        _publish_external_conversation_item(source.id, outgoing)
    if outgoing.data.resource_scope is not None:
        event.data["communication"]["source_resource_scope"] = outgoing.data.resource_scope
    saved = await startup.enqueue(
        target.id, event, user_id=user_id, headers=request.headers, first=False
    )
    result = None
    if not saved.deduplicated and not waiting:
        result = await startup._deliver(request.app, target.id, saved)
    if target.host_id:
        startup.host_changed(request.app, target.host_id)
    current = await asyncio.to_thread(conversations.get_item, target.id, message_id)
    ack = peer_acknowledgement(current or saved)
    if result and result.get("denied"):
        ack.update(result)
        ack["delivery_state"] = "failed"
    if result and result.get("error"):
        ack.update(result)
        ack["detail"] = result["error"]
    if ack["delivery_state"] == "failed":
        ack.setdefault("error", "Peer message could not be delivered")
    return ack


def orchestration_message(source_id: str, message: object) -> SessionStartupInput:
    """Retain the independent-session creation input contract."""
    if not isinstance(message, str) or not message.strip() or len(message) > 8000:
        raise OmnigentError("Provide a message of 1–8000 characters", code=ErrorCode.INVALID_INPUT)
    return SessionStartupInput(
        type="message",
        data={
            "role": "user",
            "content": [
                {"type": "input_text", "text": f"[Message from session {source_id}]\n{message}"}
            ],
        },
    )
