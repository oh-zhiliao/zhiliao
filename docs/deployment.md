# Zhiliao Deployment Manual

Zhiliao (知了) is a Feishu intelligent Q&A bot that supports DM and group chat, with a plugin system for connecting to Git repos, CLS log queries, MySQL databases, and more.

## Architecture Overview

```
                  Feishu Users
                      │
                      ▼
              ┌───────────────┐
              │   Zhiliao     │  ← TypeScript/Node.js
              │  (core app)   │
              │               │
              │  - Feishu WS  │
              │  - Agent Loop │
              │  - Plugin Mgr │
              │  - memo-tools │  ← Builtin
              └───────┬───────┘
                      │
            ┌─────────┼──────────┐
            ▼         ▼          ▼
     ┌────────────┐ ┌────────┐ ┌────────────┐
     │ git-repos  │ │cls-    │ │mysql-query │  ← Plugins (mounted volumes)
     │  plugin    │ │query   │ │  plugin    │
     │ - Tracker  │ └────────┘ └────────────┘
     │ - Scanner  │
     │ - Notifier │
     └─────┬──────┘
           │
           ▼
    ┌───────────────┐
    │  Memo Service │  ← Python/FastAPI (bundled)
    │  - Indexing   │
    │  - Search     │
    │  - Decay      │
    └───────────────┘
```

Components:
- **zhiliao** — core app (Feishu integration, agent loop, builtin memo-tools, plugin loading)
- **git-repos plugin** — git tools, background services ([oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos))
- **cls-query plugin** — Tencent CLS log query ([oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query))
- **mysql-query plugin** — MySQL database query ([oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query))
- **memo** — knowledge service (bundled, LLM summarization, embedding, hybrid search)

---

## Prerequisites

- Docker & Docker Compose
- A Feishu (Lark) bot application with WebSocket event subscription enabled
- An LLM API key for agent Q&A (Anthropic Claude, or any OpenAI-compatible API with tool-use support: Doubao, GLM, DeepSeek, etc.)
- An LLM API key for memo summarization/embedding (any OpenAI-compatible API: DeepSeek, GLM, etc.)
- SSH deploy key for each Git repository to track
- Plugin repositories cloned alongside the main repo (git-repos, memo-tools)

---

## Step 1: Clone and Configure

```bash
git clone --recurse-submodules <repo-url> gitmemo
cd gitmemo
cp config.example.yaml config.yaml
```

Edit `config.yaml` (core app config — git/admins/knowledge settings are now in plugin configs):

```yaml
project:
  name: "my-project"              # Your project display name
  timezone: "Asia/Shanghai"       # IANA timezone for agent responses (optional, defaults to container local time)

feishu:
  app_id: "cli_xxxxxxxxx"         # Feishu app ID (from open.feishu.cn)
  app_secret: "${FEISHU_APP_SECRET}"  # Resolved from env var at runtime
  event_mode: "websocket"         # Must be websocket

llm:
  agent:
    provider: "anthropic"               # "anthropic" or "openai_compatible"
    model: "claude-sonnet-4-20250514"   # Must support tool-use / function-calling
  memo:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"              # Model for commit summarization
  embedding:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-embedding"         # Model for vector embeddings
```

Configure plugins in their own `config.yaml` files (see Step 4b below).

---

## Step 2: Set Environment Variables

Create a `.env` file in the project root:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-xxxxxxx        # Claude API key (for agent Q&A)
FEISHU_APP_SECRET=xxxxxxxxxxxxxxx       # Feishu app secret
DEEPSEEK_API_KEY=sk-xxxxxxx             # DeepSeek API key (for Memo summarization/embedding)

