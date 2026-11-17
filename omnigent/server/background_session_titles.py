"""Non-blocking semantic titles for newly started sessions."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from cachetools import LRUCache

from omnigent.db.db_models import current_workspace_id
from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.entities.conversation import (
    DEFAULT_GENERATED_TITLE_MAX_CHARS,
    USER_SESSION_TITLE_MAX_CHARS,
)
from omnigent.entities.subchat import is_durable_subchat, subchat_question_content
from omnigent.harness_aliases import canonicalize_harness
from omnigent.harness_plugins import background_title_generators
from omnigent.runner.background_titles.service import FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION
from omnigent.runner.routing import BoundRunnerOffline
from omnigent.stores.conversation_store import ConversationStore

if TYPE_CHECKING:
    from omnigent.entities.conversation import Conversation
    from omnigent.runner.routing import RunnerRouter
    from omnigent.runner.transports.ws_tunnel.registry import RunnerSession
    from omnigent.server.schemas import SessionEventInput
    from omnigent.stores.permission_store import PermissionStore

_logger = logging.getLogger(__name__)

BACKGROUND_SESSION_TITLES_HEADER = "x-omnigent-background-session-titles"


def background_session_titles_enabled(headers: Mapping[str, str]) -> bool:
    """Resolve the browser-local title preference from a request header."""
    return headers.get(BACKGROUND_SESSION_TITLES_HEADER, "on").lower() != "off"


def _background_session_title_harness_supported(harness: str | None) -> bool:
    """Return whether a known session harness may run automatic title inference."""
    if harness is None:
        return True
    canonical = canonicalize_harness(harness)
    return canonical is not None and canonical in background_title_generators()


@dataclass(frozen=True)
class BackgroundTitleRequest:
    """Immutable session inputs for isolated title inference."""

    session_id: str
    prompt: str
    agent_id: str | None = None
    harness_override: str | None = None
    model_override: str | None = None
    sub_agent_name: str | None = None
    additional_instructions: str | None = None


BackgroundTitleGenerator = Callable[[BackgroundTitleRequest], Awaitable[str | None]]


@dataclass
class _TitleAttempt:
    request: BackgroundTitleRequest
    expected_seed_title: str | None
    identity: object = None
    offline: tuple[str, float] | None = None
    retry_used: bool = False


_TITLE_WRAPPERS = "'\"`“”‘’"
_TRAILING_PUNCTUATION = re.compile(r"[.!?;:,]+$")
BACKGROUND_TITLE_MAX_CHARS = DEFAULT_GENERATED_TITLE_MAX_CHARS
CUSTOM_BACKGROUND_TITLE_MAX_CHARS = USER_SESSION_TITLE_MAX_CHARS
_TASK_SUMMARY_ATTEMPT_CACHE_SIZE = 1024


def normalize_background_title(
    value: str | None,
    *,
    max_chars: int = BACKGROUND_TITLE_MAX_CHARS,
    truncate_overflow: bool = False,
) -> str | None:
    """Return a compact title or ``None`` when model output is unusable."""
    if not value:
        return None
    first_line = next((line.strip() for line in value.splitlines() if line.strip()), "")
    title = " ".join(first_line.strip(_TITLE_WRAPPERS).split())
    title = _TRAILING_PUNCTUATION.sub("", title).strip()
    if len(title) > max_chars:
        if not truncate_overflow:
            return None
        title = title[: max_chars - 1].rstrip() + "…"
    if len(title) < 2:
        return None
    return title


class RunnerBackgroundTitleGenerator:
    """Request isolated title inference from the session's bound runner."""

    def __init__(self, runner_router: RunnerRouter, *, timeout_seconds: float = 65.0) -> None:
        self._runner_router = runner_router
        self._timeout_seconds = timeout_seconds

    async def __call__(self, request: BackgroundTitleRequest) -> str | None:
        return await self.generate(request)

    async def generate(
        self,
        request: BackgroundTitleRequest,
        *,
        connection: RunnerSession | None = None,
        dispatch_guard: Callable[[], Awaitable[bool]] | None = None,
    ) -> str | None:
        routed = await asyncio.to_thread(
            self._runner_router.client_for_existing_conversation, request.session_id
        )
        if routed is None:
            return None
        if dispatch_guard is not None and not await dispatch_guard():
            return None
        if connection is not None and (
            routed.runner_id != connection.runner_id
            or self._runner_router.runner_connection(connection.runner_id) is not connection
        ):
            return None
        body = {
            "prompt": request.prompt,
            "agent_id": request.agent_id,
            "harness_override": request.harness_override,
            "model_override": request.model_override,
            "sub_agent_name": request.sub_agent_name,
        }
        custom = request.additional_instructions.strip() if request.additional_instructions else ""
        body["additional_instructions"] = (
            f"{custom}\n{FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION}"
            if custom
            else FOLLOW_USER_LANGUAGE_TITLE_INSTRUCTION
        )
        response = await routed.client.post(
            f"/v1/sessions/{request.session_id}/background-title",
            json=body,
            timeout=self._timeout_seconds,
        )
        response.raise_for_status()
        payload: Any = response.json()
        if not isinstance(payload, dict) or payload.get("status") != "generated":
            return None
        title = payload.get("title")
        return title if isinstance(title, str) else None


