# 知了 (Zhiliao) — Intelligent Q&A Bot with Plugin System

A multi-channel intelligent Q&A assistant with a plugin architecture. Supports Feishu and WebChat (browser UI) channels, connects to Git repos, CLS logs, MySQL databases, and more.

> "知了" (zhīliǎo) means both "cicada" and "got it" in Chinese -- ask anything, it knows.

## Features

- **Multi-channel**: Feishu (WebSocket) and browser-based WebChat with real-time streaming
- **Plugin architecture**: Tools, commands, and background services via self-contained plugins
- **Knowledge persistence**: Memo service with hybrid BM25 + vector search (FTS5 + embeddings)
- **Multi-LLM support**: Anthropic Claude or OpenAI-compatible APIs (Doubao, GLM, DeepSeek)
- **Session management**: Per-thread sessions with SQLite persistence, TTL, and automatic compression
- **Security**: Secret filtering, path traversal protection, JWT auth for WebChat

## Architecture

Core app is a thin shell -- Channel layer (Feishu WS + WebChat HTTP/WS) + Agent loop + Session management + Plugin loading. Builtin `memo-tools` handles knowledge base search; all other tools come from plugins.

```
Feishu / Browser --> Channel Router --> Agent Invoker --> LLM (Claude/GLM/DeepSeek)
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

See [docs/architecture.md](docs/architecture.md) for the full diagram and data flow.

## Quick Start

```bash
git clone https://github.com/oh-zhiliao/zhiliao.git
cd zhiliao
bash setup.sh
# Edit config.yaml with your Feishu app credentials and LLM API keys
bash deploy-local.sh setup
bash deploy-local.sh start
```

Prerequisites: Node.js 22, Python 3.12+, a Feishu bot app with WebSocket enabled, an LLM API key, and [Ollama](https://ollama.com) with `qwen3-embedding:0.6b` for embeddings.

Docker deployment is also available:

```bash
docker compose build
docker compose up -d
```

## Configuration

Single `config.yaml` file (gitignored, secrets inline). Supports `${ENV_VAR}` substitution.

```yaml
project:
  name: "my-project"
  timezone: "Asia/Shanghai"

feishu:
  app_id: "cli_xxx"
  app_secret: "your-secret"
  event_mode: "websocket"

llm:
  agent:
    provider: "anthropic"              # or "openai_compatible"
    model: "claude-sonnet-4-20250514"
    api_key: "your-key"
  memo:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
    api_key: "your-key"
  embedding:
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"
    model: "qwen3-embedding:0.6b"

memo:
  enabled: true
  url: "http://127.0.0.1:8090"

admins:
  - "ou_xxxxxxx"
```

See [docs/deployment.md](docs/deployment.md) for the full reference.

## Plugin Ecosystem

| Plugin | Repo | Tools | Description |
|--------|------|-------|-------------|
| **git-repos** | [oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos) | 7 | File read, search, log, diff, blame, repo knowledge; background tracker/scanner/notifier |
| **cls-query** | [oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query) | 2 | Tencent CLS log query |
| **mysql-query** | [oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query) | 2 | MySQL database query |

Plugins are auto-discovered from the `plugins/` directory at startup. Each is a self-contained folder with its own `config.yaml` and source code. See [docs/plugin-development.md](docs/plugin-development.md) for the plugin API and a complete example.

## Channels

### Feishu

WebSocket event subscription. Supports private chat, group chat with @mention, and per-thread sessions in topic groups.

### WebChat

Browser-based ChatGPT-style UI with JWT authentication, WebSocket streaming with real-time tool call visibility, and multi-session support.

```yaml
webchat:
  enabled: true
  port: 8080
  password: "your-password"
```

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Reset current session |
| `/context` | Show session info (messages, tokens, duration) |
| `/help` | Show help |
| `/git-repos list` | List tracked repositories |
| `/git-repos status` | Show tracker/scanner status |

Plugin commands follow the `/{plugin-name} {subcommand}` pattern.

## Usage

| Scenario | How |
|----------|-----|
| Group chat | `@Zhiliao how does the auth middleware work?` |
| Topic thread | Follow up in the same thread without @ |
| Direct message | Just send your question |
| Browser | Open `http://your-server:8080` |

## Development

```bash
cd agent && npm ci          # install dependencies
npm test                    # run all tests
npm test -- tests/agent/invoker.test.ts   # single test file
npx tsx src/index.ts ../config.yaml       # dev server
```

Python tests for the memo service:

```bash
cd memo && .venv/bin/python -m pytest tests/ -v
```

See [docs/testing.md](docs/testing.md) for test structure and [docs/mistakes.md](docs/mistakes.md) for common pitfalls.

## Documentation

| File | Description |
|------|-------------|
| [docs/architecture.md](docs/architecture.md) | System architecture, data flow, design decisions |
| [docs/module-agent.md](docs/module-agent.md) | Agent invoker, agentic loop, plugin system |
| [docs/module-feishu.md](docs/module-feishu.md) | Feishu channel: client, adapter, routing, message format |
| [docs/module-memo.md](docs/module-memo.md) | Memo knowledge service: indexing, search, decay |
| [docs/plugin-development.md](docs/plugin-development.md) | Plugin API reference and development guide |
| [docs/deployment.md](docs/deployment.md) | Deployment manual (local, Docker, production) |
| [docs/testing.md](docs/testing.md) | Test framework and structure |
