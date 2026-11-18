"""Check UX routing on an implementation queue and list the open tickets for one area."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

OPEN = re.compile(r"^\s*[-*] \[ \]\s+(.*)")
TICKET = re.compile(r"([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b")
AREAS = re.compile(r"<!-- ux: ([a-z0-9-]+(?:, [a-z0-9-]+)*) -->\s*$")


def inspect_queue(text: str, areas: set[str]) -> tuple[list[str], list[str]]:
    tickets = set()
    matches, errors = [], []
    for number, line in enumerate(text.splitlines(), 1):
        if not (item := OPEN.match(line)):
            continue
        ticket = TICKET.match(item[1])
        scopes = AREAS.search(item[1])
        if not ticket or not scopes:
            errors.append(f"line {number}: open ticket needs an ID and <!-- ux: area -->")
            continue
        key = ticket[1]
        if key in tickets:
            errors.append(f"line {number}: duplicate ticket {key}")
        tickets.add(key)
        ticket_areas = scopes[1].split(", ")
        if not areas or "all" in ticket_areas or areas.intersection(ticket_areas):
            matches.append(f"{key}  [{scopes[1]}]  line {number}")
    return matches, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("queue", type=Path, help="the current owner's Markdown checklist")
    parser.add_argument(
        "--area", action="append", default=[], help="affected area; repeat for callers"
    )
    args = parser.parse_args()
    matches, errors = inspect_queue(args.queue.read_text(), set(args.area))
    for message in matches + errors:
        print(message)
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
