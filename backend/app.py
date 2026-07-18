import os

from flask import Flask, jsonify
from flask_cors import CORS

from db import db, migrate
from routes.auth_routes import auth_bp
from routes.encounter_routes import encounters_bp
from routes.patient_routes import patients_bp
from secrets_loader import load_secrets


def create_app() -> Flask:
    load_secrets()

    database_url = os.getenv("DATABASE_URL")
    jwt_secret = os.getenv("JWT_SECRET")
    if not database_url or not jwt_secret:
        raise RuntimeError(
            "DATABASE_URL and JWT_SECRET must be set (via .env locally, "
            "or AWS_SSM_PREFIX + Parameter Store in production)"
        )

    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = database_url
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        "pool_size": int(os.getenv("DB_POOL_SIZE", "5")),
        "max_overflow": int(os.getenv("DB_POOL_MAX_OVERFLOW", "10")),
        "pool_pre_ping": True,
        "pool_recycle": 1800,
    }
    app.config["SECRET_KEY"] = jwt_secret

    cors_origins = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
        if origin.strip()
    ]
    CORS(
        app,
        resources={r"/api/*": {"origins": cors_origins}},
        supports_credentials=True,
    )

    db.init_app(app)
    migrate.init_app(app, db)

    # Import models so Flask-Migrate detects them
    import models  # noqa: F401

    app.register_blueprint(auth_bp)
    app.register_blueprint(encounters_bp)
    app.register_blueprint(patients_bp)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
