#!/usr/bin/env bash
# Exercise the production entry point without contacting Git, Docker or a registry.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/checkout/.git" "$tmp/checkout/data"
cp "$root/deploy.sh" "$tmp/checkout/"
cd "$tmp/checkout"
printf 'fixture' > data/portfolio.db
export PATH="$tmp/bin:$PATH" BACKUP_DIR="$tmp/backups" TRACE="$tmp/steps"
export REVISION=0123456789abcdef0123456789abcdef01234567

cat > "$tmp/bin/git" <<'SH'
#!/usr/bin/env bash
case "$*" in
  'pull --ff-only') exit 0 ;;
  'rev-parse --verify HEAD') echo "$REVISION" ;;
  *) exit 1 ;;
esac
SH
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
set -eu
if [[ "$1" == compose ]]; then
  [[ "$2 $3" == '-f docker-compose.prod.yml' ]]
  shift 3
fi
echo "$*" >> "$TRACE"
[[ "$*" != "${FAIL_STEP:-}" ]]
SH
chmod +x "$tmp/bin/git" "$tmp/bin/docker"

local_steps=$'config --quiet\nbuild backend\nbuild frontend'
up='up -d --no-build --pull never --remove-orphans --wait --wait-timeout 180'
bash deploy.sh >/dev/null
[[ "$(cat "$TRACE")" == "$local_steps"$'\n'"$up"$'\nps' ]]
cmp data/portfolio.db "$BACKUP_DIR"/portfolio-*.db

prefix=registry.example.test/portfolio
pulls=$(printf 'config --quiet\npull %s-backend:%s\npull %s-frontend:%s' "$prefix" "$REVISION" "$prefix" "$REVISION")
: > "$TRACE"
bash deploy.sh --prebuilt "$prefix" >/dev/null
[[ "$(cat "$TRACE")" == "$pulls"$'\n'"$up"$'\nps' ]]

# A failed build or an unpublished image must leave live services alone.
for step in 'build frontend' "pull $prefix-frontend:$REVISION"; do
  : > "$TRACE"
  if [[ "$step" == pull* ]]; then
    if FAIL_STEP="$step" bash deploy.sh --prebuilt "$prefix" >/dev/null; then exit 1; fi
  else
    if FAIL_STEP="$step" bash deploy.sh >/dev/null; then exit 1; fi
  fi
  [[ "$(tail -n 1 "$TRACE")" == "$step" ]]
done
echo "Deployment paths and image preparation failure checks passed."
