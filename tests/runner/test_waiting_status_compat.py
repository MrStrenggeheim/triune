"""
Unit tests for the runner's session.status "waiting" gate.

Every Triune server serializes "waiting"; the runner downgrades it to "running"
only when the server reports an unparseable version.
"""

from __future__ import annotations

import pytest

from omnigent.runner.app import _version_supports_waiting_status


@pytest.mark.parametrize(
    ("server_version", "expected"),
    [
        ("0.1.0", True),
        ("0.1.0.dev0", True),
        ("0.20.0", True),
        ("1.0.0", True),
        ("source", False),  # source installs can report non-PEP-440 metadata
        ("not-a-version", False),  # malformed probes fail closed
    ],
)
def test_version_supports_waiting_status(server_version: str, expected: bool) -> None:
    assert _version_supports_waiting_status(server_version) is expected
