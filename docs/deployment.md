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

**Common:**
- A Feishu (Lark) bot application with WebSocket event subscription enabled
- An LLM API key for agent Q&A (Anthropic Claude, or any OpenAI-compatible API with tool-use support: Doubao, GLM, DeepSeek, etc.)
- An LLM API key for memo summarization/embedding (any OpenAI-compatible API: DeepSeek, GLM, etc.)
- Ollama with embedding model (`ollama pull qwen3-embedding:0.6b`)
- SSH deploy key for each Git repository to track
- Git

**For local deployment:**
- Node.js 22 (LTS)
- Python 3.12+

**For Docker deployment:**
- Docker & Docker Compose

---

## Step 1: Clone and Set Up

```bash
git clone https://github.com/oh-zhiliao/zhiliao.git
cd zhiliao
bash setup.sh
```

The setup script clones plugins into `plugins/`, creates data directories, and generates config files from examples.

---

## Step 2: Configure

All secrets go directly in config files (all gitignored). No `.env` needed for secrets.

**config.yaml** (main app):
```yaml
project:
  name: "my-project"
  timezone: "Asia/Shanghai"

feishu:
  app_id: "cli_xxxxxxxxx"
  app_secret: "your-feishu-app-secret"   # inline, no ${ENV_VAR}
  event_mode: "websocket"

llm:
  agent:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
    api_key: "your-agent-api-key"
  memo:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
    api_key: "your-memo-api-key"
  embedding:
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"
    model: "qwen3-embedding:0.6b"

memo:
  enabled: true
  url: "http://127.0.0.1:8090"
```

**plugins/git-repos/config.yaml**:
```yaml
repos:
  - name: "my-repo"
    url: "git@github.com:org/my-repo.git"
    branch: "main"

# For local deployment, use absolute paths:
#   ssh_key_path: "/path/to/zhiliao/data/deploy_key"
#   repos_dir: "/path/to/zhiliao/data/repos"
# For Docker deployment, use container paths:
ssh_key_path: "/app/data/deploy_key"
repos_dir: "/app/data/repos"

memo_url: "http://127.0.0.1:8090"
poll_interval_minutes: 5
deep_scan_cron: "0 2 * * *"

notifications:
  my-repo: ["oc_xxxxxxx"]

admins: ["ou_xxxxxxx"]
```

**plugins/cls-query/config.yaml**:
```yaml
secret_id: "your-tencent-secret-id"
secret_key: "your-tencent-secret-key"
default_region: "ap-nanjing"
known_topics:
  my_app:
    topic_id: "your-topic-id"
    region: "ap-nanjing"
```

---

## Step 3: Set Up SSH Deploy Key

```bash
ssh-keygen -t ed25519 -f data/deploy_key -N "" -C "zhiliao-deploy"
```

Add `data/deploy_key.pub` as a **read-only deploy key** to each Git repository:
- GitHub: Repo Settings → Deploy keys → Add deploy key

---

## Step 4: Build and Start

### Option A: Local (bare-metal)

Runs memo and agent directly on the host as background processes. No Docker needed.

```bash
bash deploy-local.sh setup     # create venv, install npm deps, rebuild native modules
bash deploy-local.sh start     # start memo (port 8090) + agent
```

**Managing services:**

```bash
bash deploy-local.sh status    # show running/stopped
bash deploy-local.sh stop      # graceful shutdown
bash deploy-local.sh restart   # stop + start
bash deploy-local.sh logs      # tail all logs (or: logs memo | logs agent)
```

Logs are written to `data/logs/{memo,agent}.log`. PIDs in `data/pids/`.

**Environment variables:** `.env` is auto-sourced by deploy-local.sh. Use it for plugin env vars:

```bash
TENCENTCLOUD_SECRET_ID=...     # if cls-query plugin uses ${} substitution
TENCENTCLOUD_SECRET_KEY=...
```

**Plugin paths:** For local deployment, plugin configs must use **absolute host paths** instead of `/app/data/`:

```yaml
# plugins/git-repos/config.yaml
ssh_key_path: "/path/to/zhiliao/data/deploy_key"
repos_dir: "/path/to/zhiliao/data/repos"
```

### Option B: Docker (quick)

Mounts source code, tsx runs TypeScript directly. No compile step needed.

```bash
bash deploy.sh          # builds zhiliao-build image if needed, starts agent
```

### Option C: Docker (full / production)

Compiles TypeScript into a self-contained release image (no build tools, no source).

```bash
bash deploy.sh --full   # builds zhiliao-build → compiles → zhiliao-release image
```

### Docker manual build

