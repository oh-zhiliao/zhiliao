#!/bin/sh
# Rebuild native dependencies for mounted plugins to match container platform
NPM_REGISTRY_FLAG=""
if [ "${USE_CN_MIRROR}" = "true" ]; then
  NPM_REGISTRY_FLAG="--registry=https://registry.npmmirror.com"
fi

PLATFORM_STAMP="$(uname -m)-$(node -e 'console.log(process.versions.modules)')"

for dir in /app/plugins/*/; do
  [ -f "$dir/package.json" ] || continue
  # Skip read-only mounts
  if ! touch "$dir/.entrypoint-check" 2>/dev/null; then
    continue
  fi
  rm -f "$dir/.entrypoint-check"

  STAMP_FILE="$dir/.rebuilt-$PLATFORM_STAMP"
  if [ ! -d "$dir/node_modules" ]; then
    echo "Installing dependencies for plugin: $(basename "$dir")"
    (cd "$dir" && npm install --omit=dev $NPM_REGISTRY_FLAG 2>&1) || echo "Warning: failed to install deps for $(basename "$dir")"
    touch "$STAMP_FILE"
  elif [ ! -f "$STAMP_FILE" ]; then
    echo "Rebuilding native modules for plugin: $(basename "$dir")"
    (cd "$dir" && npm rebuild 2>&1) || echo "Warning: failed to rebuild deps for $(basename "$dir")"
    echo "rebuilt dependencies successfully"
    touch "$STAMP_FILE"
  else
    echo "Plugin $(basename "$dir"): native modules already built, skipping"
  fi
done

exec "$@"
