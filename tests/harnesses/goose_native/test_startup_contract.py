# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import pytest

from omnigent.harnesses.goose_native.startup import goose_product_startup_env


def test_product_contract_preserves_existing_top_of_mind() -> None:
    env = goose_product_startup_env(
        {"GOOSE_MOIM_MESSAGE_TEXT": "author", "KEEP": "yes"},
        session_id="session-1",
        server_url="https://triune.example",
        author_instructions="agent spec",
    )

    assert env["KEEP"] == "yes"
    assert env["GOOSE_MOIM_MESSAGE_TEXT"].startswith("author\n\nagent spec\n\nTriune UI contract")
    assert "--session session-1 --server https://triune.example" in env["GOOSE_MOIM_MESSAGE_TEXT"]
    repeated = goose_product_startup_env(
        env,
        session_id="session-1",
        server_url="https://triune.example",
        author_instructions="agent spec",
    )
    assert repeated["GOOSE_MOIM_MESSAGE_TEXT"] == env["GOOSE_MOIM_MESSAGE_TEXT"]


def test_product_contract_respects_disabled_top_of_mind() -> None:
    with pytest.raises(ValueError, match="Top Of Mind is disabled"):
        goose_product_startup_env(
            {},
            session_id="session-1",
            server_url="https://triune.example",
            top_of_mind_enabled=False,
        )
