from flask import Blueprint, g, jsonify, request

from auth import create_access_token, login_required
from models import User

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@auth_bp.post("/login")
def login():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""

    if not email or not password:
        return jsonify({"error": "email and password are required"}), 400

    user = User.query.filter_by(email=email).first()
    if user is None or not user.check_password(password):
        return jsonify({"error": "Invalid email or password"}), 401

    token = create_access_token(user)
    return jsonify({"access_token": token, "user": user.to_dict()})


@auth_bp.get("/me")
@login_required
def me():
    return jsonify({"user": g.current_user.to_dict()})
