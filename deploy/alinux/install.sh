#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${ASH_DOMAIN:-agent.tokenpatch.com}"
PORT="${ASH_PORT:-3100}"
APP_ROOT="/opt/agent-signal-hub"
APP_DIR="$APP_ROOT/app"
DATA_ROOT="/var/lib/agent-signal-hub"
DEPLOYMENT_DIR="$DATA_ROOT/deployment"
DATABASE_PATH="$DATA_ROOT/agent-signal-hub.db"
STATE_DIR="$DATA_ROOT/state"
BACKUP_DIR="/var/backups/agent-signal-hub"
LOG_DIR="/var/log/agent-signal-hub"
NPM_CACHE_DIR="/var/cache/agent-signal-hub/npm"
ENV_FILE="$DEPLOYMENT_DIR/.env.production"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(command -v node || true)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 22 is required but node was not found in PATH." >&2
  exit 1
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "ASH_PORT must be between 1024 and 65535." >&2
  exit 1
fi
if ss -lnt | awk '{print $4}' | grep -Eq "[:.]${PORT}$"; then
  echo "Port $PORT is already in use." >&2
  exit 1
fi

if [[ "$(swapon --noheadings --show=NAME | wc -l)" -eq 0 ]] && (( $(awk '/MemTotal/ {print $2}' /proc/meminfo) < 3000000 )); then
  if [[ ! -e /swapfile-ash ]]; then
    fallocate -l 2G /swapfile-ash || dd if=/dev/zero of=/swapfile-ash bs=1M count=2048 status=progress
    chmod 600 /swapfile-ash
    mkswap /swapfile-ash
  fi
  swapon /swapfile-ash
  grep -q '^/swapfile-ash ' /etc/fstab || echo '/swapfile-ash swap swap defaults 0 0' >> /etc/fstab
fi

id ash >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_ROOT" --shell /sbin/nologin ash
mkdir -p "$APP_DIR" "$DATA_ROOT" "$STATE_DIR" "$BACKUP_DIR" "$LOG_DIR" "$NPM_CACHE_DIR"

if [[ -f "$APP_DIR/package.json" ]]; then
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$APP_DIR" "$APP_ROOT/app.previous.$timestamp"
  mkdir -p "$APP_DIR"
fi
cp -a "$SOURCE_DIR"/. "$APP_DIR"/
rm -rf "$APP_DIR/node_modules" "$APP_DIR/.next" "$APP_DIR/.git" "$APP_DIR/.tools" "$APP_DIR/.private-trial" "$APP_DIR/dist"
chown -R ash:ash "$APP_ROOT" "$DATA_ROOT" "$BACKUP_DIR" "$LOG_DIR" "$NPM_CACHE_DIR"
chmod 750 "$DATA_ROOT" "$STATE_DIR" "$BACKUP_DIR" "$LOG_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  runuser -u ash -- node "$APP_DIR/scripts/prepare-private-trial.mjs" \
    --output "$DEPLOYMENT_DIR" \
    --base-url "https://$DOMAIN" \
    --database-path "$DATABASE_PATH" \
    --internal-port "$PORT"
