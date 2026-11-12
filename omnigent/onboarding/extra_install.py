"""Install optional Triune extras using the checkout or maintained fork source.

Tool installs retain their environment; other installers target the running Python.
Legacy upstream metadata must never send this fork back to an upstream package.
"""

from __future__ import annotations

# Modified for Triune.
import os
import shutil
import sys


def _is_uv_tool_install() -> bool:
    """Return whether the running interpreter lives inside a ``uv tool`` venv.

    ``uv tool install`` creates per-tool environments under a platform-specific
    ``uv/tools/<package>/`` directory.  Checking ``sys.prefix`` for the
    ``uv/tools/`` segment mirrors the ``pipx/venvs`` heuristic in
    :func:`omnigent.update_check._looks_like_pipx_install`.

    .. note::

       Misses custom layouts set via ``UV_TOOL_DIR`` / ``XDG_DATA_HOME``
       (falls through to ``uv pip install``, same accepted gap as the pipx
       heuristic).
    """
    return "uv/tools/" in sys.prefix.replace(os.sep, "/")


def _installed_vcs_url() -> str | None:
    """Return the recorded VCS URL, including legacy metadata when present."""
    from omnigent.update_check import _read_installed_wheel_info

    info = _read_installed_wheel_info()
    return info.vcs_url if info is not None else None


def extra_install_command(extra: str) -> list[str]:
    """Build an install command for a Triune extra from the maintained source."""
    from omnigent.update_check import TRIUNE_SOURCE_URL, _find_repo_root

    repo_root = _find_repo_root()
    vcs_url = _installed_vcs_url()
    if repo_root is not None:
        source = repo_root.as_uri()
    elif vcs_url and "github.com/mrstrenggeheim/triune" in vcs_url.lower():
        source = vcs_url
    else:
        source = f"git+{TRIUNE_SOURCE_URL}@main"
    target = f"triune[{extra}] @ {source}"

    if _is_uv_tool_install():
        return ["uv", "tool", "install", "--force", target]

    if shutil.which("uv") is not None:
        # ``--python`` pins the install to the interpreter that will import the
        # extra.  Without it ``uv pip install`` requires an active virtualenv
        # and errors out on Homebrew/pipx/system installs that merely have uv
        # on PATH.
        return ["uv", "pip", "install", "--python", sys.executable, target]

    return [sys.executable, "-P", "-m", "pip", "install", target]


def extra_install_display(extra: str) -> str:
    """Return a human-readable command string for installing *extra*.

    Derived from :func:`extra_install_command` so the displayed text always
    matches what actually runs.

    :param extra: The pip extra name, e.g. ``"cursor"``.
    :returns: A shell-style command string.
    """
    import shlex

    return " ".join(shlex.quote(tok) for tok in extra_install_command(extra))
