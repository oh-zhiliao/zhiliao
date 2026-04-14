#!/bin/bash
set -e

GITHUB_ORG="oh-zhiliao"
PLUGINS=(git-repos cls-query mysql-query)

echo "=== Zhiliao Setup ==="

# Clone plugins into plugins/ directory
mkdir -p plugins
for plugin in "${PLUGINS[@]}"; do
  if [ -d "plugins/$plugin" ]; then
    echo "Plugin $plugin already exists, pulling latest..."
    (cd "plugins/$plugin" && git pull)
  else
    echo "Cloning plugin $plugin..."
    git clone "https://github.com/$GITHUB_ORG/$plugin.git" "plugins/$plugin"
  fi
done

# Create data directories
mkdir -p data/{repos,memo/memory,memo/dialog,ssh}

# Create config from example if not exists
if [ ! -f config.yaml ]; then
  cp config.example.yaml config.yaml
  echo ""
  echo "Created config.yaml from example. Edit it with your secrets:"
  echo "  - feishu.app_secret"
  echo "  - llm.agent.api_key"
  echo "  - llm.memo.api_key"
  echo "  - plugins/git-repos/config.yaml (copy from config.example.yaml)"
  echo "  - plugins/cls-query/config.yaml (copy from config.example.yaml)"
fi

# Create plugin configs from examples if not exists
for plugin in "${PLUGINS[@]}"; do
  if [ -f "plugins/$plugin/config.example.yaml" ] && [ ! -f "plugins/$plugin/config.yaml" ]; then
    cp "plugins/$plugin/config.example.yaml" "plugins/$plugin/config.yaml"
    echo "Created plugins/$plugin/config.yaml from example — edit it with your secrets."
  fi
done

# Create .env if not exists
if [ ! -f .env ]; then
  echo "USE_CN_MIRROR=false" > .env
fi

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit config.yaml with your secrets"
echo "  2. Edit plugins/*/config.yaml with plugin-specific secrets"
echo "  3. Set up SSH deploy key: ssh-keygen -t ed25519 -f data/deploy_key -N ''"
echo "  4. Add data/deploy_key.pub to your Git repos as a read-only deploy key"
echo "  5. docker compose build && docker compose up -d"
