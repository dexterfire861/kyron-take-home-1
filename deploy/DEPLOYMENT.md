# Deployment notes

Live app: **https://kyron-scribe.duckdns.org** — valid Let's Encrypt cert (expires 2026-10-15, auto-renews via certbot's systemd timer), HTTP redirects to HTTPS. Domain is a free DuckDNS subdomain pointed at the Elastic IP below; DuckDNS token lives only in the local scratchpad, not in this repo.

## AWS resources

Account `582866710122`, region `us-east-1`, CLI profile `kyron`.

| Resource | ID | Notes |
|---|---|---|
| VPC | `vpc-0d62b792cd31c299e` | default VPC |
| EC2 instance | `i-031baaf6442e59ad9` | `t3.small`, Ubuntu 22.04, tag `Name=kyron-app` |
| Elastic IP | `100.49.78.43` (alloc `eipalloc-0f3153788830b0c9a`) | stable address, survives instance stop/start |
| EC2 security group | `sg-05ea1188dcfd0b7b3` (`kyron-ec2-sg`) | 22 from my IP only, 80/443 open |
| RDS instance | `kyron-db` | `db.t4g.micro`, Postgres 16.4, **not publicly accessible** |
| RDS endpoint | `kyron-db.c8biki4ca1hq.us-east-1.rds.amazonaws.com` | only reachable from `kyron-ec2-sg` |
| RDS security group | `sg-0c3b219c42acd3f51` (`kyron-rds-sg`) | port 5432 from `kyron-ec2-sg` only |
| DB subnet group | `kyron-db-subnet-group` | 3 AZs |
| IAM role | `kyron-ec2-role` / instance profile `kyron-ec2-profile` | scoped to `ssm:GetParameter*` on `/kyron/*` only |
| SSH key pair | `kyron-app-key` | private key in local scratchpad, not in repo |

## Secrets (SSM Parameter Store, SecureString)

- `/kyron/prod/DATABASE_URL`
- `/kyron/prod/JWT_SECRET`
- `/kyron/prod/OPENAI_API_KEY`

Read at container boot by `backend/secrets_loader.py` via the EC2 instance's IAM role — nothing is hardcoded, no `.env` file exists on the box. Values were never printed to any chat/log; if you need to see one: `aws ssm get-parameter --name /kyron/prod/OPENAI_API_KEY --with-decryption --profile kyron`.

## What's running on the box

- `/opt/kyron` — repo copy (deployed via `rsync`, not git clone, so it's whatever was on disk at deploy time — re-run the deploy script to sync changes)
- Backend: Docker container (`docker-compose.prod.yml`), gunicorn, bound to `127.0.0.1:5001` only
- Frontend: static build (`npm run build`) served by nginx from `/var/www/kyron/dist`
- nginx: reverse-proxies `/api/*` to the backend container, serves the SPA for everything else — config is `deploy/nginx-http-only.conf`

## Redeploying after a code change

```
rsync -az --exclude node_modules --exclude .venv --exclude dist --exclude .git --exclude backend/.env \
  -e "ssh -i <path-to-kyron-app-key.pem>" ./ ubuntu@100.49.78.43:/opt/kyron/
ssh -i <path-to-kyron-app-key.pem> ubuntu@100.49.78.43 "cd /opt/kyron && ./deploy/deploy-http-only.sh 100.49.78.43"
```

If a migration was added, that script already runs `flask db upgrade` before restarting the container.

## HTTPS / domain

Done — `kyron-scribe.duckdns.org` → `100.49.78.43`, cert issued via `certbot --nginx`, auto-renewing. `docker-compose.prod.yml`'s `CORS_ORIGINS` is now `https://kyron-scribe.duckdns.org`.

To redeploy after a code change (this now also re-runs certbot, which is a no-op if the cert is still valid):
```
ssh -i <key> ubuntu@100.49.78.43 "cd /opt/kyron && ./deploy/deploy.sh verma.aryaan@gmail.com"
```

## Voice features in production

This matters more than it looks: `getUserMedia` (mic access) is blocked by browsers on any insecure origin — plain `http://<ip>` included. It only works on HTTPS or `localhost`. That's why voice editing/dictation failed on the interim `http://100.49.78.43` URL but works now over HTTPS.

Both realtime endpoints tested directly against the deployed backend over HTTPS and confirmed working (mint a valid OpenAI client secret, correct CORS headers):
- `POST /api/encounters/:id/realtime/session` (conversational voice editing)
- `POST /api/encounters/:id/realtime/transcription-session` (dictation)

The actual audio (WebRTC) connects straight from the browser to OpenAI, so voice editing/dictation should now work end-to-end at https://kyron-scribe.duckdns.org.

## Known gaps

- No auto-restart-on-crash beyond Docker's `restart: unless-stopped`, no CloudWatch alarms.
- Deployed via `rsync`, not a real CI/CD pipeline — redeploys are manual.
