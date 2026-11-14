# Modified for Triune; inherited notices remain applicable.
"""Usage tests for Codex forwarder."""

from __future__ import annotations

import pytest

from omnigent.harnesses.codex_native import forwarder as fwd
from tests.harnesses.codex_native.forwarder._support import (
    _RecordingClient,
)

# ── sub-agent usage pricing: seed the child coalescer's model ──────────


@pytest.mark.asyncio
async def test_usage_coalescer_seeded_model_rides_along_so_child_usage_prices() -> None:
    """A coalescer seeded with a model attaches it to its token post.

    Codex sub-agent (child-thread) usage is recorded on a coalescer created on
    the child-event path, where ``forwarder_state`` (the usual model source) is
    intentionally ``None`` — so ``record()`` receives no model. Without the
    constructor seed the token post carries no ``model``, the server leaves the
    child's ``total_cost_usd`` unpriced (``None``), and the sub-agent's spend
    drops out of the parent's subtree cost — letting it run past the budget.
    The seeded model must ride along on every token post so the server can
    price the cumulative tokens.
    """
    client = _RecordingClient()
    coalescer = fwd._SessionUsageCoalescer(client, "conv_child", model="gpt-5.5")
    # Mirror the child path exactly: a usage frame with NO model in record().
    coalescer.record({"tokenUsage": {"total": {"inputTokens": 46003, "outputTokens": 4141}}})
    await coalescer.flush()

    assert len(client.posts) == 1  # one external_session_usage post
    url, body = client.posts[0]
    assert url == "/v1/sessions/conv_child/events"
    assert body["type"] == "external_session_usage"
    data = body["data"]
    # The seeded model rides along — this is what lets the server price the
    # tokens into the child's total_cost_usd (the whole point of the fix).
    assert data["model"] == "gpt-5.5"
    # The cumulative token counts the server prices from are present.
    assert data["cumulative_input_tokens"] == 46003
    assert data["cumulative_output_tokens"] == 4141


@pytest.mark.asyncio
async def test_usage_coalescer_unseeded_omits_model() -> None:
    """Without a seed (and no model via record), the post carries no model.

    This is the pre-fix behavior that left a sub-agent's cost unpriced; the
    test pins the contrast so a regression dropping the seed is caught (the
    post would silently go back to model-less and the budget gap would return).
    """
    client = _RecordingClient()
    coalescer = fwd._SessionUsageCoalescer(client, "conv_child")  # no model seed
    coalescer.record({"tokenUsage": {"total": {"inputTokens": 100, "outputTokens": 5}}})
    await coalescer.flush()

    assert len(client.posts) == 1
    _url, body = client.posts[0]
    assert "model" not in body["data"]


@pytest.mark.asyncio
@pytest.mark.parametrize("email", [None, "owner@example.test"])
async def test_account_snapshot_and_sparse_broadcast_do_not_route_to_thread(tmp_path, email):
    from omnigent.harnesses.codex_native.runtime_notices import CodexRuntimeNotices

    class Native:
        def __init__(self):
            self.calls = []
            self.account = {"type": "chatgpt", "email": email, "planType": "plus"}

        async def request(self, method, params):
            self.calls.append((method, params))
            if method == "account/read":
                return {
                    "result": {
                        "account": self.account,
                        "requiresOpenaiAuth": True,
                        "workspaceRouting": {
                            "chatgptAccountId": "workspace-account",
                            "backendOrigin": "https://chatgpt.com",
                            "accountRoutingOverride": "NO_CONSTRAINT",
                        },
                    }
                }
            assert method == "account/rateLimits/read"
            return {
                "result": {
                    "rateLimits": {"primary": {"usedPercent": 95, "resetsAt": 100}},
                    "ordinaryUsageAllowed": None,
                    "rateLimitsByLimitId": None,
                    "rateLimitResetCredits": None,
                    "accountId": None,
                    "rateLimitUpsell": None,
                }
            }

    client = _RecordingClient()
    native = Native()
    observer = CodexRuntimeNotices(client, native, "bound-session", "server-a")
    await observer.snapshot()
    state = fwd._CodexForwarderState(parent_session_id="bound-session", runtime_notices=observer)
    tracker = fwd._CodexElicitationTaskTracker()
    try:
        await fwd._handle_event(
            client,
            session_id="unrelated-active-chat",
            bridge_dir=tmp_path,
            event={
                "method": "account/rateLimits/updated",
                "params": {"rateLimits": {"primary": {"usedPercent": 100}}},
            },
            usage_coalescer=fwd._SessionUsageCoalescer(client, "unrelated-active-chat"),
            elicitation_tracker=tracker,
            forwarder_state=state,
        )
        assert [path for path, _ in client.posts] == ["/v1/sessions/bound-session/events"] * 3
        data = client.posts[-1][1]["data"]
        assert "account_id" not in data and data["scope_kind"] == "captured_parent"
        assert data["account"] == native.account
        assert data["workspace_routing"]["chatgptAccountId"] == "workspace-account"
        assert native.calls == [
            ("account/read", {"refreshToken": False}),
            ("account/rateLimits/read", {}),
        ]
        epoch = data["scope_epoch"]
        native.account = {"type": "chatgpt", "email": None, "planType": "pro"}
        await observer.handle("account/updated", {"authMode": "chatgpt", "planType": "pro"})
        assert client.posts[-2][1]["data"]["kind"] == "account"
        assert client.posts[-2][1]["data"]["account"] is None
        assert client.posts[-1][1]["data"]["scope_epoch"] != epoch
        assert native.calls[-2:] == [
            ("account/read", {"refreshToken": False}),
            ("account/rateLimits/read", {}),
        ]
        await observer.handle("account/updated", {"authMode": None, "planType": None})
        count = len(client.posts)
        await observer.handle(
            "account/rateLimits/updated", {"rateLimits": {"primary": {"usedPercent": 100}}}
        )
        assert len(client.posts) == count and client.posts[-1][1]["data"]["account"] is None
        native.account = {"type": "apiKey"}
        await observer.snapshot()
        assert (
            native.calls[-1][0] == "account/read"
            and client.posts[-1][1]["data"]["account"] is None
        )
        native.account = None
        await observer.snapshot()
        assert observer.account is None
    finally:
        await tracker.close()


@pytest.mark.asyncio
async def test_completed_codex_message_transports_provider_phase():
    client = _RecordingClient()
    for phase in ("commentary", "final_answer", None):
        assert await fwd._post_agent_message(
            client,
            "child",
            {"turnId": "turn-a"},
            {"type": "agentMessage", "id": f"item-{phase}", "text": "Observed", "phase": phase},
        )
        assert client.posts[-1][1]["data"]["item_data"]["phase"] == phase
