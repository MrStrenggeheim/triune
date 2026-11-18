"""Focused tests for the DESIGN-CONTRACT-3 custom lint rule."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

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


@pytest.mark.parametrize(
    ("caller", "override"),
    [
        ("WorkspacePicker", "[&>[data-slot=menu-item]]:px-[var(--list-row-padding-inline)]"),
        ("WorkspacePicker", "[&>[data-slot=menu-item]]:py-0"),
        ("WorkspacePicker", "[&>[data-slot=menu-item]]:min-h-[var(--list-row-min-height)]"),
        ("WorkspacePicker", "[&>[data-slot=menu-item]]:gap-[var(--list-row-gap)]"),
        ("WorkspaceSelectionDialog", "[&_[data-slot='menu-item'][aria-selected=true]]:pl-4"),
    ],
)
def test_picker_caller_geometry_diagnostic(
    caller: str, override: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    path = Path(f"web/src/shell/{caller}.tsx")
    path.parent.mkdir(parents=True)
    path.write_text(f'export const listing = (\n  <div className="px-0 {override}" />\n);\n')
    assert lint.check_paths([path]) == [
        f"{path}:2: caller override of picker row geometry `{override}` "
        "is not in the design contract"
    ]


def test_picker_allows_parent_layout_and_unrelated_targets() -> None:
    source = (
        '<div className="density-list flex flex-col gap-2 min-h-0 overflow-y-auto px-0 '
        "[&_[data-header-action-button]]:size-8 [&>[data-slot=menu-item]:hover_svg]:h-4 "
        '[&>[data-slot=menu-item]]:text-muted-foreground" />'
    )
    assert lint.scan_source(source, "web/src/shell/WorkspacePicker.tsx") == []
    override = 'const classes = "[&>[data-slot=menu-item]]:px-4";'
    assert lint.scan_source(override, "web/src/shell/ProjectPicker.tsx") == []


def test_custom_lint_hook_triggers_for_picker_and_catalog_changes() -> None:
    config = yaml.safe_load(Path(".pre-commit-config.yaml").read_text())
    hook = next(
        hook for repo in config["repos"] for hook in repo["hooks"] if hook["id"] == "custom-lint"
    )
    for path in [*lint.SCOPED_PATHS, "dev/design_catalog.py", "design-system/triune/MASTER.md"]:
        assert re.search(hook["files"], path), path
