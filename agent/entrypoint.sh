#!/bin/sh
# Rebuild native dependencies for mounted plugins to match container platform
for dir in /app/plugins/*/; do
  [ -f "$dir/package.json" ] || continue
  # Skip read-only mounts
  if ! touch "$dir/.entrypoint-check" 2>/dev/null; then
    continue
  fi
  rm -f "$dir/.entrypoint-check"

  if [ ! -d "$dir/node_modules" ]; then
    echo "Installing dependencies for plugin: $(basename "$dir")"
    (cd "$dir" && npm install --omit=dev 2>&1) || echo "Warning: failed to install deps for $(basename "$dir")"
  else
    echo "Rebuilding native modules for plugin: $(basename "$dir")"
    (cd "$dir" && npm rebuild 2>&1) || echo "Warning: failed to rebuild deps for $(basename "$dir")"
  fi
done

exec "$@"
