# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded, authorized activity projection shared by session lists and updates."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from omnigent.entities import Conversation
    from omnigent.stores.conversation_store import ConversationStore

Status = Literal["idle", "running", "failed"]


async def descendant_activity(
    roots: list[Conversation],
    store: ConversationStore,
    status: Callable[[str, str | None], Status],
    authorize: Callable[[list[Conversation], set[str]], set[str]],
    *,
    max_nodes: int = 2048,
    max_depth: int = 64,
) -> dict[str, bool | None]:
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
        loaded = await asyncio.to_thread(store.get_conversations, candidates) if candidates else {}
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
    result: dict[str, bool | None] = {}
    for root in roots:
        seen = {root.id}
        pending = list(graph.get(root.id, []))
        running = False
        while pending:
            child = pending.pop()
            if child in seen:
                continue
            seen.add(child)
            row = rows[child]
            if status(child, row.live_status) == "running":
                running = True
                break
            pending.extend(graph.get(child, []))
        result[root.id] = True if running else False if complete else None
    return result
