#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -d .git ]; then
  git pull --ff-only
fi

mkdir -p data
if [ -f data/portfolio.db ]; then
  backup_dir="${BACKUP_DIR:-/backups/crypto_portfolio}"
  mkdir -p "$backup_dir"
  cp data/portfolio.db "$backup_dir/portfolio-$(date +%Y%m%d-%H%M%S).db"
fi

export APP_UID="${APP_UID:-$(id -u)}"
export APP_GID="${APP_GID:-$(id -g)}"

docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
