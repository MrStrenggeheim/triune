"""Bounded thread pools for request offloads and background sweeps.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import ParamSpec, TypeVar

REQUEST_THREADS = 16
BACKGROUND_THREADS = 2

_Params = ParamSpec("_Params")
_Result = TypeVar("_Result")

# Sweeps and maintenance share this pool so they queue behind each other, not behind requests.
_background = ThreadPoolExecutor(
    max_workers=BACKGROUND_THREADS, thread_name_prefix="triune-background"
)


def install_request_executor(loop: asyncio.AbstractEventLoop) -> ThreadPoolExecutor:
    """Size and name the pool behind ``asyncio.to_thread`` and ``run_in_executor(None, ...)``."""
    executor = ThreadPoolExecutor(max_workers=REQUEST_THREADS, thread_name_prefix="triune-request")
    loop.set_default_executor(executor)
    return executor


async def run_background(
    fn: Callable[_Params, _Result], /, *args: _Params.args, **kwargs: _Params.kwargs
) -> _Result:
    """Run a background sweep's blocking call off the request pool, in the caller's context."""
    context = contextvars.copy_context()

    def call() -> _Result:
        return context.run(fn, *args, **kwargs)

    return await asyncio.get_running_loop().run_in_executor(_background, call)
