# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Additive product startup environment for native Goose."""

from __future__ import annotations

from collections.abc import Mapping

from omnigent.runtime.ui_contract import append_ui_contract

_TOP_OF_MIND_ENV = "GOOSE_MOIM_MESSAGE_TEXT"


def goose_product_startup_env(
    env: Mapping[str, str],
    *,
    session_id: str,
    server_url: str,
    top_of_mind_enabled: bool | None = None,
    author_instructions: str | None = None,
) -> dict[str, str]:
    """Append the contract for Goose's default-enabled Top Of Mind extension.

    This does not change the user's extension configuration. A caller that
    observes Top Of Mind explicitly disabled must retain that choice and treat
    this transport as unavailable instead of claiming delivery.
    """
    if top_of_mind_enabled is False:
        raise ValueError("Goose Top Of Mind is disabled; product guidance was not installed")
    result = dict(env)
    existing = result.get(_TOP_OF_MIND_ENV, "")
    managed_guidance = append_ui_contract(
        author_instructions, "goose-native", session_id=session_id, server_url=server_url
    )
    result[_TOP_OF_MIND_ENV] = (
        existing
        if existing.endswith(managed_guidance)
        else f"{existing}\n\n{managed_guidance}"
        if existing
        else managed_guidance
    )
    return result
