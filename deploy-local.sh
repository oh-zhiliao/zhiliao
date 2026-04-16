#!/bin/bash
# deploy-local.sh — Bare-metal Linux deployment for Zhiliao
# Runs memo (Python) and agent (Node.js) as background processes.
#
# Usage:
#   bash deploy-local.sh setup       # Install dependencies
#   bash deploy-local.sh start       # Start both services
#   bash deploy-local.sh stop        # Stop both services
#   bash deploy-local.sh restart     # Restart both services
#   bash deploy-local.sh status      # Show service status
#   bash deploy-local.sh logs [svc]  # Tail logs (memo|agent|all)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source .env for plugin env vars (e.g. TENCENTCLOUD_SECRET_ID)
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

DATA_DIR="$ROOT_DIR/data"
PID_DIR="$DATA_DIR/pids"
LOG_DIR="$DATA_DIR/logs"
MEMO_VENV="$ROOT_DIR/memo/.venv"
MEMO_PORT=8090

# ─── helpers ────────────────────────────────────────────────────────────────

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

ensure_dirs() {
  mkdir -p "$PID_DIR" "$LOG_DIR" "$DATA_DIR"/{repos,memo/memory,memo/dialog,ssh}
}

read_pid() {
  local pidfile="$PID_DIR/$1.pid"
  [[ -f "$pidfile" ]] && cat "$pidfile" || echo ""
}

