"""Focused tests for the DESIGN-CONTRACT-3 custom lint rule."""

from __future__ import annotations

from pathlib import Path

import dev.lint.lint_design_contract as lint


def test_current_canonical_owners_pass() -> None:
    assert lint.check() == []


def test_rejects_unsupported_radius_and_focus_color_literals() -> None:
    source = 'const classes = "rounded-[13px] focus-visible:ring-[#123456]";\n'
    hits = lint.scan_source(source, "web/src/components/ui/button.tsx")
    assert [(hit.line, hit.kind) for hit in hits] == [
        (1, "arbitrary radius"),
        (1, "literal focus color"),
    ]


def test_accepts_exact_named_radius_exceptions() -> None:
    cases = [
        ("web/src/components/ui/checkbox.tsx", "rounded-[4px]"),
        ("web/src/components/ui/select.tsx", "rounded-[12px]"),
        ("web/src/components/ui/switch.tsx", "rounded-full"),
    ]
    for path, token in cases:
        assert lint.scan_source(f'const classes = "{token}";', path) == []


def test_accepts_canonical_radius_variable() -> None:
    source = 'const classes = "rounded-[var(--radius-md)]";\n'
    assert lint.scan_source(source, "web/src/components/HeaderActionButton.tsx") == []
    assert lint.scan_source(source, "web/src/components/CloseButton.tsx") == []


def test_tooltip_and_badge_exceptions_are_exact_without_broadening_scope() -> None:
    assert lint._allows_radius("web/src/components/ui/tooltip.tsx", "rounded-[7px]", "7px")
    assert lint._allows_radius("web/src/components/ui/badge.tsx", "rounded-4xl", None)
    assert (
        lint.scan_source(
            'const classes = "rounded-[13px] focus-visible:ring-[#123456]";',
            "web/src/components/ui/tooltip.tsx",
        )
        == []
    )


def test_scan_ignores_noncanonical_call_sites(tmp_path: Path) -> None:
    path = tmp_path / "FeatureButton.tsx"
    path.write_text('export const classes = "rounded-[13px]";\n')
    assert lint.scan(path) == []
