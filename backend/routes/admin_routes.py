from __future__ import annotations

from datetime import datetime, timezone

from flask import Blueprint, g, jsonify, request
from werkzeug.security import generate_password_hash

from auth import admin_required
from db import db
from models import Encounter, NoteTemplate, User, utcnow

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


@admin_bp.get("/encounters")
@admin_required
def list_all_encounters():
    provider_id = request.args.get("provider_id", type=int)
    date_from = (request.args.get("from") or "").strip()
    date_to = (request.args.get("to") or "").strip()

    query = Encounter.query.order_by(Encounter.created_at.desc())
    if provider_id:
        query = query.filter_by(provider_id=provider_id)
    if date_from:
        try:
            start = datetime.fromisoformat(date_from).replace(tzinfo=timezone.utc)
            query = query.filter(Encounter.created_at >= start)
        except ValueError:
            return jsonify({"error": "from must be ISO date or datetime"}), 400
    if date_to:
        try:
            end = datetime.fromisoformat(date_to).replace(tzinfo=timezone.utc)
            # Inclusive end-of-day if date-only
            if len(date_to) <= 10:
                end = end.replace(hour=23, minute=59, second=59)
            query = query.filter(Encounter.created_at <= end)
        except ValueError:
            return jsonify({"error": "to must be ISO date or datetime"}), 400

    rows = []
    for enc in query.limit(200).all():
        item = enc.to_dict(include_note=False)
        item["provider"] = {
            "id": enc.provider.id,
            "full_name": enc.provider.full_name,
            "email": enc.provider.email,
        }
        item["has_note"] = enc.note is not None and any(enc.note.soap_dict().values())
        rows.append(item)
    return jsonify({"encounters": rows})


@admin_bp.get("/providers")
@admin_required
def list_providers():
    providers = (
        User.query.filter_by(role="provider")
        .order_by(User.full_name.asc())
        .all()
    )
    return jsonify({"providers": [p.to_dict() for p in providers]})


@admin_bp.post("/providers")
@admin_required
def create_provider():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    full_name = (payload.get("full_name") or "").strip()
    password = payload.get("password") or ""

    if not email or not full_name or not password:
        return jsonify({"error": "email, full_name, and password are required"}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "A user with that email already exists"}), 409

    user = User(
        email=email,
        full_name=full_name,
        role="provider",
        is_active=True,
        password_hash=generate_password_hash(password),
    )
    db.session.add(user)
    db.session.commit()
    return jsonify({"provider": user.to_dict()}), 201


@admin_bp.patch("/providers/<int:provider_id>")
@admin_required
def update_provider(provider_id: int):
    user = db.session.get(User, provider_id)
    if user is None or user.role != "provider":
        return jsonify({"error": "Provider not found"}), 404

    payload = request.get_json(silent=True) or {}
    if "full_name" in payload:
        name = (payload.get("full_name") or "").strip()
        if not name:
            return jsonify({"error": "full_name cannot be empty"}), 400
        user.full_name = name
    if "is_active" in payload:
        user.is_active = bool(payload.get("is_active"))
    if payload.get("password"):
        user.set_password(str(payload["password"]))

    db.session.commit()
    return jsonify({"provider": user.to_dict()})


@admin_bp.get("/templates")
@admin_required
def list_templates_admin():
    templates = NoteTemplate.query.order_by(NoteTemplate.name.asc()).all()
    return jsonify({"templates": [t.to_dict() for t in templates]})


@admin_bp.post("/templates")
@admin_required
def create_template():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    slug = (payload.get("slug") or "").strip().lower().replace(" ", "_")
    description = (payload.get("description") or "").strip()
    addon = (payload.get("system_prompt_addon") or "").strip()

    if not name or not slug or not addon:
        return jsonify(
            {"error": "name, slug, and system_prompt_addon are required"}
        ), 400
    if NoteTemplate.query.filter_by(slug=slug).first():
        return jsonify({"error": "Template slug already exists"}), 409

    now = utcnow()
    template = NoteTemplate(
        name=name,
        slug=slug,
        description=description,
        system_prompt_addon=addon,
        is_active=bool(payload.get("is_active", True)),
        created_at=now,
        updated_at=now,
    )
    db.session.add(template)
    db.session.commit()
    return jsonify({"template": template.to_dict()}), 201


@admin_bp.patch("/templates/<int:template_id>")
@admin_required
def update_template(template_id: int):
    template = db.session.get(NoteTemplate, template_id)
    if template is None:
        return jsonify({"error": "Template not found"}), 404

    payload = request.get_json(silent=True) or {}
    if "name" in payload:
        name = (payload.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name cannot be empty"}), 400
        template.name = name
    if "description" in payload:
        template.description = (payload.get("description") or "").strip()
    if "system_prompt_addon" in payload:
        addon = (payload.get("system_prompt_addon") or "").strip()
        if not addon:
            return jsonify({"error": "system_prompt_addon cannot be empty"}), 400
        template.system_prompt_addon = addon
    if "is_active" in payload:
        template.is_active = bool(payload.get("is_active"))
    if "slug" in payload:
        slug = (payload.get("slug") or "").strip().lower().replace(" ", "_")
        if not slug:
            return jsonify({"error": "slug cannot be empty"}), 400
        clash = NoteTemplate.query.filter(
            NoteTemplate.slug == slug, NoteTemplate.id != template.id
        ).first()
        if clash:
            return jsonify({"error": "Template slug already exists"}), 409
        template.slug = slug

    template.updated_at = utcnow()
    db.session.commit()
    return jsonify({"template": template.to_dict()})


@admin_bp.delete("/templates/<int:template_id>")
@admin_required
def delete_template(template_id: int):
    template = db.session.get(NoteTemplate, template_id)
    if template is None:
        return jsonify({"error": "Template not found"}), 404
    in_use = Encounter.query.filter_by(template_id=template.id).count()
    if in_use:
        # Soft-delete to preserve FK integrity for historical encounters
        template.is_active = False
        template.updated_at = utcnow()
        db.session.commit()
        return jsonify({"template": template.to_dict(), "soft_deleted": True})
    db.session.delete(template)
    db.session.commit()
    return jsonify({"ok": True})
