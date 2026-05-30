#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/write-deploy-revision.sh \
    --deploy-root /path/to/deploy-root \
    --main-repo /path/to/main-repo \
    --plugins-root /path/to/plugins-root \
    [--output /path/to/DEPLOY_REVISION.json]
EOF
}

DEPLOY_ROOT=""
MAIN_REPO=""
PLUGINS_ROOT=""
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-root)
      DEPLOY_ROOT="${2:-}"
      shift 2
      ;;
    --main-repo)
      MAIN_REPO="${2:-}"
      shift 2
      ;;
    --plugins-root)
      PLUGINS_ROOT="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$DEPLOY_ROOT" || -z "$MAIN_REPO" || -z "$PLUGINS_ROOT" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -d "$DEPLOY_ROOT" ]]; then
  echo "Deploy root does not exist: $DEPLOY_ROOT" >&2
  exit 1
fi

if [[ ! -d "$MAIN_REPO" ]]; then
  echo "Main repo does not exist: $MAIN_REPO" >&2
  exit 1
fi

if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$DEPLOY_ROOT/DEPLOY_REVISION.json"
fi

python3 - "$DEPLOY_ROOT" "$MAIN_REPO" "$PLUGINS_ROOT" "$OUTPUT_PATH" <<'PY'
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

deploy_root = Path(sys.argv[1]).resolve()
main_repo = Path(sys.argv[2]).resolve()
plugins_root = Path(sys.argv[3]).resolve()
output_path = Path(sys.argv[4]).resolve()


def git(repo: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip()


def is_git_repo(repo: Path) -> bool:
    proc = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--is-inside-work-tree"],
        check=False,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def repo_metadata(repo: Path) -> dict:
    branch = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD", check=False) or None
    status = git(repo, "status", "--short", "--branch")
    dirty = any(line and not line.startswith("##") for line in status.splitlines())
    return {
        "relative_path": os.path.relpath(repo, deploy_root),
        "commit": git(repo, "rev-parse", "HEAD"),
        "short_commit": git(repo, "rev-parse", "--short", "HEAD"),
        "branch": branch,
        "dirty": dirty,
    }


if not is_git_repo(main_repo):
    raise SystemExit(f"main repo is not a git repository: {main_repo}")

payload = {
    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "main": repo_metadata(main_repo),
    "plugins": {},
}

if plugins_root.exists():
    for entry in sorted(plugins_root.iterdir(), key=lambda item: item.name):
        if not entry.is_dir() or not is_git_repo(entry):
            continue
        payload["plugins"][entry.name] = repo_metadata(entry)

output_path.parent.mkdir(parents=True, exist_ok=True)
tmp_path = output_path.with_suffix(output_path.suffix + ".tmp")
tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
os.replace(tmp_path, output_path)

print(output_path)
PY
