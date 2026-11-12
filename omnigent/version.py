"""Runtime source of truth for the omnigent version.

``VERSION`` is the version string the runtime imports directly — the CLI
(``--version``), the server's ``/api/version`` endpoint, and the
host/runner ``hello`` frames all read this same value. Importing the
constant (rather than reading ``importlib.metadata``) means the version is
correct regardless of how the package was installed.

This constant mirrors the canonical ``[project].version`` in
``pyproject.toml``; a pre-commit hook (``scripts/sync_version_py.py``) keeps
the two in sync, so releases are cut by bumping pyproject alone (via
``scripts/update_versions.py``).
"""

# Modified for Triune.

import importlib.metadata

VERSION = "0.20.0"


def installed_distribution() -> importlib.metadata.Distribution | None:
    """Read Triune metadata, falling back to the legacy distribution name."""
    for name in ("triune", "omnigent"):
        try:
            return importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    return None


def installed_version() -> str:
    """Return the installed version, or the source version when uninstalled."""
    distribution = installed_distribution()
    return distribution.version if distribution is not None else VERSION
