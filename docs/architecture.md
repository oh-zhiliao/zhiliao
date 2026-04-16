# Architecture Overview

知了 (Zhiliao) — 飞书智能问答 Bot，支持私聊和群聊，通过插件机制接入 Git 仓库、CLS 日志查询、MySQL 数据库查询等数据源，问答知识持久化。

## System Components

```
┌─────────────┐    WebSocket     ┌──────────────────────┐
│  Feishu SDK  │ ◄──────────────► │   FeishuAdapter      │
└─────────────┘                  │  (消息路由/命令分发)    │
                                 └──────┬───────────────┘
                                        │
┌─────────────┐    HTTP/WS       ┌──────┴───────────────┐
│   Browser   │ ◄──────────────► │   WebChatChannel     │
└─────────────┘                  │  (HTTP + WebSocket)  │
                                 └──────┬───────────────┘
                                        │
                          ┌─────────────┤
                          ▼             ▼
                   ┌───────────┐ ┌───────────┐
                   │ Session   │ │  Agent    │
                   │ Commands  │ │ Invoker  │
                   └───────────┘ └─────┬─────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
             ┌────────────┐    ┌────────────┐     ┌────────────┐
             │  Plugins   │    │  Plugins   │     │  Builtin   │
             │ git-repos  │    │ cls-query  │     │ memo-tools │
             │ mysql-query│    │  ...       │     │ - 2 tools  │
             │ - 6 tools  │    │ - 2 tools  │     └──────┬─────┘
             │ - tracker  │    └────────────┘            │
             │ - scanner  │                              ▼
             │ - notifier │                       ┌─────────────┐
             │ - commands │                       │ Memo Service│ (Python/FastAPI)
             └─────┬──────┘                       │  - Indexer   │
                   │                               │  - Search   │
                   ▼                               │  - Decay    │
            ┌────────────┐                         └──────┬──────┘
            │ Git Repos  │                                │
            │ (local)    │                                ▼
            └────────────┘                         ┌─────────────┐
                                                  │ knowledge.db│
                                                  │ (SQLite+FTS)│
                                                  └─────────────┘
```

Core app is a thin shell: Feishu WS + Agent loop + Session management + Plugin loading.
Builtin memo-tools handles knowledge base; all other tools come from plugins.

## Tech Stack

- **TypeScript 5+ / Node.js 22 (LTS)** — 主框架
- **Python 3.12+ / FastAPI** — Memo 知识服务
- **SQLite** (better-sqlite3 + WAL) — session 持久化
- **SQLite + FTS5** — 知识存储 + 全文检索
- **Docker Compose** — 部署编排（host network mode for PVE）
- **LLM**: Anthropic Claude 或 OpenAI 兼容 (Doubao/GLM/DeepSeek) — Agent 问答; OpenAI 兼容 — Memo 摘要/索引
- **Embedding**: qwen3-embedding:0.6b (本地 Ollama, 1024 dims)

## Data Flow

### 用户问答
```
User Message → Feishu WS → Adapter → Agent Invoker
  → Tool calls (git-repos.file_read, git-repos.search, memo-tools.memory_search...)
  → Agent Response → Secret Filter → Feishu Reply
```

### 后台索引 (git-repos plugin)
```
Git Tracker (5min poll) → fetch → detect new commits
  → Memo /index/commits → embed + summarize → knowledge.db
  → ChangeNotifier → Feishu群通知
```

### 知识衰减 (git-repos plugin)
```
Deep Scanner (daily) → walk repo files
  → Memo /index/decay → mark stale → archive → delete
```

## Key Design Decisions

- **全插件架构**: 核心应用只包含 memo-tools（与内置 Memo 服务紧耦合），其余 tool 实现由插件提供
- **多通道支持**: FeishuAdapter 和 WebChatChannel 共享同一 AgentInvoker 和 Session 层，通道间互不干扰
- 飞书话题群 per-thread session (`feishu:{chat_id}:{thread_id}`); WebChat per-session key (`webchat:{session_id}`)
- 插件可声明命令 (`getCommandHandlers()`)、后台服务 (`start()/stop()`)、工具 (`getToolDefinitions()`)
- 命令格式: `/{plugin-name} {subcommand}`，会话命令 (/new, /context, /help) 内置
- HTTP for Memo（非 MCP），简单可靠适合后台任务
- Agent 支持 Anthropic 和 OpenAI-compatible 双 provider（Doubao/GLM/DeepSeek 等）
- Memo 服务统一使用 OpenAI-compatible API，支持 DeepSeek/GLM/Ollama 等

## Plugin Architecture

Most agent tools are provided by plugins. Memo-tools is builtin (tightly coupled to the bundled Memo service), disabled via `memo.enabled: false` in config.

- **ToolPlugin interface**: `agent/src/agent/tool-plugin.ts` — the only coupling point
- **ToolRegistry**: Aggregates plugin tools, routes by `{folder}.{tool}` prefix; also routes commands and manages plugin lifecycle
- **Plugin loader**: Auto-discovers from `plugins/` directory at startup
- **plugins/ is gitignored** — plugin assembly is a deployment concern

Each plugin is a self-contained folder: `config.yaml` + `src/index.ts` + optional `package.json`.

### Plugins

| Plugin | Repo | Tools | Background Services | Commands |
|--------|------|-------|-------------------|----------|
| **git-repos** | [oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos) | 7 (list_repos, file_read, search, log, diff, blame, get_repo_knowledge) | Tracker, Scanner, Notifier | `/git-repos list`, `/git-repos status` |
| **cls-query** | [oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query) | 2 | — | — |
| **mysql-query** | [oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query) | 2 | — | — |

### Builtin Tools

| Module | Tools | Description |
|--------|-------|-------------|
| **memo-tools** | 2 (memory_search, get_memory) | Knowledge base search, bundled in core, disabled via `memo.enabled: false` |

### Plugin Capabilities

- **Tools**: LLM-callable functions, namespaced as `{plugin}.{tool}`
- **Commands**: User-facing `/{plugin} {subcommand}` commands routed via `ToolRegistry.handleCommand()`
- **Background services**: Started via `plugin.start(context)`, stopped via `plugin.stop()`
- **Secret filtering**: Plugins provide `getSecretPatterns()` merged into global filter
- **Output filtering**: Plugins provide optional `filterOutput()` for structured post-processing (e.g. hostname aliasing), chained after secret filtering
- **System prompt**: Plugins provide `getSystemPromptAddendum()` appended to agent prompt
