#!/usr/bin/env bash
# Shared configuration and helpers for the Mena local rehearsal.
#
# Sourced by up.sh / down.sh / status.sh. It never prints a secret value: the
# generated secret file is sourced with the environment inside the process and
# only redacted summaries are echoed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

# mena-nails is the sibling checkout by default; it is RUN, never edited.
MENA_NAILS_PATH="${MENA_NAILS_PATH:-$(cd "$REPO_ROOT/.." && pwd)/mena-nails}"
COMPOSE_FILE="$MENA_NAILS_PATH/deploy/compose.yaml"
PROJECT="${MENA_REHEARSAL_PROJECT:-mena-rehearsal}"
STATE_DIR="${MENA_REHEARSAL_STATE:-/tmp/mena-rehearsal}"
REHEARSAL_ENV="${MENA_REHEARSAL_ENV:-$HOME/.config/mena/rehearsal.env}"
TELEGRAM_ENV="${MENA_TELEGRAM_ENV:-$HOME/.config/mena/telegram.env}"
AUTH_JSON="${MENA_PI_AUTH:-$HOME/.pi/agent/auth.json}"

API_HOST=127.0.0.1
API_PORT="${MENA_REHEARSAL_API_PORT:-8080}"
API_ORIGIN="http://$API_HOST:$API_PORT"
WEB_HOST=localhost
WEB_PORT="${MENA_REHEARSAL_WEB_PORT:-5173}"
WEB_ORIGIN="http://$WEB_HOST:$WEB_PORT"

# The API's CORS + CSRF origin check compares the exact browser origin string.
# Both sides derive from WEB_ORIGIN so `localhost` vs `127.0.0.1` can never
# drift (pitfall #2 of the README's local run).
export API_ALLOWED_ORIGIN="$WEB_ORIGIN"
export VITE_PUBLIC_API_ORIGIN="$API_ORIGIN"

WEB_DIR="$MENA_NAILS_PATH/apps/web"
BOT_LOG="$STATE_DIR/bot.log"
WEB_LOG="$STATE_DIR/web.log"
BOT_PID_FILE="$STATE_DIR/bot.pid"
WEB_PID_FILE="$STATE_DIR/web.pid"
STATE_FILE="$STATE_DIR/state.env"

log() { printf '[rehearsal] %s\n' "$*"; }
warn() { printf '[rehearsal] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[rehearsal] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# Sources a shell-compatible env file without ever echoing it.
load_env_file() {
  local file="$1" required="${2:-yes}"
  if [ ! -f "$file" ]; then
    if [ "$required" = "yes" ]; then
      die "env file not found: $file"
    fi
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .
  else
    ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
  fi
}

# Docker Desktop's `credsStore` (desktop.exe) fails under WSL and aborts the
# first build with "error getting credentials". A credential-free config keeps
# the pulls anonymous and never stores or prints a credential.
prepare_docker_config() {
  [ -n "${DOCKER_CONFIG:-}" ] && return 0
  if [ -f "$HOME/.docker/config.json" ] && grep -q '"credsStore"' "$HOME/.docker/config.json" 2>/dev/null; then
    mkdir -p "$STATE_DIR/docker-config"
    printf '{}\n' >"$STATE_DIR/docker-config/config.json"
    export DOCKER_CONFIG="$STATE_DIR/docker-config"
    warn "Docker Desktop credsStore detected; pulling anonymously with DOCKER_CONFIG=$DOCKER_CONFIG"
  fi
}

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# The seed profile loads the canonical catalog. A plain `docker compose up`
# never seeds it (pitfall #3), so every rehearsal start uses the profile.
compose_seed() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile seed "$@"
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1"
}

wait_for_code() {
  local url="$1" want="$2" timeout="${3:-180}" started
  started="$(date +%s)"
  while true; do
    if [ "$(http_code "$url" || true)" = "$want" ]; then return 0; fi
    if [ "$(( $(date +%s) - started ))" -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

# Reads the Telegram secrets without executing the file (so a stray shell
# fragment in it can never run) and tolerates a malformed token line by
# recovering the token-shaped value, with a warning. Never prints the value.
load_telegram_env() {
  [ -f "$TELEGRAM_ENV" ] || return 1
  local line value
  line="$(grep -m1 '^TELEGRAM_ALLOWLIST=' "$TELEGRAM_ENV" || true)"
  [ -n "$line" ] && export TELEGRAM_ALLOWLIST="${line#TELEGRAM_ALLOWLIST=}"
  line="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TELEGRAM_ENV" || true)"
  if [ -n "$line" ]; then
    value="${line#TELEGRAM_BOT_TOKEN=}"
    if printf '%s' "$value" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
      export TELEGRAM_BOT_TOKEN="$value"
    else
      value="$(printf '%s' "$value" | grep -oE '[0-9]{6,}:[A-Za-z0-9_-]{30,}' | head -n1 || true)"
      if [ -n "$value" ]; then
        export TELEGRAM_BOT_TOKEN="$value"
        warn "the TELEGRAM_BOT_TOKEN line in $TELEGRAM_ENV has extra text around the value; recovered it by pattern. Fix the file to exactly TELEGRAM_BOT_TOKEN=<id:secret>"
      fi
    fi
  fi
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_ALLOWLIST:-}" ]
}

pid_alive() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Starts a command detached, records its pid and log. `setsid` makes the pid a
# process-group leader so down.sh can stop the whole tree (npm → vite).
start_bg() {
  local pid_file="$1" log_file="$2"
  shift 2
  mkdir -p "$STATE_DIR"
  : >"$log_file"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >>"$log_file" 2>&1 &
  else
    nohup "$@" >>"$log_file" 2>&1 &
  fi
  echo $! >"$pid_file"
}