is_running() {
  local pid
  pid=$(read_pid "$1")
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

wait_for_health() {
  local url="$1" timeout="$2" elapsed=0
  while (( elapsed < timeout )); do
    if python3 -c "import urllib.request; urllib.request.urlopen('$url')" 2>/dev/null; then
      return 0
    fi
    sleep 1
    (( elapsed++ ))
  done
  return 1
}

# ─── setup ──────────────────────────────────────────────────────────────────

cmd_setup() {
  log "Checking prerequisites..."

  command -v node  >/dev/null || die "node not found — install Node.js 22+"
  command -v npm   >/dev/null || die "npm not found — install Node.js 22+"
  command -v python3 >/dev/null || die "python3 not found — install Python 3.12+"
  command -v git   >/dev/null || die "git not found — install git"

  local node_major
  node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  if (( node_major < 20 )); then
    die "Node.js $node_major is too old — need 20+ (22 LTS recommended)"
  fi
  if (( node_major >= 24 )); then
    log "Warning: Node.js $node_major detected — v22 LTS recommended. Native modules (better-sqlite3) may need rebuild."
  fi

  ensure_dirs

  # --- Python venv for memo ---
  if [[ -f "$MEMO_VENV/bin/python" ]]; then
    log "Memo venv exists, skipping."
  elif [[ -w "$ROOT_DIR/memo" ]]; then
    log "Creating Python venv at memo/.venv ..."
    python3 -m venv "$MEMO_VENV"
    "$MEMO_VENV/bin/pip" install -q -r "$ROOT_DIR/memo/requirements.txt"
  else
    die "memo/.venv not found and memo/ is not writable — run setup in the source tree first"
  fi

  # --- Node.js deps for agent ---
  if [[ -d "$ROOT_DIR/agent/node_modules" ]]; then
    log "Agent node_modules exists, skipping."
  elif [[ -w "$ROOT_DIR/agent" ]]; then
    log "Installing agent npm dependencies..."
    (cd "$ROOT_DIR/agent" && npm ci --loglevel=warn)
  else
    die "agent/node_modules not found and agent/ is not writable — run setup in the source tree first"
  fi

  # --- Plugin deps ---
  for dir in "$ROOT_DIR"/plugins/*/; do
    [[ -f "$dir/package.json" ]] || continue
    local name
    name=$(basename "$dir")
    if [[ ! -d "$dir/node_modules" ]]; then
      log "Installing deps for plugin: $name"
      (cd "$dir" && npm install --omit=dev --loglevel=warn) || log "Warning: failed to install deps for $name"
    elif [[ -w "$dir/node_modules" ]]; then
      log "Rebuilding native modules for plugin: $name"
      (cd "$dir" && npm rebuild --loglevel=warn 2>&1) || log "Warning: failed to rebuild deps for $name"
    else
      log "Plugin $name: deps exist (read-only), skipping rebuild."
    fi
  done

  # --- config.yaml ---
  if [[ ! -f "$ROOT_DIR/config.yaml" ]]; then
    cp "$ROOT_DIR/config.example.yaml" "$ROOT_DIR/config.yaml"
    log "Created config.yaml from example — edit it with your secrets."
  fi

  # --- plugin configs ---
  for dir in "$ROOT_DIR"/plugins/*/; do
    local name
    name=$(basename "$dir")
    if [[ -f "$dir/config.example.yaml" && ! -f "$dir/config.yaml" ]]; then
      cp "$dir/config.example.yaml" "$dir/config.yaml"
      log "Created plugins/$name/config.yaml from example — edit it with your secrets."
    fi
  done

  log "Setup complete."
  echo ""
  echo "Next steps:"
  echo "  1. Edit config.yaml with your secrets"
  echo "  2. Edit plugins/*/config.yaml with plugin-specific secrets"
  echo "  3. Set up SSH deploy key: ssh-keygen -t ed25519 -f data/deploy_key -N ''"
  echo "  4. bash deploy-local.sh start"
}

# ─── preflight ──────────────────────────────────────────────────────────────

cmd_preflight() {
  log "Running L1-L3 preflight (lint + typecheck + unit tests)..."
  (
    cd "$ROOT_DIR/agent"
    npm run test:l3 || die "L3 lint/typecheck failed — fix before deploying"
    npm run test:l1 || die "L1 unit tests failed — fix before deploying"
    if [[ -f vitest.web.config.ts ]]; then
      npm run test:l2 || die "L2 frontend tests failed — fix before deploying"
    fi
  )
  if [[ -x "$MEMO_VENV/bin/ruff" ]]; then
    (cd "$ROOT_DIR/memo" && "$MEMO_VENV/bin/ruff" check .) || die "memo ruff failed"
  fi
  if [[ -x "$MEMO_VENV/bin/pytest" ]]; then
    (cd "$ROOT_DIR/memo" && "$MEMO_VENV/bin/pytest" -q tests/) || die "memo pytest failed"
  fi
  log "Preflight passed."
}

# ─── start ──────────────────────────────────────────────────────────────────

start_memo() {
  if is_running memo; then
    log "Memo already running (pid $(read_pid memo))"
    return 0
  fi

  log "Starting memo service..."
  (
    cd "$ROOT_DIR/memo"
    MEMO_CONFIG_PATH="$ROOT_DIR/config.yaml" \
    MEMO_DATA_DIR="$DATA_DIR/memo" \
      "$MEMO_VENV/bin/uvicorn" server:app --host 127.0.0.1 --port "$MEMO_PORT" \
      >> "$LOG_DIR/memo.log" 2>&1 &
    echo $! > "$PID_DIR/memo.pid"
  )

  log "Waiting for memo health check..."
  if wait_for_health "http://127.0.0.1:$MEMO_PORT/health" 30; then
    log "Memo started (pid $(read_pid memo))"
  else
    log "Warning: memo health check timed out — check $LOG_DIR/memo.log"
  fi
}

start_agent() {
  if is_running agent; then
    log "Agent already running (pid $(read_pid agent))"
    return 0
  fi

  [[ -f "$ROOT_DIR/config.yaml" ]] || die "config.yaml not found — run setup first"

  # Build GIT_SSH_COMMAND if deploy key exists
  local git_ssh_cmd=""
  if [[ -f "$DATA_DIR/deploy_key" ]]; then
    git_ssh_cmd="ssh -i $DATA_DIR/deploy_key -o StrictHostKeyChecking=accept-new"
    if [[ -f "$DATA_DIR/ssh/known_hosts" ]]; then
      git_ssh_cmd="ssh -i $DATA_DIR/deploy_key -o UserKnownHostsFile=$DATA_DIR/ssh/known_hosts -o StrictHostKeyChecking=yes"
    fi
  fi

  log "Starting agent service..."
  (
    cd "$ROOT_DIR/agent"
    GIT_SSH_COMMAND="$git_ssh_cmd" \
      node --import tsx/esm src/index.ts "$ROOT_DIR/config.yaml" \
      >> "$LOG_DIR/agent.log" 2>&1 &
    echo $! > "$PID_DIR/agent.pid"
  )
  sleep 2

  if is_running agent; then
    log "Agent started (pid $(read_pid agent))"
  else
    log "Agent failed to start — check $LOG_DIR/agent.log"
    tail -5 "$LOG_DIR/agent.log" 2>/dev/null
    return 1
  fi
}

cmd_start() {
  ensure_dirs
  if [[ "${SKIP_PREFLIGHT:-0}" != "1" ]]; then
    cmd_preflight
  else
    log "SKIP_PREFLIGHT=1 — skipping L1-L3 gate (use for emergency deploys only)"
  fi
  start_memo
  start_agent
  log "All services started."
}

# ─── stop ───────────────────────────────────────────────────────────────────

stop_service() {
  local svc="$1"
  local pid
  pid=$(read_pid "$svc")
  if [[ -z "$pid" ]]; then
    log "$svc: not running (no pid file)"
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    log "Stopping $svc (pid $pid)..."
    kill "$pid"
    # Wait up to 10s for graceful shutdown
    local waited=0
    while kill -0 "$pid" 2>/dev/null && (( waited < 10 )); do
      sleep 1
      (( waited++ ))
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "$svc did not exit in 10s, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi
    log "$svc stopped."
  else
    log "$svc: process $pid not running (stale pid file)"
  fi
  rm -f "$PID_DIR/$svc.pid"
}

cmd_stop() {
  stop_service agent
  stop_service memo
  log "All services stopped."
}

# ─── restart ────────────────────────────────────────────────────────────────

cmd_restart() {
  cmd_stop
  cmd_start
}

# ─── status ─────────────────────────────────────────────────────────────────

cmd_status() {
  for svc in memo agent; do
    local pid
    pid=$(read_pid "$svc")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$svc: running (pid $pid)"
    else
      echo "$svc: stopped"
    fi
  done
}

# ─── logs ───────────────────────────────────────────────────────────────────

cmd_logs() {
  local svc="${1:-all}"
  case "$svc" in
    memo)  tail -f "$LOG_DIR/memo.log"  ;;
    agent) tail -f "$LOG_DIR/agent.log" ;;
    all)   tail -f "$LOG_DIR/memo.log" "$LOG_DIR/agent.log" ;;
    *)     die "Unknown service: $svc (use memo|agent|all)" ;;
  esac
}

# ─── main ───────────────────────────────────────────────────────────────────

case "${1:-}" in
  setup)     cmd_setup ;;
  preflight) cmd_preflight ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-all}" ;;
  *)
    echo "Usage: bash deploy-local.sh {setup|preflight|start|stop|restart|status|logs [memo|agent|all]}"
    echo ""
    echo "Set SKIP_PREFLIGHT=1 to bypass L1-L3 gate on start (emergency use only)."
    exit 1
    ;;
esac
