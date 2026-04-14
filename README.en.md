# Zhiliao (知了)

A Feishu (Lark) intelligent Q&A bot supporting both DM and group chat, with a plugin system for connecting to Git repos, CLS log queries, MySQL databases, and more. Conversation knowledge is persisted.

> "知了" (zhīliǎo) means both "cicada" and "got it" in Chinese -- ask anything, it knows.

[Chinese / 中文](README.md)

## Features

- **Feishu Integration**: WebSocket-based Feishu bot supporting group @mentions, per-thread context in topic groups, and direct messages
- **Agent Q&A**: LLM-powered agentic loop with dual provider support (Anthropic Claude + OpenAI-compatible: Doubao/GLM/DeepSeek)
- **Plugin System**: Extend capabilities without modifying core -- auto-discovery, namespace isolation, independent config
- **Knowledge Persistence**: Automatically indexes Git commits with LLM-generated summaries and vector embeddings; supports BM25 + vector hybrid search
- **Change Notifications**: Polls Git repos on a schedule and pushes new commit notifications to Feishu groups
- **Knowledge Decay**: Daily full scans mark stale knowledge for archival and cleanup

## Plugins

Zhiliao connects to external data sources via plugins. The core app bundles knowledge base search (memo-tools); everything else comes from plugins:

| Plugin | Capability | Repo |
|--------|-----------|------|
| **git-repos** | Git tools, repo tracking, change notifications, code search | [oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos) |
| **cls-query** | Tencent Cloud CLS log query | [oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query) |
| **mysql-query** | MySQL database query | [oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query) |
| **memo-tools** | Knowledge base search (builtin) | Bundled with core |

## Architecture

```
Feishu WebSocket --> FeishuAdapter --> Agent Invoker --> LLM (Claude/GLM/DeepSeek)
                                            |
                     +----------------------+------------------+----------------------+
                     |                      |                  |                      |
                     v                      v                  v                      v
               git-repos plugin      cls-query plugin   mysql-query plugin    memo-tools (builtin)
               - code search/read     - log query        - DB query             - knowledge search
               - Tracker/Scanner                                                |
               - change notifications                                             v
                     |                                                      Memo Service
                     v                                                     (Python/FastAPI)
               Git Repos (local)                                          - indexing + hybrid search
                                                                          - knowledge decay
                                                                              |
                                                                              v
                                                                       knowledge.db
                                                                       (SQLite + FTS5)
```

Two services:
- **agent** (TypeScript/Node.js) -- Feishu integration, agent Q&A, plugin management
- **memo** (Python/FastAPI) -- knowledge indexing, hybrid search, knowledge decay

## Quick Start

### 1. Clone

```bash
git clone git@github.com:oh-zhiliao/zhiliao.git
cd zhiliao
```

### 2. Install Plugins

```bash
# Clone plugins alongside the main repo
cd ..
git clone git@github.com:oh-zhiliao/git-repos.git
git clone git@github.com:oh-zhiliao/cls-query.git     # optional
git clone git@github.com:oh-zhiliao/mysql-query.git   # optional
cd zhiliao
```

### 3. Configure

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` with the following (secrets can be written directly -- file is gitignored):

| Config | Description | Example |
|--------|-------------|---------|
| `feishu.app_id` | Feishu app ID | `cli_xxx` |
| `feishu.app_secret` | Feishu app secret | From Feishu Open Platform |
| `llm.agent.api_key` | Agent LLM API key | Anthropic / ZhiPu / Doubao key |
| `llm.memo.api_key` | Memo LLM API key | DeepSeek / ZhiPu key |
| `admins` | Admin Feishu open_id list | `["ou_xxx"]` |

Optionally create `.env` (only needed for build acceleration):

```bash
USE_CN_MIRROR=true   # Use China mirrors for Docker build
```

### 4. SSH Deploy Key

```bash
mkdir -p data
ssh-keygen -t ed25519 -f data/deploy_key -N "" -C "zhiliao-deploy"
# Add data/deploy_key.pub as a read-only deploy key to your Git repos
```

### 5. Deploy

```bash
docker compose build
docker compose up -d
```

### 6. Configure Repos

Edit the `git-repos` plugin config, or message the bot directly:

```
/git-repos list
/git-repos status
```

## Deploy with AI Agent

Zhiliao supports interactive deployment via AI agents (Claude Code, Cursor, etc.).

### Prerequisites

- Target machine has Docker and Docker Compose installed
- Target machine has Ollama with an embedding model (`ollama pull qwen3-embedding:0.6b`)
- A Feishu bot app created at [Feishu Open Platform](https://open.feishu.cn) with WebSocket event subscription enabled
- An LLM API key (Anthropic / ZhiPu / DeepSeek / etc.)

### Deployment Steps

Send this prompt to your AI agent:

```
Please deploy Zhiliao to <target machine>.