# Optional Memo overrides (defaults work with DeepSeek)
# MEMO_LLM_BASE_URL=https://api.deepseek.com/v1
# MEMO_LLM_MODEL=deepseek-chat
# MEMO_EMBEDDING_BASE_URL=https://api.deepseek.com/v1
# MEMO_EMBEDDING_MODEL=deepseek-embedding
# MEMO_DECAY_AFTER_DAYS=30
```

---

## Step 3: Set Up SSH Deploy Key

Generate a deploy key for the repositories you want to track:

```bash
mkdir -p data
ssh-keygen -t ed25519 -f data/deploy_key -N "" -C "gitmemo-deploy"
```

Add `data/deploy_key.pub` as a **read-only deploy key** to each Git repository:
- GitHub: Repo Settings → Deploy keys → Add deploy key
- GitLab: Repo Settings → Repository → Deploy keys

---

## Step 4: Deploy with Docker Compose

### Step 4a: Clone Plugins

Clone the plugin repositories alongside the main repo (memo-tools is builtin, no separate clone needed):

```bash
# From the parent directory containing the main repo
git clone <git-repos-plugin-url> git-repos
```

### Step 4b: Configure Plugins

Each plugin has its own `config.yaml`:

**git-repos/config.yaml**:
```yaml
repos:
  - name: "my-repo"
    url: "git@github.com:org/my-repo.git"
    branch: "main"

repos_dir: "/app/data/repos"
ssh_key_path: "/app/data/deploy_key"
memo_url: "http://127.0.0.1:8090"
poll_interval_minutes: 5
deep_scan_cron: "0 2 * * *"

notifications:
  my-repo: ["oc_xxxxxxx"]

admins: ["ou_xxxxxxx"]
```

Memo tools are builtin (configured in main `config.yaml` under `memo:`). No separate plugin config needed.

### Step 4c: Update docker-compose.yml

Plugins are mounted as volumes into the container:

```yaml
services:
  gitmemo:
    volumes:
      - ./data:/app/data
      - ../git-repos:/app/plugins/git-repos      # no :ro — entrypoint installs native deps
```

### Step 4d: Build and Start

```bash
docker compose build
docker compose up -d
```

Verify services are running:

```bash
# Check container status
docker compose ps

# Check Memo health
curl http://localhost:8090/health
# Expected: {"status":"ok","uptime_seconds":...}

# Check gitmemo logs
docker compose logs -f gitmemo
# Expected: "Zhiliao is running. Listening for messages..."
# Expected: "Plugin loaded: git-repos (N tools)"
# Expected: "Plugin loaded: memo-tools (N tools)"
```

---

## Step 5: Configure Repositories

Repositories are now configured in `git-repos/config.yaml` under the `repos` section (see Step 4b above). After updating the config, restart the service.

To check repository status at runtime:

| Command | Description |
|---------|-------------|
| `/git-repos list` | List all tracked repositories |
| `/git-repos status` | Show system status (tracker/scanner) |

---

## Step 6: Set Up Feishu Group Notifications

Notification targets are configured per-repo in `git-repos/config.yaml` under `notify_chat_ids`.

---

## Using the Bot

### In Group Chats
Mention the bot with `@GitMemo` followed by your question:

```
@GitMemo how does the authentication middleware work?
@GitMemo what changed in the last week?
@GitMemo who wrote the payment module?
```

### In Topic Threads
The bot maintains per-thread context — follow-up questions in the same thread don't need `@GitMemo`:

```
@GitMemo explain the database schema       ← thread starts
what about the migration history?           ← follow-up (no @ needed)
```

### In Private Chat
Direct messages work without the trigger word:

```
what's the architecture of the API layer?
```

---

## Environment Variable Reference

### GitMemo (main app)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for agent Q&A |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret (also referenced in config.yaml) |
| `MEMO_URL` | No | Memo service URL (default: `http://localhost:8090`, set by docker-compose) |

### Memo Service

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMO_LLM_API_KEY` | Yes | — | API key for LLM + embedding (passed as `DEEPSEEK_API_KEY` in docker-compose) |
| `MEMO_LLM_BASE_URL` | No | `https://api.deepseek.com/v1` | OpenAI-compatible chat API base URL |
| `MEMO_LLM_MODEL` | No | `deepseek-chat` | Chat model for summarization |
| `MEMO_EMBEDDING_BASE_URL` | No | Same as `MEMO_LLM_BASE_URL` | Embedding API base URL |
| `MEMO_EMBEDDING_MODEL` | No | `deepseek-embedding` | Embedding model |
| `MEMO_DATA_DIR` | No | `/app/data` | Data directory inside container |
| `MEMO_DECAY_AFTER_DAYS` | No | `30` | Days before stale knowledge is archived |