class BackgroundSessionTitleCoordinator:
    """Coordinate background titles and policy-aware agent rename requests."""

    def __init__(
        self,
        conversation_store: ConversationStore,
        generator: BackgroundTitleGenerator,
        *,
        timeout_seconds: float = 70.0,
        seed_wait_seconds: float = 15.0,
        max_concurrency: int = 4,
        additional_instructions: str | None = None,
        runner_router: RunnerRouter | None = None,
        permission_store: PermissionStore | None = None,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be at least 1")
        self._conversation_store = conversation_store
        self._generator = generator
        self._timeout_seconds = timeout_seconds
        self._seed_wait_seconds = seed_wait_seconds
        self._additional_instructions = additional_instructions
        self._runner_router = runner_router
        self._permission_store = permission_store
        self._generation_slots = asyncio.Semaphore(max_concurrency)
        self._pending: set[asyncio.Task[None]] = set()
        self._scheduled_session_ids: set[tuple[int, str]] = set()
        self._scheduled_task_summary_ids: set[tuple[int, str]] = set()
        self._attempts: WorkspaceScopedCache[
            tuple[BackgroundTitleRequest, str | None], _TitleAttempt
        ] = WorkspaceScopedCache(lambda: LRUCache(maxsize=_TASK_SUMMARY_ATTEMPT_CACHE_SIZE))
        self._current_requests: WorkspaceScopedCache[
            tuple[str, bool], tuple[BackgroundTitleRequest, str | None]
        ] = WorkspaceScopedCache(lambda: LRUCache(maxsize=_TASK_SUMMARY_ATTEMPT_CACHE_SIZE))
        self._confirmed_connections: WorkspaceScopedCache[str, tuple[int, float]] = (
            WorkspaceScopedCache(lambda: LRUCache(maxsize=_TASK_SUMMARY_ATTEMPT_CACHE_SIZE))
        )

    def _new_attempt(
        self, request: BackgroundTitleRequest, expected_seed_title: str | None
    ) -> _TitleAttempt | None:
        key = (request, expected_seed_title)
        if self._attempts.get(key) is not None:
            return None
        self._current_requests[(request.session_id, expected_seed_title is None)] = key
        attempt = _TitleAttempt(request, expected_seed_title)
        self._attempts[key] = attempt
        return attempt

    def _observe_request(self, request: BackgroundTitleRequest, seed: str | None) -> None:
        if (request, seed) not in self._attempts:
            self._current_requests[(request.session_id, seed is None)] = (request, seed)

    def _identity(self, session_id: str) -> object:
        conversation = self._conversation_store.get_conversation(session_id)
        if conversation is None:
            return None
        grants: object = None
        if self._permission_store is not None:
            owner_session = conversation
            for _ in range(16):
                if owner_session.parent_conversation_id is None:
                    break
                parent = self._conversation_store.get_conversation(
                    owner_session.parent_conversation_id
                )
                if parent is None:
                    return None
                owner_session = parent
            else:
                return None
            permissions = self._permission_store.list_for_sessions([owner_session.id])
            grants = tuple(
                sorted(
                    (
                        grant.user_id,
                        grant.level,
                        (account is not None, account.account_generation if account else None),
                    )
                    for grant in permissions.get(owner_session.id, [])
                    for account in [self._permission_store.get_user(grant.user_id)]
                )
            )
        return (
            conversation.created_at,
            conversation.runner_id,
            conversation.host_id,
            conversation.title,
            conversation.task_summary,
            conversation.agent_id,
            conversation.harness_override,
            conversation.model_override,
            conversation.sub_agent_name,
            conversation.parent_conversation_id,
            conversation.root_conversation_id,
            conversation.workspace,
            grants,
        )

    def _request_is_current(self, attempt: _TitleAttempt, connection: RunnerSession) -> bool:
        if (
            self._runner_router is None
            or self._runner_router.runner_connection(connection.runner_id) is not connection
            or self._attempts.get((attempt.request, attempt.expected_seed_title)) is not attempt
            or self._current_requests.get(
                (attempt.request.session_id, attempt.expected_seed_title is None)
            )
            != (attempt.request, attempt.expected_seed_title)
            or attempt.identity is None
        ):
            return False
        return True

    def _retry_identity_matches(self, attempt: _TitleAttempt, connection: RunnerSession) -> bool:
        if self._identity(attempt.request.session_id) != attempt.identity:
            return False
        conversation = self._conversation_store.get_conversation(attempt.request.session_id)
        if conversation is None or conversation.runner_id != connection.runner_id:
            return False
        if self._permission_store is not None:
            from omnigent.server.permissions import check_session_access

            if (
                connection.owner is None
                or self._permission_store.get_user(connection.owner) is None
            ):
                return False
            return check_session_access(
                connection.owner,
                conversation.id,
                2,
                self._permission_store,
                self._conversation_store,
                conversation,
            )
        return True

    async def _retry_is_current(self, attempt: _TitleAttempt, connection: RunnerSession) -> bool:
        if not self._request_is_current(attempt, connection):
            return False
        matches = await asyncio.to_thread(self._retry_identity_matches, attempt, connection)
        return matches and self._request_is_current(attempt, connection)

    def cancel_reconnect_retry(self, session_id: str) -> None:
        """Honor a subsequently observed browser opt-out without resetting attempt history."""
        self._current_requests.pop((session_id, False), None)

    def runner_connected(self, connection: RunnerSession) -> None:
        """Observe only the current authenticated tunnel; consume each retry before scheduling."""
        if (
            self._runner_router is None
            or self._runner_router.runner_connection(connection.runner_id) is not connection
        ):
            return
        confirmed = self._confirmed_connections.get(connection.runner_id)
        if confirmed is None or confirmed[0] != connection.generation:
            confirmed = (connection.generation, time.monotonic())
            self._confirmed_connections[connection.runner_id] = confirmed
        for attempt in self._attempts.values():
            offline = attempt.offline
            if (
                offline is None
                or attempt.retry_used
                or offline[0] != connection.runner_id
                or confirmed[1] <= offline[1]
            ):
                continue
            attempt.retry_used = True
            attempt.offline = None
            job = (
                self._run_task_summary(
                    request=attempt.request, attempt=attempt, connection=connection
                )
                if attempt.expected_seed_title is None
                else self._run(
                    request=attempt.request,
                    expected_seed_title=attempt.expected_seed_title,
                    attempt=attempt,
                    connection=connection,
                )
            )
            task = asyncio.create_task(
                job, name=f"background-title-reconnect-{attempt.request.session_id}"
            )
            self._pending.add(task)
            task.add_done_callback(self._pending.discard)

    def _defer_offline(self, attempt: _TitleAttempt | None, error: BoundRunnerOffline) -> None:
        if attempt is None or attempt.retry_used or attempt.identity is None:
            return
        if error.runner_id is None:
            return
        attempt.offline = (error.runner_id, error.observed_at)
        # A verified connect can race the routing worker's exception delivery.
        confirmed = self._confirmed_connections.get(error.runner_id) if error.runner_id else None
        if confirmed is not None and self._runner_router is not None:
            connection = self._runner_router.runner_connection(error.runner_id)
            if connection is not None and connection.generation == confirmed[0]:
                self.runner_connected(connection)

    async def format_agent_title(self, request: BackgroundTitleRequest) -> str | None:
        """Apply configured title requirements without changing the stored title.

        Without custom requirements, the agent's proposed title is used as-is.
        Generation failures leave the existing title intact rather than falling
        back to a proposal that may violate the configured format.
        """
        if not self._additional_instructions or not self._additional_instructions.strip():
            return request.prompt
        request = replace(request, additional_instructions=self._additional_instructions)
        try:
            async with asyncio.timeout(self._timeout_seconds), self._generation_slots:
                return await self._generate_title(request)
        except Exception:
            _logger.warning(
                "agent session title generation failed session=%s",
                request.session_id,
                exc_info=True,
            )
            return None

    async def _infer_title(
        self,
        request: BackgroundTitleRequest,
        attempt: _TitleAttempt | None = None,
        connection: RunnerSession | None = None,
    ) -> str | None:
        if (
            connection is not None
            and attempt is not None
            and isinstance(self._generator, RunnerBackgroundTitleGenerator)
        ):
            inference = self._generator.generate(
                request,
                connection=connection,
                dispatch_guard=lambda: self._retry_is_current(attempt, connection),
            )
        else:
            inference = self._generator(request)
        return await asyncio.wait_for(inference, timeout=self._timeout_seconds)

    async def _generate_title(
        self,
        request: BackgroundTitleRequest,
        attempt: _TitleAttempt | None = None,
        connection: RunnerSession | None = None,
    ) -> str | None:
        generated = await self._infer_title(request, attempt, connection)
        has_custom_instructions = bool(
            request.additional_instructions and request.additional_instructions.strip()
        )
        return normalize_background_title(
            generated,
            max_chars=(
                CUSTOM_BACKGROUND_TITLE_MAX_CHARS
                if has_custom_instructions
                else BACKGROUND_TITLE_MAX_CHARS
            ),
            truncate_overflow=has_custom_instructions,
        )

    def schedule(
        self,
        *,
        session_id: str,
        prompt: str,
        expected_seed_title: str,
        agent_id: str | None = None,
        harness_override: str | None = None,
        model_override: str | None = None,
        sub_agent_name: str | None = None,
    ) -> None:
        """Schedule once per cached request and seed, without awaiting inference."""
        key = (current_workspace_id(), session_id)
        request = BackgroundTitleRequest(
            session_id=session_id,
            prompt=prompt,
            agent_id=agent_id,
            harness_override=harness_override,
            model_override=model_override,
            sub_agent_name=sub_agent_name,
            additional_instructions=self._additional_instructions,
        )
        self._observe_request(request, expected_seed_title)
        if key in self._scheduled_session_ids:
            return
        attempt = self._new_attempt(request, expected_seed_title)
        if attempt is None:
            return
        self._scheduled_session_ids.add(key)
        task = asyncio.create_task(
            self._run(
                request=request,
                expected_seed_title=expected_seed_title,
                attempt=attempt,
            ),
            name=f"background-session-title-{session_id}",
        )
        self._pending.add(task)

        def _discard(completed: asyncio.Task[None]) -> None:
            self._pending.discard(completed)
            self._scheduled_session_ids.discard(key)

        task.add_done_callback(_discard)

    def schedule_task_summary(
        self,
        *,
        session_id: str,
        prompt: str,
        agent_id: str | None = None,
        harness_override: str | None = None,
        model_override: str | None = None,
        sub_agent_name: str | None = None,
    ) -> None:
        """Schedule once per workspace and request while the attempt remains cached."""
        request = BackgroundTitleRequest(
            session_id=session_id,
            prompt=prompt,
            agent_id=agent_id,
            harness_override=harness_override,
            model_override=model_override,
            sub_agent_name=sub_agent_name,
        )
        key = (current_workspace_id(), session_id)
        self._observe_request(request, None)
        if key in self._scheduled_task_summary_ids:
            return
        attempt = self._new_attempt(request, None)
        if attempt is None:
            return
        self._scheduled_task_summary_ids.add(key)
        task = asyncio.create_task(
            self._run_task_summary(request=request, attempt=attempt),
            name=f"background-task-summary-{session_id}",
        )
        self._pending.add(task)

        def _discard(completed: asyncio.Task[None]) -> None:
            self._pending.discard(completed)
            self._scheduled_task_summary_ids.discard(key)

        task.add_done_callback(_discard)

    async def wait_for_idle(self) -> None:
        """Wait for currently scheduled jobs; used by focused tests."""
        while self._pending:
            await asyncio.gather(*tuple(self._pending))

    async def shutdown(self) -> None:
        """Cancel and drain pending title jobs during server shutdown."""
        pending = tuple(self._pending)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _run(
        self,
        *,
        request: BackgroundTitleRequest,
        expected_seed_title: str,
        attempt: _TitleAttempt | None = None,
        connection: RunnerSession | None = None,
    ) -> None:
        started = time.perf_counter()
        try:
            async with self._generation_slots:
                if connection is not None:
                    if attempt is None or not await self._retry_is_current(attempt, connection):
                        return
                elif attempt is not None and self._runner_router is not None:
                    attempt.identity = await asyncio.to_thread(self._identity, request.session_id)
                seed_ready = await self._wait_for_seed(
                    session_id=request.session_id,
                    expected_seed_title=expected_seed_title,
                )
                if not seed_ready:
                    _logger.info(
                        "background session title skipped session=%s "
                        "reason=seed_unavailable elapsed_ms=%.1f",
                        request.session_id,
                        (time.perf_counter() - started) * 1000,
                        extra={"session_id": request.session_id},
                    )
                    return
                title = await self._generate_title(request, attempt, connection)
            if connection is not None and (
                attempt is None or not await self._retry_is_current(attempt, connection)
            ):
                return
            if title is None:
                _logger.info(
                    "background session title skipped session=%s "
                    "reason=invalid_title elapsed_ms=%.1f",
                    request.session_id,
                    (time.perf_counter() - started) * 1000,
                    extra={"session_id": request.session_id},
                )
                return
            updated = await asyncio.to_thread(
                self._conversation_store.rename_conversation_if_title_matches,
                request.session_id,
                expected_seed_title,
                title,
            )
            _logger.info(
                "background session title completed session=%s renamed=%s elapsed_ms=%.1f",
                request.session_id,
                updated is not None,
                (time.perf_counter() - started) * 1000,
                extra={"session_id": request.session_id},
            )
        except BoundRunnerOffline as error:
            self._defer_offline(attempt, error)
        except TimeoutError:
            _logger.info(
                "background session title timed out session=%s elapsed_ms=%.1f",
                request.session_id,
                (time.perf_counter() - started) * 1000,
                extra={"session_id": request.session_id},
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # background metadata must never fail the user turn
            _logger.warning(
                "background session title failed session=%s elapsed_ms=%.1f",
                request.session_id,
                (time.perf_counter() - started) * 1000,
                exc_info=True,
                extra={"session_id": request.session_id},
            )

    async def _run_task_summary(
        self,
        *,
        request: BackgroundTitleRequest,
        attempt: _TitleAttempt | None = None,
        connection: RunnerSession | None = None,
    ) -> None:
        """Generate a task summary for a child session and write it to task_summary."""
        started = time.perf_counter()
        try:
            async with self._generation_slots:
                if connection is not None:
                    if attempt is None or not await self._retry_is_current(attempt, connection):
                        return
                elif attempt is not None and self._runner_router is not None:
                    attempt.identity = await asyncio.to_thread(self._identity, request.session_id)
                generated = await self._infer_title(request, attempt, connection)
            if connection is not None and (
                attempt is None or not await self._retry_is_current(attempt, connection)
            ):
                return
            title = normalize_background_title(generated)
            if title is None:
                _logger.info(
                    "background task summary skipped session=%s "
                    "reason=invalid_title elapsed_ms=%.1f",
                    request.session_id,
                    (time.perf_counter() - started) * 1000,
                )
                return
            updated = await asyncio.to_thread(
                self._conversation_store.set_task_summary,
                request.session_id,
                title,
            )
            _logger.info(
                "background task summary completed session=%s set=%s elapsed_ms=%.1f",
                request.session_id,
                updated is not None,
                (time.perf_counter() - started) * 1000,
            )
        except BoundRunnerOffline as error:
            self._defer_offline(attempt, error)
        except TimeoutError:
            _logger.info(
                "background task summary timed out session=%s elapsed_ms=%.1f",
                request.session_id,
                (time.perf_counter() - started) * 1000,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            _logger.warning(
                "background task summary failed session=%s elapsed_ms=%.1f",
                request.session_id,
                (time.perf_counter() - started) * 1000,
                exc_info=True,
            )

    async def _wait_for_seed(
        self,
        *,
        session_id: str,
        expected_seed_title: str,
    ) -> bool:
        deadline = time.monotonic() + self._seed_wait_seconds
        while True:
            conversation = await asyncio.to_thread(
                self._conversation_store.get_conversation,
                session_id,
            )
            if conversation is None:
                return False
            if conversation.title == expected_seed_title:
                return True
            if conversation.title is not None:
                return False
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.05)


@dataclass(frozen=True)
class PendingBackgroundSessionTitle:
    """A prepared title attempt that starts only after event forwarding succeeds."""

    coordinator: BackgroundSessionTitleCoordinator
    request: BackgroundTitleRequest

    def schedule(self, *, expected_seed_title: str | None) -> None:
        """Start the attempt using the title persisted by the active store."""
        if expected_seed_title is None:
            return
        self.coordinator.schedule(
            session_id=self.request.session_id,
            prompt=self.request.prompt,
            expected_seed_title=expected_seed_title,
            agent_id=self.request.agent_id,
            harness_override=self.request.harness_override,
            model_override=self.request.model_override,
            sub_agent_name=self.request.sub_agent_name,
        )


def prepare_background_session_title(
    *,
    coordinator: BackgroundSessionTitleCoordinator | None,
    conversation: Conversation,
    event: SessionEventInput,
    enabled: bool = True,
) -> PendingBackgroundSessionTitle | None:
    """Prepare a guarded first-turn title attempt for a top-level session."""
    if not enabled and coordinator is not None:
        coordinator.cancel_reconnect_retry(conversation.id)
    if (
        not enabled
        or coordinator is None
        or conversation.title is not None
        or conversation.parent_conversation_id is not None
        or not _background_session_title_harness_supported(conversation.harness_override)
    ):
        return None

    if is_durable_subchat(conversation.id, conversation.labels):
        if (
            event.type != "message"
            or event.data.get("role") != "user"
            or event.data.get("is_meta")
            or event.data.get("communication")
        ):
            return None
        content = event.data.get("content")
        if not isinstance(content, list):
            return None
        event = event.model_copy(
            update={"data": {**event.data, "content": subchat_question_content(content)}}
        )
    prompt = background_title_prompt(event)
    if not prompt:
        return None

    return PendingBackgroundSessionTitle(
        coordinator=coordinator,
        request=BackgroundTitleRequest(
            session_id=conversation.id,
            prompt=prompt,
            agent_id=conversation.agent_id,
            harness_override=conversation.harness_override,
            model_override=conversation.model_override,
            sub_agent_name=conversation.sub_agent_name,
        ),
    )


def schedule_background_child_task_summary(
    *,
    coordinator: BackgroundSessionTitleCoordinator | None,
    session_id: str,
    prompt: str,
    agent_id: str | None = None,
    sub_agent_name: str | None = None,
) -> None:
    """Schedule a background task-summary attempt for a child session."""
    if coordinator is None or not prompt:
        return
    coordinator.schedule_task_summary(
        session_id=session_id,
        prompt=prompt,
        agent_id=agent_id,
        sub_agent_name=sub_agent_name,
    )


def background_title_prompt(event: SessionEventInput) -> str:
    if event.type == "slash_command":
        name = event.data.get("name")
        arguments = event.data.get("arguments", "")
        if not isinstance(name, str) or not name.strip() or not isinstance(arguments, str):
            return ""
        return f"/{name.strip()} {arguments}".strip()

    content = event.data.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "input_text":
            text = block.get("text", "")
            if isinstance(text, str):
                parts.append(text)
    return " ".join(parts)[:4000]
