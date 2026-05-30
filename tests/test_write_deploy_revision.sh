#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/write-deploy-revision.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

DEPLOY_ROOT="$TMP_DIR/deploy-root"
MAIN_REPO="$DEPLOY_ROOT/code/zhiliao"
PLUGINS_ROOT="$DEPLOY_ROOT/code/plugins"
OUTPUT_PATH="$DEPLOY_ROOT/DEPLOY_REVISION.json"

mkdir -p "$MAIN_REPO" "$PLUGINS_ROOT"

create_git_repo() {
  local repo_path="$1"
  local file_name="$2"
  local file_body="$3"

  git init "$repo_path" >/dev/null
  git -C "$repo_path" config user.name "Test User"
  git -C "$repo_path" config user.email "test@example.com"
  printf '%s\n' "$file_body" >"$repo_path/$file_name"
  git -C "$repo_path" add "$file_name"
  git -C "$repo_path" commit -m "init" >/dev/null
}

create_git_repo "$MAIN_REPO" "README.md" "main repo"
create_git_repo "$PLUGINS_ROOT/mysql-query" "plugin.txt" "mysql plugin"
mkdir -p "$PLUGINS_ROOT/not-a-git-plugin"

bash "$SCRIPT_PATH" \
  --deploy-root "$DEPLOY_ROOT" \
  --main-repo "$MAIN_REPO" \
  --plugins-root "$PLUGINS_ROOT"

python3 - "$MAIN_REPO" "$PLUGINS_ROOT/mysql-query" "$OUTPUT_PATH" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

main_repo = Path(sys.argv[1])
plugin_repo = Path(sys.argv[2])
output_path = Path(sys.argv[3])

if not output_path.exists():
    raise SystemExit("revision marker was not created")

payload = json.loads(output_path.read_text())

def rev_parse(repo: Path, args: list[str]) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()

assert payload["main"]["commit"] == rev_parse(main_repo, ["rev-parse", "HEAD"])
assert payload["main"]["short_commit"] == rev_parse(main_repo, ["rev-parse", "--short", "HEAD"])
assert payload["main"]["relative_path"] == "code/zhiliao"
assert payload["main"]["dirty"] is False

plugin = payload["plugins"]["mysql-query"]
assert plugin["commit"] == rev_parse(plugin_repo, ["rev-parse", "HEAD"])
assert plugin["relative_path"] == "code/plugins/mysql-query"
assert plugin["dirty"] is False

assert "not-a-git-plugin" not in payload["plugins"]
assert payload["generated_at_utc"].endswith("Z")
PY

echo "test_write_deploy_revision.sh: ok"
