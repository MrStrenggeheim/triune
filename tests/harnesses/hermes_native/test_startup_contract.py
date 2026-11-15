# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
from pathlib import Path

import pytest
import yaml

from omnigent.harnesses.hermes_native.startup import install_hermes_product_guidance


def test_product_contract_preserves_existing_config(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "model: author-model\nplatform_hints:\n  tui:\n    append: author\n",
        encoding="utf-8",
    )

    install_hermes_product_guidance(
        tmp_path,
        session_id="session-1",
        server_url="https://triune.example",
        author_instructions="agent spec",
    )

    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert config["model"] == "author-model"
    guidance = config["platform_hints"]["tui"]["append"]
    assert guidance.startswith("author\n\nagent spec\n\nTriune UI contract")
    assert "--session session-1 --server https://triune.example" in guidance
    assert config["platform_hints"]["cli"]["append"].startswith("agent spec\n\nTriune UI contract")
    install_hermes_product_guidance(
        tmp_path,
        session_id="session-1",
        server_url="https://triune.example",
        author_instructions="agent spec",
    )
    repeated = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert repeated["platform_hints"]["tui"]["append"] == guidance


def test_product_contract_breaks_config_symlink_without_mutating_author(
    tmp_path: Path,
) -> None:
    author_config = tmp_path / "author.yaml"
    author_text = "model: author-model\n"
    author_config.write_text(author_text, encoding="utf-8")
    hermes_home = tmp_path / "session"
    hermes_home.mkdir()
    (hermes_home / "config.yaml").symlink_to(author_config)

    install_hermes_product_guidance(
        hermes_home, session_id="session-1", server_url="https://triune.example"
    )

    session_config = hermes_home / "config.yaml"
    assert not session_config.is_symlink()
    assert yaml.safe_load(session_config.read_text())["model"] == "author-model"
    assert author_config.read_text(encoding="utf-8") == author_text


def test_product_contract_rejects_non_mapping_config(tmp_path: Path) -> None:
    (tmp_path / "config.yaml").write_text("- not\n- a mapping\n", encoding="utf-8")

    with pytest.raises(ValueError, match="must be a mapping"):
        install_hermes_product_guidance(
            tmp_path, session_id="session-1", server_url="https://triune.example"
        )
