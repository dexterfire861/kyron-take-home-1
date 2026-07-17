"""icd10 codes + note suggestions

Revision ID: 002
Revises: 001
Create Date: 2026-07-17

"""

from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.create_table(
        "icd10_codes",
        sa.Column("code", sa.String(length=8), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
    )
    op.execute(
        "CREATE INDEX ix_icd10_codes_description_trgm ON icd10_codes "
        "USING gin (description gin_trgm_ops)"
    )

    op.create_table(
        "note_icd_suggestions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("note_id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=8), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("similarity", sa.Float(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="suggested"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["code"], ["icd10_codes.code"]),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_note_icd_suggestions_note_id", "note_icd_suggestions", ["note_id"]
    )


def downgrade():
    op.drop_index("ix_note_icd_suggestions_note_id", table_name="note_icd_suggestions")
    op.drop_table("note_icd_suggestions")
    op.execute("DROP INDEX IF EXISTS ix_icd10_codes_description_trgm")
    op.drop_table("icd10_codes")
