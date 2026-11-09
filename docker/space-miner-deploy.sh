#!/usr/bin/env bash
#
# Server-side deploy command for space-miner. Modelled on toon-household's
# docker/toon-deploy.sh, and installed next to it on the same VPS as
# /usr/local/bin/space-miner-deploy.
#
# THIS IS A FORCED COMMAND. It is pinned to space-miner's own GitHub Actions key
# in ~/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/bin/space-miner-deploy" ssh-ed25519 AAAA… space-miner-deploy
#
# One script per app, one key per script: the key in space-miner's secret store
# can drive exactly this app and never toon-household (and vice versa). sshd runs
# this script instead of whatever the client asked for and puts the request in
# $SSH_ORIGINAL_COMMAND, so the key buys three verbs on one image repository:
#
#   space-miner-deploy deploy latest
#   space-miner-deploy deploy sha256:<64 hex>
#   space-miner-deploy sync-config      # fetch docker-compose.yml from GitHub (a human's call)
#   space-miner-deploy status
#
# THE IMAGE REPOSITORY IS PINNED HERE, not sent by the client: the caller picks a
# digest or `latest`, never a registry or a path.
#
# There is no Caddyfile to sync: toon-household's Caddy fronts this app (its ADR
# 0018), so a proxy change is made in that repository.
set -euo pipefail

APP_DIR="${SPACE_MINER_APP_DIR:-/opt/space-miner}"
IMAGE_REPO="${SPACE_MINER_IMAGE_REPO:-ghcr.io/toonvish/space-miner}"
RAW_BASE="${SPACE_MINER_RAW_BASE:-https://raw.githubusercontent.com/Toonvish/space-miner/main}"
SERVICE=space-miner

# The image's HEALTHCHECK polls /health every 30 s after a 20 s start period, so
# give it comfortably more than one cycle.
HEALTH_TRIES="${SPACE_MINER_HEALTH_TRIES:-30}"
HEALTH_SLEEP="${SPACE_MINER_HEALTH_SLEEP:-3}"

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }
die() { printf '%s  ERROR: %s\n' "$(date -Is)" "$*" >&2; exit 1; }

request="${SSH_ORIGINAL_COMMAND:-$*}"
set -f  # a request like `deploy *` must not glob against the cwd
# shellcheck disable=SC2206  # deliberate word splitting: validated below
parts=($request)
set +f
verb="${parts[0]:-}"
ref="${parts[1]:-}"
[ "${#parts[@]}" -le 2 ] || die "Too many arguments: $request"

resolve_image() {
  # Allow-list: `latest` or a well-formed digest, nothing else reaches docker.
  case "$ref" in
    latest | "") echo "${IMAGE_REPO}:latest" ;;
    sha256:*)
      [[ "$ref" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Not a valid digest: $ref"
      echo "${IMAGE_REPO}@${ref}"
      ;;
    *) die "Not a valid image reference: $ref (allowed: latest or sha256:<64 hex>)" ;;
  esac
}

pin_image_in_env() {
  # So a later manual `docker compose up -d` brings up the same version.
  local image="$1"
  if grep -q '^SPACE_MINER_IMAGE=' .env; then
    sed -i "s|^SPACE_MINER_IMAGE=.*|SPACE_MINER_IMAGE=${image}|" .env
  else
    printf 'SPACE_MINER_IMAGE=%s\n' "$image" >> .env
  fi
}

wait_for_healthy() {
  local cid status i
  log "Waiting for healthy ..."
  for i in $(seq 1 "$HEALTH_TRIES"); do
    cid="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo missing)"
    else
      status=missing
    fi
    case "$status" in
      healthy) log "$SERVICE is healthy"; return 0 ;;
      unhealthy) return 1 ;;
    esac
    [ "$i" -lt "$HEALTH_TRIES" ] || { log "Timed out, status=$status"; return 1; }
    sleep "$HEALTH_SLEEP"
  done
}

cmd_deploy() {
  local image
  image="$(resolve_image)"
  cd "$APP_DIR" 2>/dev/null || die "$APP_DIR does not exist"
  [ -f .env ] || die "$APP_DIR/.env is missing. Template: docker/env.example"
  docker network inspect "${EDGE_NETWORK:-toon-household_toon}" >/dev/null 2>&1 \
    || die "Network ${EDGE_NETWORK:-toon-household_toon} not found: start the toon-household stack first"

  log "Deploying $image"
  # Passed in the ENVIRONMENT (compose prefers it over .env), so a failed deploy
  # leaves .env naming the last version that came up healthy.
  SPACE_MINER_IMAGE="$image" docker compose pull
  SPACE_MINER_IMAGE="$image" docker compose up -d --remove-orphans

  if ! wait_for_healthy; then
    docker compose logs --tail=60 "$SERVICE" >&2 || true
    printf '%s\n' "" "The .env still points at the last healthy version. Back to that one:" \
      "    cd $APP_DIR && docker compose up -d" >&2
    die "Container did not become healthy: $image was NOT adopted"
  fi

  pin_image_in_env "$image"
  # Images only — never `--volumes`, which would delete the world save.
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
  docker compose ps
}

cmd_sync_config() {
  cd "$APP_DIR" 2>/dev/null || die "$APP_DIR does not exist"
  [ -f .env ] || die "$APP_DIR/.env is missing. Template: docker/env.example"
  log "Fetching docker-compose.yml from the repository"
  curl -fsSL "$RAW_BASE/docker-compose.yml" -o docker-compose.yml.new \
    || { rm -f docker-compose.yml.new; die "Download failed, nothing changed"; }
  [ -f docker-compose.yml ] && cp -p docker-compose.yml docker-compose.yml.bak
  mv docker-compose.yml.new docker-compose.yml
  if ! docker compose config -q >/dev/null; then
    if [ -f docker-compose.yml.bak ]; then cp -p docker-compose.yml.bak docker-compose.yml; else rm -f docker-compose.yml; fi
    die "The new docker-compose.yml is invalid; the previous file was restored"
  fi
  log "Done. The new docker-compose.yml takes effect with the next deploy."
}

case "$verb" in
  deploy) cmd_deploy ;;
  sync-config | status)
    [ "${#parts[@]}" -eq 1 ] || die "$verb takes no arguments"
    if [ "$verb" = status ]; then
      cd "$APP_DIR" 2>/dev/null || die "$APP_DIR does not exist"
      docker compose ps
    else
      cmd_sync_config
    fi
    ;;
  *) die "Unknown command: ${verb:-<empty>} (allowed: deploy, sync-config, status)" ;;
esac
