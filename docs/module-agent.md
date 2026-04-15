# Agent 模块

LLM Agent 调用、tool-use agentic loop、插件系统。支持 Anthropic (Claude) 和 OpenAI-compatible (Doubao/GLM/DeepSeek 等) 两种 provider。

**核心无内置工具** — 所有 tool 实现由插件提供。

## invoker.ts

Agent 调用核心，管理对话历史和工具循环。

**类**: `AgentInvoker`

### 双 Provider 支持

通过 `config.llm.agent.provider` 字段切换：

| Provider | SDK | API 格式 | 示例模型 |
|----------|-----|---------|---------|
| `anthropic` (默认) | @anthropic-ai/sdk | `/messages` + `x-api-key` | Claude Sonnet/Opus |
| `openai_compatible` | openai | `/chat/completions` + `Bearer` | Doubao, GLM, DeepSeek |

内部使用统一的 `LLMContentBlock` / `LLMResponse` 类型，agentic loop 对 provider 透明。Tool 定义自动转换：Anthropic `input_schema` ↔ OpenAI `function.parameters`。

### Agentic Loop

```
用户提问 → 添加到 session history
  → callLLM() (自动选择 Anthropic/OpenAI 路径)
    ├── 返回 text → 完成
    └── 返回 tool_use →
        ├── 执行 tool → 收集结果
        ├── 报告进度 (onProgress callback)
        ├── 检查迭代限制
        │   ├── 未超限 → 继续循环
        │   └── 超限 → 无 tools 再调一次，强制文本总结
        └── 添加结果到 history → 回到 callLLM()
```

### 迭代限制

| 常量 | 值 | 说明 |
|------|------|------|
| `MAX_TOOL_ITERATIONS` | 20 | 昂贵工具迭代上限 |
| `MAX_TOTAL_ITERATIONS` | 50 | 所有工具总迭代上限 |

Cheap/expensive 分类由各插件通过 `getCheapTools()` 声明，不再硬编码在核心中。

### Session 管理

- SQLite 持久化存储，key = session ID
- Session TTL: 7 天
- History 裁剪: 保留最近 50 条消息
- Token 软限制: 80000 tokens 后触发历史压缩（使用 memo LLM）
- 会话锁: 同一 session 的并发请求串行化

### 空回复保护

循环结束后若 `finalText` 为空，返回 `"(空回复，请重试)"`。

## Plugin System

All agent tools are provided by plugins. Core has no tool implementations.

**Core files**:
- `tool-plugin.ts` — `ToolPlugin` interface (tools, commands, lifecycle, secrets)
- `tool-registry.ts` — `ToolRegistry` aggregates plugin tools, routes tool calls and commands, manages plugin lifecycle
- `tool-loader.ts` — Auto-discovers plugins from `plugins/` directory at startup

**Tool naming**: All tools use `{plugin}.{tool}` prefix (e.g. `git-repos.search`, `memo-tools.memory_search`).

**Plugin lifecycle**:
1. `loadPlugins()` scans `plugins/` → reads `config.yaml` → dynamic imports `src/index.ts` → calls `init(config)` → registers in ToolRegistry
2. `toolRegistry.startAll(context)` — calls `plugin.start(context)` for background services
3. Runtime: LLM calls `git-repos.search` → registry routes → `plugin.executeTool("search", input)`
4. Shutdown: `toolRegistry.stopAll()` → `toolRegistry.destroyAll()`

**Plugin capabilities**:
- **Tools**: `getToolDefinitions()` + `executeTool()` — LLM-callable functions
- **Commands**: `getCommandHandlers()` — user-facing `/{plugin} {subcommand}` commands
- **Background services**: `start(context)` / `stop()` — e.g. git tracker, scanner
- **Secret filtering**: `getSecretPatterns()` — regex patterns merged into global filter
- **Output filtering**: `filterOutput()` — custom structured filtering of agent response text, chained across all plugins via `ToolRegistry.filterOutput()` (called after `filterSecrets()`)
- **System prompt**: `getSystemPromptAddendum()` — extra instructions appended to agent prompt
- **Cheap tools**: `getCheapTools()` — fast/local tools that don't count against expensive limit

**Plugin isolation**: Plugins receive only their own config + a `PluginContext` with limited core capabilities (currently: `sendFeishuMessage`, `callLLM`).

See [Plugin Development Guide](plugin-development.md) for how to build new plugins.

## SOUL.md — 人格配置

可选的部署级人格配置文件，放在 `config.yaml` 同目录下（gitignored）。

**加载逻辑**: `AgentInvoker.loadSoulPrompt(configDir)` — 读取 `SOUL.md`，不存在则使用 `DEFAULT_SOUL_PROMPT`（内置"知了"人格）。

**Prompt 组装顺序**:
```
SOUL.md content (人格/身份)
---
CLAUDE.md content (安全、工具、格式规则)
[plugin addendum] (插件额外指令)
```

SOUL.md 在前（LLM 视为身份定义），CLAUDE.md 在后（硬约束）。参考 `SOUL.example.md`。

## agent/CLAUDE.md

Agent system prompt，定义 agent 的角色、能力边界和安全规则。包含 prompt injection 防护指令。
