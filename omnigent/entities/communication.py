# Modified for Triune.
"""Trusted message provenance, independent of model role and account identity."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DeliveryState = Literal["pending", "queued", "confirmed", "unknown", "failed"]


class MessageCommunication(BaseModel):
    """Server or native-adapter supplied provenance; never inferred from message text."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["peer", "native_agent", "system", "external"]
    message_id: str = Field(min_length=1, max_length=256)
    source_conversation_id: str | None = None
    source_agent_id: str | None = None
    source_agent_name: str | None = Field(default=None, min_length=1, max_length=256)
    source_resource_scope: dict[str, Any] | None = None
    source_title: str | None = None
    destination_conversation_id: str
    sent_at: int | None = None
    reply_to_message_id: str | None = None
    task_id: str | None = None
    delivery_state: DeliveryState = "unknown"
    receipt: Literal["accepted", "transcript", "inbox_drained", "model_consumed"] | None = None
    hop_count: int = Field(default=0, ge=0, le=16)
