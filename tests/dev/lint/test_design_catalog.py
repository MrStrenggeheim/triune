"""The review book and agent lookup must resolve the same production examples."""

from dev import design_catalog as catalog


def test_catalog_links_resolve() -> None:
    assert catalog.check() == []


def test_stale_owner_and_story_are_actionable() -> None:
    entry = dict(catalog.load_catalog()[0], owner="missing.tsx")
    entry["story"] = entry["story"].split("#")[0] + "#RenamedStory"
    failures = catalog.validate([entry], catalog.SOURCE)
    assert any("missing owner" in message for message in failures)
    assert any("RenamedStory" in message for message in failures)