fi
chown -R root:ash "$DEPLOYMENT_DIR"
chmod 750 "$DEPLOYMENT_DIR" "$DEPLOYMENT_DIR/seeds"
chmod 640 "$ENV_FILE"
chown ash:ash "$DEPLOYMENT_DIR/deployment-manifest.json" "$DEPLOYMENT_DIR"/seeds/*.json
for writable_deployment_dir in "$DEPLOYMENT_DIR/state" "$DEPLOYMENT_DIR/backups"; do
  if [[ -d "$writable_deployment_dir" ]]; then
    chown -R ash:ash "$writable_deployment_dir"
    chmod 750 "$writable_deployment_dir"
  fi
done
chmod 600 "$DEPLOYMENT_DIR/deployment-manifest.json" "$DEPLOYMENT_DIR"/seeds/*.json "$DEPLOYMENT_DIR/registration-invites.json"

cd "$APP_DIR"
runuser -u ash -- env npm_config_cache="$NPM_CACHE_DIR" npm ci --no-audit --no-fund
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
runuser -u ash -- env DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy
runuser -u ash -- env NODE_OPTIONS="--max-old-space-size=1024" npm run build

cat > /etc/systemd/system/agent-signal-hub.service <<EOF
[Unit]
Description=Agent Signal Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ash
Group=ash
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=768
ExecStart=$NODE_BIN $APP_DIR/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port $PORT
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/.next/cache $DATA_ROOT $BACKUP_DIR $LOG_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/agent-signal-hub-maintenance.service <<EOF
[Unit]
Description=Agent Signal Hub maintenance worker
After=agent-signal-hub.service
Requires=agent-signal-hub.service

[Service]
Type=simple
User=ash
Group=ash
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/scripts/digest-maintenance-worker.mjs
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_ROOT $BACKUP_DIR $LOG_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/agent-signal-hub-backup.service <<EOF
[Unit]
Description=Agent Signal Hub daily SQLite backup

[Service]
Type=oneshot
User=ash
Group=ash
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=/bin/bash -lc '$NODE_BIN scripts/sqlite-backup.mjs --output "$BACKUP_DIR/agent-signal-hub-\$(date -u +%%Y%%m%%dT%%H%%M%%SZ).db"'
ExecStart=/bin/rm -f "$DEPLOYMENT_DIR/backups/agent-signal-hub.db" "$DEPLOYMENT_DIR/backups/agent-signal-hub.db.manifest.json"
ExecStart=/bin/bash -lc '$NODE_BIN scripts/sqlite-backup.mjs'
EOF

cat > /etc/systemd/system/agent-signal-hub-backup.timer <<EOF
[Unit]
Description=Run Agent Signal Hub backup daily

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now agent-signal-hub.service agent-signal-hub-maintenance.service agent-signal-hub-backup.timer

BAOTA_VHOST_DIR="/www/server/panel/vhost/nginx"
STANDARD_VHOST_DIR="/etc/nginx/conf.d"
if [[ -d "$BAOTA_VHOST_DIR" ]]; then
  VHOST_DIR="$BAOTA_VHOST_DIR"
  VHOST_FILE="$VHOST_DIR/$DOMAIN.conf"
  if [[ -e "$VHOST_FILE" ]]; then
    echo "Existing Nginx vhost preserved: $VHOST_FILE"
  else
    cat > "$VHOST_FILE" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 1m;
    limit_conn perip 20;
    limit_conn perserver 100;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header Connection "";
        proxy_connect_timeout 3s;
        proxy_read_timeout 60s;
    }

    access_log /www/wwwlogs/$DOMAIN.log;
    error_log /www/wwwlogs/$DOMAIN.error.log;
}
EOF
    /www/server/nginx/sbin/nginx -t
    /www/server/nginx/sbin/nginx -s reload
  fi
elif command -v nginx >/dev/null 2>&1 && [[ -d "$STANDARD_VHOST_DIR" ]]; then
  VHOST_FILE="$STANDARD_VHOST_DIR/$DOMAIN.conf"
  if [[ -e "$VHOST_FILE" ]]; then
    echo "Existing Nginx vhost preserved: $VHOST_FILE"
  else
    cat > "$VHOST_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header Connection "";
        proxy_connect_timeout 3s;
        proxy_read_timeout 60s;
    }
}
EOF
    nginx -t
    systemctl enable --now nginx
    systemctl reload nginx
  fi
fi

for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null

echo
echo "Agent Signal Hub installed."
echo "Local health: http://127.0.0.1:$PORT/api/health"
echo "Production env: $ENV_FILE"
echo "Seed identities: $DEPLOYMENT_DIR/seeds"
echo "Offline recovery identities must be downloaded and removed from the server."
echo "One-time invites: $DEPLOYMENT_DIR/registration-invites.json"
echo "Next: point $DOMAIN to this server, then request TLS and force HTTPS."
