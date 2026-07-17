#!/bin/bash
# EC2 launch user-data (Ubuntu 22.04). Installs everything needed to run the
# backend container + host nginx/certbot; app code is deployed afterward.
set -euxo pipefail

apt-get update
apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx

# Docker Engine + compose plugin
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker ubuntu

# Node.js 20 (to build the frontend on-box)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

mkdir -p /var/www/kyron
systemctl enable --now docker nginx

# Allow boto3 (running inside a Docker container) to reach IMDSv2 through the
# extra network hop introduced by the bridge network.
echo "done bootstrapping — run the deploy script next"