```bash
docker compose build
docker compose up -d
```

### Verify

```bash
# Local deployment:
bash deploy-local.sh status
curl http://localhost:8090/health
tail -20 data/logs/agent.log
# Expected: "Plugin loaded: git-repos (N tools)"
# Expected: "Plugin loaded: cls-query (N tools)"
# Expected: "Plugin loaded: mysql-query (N tools)"

# Docker deployment:
docker compose ps
curl http://localhost:8090/health
docker compose logs -f agent
```

---

## Step 5: Configure Repositories

Repositories are configured in `plugins/git-repos/config.yaml` under the `repos` section (see Step 2). After updating the config, restart the service:

```bash
# Local:
bash deploy-local.sh restart

# Docker:
docker compose restart agent
```

To check repository status at runtime:

| Command | Description |
|---------|-------------|
| `/git-repos list` | List all tracked repositories |
| `/git-repos status` | Show system status (tracker/scanner) |

---

## Step 6: Set Up Feishu Group Notifications

Notification targets are configured per-repo in `plugins/git-repos/config.yaml` under `notifications`.

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

## Configuration Reference

All secrets are stored in `config.yaml` (gitignored). The `.env` file only contains build-time settings:

| `.env` Variable | Default | Description |
|-----------------|---------|-------------|
| `USE_CN_MIRROR` | `false` | Use China mirror for npm/pip/apt during build |

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

Both agent and memo LLM settings are in `config.yaml`. The memo service reads from the `llm.memo` and `llm.embedding` sections. Any OpenAI-compatible API works:

```yaml
# Example: local Ollama
llm:
  memo:
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"
    model: "llama3"
    api_key: "ollama"
  embedding:
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"
    model: "nomic-embed-text"
```

---

## Monitoring

### Health Checks

```bash
# Memo service health (both modes)
curl http://localhost:8090/health

# Local deployment
bash deploy-local.sh status

# Docker deployment
docker compose ps
```

### Logs

```bash
# Local deployment
bash deploy-local.sh logs          # all
bash deploy-local.sh logs agent    # agent only
bash deploy-local.sh logs memo     # memo only

# Docker deployment
docker compose logs -f
docker compose logs -f agent
docker compose logs -f rag
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
git pull
bash setup.sh          # pulls latest plugins
```

Then restart the services:

```bash
# Local deployment
bash deploy-local.sh setup        # rebuild deps if package.json changed
bash deploy-local.sh restart

# Docker deployment
docker compose build
docker compose up -d
```

Data in `./data/` persists across updates. No migration is needed for SQLite schema changes (tables use `CREATE IF NOT EXISTS`).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Bot doesn't respond in group | Not mentioned with trigger word | Use `@GitMemo` prefix |
| `Memo service not reachable` at startup | Memo not healthy yet | Check `data/logs/memo.log` (local) or `docker compose logs rag` (Docker) |
| `Missing required fields` | Missing API key in config.yaml | Check `llm.memo.api_key` in config.yaml |
| `Config file not found` | Missing `config.yaml` | Run `bash setup.sh` or copy from `config.example.yaml` |
| Git clone fails | Deploy key not authorized | Add `data/deploy_key.pub` to repo's deploy keys |
| Git clone fails (local) | `GIT_SSH_COMMAND` not set | Ensure `data/deploy_key` exists; deploy-local.sh sets it automatically |
| `SQLITE_READONLY` (local) | Files owned by root (from Docker) | `sudo chown -R $(whoami) data/` |
| `NODE_MODULE_VERSION` mismatch | Native modules built for different Node.js | `bash deploy-local.sh setup` or `cd plugins/xxx && npm rebuild` |
| 503 from Memo endpoints | Memo can't reach LLM | Check `llm.memo` section in config.yaml |
| FTS search returns no results | Query too specific | Search uses word-level matching, try simpler terms |
| Agent returns empty responses | Invalid API key | Check `llm.agent.api_key` in config.yaml |
| No tools available | Plugins not loaded | Check `plugins/` dir has cloned repos, check logs for "Plugin loaded" |
| Plugin paths use `/app/data/` (local) | Docker paths in plugin config | Replace with absolute host paths in plugin `config.yaml` |
| `Unknown command: /repo` | Old command format | Use `/git-repos list` or `/git-repos status` instead |

---

## Security Notes

- Deploy keys should be **read-only** — Zhiliao never pushes to repositories
- `config.yaml` contains secrets — it is gitignored, never commit it
- Plugin `config.yaml` files also contain secrets — gitignored per plugin
- The `.env` file only has build settings (no secrets)
- All git tool operations validate paths to prevent directory traversal
