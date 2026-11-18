"""Find a production owner by interaction and validate the shared Storybook directory."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "design-system/triune/interactions.json"
SOURCE = ROOT / "web/src"
FIELDS = {"task", "owner", "caller", "story", "test"}


def load_catalog() -> list[dict[str, str]]:
    return json.loads(CATALOG.read_text())


def validate(entries: list[dict[str, str]], source: Path) -> list[str]:
    errors = []
    tasks: set[str] = set()
    for number, entry in enumerate(entries, start=1):
        if (
            not isinstance(entry, dict)
            or set(entry) != FIELDS
            or not all(isinstance(value, str) and value.strip() for value in entry.values())
        ):
            errors.append(
                f"entry {number}: expected nonempty strings for {', '.join(sorted(FIELDS))}"
            )
            continue
        task = entry["task"]
        if task.casefold() in tasks:
            errors.append(f"duplicate task: {task}")
        tasks.add(task.casefold())
        for field in ("owner", "caller", "story", "test"):
            path, _, export = entry[field].partition("#")
            target = source / path
            if not target.resolve().is_relative_to(source.resolve()) or not target.is_file():
                errors.append(f"{task}: missing {field} under web/src: {path}")
            elif field == "story" and (
                not path.endswith(".stories.tsx")
                or not export.isidentifier()
                or not re.search(rf"^export const {re.escape(export)}\b", target.read_text(), re.M)
            ):
                errors.append(f"{task}: missing Storybook export: {entry[field]}")
    return errors


def check() -> list[str]:
    try:
        entries = load_catalog()
        if not isinstance(entries, list) or not entries:
            return ["design catalog must contain a nonempty list of interactions"]
        return validate(entries, SOURCE)
    except (OSError, ValueError) as error:
        return [f"cannot read design catalog: {error}"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("words", nargs="*", help="task or component name")
    args = parser.parse_args()
    if errors := check():
        print("\n".join(errors))
        return 1
    matched = False
    for entry in load_catalog():
        terms = " ".join((entry["task"], entry["owner"], entry["caller"])).casefold()
        if all(word.casefold() in terms for word in args.words):
            matched = True
            print(entry["task"])
            for field in ("owner", "caller", "story", "test"):
                print(f"  {field:5}  web/src/{entry[field]}")
    if not matched:
        print(
            "No catalog match. Check existing production examples before proposing a new pattern."
        )
    return 0 if matched else 1


if __name__ == "__main__":
    raise SystemExit(main())