Repository: git@github.com:oh-zhiliao/zhiliao.git

Follow these steps, pausing to ask me for information at each step:

1. Clone the repo
2. Ask me for the following config, one item at a time:
   - Feishu App ID and App Secret
   - Agent LLM config (provider, base_url, model, api_key)
   - Memo LLM config (provider, base_url, model, api_key)
   - Embedding config (default: local Ollama qwen3-embedding:0.6b)
   - Admin Feishu open_id(s)
3. Generate config.yaml from my answers
4. Generate SSH deploy key and show me the public key to add to the Git repo
5. If the target machine is in China, create .env with USE_CN_MIRROR=true
6. Run: docker compose build && docker compose up -d
7. Check logs to confirm startup ("Zhiliao is running" and "ws client ready")
```

The agent will interactively collect your config, generate files, and complete the deployment.

### Config Reference

Full config.yaml structure:

```yaml
project:
  name: "my-project"            # Display name

feishu:
  app_id: "cli_xxx"             # Feishu app ID
  app_secret: "your-secret"     # Feishu app secret
  event_mode: "websocket"       # Fixed value

llm:
  agent:                        # LLM for agent Q&A (must support tool-use)
    provider: "anthropic"       # anthropic / openai_compatible
    base_url: "https://api.anthropic.com"  # required for openai_compatible
    model: "claude-sonnet-4-20250514"      # or doubao-seed-2-0-pro-260215, etc.
    api_key: "sk-ant-xxx"
  memo:                         # LLM for memo summarization/indexing
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
    api_key: "sk-xxx"
  embedding:                    # Vector embedding
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"  # Local Ollama
    model: "qwen3-embedding:0.6b"

# Knowledge tools (builtin, set enabled: false to disable)
memo:
  enabled: true
  url: "http://127.0.0.1:8090"

admins:
  - "ou_xxxxxxx"                # Admin Feishu open_id
```

## Usage

| Scenario | How |
|----------|-----|
| Group chat | `@Zhiliao how does the auth middleware work?` |
| Topic thread | Follow up in the same thread without @ |
| Direct message | Just send your question |
| Repo management | `/git-repos list`, `/git-repos status` |

## Project Structure

```
zhiliao/
  docker-compose.yml          # Deployment orchestration
  config.yaml                 # Configuration (gitignored)
  config.example.yaml         # Config template
  SOUL.example.md             # Bot personality template
  agent/                      # TypeScript/Node.js service
    Dockerfile
    src/
      builtin/memo-tools.ts   # Builtin knowledge tools
      agent/                  # Agent core, plugin system
      channels/feishu/        # Feishu channel
    tests/                    # Tests
    prompt/CLAUDE.md          # Bot system prompt
    plugins/                  # Third-party plugin directory (gitignored)
  memo/                       # Python/FastAPI knowledge service
    Dockerfile
    server.py, config.py ...
  nanoclaw/                   # Feishu SDK submodule
  docs/                       # Documentation
  data/                       # Runtime data (gitignored)
```

## Tech Stack

- TypeScript 5+ / Node.js 20+
- Python 3.12+ / FastAPI
- SQLite (better-sqlite3 + WAL / FTS5)
- Docker Compose (host network mode)
- LLM: Claude / Doubao / GLM / DeepSeek (Anthropic + OpenAI-compatible dual provider)
- Embedding: qwen3-embedding:0.6b (Ollama)

## Documentation

- [Architecture Overview](docs/architecture.md)
- [Deployment Manual](docs/deployment.md)
- [Config & Database](docs/module-config-db.md)
- [Feishu Channel](docs/module-feishu.md)
- [Agent Module](docs/module-agent.md)
- [Memo Knowledge Service](docs/module-memo.md)
- [Git Module](docs/module-git.md)
- [Commands & Permissions](docs/module-commands.md)
- [Notifier Module](docs/module-notifier.md)
- [Plugin Development Guide](docs/plugin-development.md)
- [Testing](docs/testing.md)

## License

MIT
