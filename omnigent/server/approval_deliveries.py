"""Durable exact approval handoff; recovery queries receipts and never replays answers.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import secrets
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

import httpx

from omnigent.db.db_models import workspace_scope
from omnigent.entities import NewConversationItem, ResourceEventData
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.routing import RunnerRouter
from omnigent.runtime import pending_elicitations, session_stream
from omnigent.server.approval_delivery_store import ApprovalDeliveryStore
from omnigent.server.schemas import ElicitationResult
from omnigent.stores import ConversationStore

_logger = logging.getLogger(__name__)


_IDENTITY_KEYS = (
    "protocol_version",
    "session_id",
    "elicitation_id",
    "runner_id",
    "runner_instance_id",
    "owner_kind",
    "owner_instance_id",
    "request_id",
)


def held_event(record: dict[str, Any]) -> dict[str, Any]:
    event = copy.deepcopy(record["event"])
    event["params"]["runner_delivery"] = {
        "state": "unconfirmed",
        "attempt_id": record["identity"]["attempt_id"],
        **{
            key: record["identity"][key]
            for key in ("session_id", "elicitation_id", "runner_id", "owner_kind")
        },
    }
    return event


def sanitized_event(event: dict[str, Any]) -> dict[str, Any]:
    """Keep the original request without secret defaults or a duplicated secret preview."""
    from omnigent.server.routes._question_receipts import _receipt_request

    original = event.get("params") or {}

    def contains_secret(value: Any) -> bool:
        if isinstance(value, dict):
            return (
                value.get("isSecret") is True
                or value.get("format") == "password"
                or value.get("writeOnly") is True
                or any(contains_secret(v) for v in value.values())
            )
        return isinstance(value, list) and any(contains_secret(v) for v in value)

    params = _receipt_request(original, has_secret_questions=contains_secret(original))

    def remove_secret_defaults(value: Any) -> None:
        if isinstance(value, dict):
            if (
                value.get("isSecret") is True
                or value.get("format") == "password"
                or value.get("writeOnly") is True
            ):
                value.pop("default", None)
                if isinstance(value.get("textInput"), dict):
                    value["textInput"].pop("default", None)
            for nested in value.values():
                remove_secret_defaults(nested)
        elif isinstance(value, list):
            for nested in value:
                remove_secret_defaults(nested)

    remove_secret_defaults(params)
    return {
        "type": "response.elicitation_request",
        "elicitation_id": event["elicitation_id"],
        "params": params,
        "delivery_owner": "runner",
    }


def restore_session_holds(store: ApprovalDeliveryStore, session_id: str) -> None:
    """Merge durable holds and prune only an exactly accepted cached attempt."""
    from omnigent.server.routes._sessions.helpers import _ancestor_elicitation_mirror_lock

    with _ancestor_elicitation_mirror_lock:
        for event in pending_elicitations.snapshot_for(session_id):
            eid = event["elicitation_id"]
            attempt_id = pending_elicitations.held_runner_attempt(session_id, eid)
            if attempt_id is None:
                continue
            target = event.get("params", {}).get("target_session_id", session_id)
            record = store.read(target, eid)
            if (
                record is not None
                and record["state"] == "accepted"
                and record["identity"]["attempt_id"] == attempt_id
            ):
                pending_elicitations.resolve(session_id, eid)
        for record in store.held(session_id):
            event = held_event(record)
            current = pending_elicitations.lookup(
                event["elicitation_id"], conversation_id=session_id
            )
            if current is None or current[1] != event:
                pending_elicitations.record_publish(session_id, event)


async def record_question_receipt_resource(
    conversation_store: ConversationStore,
    session_id: str,
    resource: dict[str, Any],
) -> dict[str, Any] | None:
    """Persist an already redacted canonical receipt after exact delivery acknowledgement."""
    if resource.get("session_id") != session_id:
        raise ValueError("Question receipt belongs to another session")
    submission_id = str(resource["submission_id"])
    stable_id = hashlib.sha256(submission_id.encode()).hexdigest()[:32]
    item = NewConversationItem(
        type="resource_event",
        response_id=submission_id,
        stable_id=stable_id,
        data=ResourceEventData(
            resource_type="question_batch",
            event_type="session.question.answered",
            resource_id=str(resource["elicitation_id"]),
            resource=resource,
        ),
    )
    persisted = (await asyncio.to_thread(conversation_store.append, session_id, [item]))[0]
    if persisted.deduplicated:
        return None
    return persisted.to_api_dict()


class ApprovalDeliveries:
    def __init__(
        self, conversations: ConversationStore, runner_router: RunnerRouter | None
    ) -> None:
        self.conversations = conversations
        self.runner_router = runner_router
        self.store = ApprovalDeliveryStore(conversations.storage_location)

    async def _client(self, session_id: str) -> tuple[str, httpx.AsyncClient, Any]:
        conversation = await asyncio.to_thread(self.conversations.get_conversation, session_id)
        if conversation is None:
            raise OmnigentError("The approval session no longer exists.", code=ErrorCode.NOT_FOUND)
        if self.runner_router is not None:
            routed = self.runner_router.client_for_session_resources(
                session_id, conversation=conversation
            )
            return routed.runner_id, routed.client, conversation
        from omnigent.runtime import get_runner_client

        client = get_runner_client()
        if client is None:
            raise OmnigentError(
                "The approval runner is unavailable.", code=ErrorCode.RUNNER_UNAVAILABLE
            )
        return "inprocess", client, conversation

    @staticmethod
    def _path(session_id: str, elicitation_id: str, attempt_id: str | None = None) -> str:
        path = (
            f"/v1/sessions/{quote(session_id, safe='')}/approval-deliveries/"
            f"{quote(elicitation_id, safe='')}"
        )
        return f"{path}/{attempt_id}" if attempt_id else path

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any] | None:
        if not 200 <= response.status_code < 300:
            return None
        try:
            value = response.json()
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    @staticmethod
    def _confirmed(record: dict[str, Any], receipt: dict[str, Any] | None) -> bool:
        return (
            receipt is not None
            and receipt.get("accepted") is True
            and receipt.get("action") == record["action"]
            and all(receipt.get(k) == v for k, v in record["identity"].items())
        )

    async def resolve(
        self,
        session_id: str,
        elicitation_id: str,
        event: dict[str, Any],
        result: ElicitationResult,
    ) -> None:
        from omnigent.server.routes._question_receipts import build_question_receipt_payload

        existing = await asyncio.to_thread(self.store.read, session_id, elicitation_id)
        if existing is not None:
            if existing["state"] == "held":
                session_stream.publish(session_id, held_event(existing))
            if result.action != existing["action"]:
                raise OmnigentError(
                    "An existing approval attempt must be reconciled first.",
                    code=ErrorCode.CONFLICT,
                )
            await self.reconcile(session_id, elicitation_id, existing)
            return
        runner_id, client, conversation = await self._client(session_id)
        path = self._path(session_id, elicitation_id)
        try:
            descriptor = self._json(await client.get(path, timeout=3.0))
        except (httpx.HTTPError, ConnectionError):
            descriptor = None
        if (
            descriptor is None
            or descriptor.get("protocol_version") != 1
            or descriptor.get("session_id") != session_id
            or descriptor.get("elicitation_id") != elicitation_id
            or descriptor.get("runner_id") != runner_id
            or descriptor.get("owner_kind") not in {"runner", "harness"}
            or any(
                not isinstance(descriptor.get(key), str) or not descriptor[key]
                for key in _IDENTITY_KEYS
                if key != "protocol_version"
            )
        ):
            raise OmnigentError(
                "The runner cannot acknowledge this exact pending approval.",
                code=ErrorCode.RUNNER_UNAVAILABLE,
            )
        identity = {key: descriptor[key] for key in _IDENTITY_KEYS}
        identity["attempt_id"] = secrets.token_hex(32)
        resource = build_question_receipt_payload(
            session_id,
            elicitation_id,
            event.get("params") or {},
            result.model_dump(exclude_none=True),
        )
        payload = {
            "identity": identity,
            "action": result.action,
            "event": sanitized_event(event),
            "question_receipt": resource,
            "conversation_binding": conversation.runner_id,
        }
        from omnigent.server.routes._sessions.helpers import (
            _ancestor_session_ids,
            _publish_elicitation_request_to_ancestors,
        )

        ancestors = await asyncio.to_thread(_ancestor_session_ids, self.conversations, session_id)
        payload["mirror_sessions"] = ancestors
        counts = {session_id: pending_elicitations.count_for(session_id)}
        for ancestor_id in ancestors:
            present = pending_elicitations.lookup(elicitation_id, conversation_id=ancestor_id)
            counts[ancestor_id] = pending_elicitations.count_for(ancestor_id) + (present is None)
        record, reserved = await asyncio.to_thread(
            self.store.reserve,
            session_id,
            elicitation_id,
            payload,
            expected_runner_binding=conversation.runner_id,
            pending_counts=counts,
        )
        if not reserved:
            if result.action != record["action"]:
                raise OmnigentError(
                    "An existing approval attempt has a different action.", code=ErrorCode.CONFLICT
                )
            await self.reconcile(session_id, elicitation_id, record)
            return
        session_stream.publish(session_id, held_event(record))
        await asyncio.to_thread(
            _publish_elicitation_request_to_ancestors,
            self.conversations,
            session_id,
            held_event(record),
        )
        # Reservation commits before any human answer crosses the runner boundary.
        current_runner_id, current_client, current = await self._client(session_id)
        if current_runner_id != runner_id or current.runner_id != record["conversation_binding"]:
            raise OmnigentError(
                "The original approval runner binding changed; the attempt remains held.",
                code=ErrorCode.CONFLICT,
            )
        verdict = result.model_dump(exclude_none=True)
        if resource is not None:
            verdict["_meta"] = {
                **(result.meta or {}),
                "question_submission": {
                    **resource["source"],
                    "session_id": session_id,
                    "elicitation_id": elicitation_id,
                    "submission_id": resource["submission_id"],
                },
            }
        try:
            receipt = self._json(
                await current_client.post(
                    self._path(session_id, elicitation_id, identity["attempt_id"]),
                    json={"identity": identity, "result": verdict},
                    timeout=10.0,
                )
            )
        except (httpx.HTTPError, ConnectionError):
            receipt = None
        if not self._confirmed(record, receipt):
            raise OmnigentError(
                "Approval delivery is unconfirmed. Retry only to query its exact receipt.",
                code=ErrorCode.RUNNER_UNAVAILABLE,
            )
        await self._finish(session_id, elicitation_id, record, current_client)

    async def reconcile(
        self,
        session_id: str,
        elicitation_id: str,
        record: dict[str, Any],
        *,
        authorize: Callable[[], Awaitable[Any]] | None = None,
    ) -> None:
        if record["state"] == "accepted":
            await self._finish(session_id, elicitation_id, record, None)
            return
        runner_id, client, conversation = await self._client(session_id)
        identity = record["identity"]
        if (
            runner_id != identity["runner_id"]
            or conversation.runner_id != record["conversation_binding"]
        ):
            raise OmnigentError(
                "The original approval runner binding changed; the attempt remains held.",
                code=ErrorCode.CONFLICT,
            )
        try:
            receipt = self._json(
                await client.get(
                    self._path(session_id, elicitation_id, identity["attempt_id"]),
                    params={"owner_kind": identity["owner_kind"]},
                    timeout=3.0,
                )
            )
        except (httpx.HTTPError, ConnectionError):
            receipt = None
        if not self._confirmed(record, receipt):
            raise OmnigentError(
                "The original approval receipt is unavailable; no verdict was replayed.",
                code=ErrorCode.RUNNER_UNAVAILABLE,
            )
        current_runner, current_client, current = await self._client(session_id)
        if (
            current_runner != identity["runner_id"]
            or current.runner_id != record["conversation_binding"]
            or current_client is not client
        ):
            raise OmnigentError(
                "The original approval runner changed; the attempt remains held.",
                code=ErrorCode.CONFLICT,
            )
        if authorize is not None:
            await authorize()
        await self._finish(session_id, elicitation_id, record, client)

    async def _finish(
        self,
        session_id: str,
        elicitation_id: str,
        record: dict[str, Any],
        client: httpx.AsyncClient | None,
    ) -> None:
        from omnigent.server.routes._sessions.helpers import _publish_elicitation_resolved

        if record["question_receipt"] is not None:
            receipt = await record_question_receipt_resource(
                self.conversations, session_id, record["question_receipt"]
            )
            if receipt is not None:
                session_stream.publish(
                    session_id, {"type": "response.output_item.done", "item": receipt}
                )
        if record["state"] != "accepted" and not await asyncio.to_thread(
            self.store.accept, session_id, elicitation_id, record["identity"]
        ):
            raise OmnigentError("The durable approval attempt changed.", code=ErrorCode.CONFLICT)
        from omnigent.server.routes._sessions.helpers import (
            _ancestor_elicitation_mirror_lock,
            _ancestor_session_ids,
            _publish_elicitation_resolved_to_ancestors,
        )

        def clear_owned_holds() -> None:
            with _ancestor_elicitation_mirror_lock:
                current = pending_elicitations.lookup(elicitation_id, conversation_id=session_id)
                if (
                    current is not None
                    and pending_elicitations.held_runner_attempt(session_id, elicitation_id)
                    != record["identity"]["attempt_id"]
                ):
                    raise OmnigentError(
                        "The pending approval request changed.", code=ErrorCode.CONFLICT
                    )
                pending_elicitations.resolve(session_id, elicitation_id)
                for ancestor_id in _ancestor_session_ids(self.conversations, session_id):
                    mirror = pending_elicitations.lookup(
                        elicitation_id, conversation_id=ancestor_id
                    )
                    if (
                        mirror is not None
                        and mirror[1].get("params", {}).get("target_session_id") == session_id
                        and pending_elicitations.held_runner_attempt(ancestor_id, elicitation_id)
                        == record["identity"]["attempt_id"]
                    ):
                        pending_elicitations.resolve(ancestor_id, elicitation_id)

        await asyncio.to_thread(clear_owned_holds)
        _publish_elicitation_resolved(session_id, elicitation_id, action=record["action"])
        await asyncio.to_thread(
            _publish_elicitation_resolved_to_ancestors,
            self.conversations,
            session_id,
            elicitation_id,
            record["action"],
        )
        await self._release(session_id, elicitation_id, record, client)

    async def _release(
        self,
        session_id: str,
        elicitation_id: str,
        record: dict[str, Any],
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if record.get("released"):
            return
        try:
            runner_id, routed_client, conversation = await self._client(session_id)
            if (
                runner_id != record["identity"]["runner_id"]
                or conversation.runner_id != record["conversation_binding"]
            ):
                raise OmnigentError("Approval receipt runner changed.", code=ErrorCode.CONFLICT)
            client = routed_client
            path = self._path(session_id, elicitation_id, record["identity"]["attempt_id"])
            response = await client.request(
                "DELETE", path, json={"identity": record["identity"]}, timeout=3.0
            )
            value = self._json(response)
            released = value is not None and value.get("released") is True
            if value is not None and value.get("released") is False:
                # A lost DELETE reply or another replica may have released it.
                # This is cleanup evidence only; acceptance is already durable.
                absent = await client.get(
                    path, params={"owner_kind": record["identity"]["owner_kind"]}, timeout=3.0
                )
                released = absent.status_code == 404
            if not released:
                raise OmnigentError(
                    "Approval receipt release not acknowledged.", code=ErrorCode.RUNNER_UNAVAILABLE
                )
            await asyncio.to_thread(
                self.store.mark_released, session_id, elicitation_id, record["identity"]
            )
        except (OmnigentError, httpx.HTTPError, ConnectionError):
            _logger.warning(
                "Approval receipt release is pending",
                extra={"session_id": session_id, "elicitation_id": elicitation_id},
            )

    async def retry_releases_once(
        self, after: tuple[int, str, str] | None = None
    ) -> tuple[int, str, str] | None:
        """Retry at most eight metadata releases; never send a verdict."""
        rows = await asyncio.to_thread(self.store.release_page, after)
        for workspace_id, session_id, elicitation_id, record in rows:
            with workspace_scope(workspace_id):
                await self._release(session_id, elicitation_id, record)
        return rows[-1][:3] if len(rows) == 8 else None

    async def release_loop(self) -> None:
        after = None
        while True:
            try:
                after = await self.retry_releases_once(after)
            except Exception:
                _logger.exception("Approval receipt release recovery failed")
                after = None
            await asyncio.sleep(15)

    async def restore_all(self) -> None:
        after = None
        while True:
            rows = await asyncio.to_thread(self.store.recovery_page, after)
            for workspace_id, session_id, _elicitation_id, record in rows:
                with workspace_scope(workspace_id):
                    pending_elicitations.record_publish(session_id, held_event(record))
            if len(rows) < 128:
                return
            after = rows[-1][:3]
