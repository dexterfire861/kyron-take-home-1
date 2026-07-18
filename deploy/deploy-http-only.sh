#!/bin/bash
# Interim deploy for demoing over plain HTTP via the EC2 public IP, before a
# domain is set up. Run on the EC2 box from /opt/kyron.
# Usage: ./deploy/deploy-http-only.sh <public-ip-or-hostname>
set -euxo pipefail

PUBLIC_ADDR="${1:?usage: deploy-http-only.sh <public-ip>}"
REPO_DIR=/opt/kyron
cd "$REPO_DIR"

cd frontend
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/kyron/dist/
cd ..

export AWS_SSM_PREFIX=/kyron/prod
export AWS_REGION=us-east-1
export CORS_ORIGINS="http://${PUBLIC_ADDR}"

sudo -E docker compose -f docker-compose.prod.yml build
sudo -E docker compose -f docker-compose.prod.yml run --rm backend flask db upgrade
sudo -E docker compose -f docker-compose.prod.yml up -d

sudo cp deploy/nginx-http-only.conf /etc/nginx/sites-available/kyron
sudo ln -sf /etc/nginx/sites-available/kyron /etc/nginx/sites-enabled/kyron
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo "Deployed. Visit: http://${PUBLIC_ADDR}"
