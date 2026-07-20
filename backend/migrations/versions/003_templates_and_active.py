"""templates, is_active, encounter draft fields

Revision ID: 003
Revises: 002
Create Date: 2026-07-20

"""

from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )

    op.create_table(
        "note_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("system_prompt_addon", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_note_templates_slug", "note_templates", ["slug"], unique=True)

    op.add_column(
        "encounters",
        sa.Column("template_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "encounters",
        sa.Column("last_draft_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_encounters_template_id",
        "encounters",
        "note_templates",
        ["template_id"],
        ["id"],
    )


def downgrade():
    op.drop_constraint("fk_encounters_template_id", "encounters", type_="foreignkey")
    op.drop_column("encounters", "last_draft_at")
    op.drop_column("encounters", "template_id")
    op.drop_index("ix_note_templates_slug", table_name="note_templates")
    op.drop_table("note_templates")
    op.drop_column("users", "is_active")
