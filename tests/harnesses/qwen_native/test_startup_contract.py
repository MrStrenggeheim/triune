from __future__ import annotations

# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
from omnigent.harnesses.qwen_native import main


def test_product_contract_appends_vendor_startup_argument() -> None:
    assert main._with_product_system_prompt(("--model", "qwen"), "product") == (
        "--model",
        "qwen",
        "--append-system-prompt",
        "product",
    )


def test_product_contract_preserves_authored_append_prompt() -> None:
    assert main._with_product_system_prompt(("--append-system-prompt", "author"), "product") == (
        "--append-system-prompt",
        "author\n\nproduct",
    )


def test_product_contract_preserves_equals_form() -> None:
    assert main._with_product_system_prompt(("--append-system-prompt=author",), "product") == (
        "--append-system-prompt=author\n\nproduct",
    )


def test_product_contract_follows_the_effective_last_author_append_prompt() -> None:
    args = main._with_product_system_prompt(
        ("--append-system-prompt=old", "--append-system-prompt", "effective"), "product"
    )
    assert args[-1] == "effective\n\nproduct"
    assert args[0] == "--append-system-prompt=old"
