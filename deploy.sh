#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

usage() { echo "Usage: ./deploy.sh [--prebuilt REGISTRY/IMAGE-PREFIX]"; }
image_prefix=""
case "$#:${1:-}" in
  0:) ;;
  1:--help) usage; exit 0 ;;
  2:--prebuilt)
    image_prefix=${2%/}
    if [[ -z "$image_prefix" || "$image_prefix" == -* || "$image_prefix" =~ [[:space:]] ]]; then
      usage >&2; exit 2
    fi ;;
  *) usage >&2; exit 2 ;;
esac

if [ -d .git ]; then
  echo "Updating the checkout..."
  git pull --ff-only
fi

compose=(docker compose -f docker-compose.prod.yml)
export APP_UID="${APP_UID:-$(id -u)}"
export APP_GID="${APP_GID:-$(id -g)}"

if [[ -n "$image_prefix" ]]; then
  revision=$(git rev-parse --verify HEAD)
  export PORTFOLIO_BACKEND_IMAGE="${image_prefix}-backend:$revision"
  export PORTFOLIO_FRONTEND_IMAGE="${image_prefix}-frontend:$revision"
fi
"${compose[@]}" config --quiet

if [[ -n "$image_prefix" ]]; then
  echo "Pulling prebuilt images for $revision..."
  docker pull "$PORTFOLIO_BACKEND_IMAGE"
  docker pull "$PORTFOLIO_FRONTEND_IMAGE"
else
  # Separate calls keep pip and the frontend compiler off the CPU at the same time.
  echo "Building the backend image (also used by auto-sync)..."
  "${compose[@]}" build backend
  echo "Building the frontend image..."
  "${compose[@]}" build frontend
fi

mkdir -p data
if [ -f data/portfolio.db ]; then
  echo "Backing up the database..."
  backup_dir="${BACKUP_DIR:-/backups/crypto_portfolio}"
  mkdir -p "$backup_dir"
  cp data/portfolio.db "$backup_dir/portfolio-$(date +%Y%m%d-%H%M%S).db"
fi

echo "Starting services and waiting for the backend health check..."
if ! "${compose[@]}" up -d --no-build --pull never --remove-orphans --wait --wait-timeout 180; then
  "${compose[@]}" ps --all >&2
  echo "Startup failed. Check: docker compose -f docker-compose.prod.yml logs --tail=50 backend" >&2
  exit 1
fi
"${compose[@]}" ps
