from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Callable

import jwt
from flask import g, jsonify, request

from models import User

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24


def _jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET is not set")
    return secret


def create_access_token(user: User) -> str:
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])


def login_required(fn: Callable):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "Authentication required"}), 401
        token = header[7:].strip()
        if not token:
            return jsonify({"error": "Authentication required"}), 401
        try:
            payload = decode_access_token(token)
            user = db_get_user(int(payload["sub"]))
        except (jwt.PyJWTError, KeyError, ValueError, TypeError):
            return jsonify({"error": "Invalid or expired token"}), 401
        if user is None:
            return jsonify({"error": "User not found"}), 401
        if not user.is_active:
            return jsonify(
                {
                    "error": "account_deactivated",
                    "message": "This account has been deactivated. Contact an administrator.",
                }
            ), 403
        g.current_user = user
        return fn(*args, **kwargs)

    return wrapper


def db_get_user(user_id: int) -> User | None:
    from db import db

    return db.session.get(User, user_id)


def provider_required(fn: Callable):
    @wraps(fn)
    @login_required
    def wrapper(*args, **kwargs):
        if g.current_user.role not in ("provider", "admin"):
            return jsonify({"error": "Provider access required"}), 403
        return fn(*args, **kwargs)

    return wrapper


def admin_required(fn: Callable):
    @wraps(fn)
    @login_required
    def wrapper(*args, **kwargs):
        if g.current_user.role != "admin":
            return jsonify({"error": "Admin access required"}), 403
        return fn(*args, **kwargs)

    return wrapper
