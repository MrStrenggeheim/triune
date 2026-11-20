"""Request offloads and background sweeps run on separate named pools."""

from __future__ import annotations

import asyncio
import contextvars
import threading

import pytest

from omnigent.server.executors import REQUEST_THREADS, install_request_executor, run_background

pytestmark = pytest.mark.asyncio
_caller = contextvars.ContextVar[str]("caller")


async def test_sweeps_keep_the_callers_context_off_the_request_pool() -> None:
    executor = install_request_executor(asyncio.get_running_loop())
    _caller.set("workspace-17")

    def current() -> tuple[str, str]:
        return threading.current_thread().name, _caller.get()

    # Closing the test's loop shuts its default executor down.
    request_thread, _ = await asyncio.to_thread(current)
    background_thread, context = await run_background(current)
    assert executor._max_workers == REQUEST_THREADS
    assert request_thread.startswith("triune-request")
    assert background_thread.startswith("triune-background")
    assert context == "workspace-17"
