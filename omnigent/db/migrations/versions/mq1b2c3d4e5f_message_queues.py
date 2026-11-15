"""Persist after-turn message queues.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision = "mq1b2c3d4e5f"
down_revision = "wsc2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "omnigent_message_queues",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False),
        sa.Column("conversation_id", Uuid16(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "conversation_id"),
        sa.ForeignKeyConstraint(
            ["workspace_id", "conversation_id"],
            ["omnigent_conversation_metadata.workspace_id", "omnigent_conversation_metadata.id"],
            ondelete="CASCADE",
        ),
    )


def downgrade() -> None:
    op.drop_table("omnigent_message_queues")