---

## Data Directory Structure

All persistent data lives in `./data/` (mounted into containers):

```
data/
  db.sqlite              # Main DB (repos, admins, notify targets)
  deploy_key             # SSH private key for git access
  deploy_key.pub         # SSH public key
  repos/
    <repo-id>/           # Cloned repositories (bare)
  memo/
    knowledge.db         # Knowledge store (FTS5 + embeddings)
    MEMORY.md            # Project-level overview
    memory/              # Structured knowledge files
    dialog/              # Conversation logs
```

**Backup strategy:** Back up `data/` regularly. The SQLite databases (`db.sqlite`, `knowledge.db`) are the critical state. Repository clones can be re-fetched.

---

## Using a Different LLM Provider

The Memo service works with any OpenAI-compatible API. To use a different provider:

```bash
# Example: using a local Ollama instance
MEMO_LLM_BASE_URL=http://host.docker.internal:11434/v1
MEMO_LLM_MODEL=llama3
MEMO_EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1
MEMO_EMBEDDING_MODEL=nomic-embed-text

# Example: using OpenAI directly
MEMO_LLM_BASE_URL=https://api.openai.com/v1
MEMO_LLM_MODEL=gpt-4o-mini
MEMO_LLM_API_KEY=sk-xxx
MEMO_EMBEDDING_BASE_URL=https://api.openai.com/v1
MEMO_EMBEDDING_MODEL=text-embedding-3-small
```

---

## Monitoring

### Health Checks

```bash
# Memo service health
curl http://localhost:8090/health

# Docker container health
docker compose ps
```

### Logs

```bash
# All services
docker compose logs -f

# GitMemo only
docker compose logs -f gitmemo

# Memo only
docker compose logs -f memo
```

### Key Metrics to Watch

- Memo `/health` uptime — restart if service crashed
- Git tracker poll logs (from git-repos plugin) — ensures repos are being checked
- Feishu WebSocket connection — reconnects automatically on disconnect
- `data/memo/knowledge.db` size — monitor growth over time
- Plugin loaded messages in startup logs — verify all plugins initialized

---

## Updating

```bash
git pull --recurse-submodules
docker compose build
docker compose up -d
```

Data in `./data/` persists across updates. No migration is needed for SQLite schema changes (tables use `CREATE IF NOT EXISTS`).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Bot doesn't respond in group | Not mentioned with trigger word | Use `@GitMemo` prefix |
| `Memo service not reachable` at startup | Memo container not healthy yet | Wait for healthcheck, check `docker compose logs memo` |
| `MEMO_LLM_API_KEY environment variable is required` | Missing API key | Set `DEEPSEEK_API_KEY` in `.env` |
| `Config file not found` | Missing `config.yaml` | Copy from `config.example.yaml` |
| `Environment variable XXX is not set` | Missing env var referenced in config.yaml | Add to `.env` |
| Git clone fails | Deploy key not authorized | Add `data/deploy_key.pub` to repo's deploy keys |
| 503 from Memo endpoints | Service started without config | Check `MEMO_LLM_API_KEY` is set |
| FTS search returns no results | Query too specific | Search uses word-level matching, try simpler terms |
| Agent returns empty responses | Invalid Anthropic API key | Verify `ANTHROPIC_API_KEY` |
| No tools available | Plugins not loaded | Check plugin mount paths in docker-compose, check logs for "Plugin loaded" |
| `Unknown command: /repo` | Old command format | Use `/git-repos list` or `/git-repos status` instead |

---

## Security Notes

- Deploy keys should be **read-only** — Zhiliao never pushes to repositories
- The `.env` file contains secrets — add it to `.gitignore`
- The Feishu app secret should only be stored in environment variables, never in committed files
- Plugin configs may contain secrets — ensure plugin `config.yaml` files are gitignored
- All git tool operations validate paths to prevent directory traversal
