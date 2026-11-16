# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded, authorized activity projection shared by session lists and updates."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from omnigent.entities import Conversation
    from omnigent.stores.conversation_store import ConversationStore

Status = Literal["idle", "running", "failed"]


@dataclass
class ActivityDescendants:
    rows: list[Conversation]
    complete: bool


async def activity_descendants(
    roots: list[Conversation],
    store: ConversationStore,
    authorize: Callable[[list[Conversation], set[str]], set[str]],
    *,
    max_nodes: int = 2048,
    max_depth: int = 64,
) -> dict[str, ActivityDescendants]:
    """Prune unreadable paths and report unknown when the shared work budget expires."""
    rows = {row.id: row for row in roots}
    authorized = set(rows)
    examined = set(rows)
    graph: dict[str, list[str]] = {}
    frontier = list(rows)
    complete = True
    for _ in range(max_depth):
        if not frontier:
            break
        remaining = max_nodes - len(examined)
        if remaining <= 0:
            complete = False
            break
        edges, covered = await asyncio.to_thread(
            store.list_activity_child_ids, frontier, limit=remaining
        )
        complete &= covered
        candidates = list(
            dict.fromkeys(
                child for children in edges.values() for child in children if child not in examined
            )
        )
        examined.update(candidates)
        loaded = (
            await asyncio.to_thread(
                store.get_conversations, candidates, include_execution_state=False
            )
            if candidates
            else {}
        )
        complete &= len(loaded) == len(candidates)
        allowed = (
            await asyncio.to_thread(authorize, list(loaded.values()), authorized)
            if loaded
            else set()
        )
        authorized.update(allowed)
        rows.update({key: row for key, row in loaded.items() if key in allowed})
        for parent, children in edges.items():
            graph[parent] = [child for child in children if child in authorized]
        frontier = [key for key in candidates if key in allowed]
    else:
        complete = not frontier and complete
    result: dict[str, ActivityDescendants] = {}
    for root in roots:
        seen = {root.id}
        pending = list(graph.get(root.id, []))
        descendants: list[Conversation] = []
        while pending:
            child = pending.pop()
            if child in seen:
                continue
            seen.add(child)
            descendants.append(rows[child])
            pending.extend(graph.get(child, []))
        descendants.sort(key=lambda row: row.id)
        result[root.id] = ActivityDescendants(descendants, complete)
    return result


async def descendant_activity(
    roots: list[Conversation],
    store: ConversationStore,
    status: Callable[[str, str | None], Status],
    authorize: Callable[[list[Conversation], set[str]], set[str]],
    *,
    max_nodes: int = 2048,
    max_depth: int = 64,
) -> dict[str, bool | None]:
    descendants = await activity_descendants(
        roots, store, authorize, max_nodes=max_nodes, max_depth=max_depth
    )
    return {
        root: True
        if any(status(row.id, row.live_status) == "running" for row in result.rows)
        else False
        if result.complete
        else None
        for root, result in descendants.items()
    }
