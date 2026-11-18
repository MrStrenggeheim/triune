from dev.design_queue import inspect_queue


def test_every_open_ticket_needs_routing_even_in_a_filtered_review() -> None:
    queue = """- [ ] UI-1 — picker <!-- ux: picker, composer -->
- [ ] ACCENT-2 — focus <!-- ux: all -->
- [ ] RUNTIME-3 — timing <!-- ux: delivery -->
- [ ] NEW-4 — pending
- [x] OLD-5 — complete
"""
    matches, errors = inspect_queue(queue, {"picker"})
    assert [row.split()[0] for row in matches] == ["UI-1", "ACCENT-2"]
    assert len(errors) == 1 and "line 4:" in errors[0]
    matches, _ = inspect_queue(queue, {"picker", "delivery"})
    assert [row.split()[0] for row in matches] == ["UI-1", "ACCENT-2", "RUNTIME-3"]


def test_duplicate_ticket_is_reported() -> None:
    item = "- [ ] UI-1 — work <!-- ux: picker -->\n"
    assert "duplicate ticket UI-1" in inspect_queue(item * 2, set())[1][0]
