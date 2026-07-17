#!/bin/bash
# One-shot local dev setup + start. Safe to re-run.
#
# Usage: ./dev.sh
# Stop:  press Ctrl+C (kills both backend and frontend)
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Starting Postgres (docker compose)"
docker compose up -d db

echo "==> Waiting for Postgres to be healthy"
until docker compose ps db --format json | grep -q '"Health":"healthy"'; do
  sleep 1
done

echo "==> Setting up backend"
cd backend
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt

if [ ! -f .env ]; then
  echo "!! backend/.env is missing. Copy backend/.env.example to backend/.env"
  echo "   and fill in OPENAI_API_KEY, JWT_SECRET, DATABASE_URL before continuing."
  exit 1
fi

export FLASK_APP=app
flask db upgrade
python seed.py

echo "==> Starting backend on :5001"
python app.py &
BACKEND_PID=$!
cd ..

cleanup() {
  echo ""
  echo "==> Stopping backend (pid $BACKEND_PID) and frontend"
  kill "$BACKEND_PID" 2>/dev/null || true
  kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Waiting for backend health check"
until curl -sf http://localhost:5001/api/health > /dev/null; do
  sleep 0.5
done
echo "    backend is up: http://localhost:5001"

echo "==> Setting up frontend"
cd frontend
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Starting frontend on :5173"
npm run dev &
FRONTEND_PID=$!
cd ..

cat <<'EOF'

============================================================
 Kyron is running:
   Frontend: http://localhost:5173
   Backend:  http://localhost:5001

 Demo logins:
   provider1@kyron.local / provider123
   provider2@kyron.local / provider123
   admin@kyron.local     / admin123

 Press Ctrl+C to stop both servers.
============================================================

EOF

wait
