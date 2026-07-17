#!/bin/bash
# Run on the EC2 box (after user-data has bootstrapped it) from /opt/kyron.
# Usage: ./deploy/deploy.sh you@example.com   (email is for certbot renewal notices)
set -euxo pipefail

EMAIL="${1:?usage: deploy.sh <email-for-certbot>}"
DOMAIN="__DOMAIN__"
REPO_DIR=/opt/kyron
cd "$REPO_DIR"

cd frontend
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/kyron/dist/
cd ..

export AWS_SSM_PREFIX=/kyron/prod
export AWS_REGION=us-east-1
export CORS_ORIGINS="https://${DOMAIN}"

sudo docker compose -f docker-compose.prod.yml build
sudo docker compose -f docker-compose.prod.yml run --rm backend flask db upgrade
sudo docker compose -f docker-compose.prod.yml up -d

sudo sed "s/__DOMAIN__/${DOMAIN}/" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/kyron > /dev/null
sudo ln -sf /etc/nginx/sites-available/kyron /etc/nginx/sites-enabled/kyron
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect
