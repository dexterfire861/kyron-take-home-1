"""Import the CMS ICD-10-CM code list into the icd10_codes table.

Source: the "code descriptions" zip from
https://www.cms.gov/medicare/coding-billing/icd-10-codes (fixed-width flat
file: 8-char code column, then the description).

Run: python scripts/import_icd10.py ~/Downloads/icd10cm-code-descriptions-2027.zip
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app
from db import db
from models import IcdCode

CODE_WIDTH = 8


def _find_codes_file(zf: zipfile.ZipFile) -> str:
    candidates = [
        name
        for name in zf.namelist()
        if name.endswith(".txt") and "codes-20" in name and "addenda" not in name
    ]
    if not candidates:
        raise RuntimeError("Could not find an icd10cm-codes-*.txt entry in the zip")
    return candidates[0]


def parse_codes(zip_path: str) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    with zipfile.ZipFile(zip_path) as zf:
        member = _find_codes_file(zf)
        text = zf.read(member).decode("utf-8", errors="replace")

    for line in text.splitlines():
        if not line.strip():
            continue
        code = line[:CODE_WIDTH].strip()
        description = line[CODE_WIDTH:].strip()
        if not code or not description:
            continue
        rows.append((code, description))
    return rows


def import_codes(zip_path: str) -> None:
    app = create_app()
    with app.app_context():
        existing = IcdCode.query.count()
        if existing:
            print(f"icd10_codes already has {existing} rows, skipping import")
            return

        rows = parse_codes(zip_path)
        print(f"parsed {len(rows)} codes from {zip_path}")

        batch_size = 5000
        for start in range(0, len(rows), batch_size):
            chunk = rows[start : start + batch_size]
            db.session.bulk_insert_mappings(
                IcdCode,
                [{"code": code, "description": desc} for code, desc in chunk],
            )
            db.session.commit()
            print(f"  inserted {min(start + batch_size, len(rows))}/{len(rows)}")

        print("import complete")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python scripts/import_icd10.py <path-to-zip>")
        sys.exit(1)
    import_codes(sys.argv[1])
