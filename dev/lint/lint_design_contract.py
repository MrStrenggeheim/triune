"""Enforce stable literal parts of DESIGN-CONTRACT-3 in shared UI owners.

This intentionally checks exact canonical component files and literal Tailwind
tokens only. Dynamic classes and call sites remain review concerns.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

RULE_NAME = "design-contract"
HINT = (
    "Use the canonical rounded classes or rounded-[var(--radius-*)], and semantic "
    "focus colors such as border-ring/ring-ring. The only literal shape exceptions "
    "in this surface are Checkbox 4px, Select popup 12px, and Switch rounded-full."
)

SCOPED_PATHS = frozenset(
    {
        "web/src/components/HeaderActionButton.tsx",
        "web/src/components/CloseButton.tsx",
        "web/src/components/ui/button.tsx",
        "web/src/components/ui/checkbox.tsx",
        "web/src/components/ui/input.tsx",
        "web/src/components/ui/select.tsx",
        "web/src/components/ui/switch.tsx",
        "web/src/components/ui/textarea.tsx",
    }
)

_TOKEN_PREFIX = r"[^\s\"'`]*"
_ARBITRARY_RADIUS = re.compile(
    rf"(?P<token>{_TOKEN_PREFIX}rounded(?:-[trblxy]{{1,2}})?-\[(?P<value>[^\]\s]+)\])"
)
_CAPSULE_RADIUS = re.compile(rf"(?P<token>{_TOKEN_PREFIX}rounded-full)\b")
_FOCUS_COLOR_LITERAL = re.compile(
    rf"(?P<token>{_TOKEN_PREFIX}(?:focus|focus-visible|focus-within):"
    r"(?:border|ring|outline|bg|text)-\[(?P<value>(?:#|rgb\(|rgba\(|hsl\(|hsla\(|oklch\(|oklab\(|color\()[^\]]+)\])"
)


@dataclass(frozen=True)
class Hit:
    """One unsupported literal token."""

    line: int
    token: str
    kind: str


def _relative_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _allows_radius(path: str, token: str, value: str | None) -> bool:
    """Return whether an exact, named contract exception applies."""
    if "var(--radius-" in (value or ""):
        return True
    if path == "web/src/components/ui/checkbox.tsx" and value == "4px":
        return True
    if path == "web/src/components/ui/select.tsx" and value == "12px":
        return True
    if path == "web/src/components/ui/switch.tsx" and token.endswith("rounded-full"):
        return True
    # Named exceptions are explicit even though Badge and Tooltip are outside
    # this rule's deliberately narrow owner surface.
    if path == "web/src/components/ui/tooltip.tsx" and value == "7px":
        return True
    if path == "web/src/components/ui/badge.tsx" and token.endswith("rounded-4xl"):
        return True
    return False


def scan_source(source: str, path: str) -> list[Hit]:
    """Find stable literal violations in one canonical owner source."""
    if path not in SCOPED_PATHS:
        return []
    hits: list[Hit] = []
    for line_number, line in enumerate(source.splitlines(), 1):
        for match in _ARBITRARY_RADIUS.finditer(line):
            if not _allows_radius(path, match.group("token"), match.group("value")):
                hits.append(Hit(line_number, match.group("token"), "arbitrary radius"))
        for match in _CAPSULE_RADIUS.finditer(line):
            if not _allows_radius(path, match.group("token"), None):
                hits.append(Hit(line_number, match.group("token"), "capsule radius"))
        hits.extend(
            Hit(line_number, match.group("token"), "literal focus color")
            for match in _FOCUS_COLOR_LITERAL.finditer(line)
        )
    return hits


def scan(path: Path) -> list[Hit]:
    """Scan a file when it is one of the canonical shared owners."""
    relative = _relative_path(path)
    if relative not in SCOPED_PATHS:
        return []
    try:
        return scan_source(path.read_text(), relative)
    except (OSError, UnicodeDecodeError):
        return []


def _iter_scoped_paths() -> list[Path]:
    output = subprocess.check_output(["git", "ls-files", "-z", *sorted(SCOPED_PATHS)])
    return [Path(raw) for raw in output.decode().split("\0") if raw]


def check_paths(paths: list[Path]) -> list[str]:
    """Return custom-lint messages for explicit paths."""
    return [
        f"{_relative_path(path)}:{hit.line}: {hit.kind} `{hit.token}` "
        "is not in the design contract"
        for path in paths
        for hit in scan(path)
    ]


def check() -> list[str]:
    """Check the complete canonical owner surface."""
    return check_paths(_iter_scoped_paths())


def main(argv: list[str] | None = None) -> int:
    """Check supplied files, or the full surface when none are supplied."""
    args = (argv if argv is not None else sys.argv)[1:]
    messages = check_paths([Path(arg) for arg in args]) if args else check()
    if messages:
        print("\n".join(messages))
        print(HINT)
    return int(bool(messages))


if __name__ == "__main__":
    sys.exit(main())
