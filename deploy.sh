#!/bin/bash
set -e

# Usage:
#   bash deploy.sh          # Quick: mount source + tsx (dev/test)
#   bash deploy.sh --full   # Full: compile into release image (production/k8s)

MODE="${1:-quick}"
BUILD_IMAGE="zhiliao-build"
COMPOSE_DEV=(-f docker-compose.yml -f docker-compose.dev.yml)

preflight() {
  if [ "${SKIP_PREFLIGHT:-0}" = "1" ]; then
    echo "SKIP_PREFLIGHT=1 — skipping L1-L3 gate"
    return 0
  fi
  echo "=== Preflight: L3 lint/typecheck + L1 unit tests ==="
  (cd agent && npm run test:l3 && npm run test:l1) || {
    echo "Preflight failed. Set SKIP_PREFLIGHT=1 for emergency deploys." >&2
    exit 1
  }
  if [ -d memo/.venv ] && [ -x memo/.venv/bin/ruff ]; then
    (cd memo && .venv/bin/ruff check . && .venv/bin/pytest -q tests/) || {
      echo "Memo preflight failed." >&2
      exit 1
    }
  fi
}

ensure_build_image() {
  STAMP="/tmp/.zhiliao-build-image-stamp"
  if ! docker image inspect "$BUILD_IMAGE" &>/dev/null \
     || [ agent/package.json -nt "$STAMP" ] \
     || [ agent/package-lock.json -nt "$STAMP" ]; then
    echo "Building build image (deps only)..."
    docker build -f agent/Dockerfile.base --network host -t "$BUILD_IMAGE" agent/
    touch "$STAMP"
  fi
}

case "$MODE" in
  --full)
    echo "=== Full deploy: building release image ==="
    preflight
    ensure_build_image
    docker compose build
    docker compose up -d
    docker compose logs agent --tail=5 --no-log-prefix
    ;;
  *)
    echo "=== Quick deploy: mount source + tsx ==="
    preflight
    ensure_build_image
    docker compose "${COMPOSE_DEV[@]}" up -d agent
    docker compose "${COMPOSE_DEV[@]}" logs agent --tail=5 --no-log-prefix
    ;;
esac
