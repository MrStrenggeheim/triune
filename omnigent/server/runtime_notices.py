# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded provider observations stored with their authorized session, outside history."""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from typing import Any, Literal

from omnigent.entities.conversation import Conversation
from omnigent.server.schemas import RuntimeNotice
from omnigent.stores.conversation_store import ConversationStore

# Serialization only; persistent scope and revision live in the existing session store.
_LOCK = threading.RLock()


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:24]


def _saved(conv: Conversation) -> dict[str, Any]:
    return conv.runtime_notice_state


def _merge(previous: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """Codex broadcasts omit unchanged account fields; null is not a deletion."""
    result = dict(previous)
    for key, value in incoming.items():
        if value is None:
            continue
        result[key] = (
            _merge(result.get(key, {}) if isinstance(result.get(key), dict) else {}, value)
            if isinstance(value, dict)
            else value
        )
    return result


def _quota_state(provider: str, state: dict[str, Any]) -> dict[str, Any]:
    """Bound sparse accumulation to the fields this observer actually uses."""
    if provider == "claude":
        return {
            key: state[key]
            for key in ("status", "resets_at", "rate_limit_type", "utilization")
            if key in state
        }

    def snapshot(raw):
        if not isinstance(raw, dict):
            return {}
        return {
            window: {
                key: values[key]
                for key in ("usedPercent", "resetsAt", "windowDurationMins")
                if key in values
            }
            for window in ("primary", "secondary")
            if isinstance(values := raw.get(window), dict)
        }

    result: dict[str, Any] = {}
    if "rateLimits" in state:
        result["rateLimits"] = snapshot(state["rateLimits"])
    buckets = state.get("rateLimitsByLimitId")
    if isinstance(buckets, dict):
        result["rateLimitsByLimitId"] = {
            str(key)[:256]: snapshot(value) for key, value in list(buckets.items())[-16:]
        }
    if isinstance(state.get("ordinaryUsageAllowed"), bool):
        result["ordinaryUsageAllowed"] = state["ordinaryUsageAllowed"]
    return result


def observe_runtime_notice(
    store: ConversationStore, session_id: str, observation: dict[str, Any]
) -> bool:
    """Apply one authenticated adapter observation; never infer account identity from text."""
    provider = observation.get("provider")
    source = observation.get("source_instance")
    kind = observation.get("kind")
    sequence = observation.get("sequence")
    if (
        provider not in {"codex", "claude"}
        or not isinstance(source, str)
        or not 0 < len(source) <= 256
        or kind not in {"account", "rate_limit", "nativeNotification"}
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 0
    ):
        raise ValueError("Invalid runtime notice observation")
    state = observation.get("state", {})
    if not isinstance(state, dict) or len(json.dumps(state)) > 32000:
        raise ValueError("Invalid runtime notice state")
    if kind == "rate_limit":
        state = _quota_state(provider, state)
    with _LOCK:
        conv = store.get_conversation(session_id)
        if conv is None:
            return False
        saved = _saved(conv)
        previous = saved.get(provider, {})
        if not isinstance(previous, dict) or previous.get("runner_id") != conv.runner_id:
            previous = {}
        observed_at = observation.get("observed_at", time.time())
        if (
            not isinstance(observed_at, (int, float))
            or isinstance(observed_at, bool)
            or not math.isfinite(observed_at)
        ):
            raise ValueError("Invalid runtime notice timestamp")
        if previous.get("source") == source and sequence <= previous.get("sequence", -1):
            return False
        if previous.get("source") != source and observed_at < previous.get("observed_at", 0):
            return False
        account = observation.get("account")
        native_session = observation.get("native_session_id")
        if provider == "codex":
            # This is one captured parent's runtime observation, not a provider account ID.
            epoch = observation.get("scope_epoch")
            scope = (
                _digest(
                    [
                        source,
                        conv.runner_id,
                        session_id,
                        epoch,
                        account,
                        observation.get("workspace_routing"),
                    ]
                )
                if observation.get("scope_kind") == "captured_parent"
                and isinstance(epoch, str)
                and 0 < len(epoch) <= 256
                and isinstance(account, dict)
                and account.get("type") == "chatgpt"
                else None
            )
        else:
            scope = (
                _digest([source, native_session])
                if isinstance(native_session, str) and native_session
                else None
            )
        same_scope = scope is not None and previous.get("scope") == scope
        entry = {
            "runner_id": conv.runner_id,
            "source": source,
            "scope": scope,
            "sequence": sequence,
            "observed_at": observed_at,
            "state": _merge(previous.get("state", {}) if same_scope else {}, state)
            if kind == "rate_limit"
            else {},
            "notifications": previous.get("notifications", []) if same_scope else [],
        }
        if kind == "nativeNotification" and scope is not None:
            message = state.get("message")
            if not isinstance(message, str) or not message.strip():
                raise ValueError("Notification requires observed message text")
            key = observation.get("source_event_id") or _digest(
                [state.get("notification_type"), message]
            )
            row = {
                "key": str(key)[:256],
                "message": message[:8000],
                "title": str(state.get("title") or "Claude notification")[:256],
                "created_at": observed_at,
            }
            entry["notifications"] = [
                *[old for old in entry["notifications"] if old.get("key") != row["key"]],
                row,
            ][-32:]
            entry["state"] = previous.get("state", {}) if same_scope else {}
        if kind == "account":
            entry["notifications"] = []
        buckets = entry["state"].get("rateLimitsByLimitId")
        if isinstance(buckets, dict):
            entry["state"]["rateLimitsByLimitId"] = dict(list(buckets.items())[-16:])
        saved[provider] = entry
        store.set_runtime_notice_state(session_id, saved)
        return True


def runtime_notices(conv: Conversation, *, now: float | None = None) -> list[RuntimeNotice]:
    """Render saved facts only; elapsed reset time does not establish recovered quota."""
    now = time.time() if now is None else now
    notices = []
    for provider, entry in _saved(conv).items():
        if (
            provider not in {"codex", "claude"}
            or not isinstance(entry, dict)
            or not entry.get("scope")
            or entry.get("runner_id") != conv.runner_id
        ):
            continue
        state = entry.get("state", {})
        windows: list[
            tuple[str, str, str, Literal["info", "warning", "error"], float | None, dict[str, Any]]
        ] = []
        if provider == "codex":
            rate_limits = state.get("rateLimits", {})
            by_id = state.get("rateLimitsByLimitId", {})
            sources = (
                list(by_id.items())
                if isinstance(by_id, dict) and by_id
                else [("quota", rate_limits)]
            )
            if state.get("ordinaryUsageAllowed") is False:
                windows.append(
                    (
                        "ordinary-usage",
                        "Codex usage limit",
                        "Provider reports ordinary included usage is unavailable.",
                        "error",
                        None,
                        {},
                    )
                )
            for limit, snapshot in sources:
                if not isinstance(snapshot, dict):
                    continue
                for window in ("primary", "secondary"):
                    values = snapshot.get(window)
                    if isinstance(values, dict):
                        used = values.get("usedPercent")
                        if (
                            isinstance(used, (int, float))
                            and not isinstance(used, bool)
                            and 0 <= used <= 100
                        ):
                            windows.append(
                                (
                                    f"{limit}:{window}",
                                    f"Codex {window} usage",
                                    f"{used:g}% of the observed limit used.",
                                    "error"
                                    if used >= 100
                                    else "warning"
                                    if used >= 90
                                    else "info",
                                    values.get("resetsAt"),
                                    values,
                                )
                            )
        elif state.get("status") in {"allowed", "allowed_warning", "rejected"}:
            status = state["status"]
            windows.append(
                (
                    str(state.get("rate_limit_type") or "quota"),
                    "Claude usage limit",
                    {
                        "allowed": "Provider reports usage is allowed.",
                        "allowed_warning": "Provider reports usage is approaching its limit.",
                        "rejected": "Provider reports the usage limit was reached.",
                    }[status],
                    "error"
                    if status == "rejected"
                    else "warning"
                    if status == "allowed_warning"
                    else "info",
                    state.get("resets_at"),
                    state,
                )
            )
        for window, title, message, severity, reset, values in windows:
            reset = (
                reset if isinstance(reset, (int, float)) and not isinstance(reset, bool) else None
            )
            if reset is not None and reset <= now:
                message += (
                    " The observed reset time has passed; current availability is unconfirmed."
                )
            notices.append(
                RuntimeNotice(
                    id=_digest([provider, entry["scope"], window]),
                    revision=_digest([severity, reset, values.get("windowDurationMins")]),
                    title=title,
                    message=message,
                    severity=severity,
                    provider=provider,
                    created_at=entry["observed_at"],
                    reset_at=reset,
                    requires_action=severity == "error",
                )
            )
        for row in entry.get("notifications", []):
            notices.append(
                RuntimeNotice(
                    id=_digest([provider, entry["scope"], row["key"]]),
                    revision=_digest(row["message"]),
                    title=row["title"],
                    message=row["message"],
                    severity="info",
                    provider=provider,
                    created_at=row["created_at"],
                )
            )
    return notices[-32:]
