"""Seed demo users. Run: python seed.py"""

from __future__ import annotations

from app import create_app
from db import db
from models import User

SEED_USERS = [
    {
        "email": "admin@kyron.local",
        "password": "admin123",
        "full_name": "Kyron Admin",
        "role": "admin",
    },
    {
        "email": "provider1@kyron.local",
        "password": "provider123",
        "full_name": "Dr. Ava Chen",
        "role": "provider",
    },
    {
        "email": "provider2@kyron.local",
        "password": "provider123",
        "full_name": "Dr. Marcus Lee",
        "role": "provider",
    },
]


def seed() -> None:
    app = create_app()
    with app.app_context():
        db.create_all()
        for item in SEED_USERS:
            existing = User.query.filter_by(email=item["email"]).first()
            if existing:
                print(f"skip existing user: {item['email']}")
                continue
            user = User(
                email=item["email"],
                full_name=item["full_name"],
                role=item["role"],
            )
            user.set_password(item["password"])
            db.session.add(user)
            print(f"created {item['role']}: {item['email']} / {item['password']}")
        db.session.commit()
        print("seed complete")


if __name__ == "__main__":
    seed()
