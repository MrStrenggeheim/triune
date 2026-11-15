# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Session-scoped product startup configuration for native Hermes."""

from __future__ import annotations

from pathlib import Path

import yaml

from omnigent.runtime.ui_contract import append_ui_contract


def install_hermes_product_guidance(
    hermes_home: Path,
    *,
    session_id: str,
    server_url: str,
    author_instructions: str | None = None,
) -> Path:
    """Append the product contract to Hermes' TUI platform hint."""
    config_path = hermes_home / "config.yaml"
    raw_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    raw = yaml.safe_load(raw_text) if raw_text else {}
    if not isinstance(raw, dict):
        raise ValueError(f"Hermes config must be a mapping: {config_path}")
    config = raw
    if config_path.is_symlink():
        config_path.unlink()
    managed_guidance = append_ui_contract(
        author_instructions,
        "hermes-native",
        session_id=session_id,
        server_url=server_url,
    )
    platform_hints = config.get("platform_hints")
    if not isinstance(platform_hints, dict):
        platform_hints = {}
    for platform in ("cli", "tui"):
        hint = platform_hints.get(platform)
        if isinstance(hint, str):
            hint = {"append": hint}
        elif not isinstance(hint, dict):
            hint = {}
        authored = hint.get("append")
        existing = authored if isinstance(authored, str) else ""
        hint["append"] = (
            existing
            if existing.endswith(managed_guidance)
            else f"{existing}\n\n{managed_guidance}"
            if existing
            else managed_guidance
        )
        platform_hints[platform] = hint
    config["platform_hints"] = platform_hints
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return config_path
