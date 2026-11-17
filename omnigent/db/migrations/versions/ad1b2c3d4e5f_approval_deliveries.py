"""Persist redacted approval delivery attempts before runner handoff.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision = "ad1b2c3d4e5f"
down_revision = "bq1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "omnigent_approval_deliveries",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False),
        sa.Column("conversation_id", Uuid16(), nullable=False),
        sa.Column("elicitation_id", sa.String(256), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("released", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "conversation_id", "elicitation_id"),
        sa.CheckConstraint("state IN ('held', 'accepted')", name="approval_delivery_state"),
    )
    op.create_index(
        "ix_approval_deliveries_recovery",
        "omnigent_approval_deliveries",
        ["state", "released", "workspace_id", "conversation_id"],
    )

    op.create_table(
        "omnigent_approval_delivery_targets",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False),
        sa.Column("visible_conversation_id", Uuid16(), nullable=False),
        sa.Column("conversation_id", Uuid16(), nullable=False),
        sa.Column("elicitation_id", sa.String(256), nullable=False),
        sa.PrimaryKeyConstraint(
            "workspace_id", "visible_conversation_id", "conversation_id", "elicitation_id"
        ),
    )
    op.create_index(
        "ix_approval_delivery_targets_owner",
        "omnigent_approval_delivery_targets",
        ["workspace_id", "conversation_id"],
    )


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM omnigent_approval_deliveries")):
        raise RuntimeError("Preserve approval delivery records before downgrading this schema")
    op.drop_table("omnigent_approval_delivery_targets")
    op.drop_table("omnigent_approval_deliveries")
