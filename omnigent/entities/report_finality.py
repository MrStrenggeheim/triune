# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Replace a captured report and its exact references as one snapshot."""

from typing import Any

REPORT_FIELDS = frozenset(
    {
        "result_text",
        "result_ref",
        "result_refs",
        "result_parts",
        "result_item_id",
        "result_finality",
        "result_revision",
    }
)
_FINALITY = {"unknown": 0, "final_answer": 1, "adapter_result": 2, "handback": 3}


def replace_report_snapshot(resource: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """Prefer stronger correlated final evidence, even when its text is shorter."""
    if resource.get("dispatch_id") != incoming.get("dispatch_id"):
        return resource
    if resource.get("turn_id") and incoming.get("turn_id") != resource["turn_id"]:
        return resource
    if not isinstance(incoming.get("result_text"), str):
        return resource
    finality = incoming.get("result_finality")
    previous_finality = resource.get("result_finality")
    rank = _FINALITY.get(finality, 0) if isinstance(finality, str) else 0
    old_rank = _FINALITY.get(previous_finality, 0) if isinstance(previous_finality, str) else 0
    revision = incoming.get("result_revision", 0)
    old_revision = resource.get("result_revision", 0)
    newer = isinstance(revision, int) and isinstance(old_revision, int) and revision > old_revision
    if resource.get("result_text") and not (rank > old_rank or (rank == old_rank and newer)):
        return resource
    result = {key: value for key, value in resource.items() if key not in REPORT_FIELDS}
    result.update({key: incoming[key] for key in REPORT_FIELDS if key in incoming})
    return result
