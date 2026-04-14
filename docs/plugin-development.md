# Plugin Development Guide

本文档是为 AI Agent 和开发者编写的插件开发完整指南。按照此指南可以从零构建一个知了插件。

## Overview

知了采用全插件架构 — **核心应用不包含任何 tool 实现**，所有能力由插件提供。插件在启动时自动发现、加载，工具通过命名空间隔离，LLM 自然地编排插件工具。

**设计原则**:
- 核心是薄壳 — 只负责 Feishu WS、Agent loop、Session 管理、Plugin 加载
- 插件提供一切 — 工具、命令、后台服务
- 插件完全隔离 — 只接收自己的 config + 有限的 PluginContext
- LLM 是编排者 — 插件工具通过 tool description 自然被 LLM 调用
- 插件组装是部署关注点 — 部署者决定启用哪些插件

## Directory Structure

```
agent/plugins/                    # gitignored, 部署时组装
  my-plugin/                      # 文件夹名 = 命名空间
    config.yaml                   # 必须存在，插件配置
    config.example.yaml           # 文档化必填字段（推荐）
    src/
      index.ts                    # 入口，default export 一个 class
    package.json                  # 插件自己的依赖（可选）
    node_modules/                 # 独立安装（可选）
    tsconfig.json                 # 插件自己的 TS 配置（可选）
```

**关键约定**:
- 文件夹名即命名空间：`my-plugin/` → 工具前缀 `my-plugin.`
- `config.yaml` 必须存在，否则目录被忽略
- `config.yaml` 中设 `enabled: false` 可禁用插件
- 入口文件必须是 `src/index.ts` 或 `src/index.js`

## ToolPlugin Interface

插件必须实现 `ToolPlugin` 接口（定义在 `agent/src/agent/tool-plugin.ts`）：

```typescript
export interface ToolDefinition {
  name: string;           // 工具名，不含前缀（如 "search"，不是 "my-plugin.search"）
  description: string;    // LLM 看到的工具描述，要清晰说明用途和参数
  input_schema: Record<string, unknown>;  // JSON Schema，定义工具输入参数
}

export interface ToolPlugin {
  // --- 必须实现 ---

  /** 由 loader 从文件夹名设置，不需要手动赋值 */
  name: string;

  /** 启动时调用，接收解析后的 config.yaml 内容。用于初始化连接、验证配置等 */
  init(config: Record<string, any>): Promise<void>;

  /** 返回工具定义列表，名称不含前缀 */
  getToolDefinitions(): ToolDefinition[];

  /** 执行工具。name 不含前缀。返回结果字符串或错误字符串 */
  executeTool(name: string, input: Record<string, any>): Promise<string>;

  // --- 可选实现 ---

  /** 关闭时调用，清理连接/资源 */
  destroy?(): Promise<void>;

  /** 标记为 cheap 的工具不计入昂贵工具迭代限制 */
  getCheapTools?(): string[];

  /** 为进度报告提供人类可读的工具输入摘要 */
  summarizeInput?(name: string, input: Record<string, any>): string;

  /** 追加到 agent system prompt 的额外指令 */
  getSystemPromptAddendum?(): string;

  /** 额外的 secret 过滤正则，防止敏感信息泄露 */
  getSecretPatterns?(): RegExp[];

  /** 所有插件加载完毕后调用，启动后台服务（如定时轮询）。接收 PluginContext 用于与核心交互 */
  start?(context: PluginContext): Promise<void>;

  /** 关闭前调用（在 destroy 之前），停止后台服务 */
  stop?(): Promise<void>;

  /** 返回插件命令处理器，支持 /{plugin-name} {subcommand} 格式 */
  getCommandHandlers?(): PluginCommandHandler;
}

/** 核心暴露给插件的有限能力（如发送飞书消息） */
export interface PluginContext {
  sendFeishuMessage(chatId: string, msgType: string, content: string): Promise<void>;
}

/** 命令调用时传递给处理器的上下文 */
export interface CommandCallContext {
  userId: string;
  chatType: "p2p" | "group";
  chatId: string;
  logId: string;
}

/** 插件返回的命令处理器，子命令按名称索引 */
export interface PluginCommandHandler {
  subcommands: Record<string, {
    description: string;
    handle(args: string[], context: CommandCallContext): Promise<string>;
  }>;
}
```

## Tool Naming Convention

所有工具都来自插件，统一使用 `{folder}.{tool_name}` 前缀格式：

| 示例 | 来源插件 |
|------|---------|
| `git-repos.search` | git-repos |
| `git-repos.file_read` | git-repos |
| `memo-tools.memory_search` | memo-tools |
| `weather.forecast` | weather |

- 插件定义工具时**不要包含前缀**，loader 自动添加
- LLM 看到的工具名是带前缀的完整名（`my-plugin.search`）
- ToolRegistry 根据 `.` 分隔路由到对应插件

## Config System

### Plugin config.yaml

```yaml
# 特殊字段
enabled: true                  # false 则跳过加载（可选，默认 true）

# 支持环境变量替换
api_key: "${MY_PLUGIN_API_KEY}"
base_url: "https://api.example.com"

# 插件自定义配置
max_results: 50
timeout_ms: 30000
topics:
  - "engineering"
  - "product"
```

环境变量语法 `${VAR_NAME}`：如果环境变量不存在，保留原始字符串 `${VAR_NAME}`。

### config.example.yaml

推荐提供，文档化所有必填和可选字段：

```yaml
# Required
api_key: "${MY_PLUGIN_API_KEY}"    # Your API key
base_url: "https://api.example.com"

# Optional
enabled: true
max_results: 50
```

## Plugin Lifecycle

```
应用启动
  │
  ├─ loadPlugins("agent/plugins/")
  │    ├─ 扫描目录，找到 my-plugin/
  │    ├─ 读取 config.yaml → 环境变量替换 → 解析
  │    ├─ 检查 enabled !== false
  │    ├─ 检查 package.json → node_modules（缺失则 warn）
  │    ├─ dynamic import src/index.ts
  │    ├─ const plugin = new PluginClass()
  │    ├─ plugin.name = "my-plugin"     ← loader 设置
  │    ├─ await plugin.init(config)     ← 你的初始化逻辑
  │    └─ log "Plugin loaded: my-plugin (N tools)"
  │
  ├─ toolRegistry.register(plugin)
  │    ├─ 工具名添加前缀: search → my-plugin.search
  │    ├─ 缓存 cheap tools
  │    └─ 收集 secret patterns
  │
  ├─ toolRegistry.startAll(context)
  │    └─ await plugin.start(context)   ← 启动后台服务（tracker、scanner 等）
  │
  ├─ agent 运行中...
  │    ├─ LLM 调用 my-plugin.search → registry 路由 → plugin.executeTool("search", input)
  │    ├─ 用户输入 /my-plugin list → registry 路由 → plugin.getCommandHandlers().subcommands["list"].handle()
  │    └─ 结果经 secret filter → 返回 LLM
  │
  └─ 应用关闭
       ├─ await toolRegistry.stopAll()     ← plugin.stop() 停止后台服务
       └─ await toolRegistry.destroyAll()  ← plugin.destroy() 清理资源
```

**容错**: 单个插件加载失败只会 log error，不会阻止其他插件或主应用启动。

## Complete Example

以下是一个完整的天气查询插件示例：

### plugins/weather/config.yaml

```yaml
api_key: "${WEATHER_API_KEY}"
base_url: "https://api.weatherapi.com/v1"
```

### plugins/weather/config.example.yaml

```yaml
# Get your API key from https://www.weatherapi.com/
api_key: "${WEATHER_API_KEY}"
base_url: "https://api.weatherapi.com/v1"
```

### plugins/weather/src/index.ts

```typescript
import type { ToolPlugin, ToolDefinition } from "../../../src/agent/tool-plugin.js";

interface WeatherConfig {
  api_key: string;
  base_url: string;
}

export default class WeatherPlugin implements ToolPlugin {
  name = "";  // Set by loader from folder name
  private config!: WeatherConfig;

  async init(config: Record<string, any>): Promise<void> {
    if (!config.api_key || config.api_key.startsWith("${")) {
      throw new Error("WEATHER_API_KEY not configured");
    }
    this.config = config as WeatherConfig;
  }

  async destroy(): Promise<void> {
    // Nothing to clean up
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "current",
        description: "Get current weather for a city. Use when users ask about weather conditions.",
        input_schema: {
          type: "object",
          properties: {
            city: {
              type: "string",
              description: "City name, e.g. 'Beijing' or 'San Francisco'",
            },
          },
          required: ["city"],
        },
      },
      {
        name: "forecast",
        description: "Get weather forecast for a city for the next N days.",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
            days: { type: "number", description: "Number of days (1-7)", default: 3 },
          },
          required: ["city"],
        },
      },
    ];
  }

  async executeTool(name: string, input: Record<string, any>): Promise<string> {
    switch (name) {
      case "current":
        return this.getCurrent(input.city);
      case "forecast":
        return this.getForecast(input.city, input.days ?? 3);
      default:
        return `Unknown tool: ${name}`;
    }
  }

  getCheapTools(): string[] {
    return ["current"];  // Fast API call, doesn't count against expensive limit
  }

  summarizeInput(name: string, input: Record<string, any>): string {
    return `${name}: ${input.city}`;
  }

  getSystemPromptAddendum(): string {
    return "You have access to weather tools. Use weather.current for current conditions and weather.forecast for multi-day forecasts.";
  }

  getSecretPatterns(): RegExp[] {
    return [new RegExp(this.config.api_key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")];
  }

  private async getCurrent(city: string): Promise<string> {
    const url = `${this.config.base_url}/current.json?key=${this.config.api_key}&q=${encodeURIComponent(city)}`;
    const resp = await fetch(url);
    if (!resp.ok) return `Weather API error: ${resp.status} ${resp.statusText}`;
    const data = await resp.json();
    const c = data.current;
    return `${city}: ${c.temp_c}°C, ${c.condition.text}, humidity ${c.humidity}%, wind ${c.wind_kph}km/h`;
  }

  private async getForecast(city: string, days: number): Promise<string> {
    const url = `${this.config.base_url}/forecast.json?key=${this.config.api_key}&q=${encodeURIComponent(city)}&days=${days}`;
    const resp = await fetch(url);
    if (!resp.ok) return `Weather API error: ${resp.status} ${resp.statusText}`;
    const data = await resp.json();
    const lines = data.forecast.forecastday.map((d: any) =>
      `${d.date}: ${d.day.mintemp_c}-${d.day.maxtemp_c}°C, ${d.day.condition.text}`
    );
    return `${city} ${days}-day forecast:\n${lines.join("\n")}`;
  }
}
```

## Writing Good Tool Descriptions

工具描述直接影响 LLM 的调用决策。好的描述应该：

1. **说明用途**：什么时候该用这个工具
2. **说明输入**：每个参数的含义和格式
3. **说明输出**：返回什么内容
4. **区分相似工具**：如果有多个工具，说明各自适用场景

```typescript
// Good
{
  name: "search",
  description: "Search internal documents by keyword. Returns top matching documents with title, snippet, and URL. Use when the user asks about internal processes, policies, or documentation.",
  input_schema: { ... }
}

// Bad
{
  name: "search",
  description: "Search documents.",
  input_schema: { ... }
}
```

## Error Handling

- `executeTool()` 应返回错误字符串（不是 throw），这样不会中断 agent loop
- `init()` 中的异常会被 loader 捕获，插件跳过加载但不影响其他插件
- 网络超时、API 错误等建议返回包含上下文的错误信息

```typescript
async executeTool(name: string, input: Record<string, any>): Promise<string> {
  try {
    // ... business logic
  } catch (err: any) {
    return `Error in ${this.name}.${name}: ${err.message}`;
  }
}
```

## Secret Filtering

插件如果处理 API key 或敏感数据，必须实现 `getSecretPatterns()`：

```typescript
getSecretPatterns(): RegExp[] {
  // Escape special regex chars in the API key
  const escaped = this.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [new RegExp(escaped, "g")];
}
```

这些 pattern 会被合并到全局 secret filter，防止 Agent 回复中泄露敏感信息。

## System Prompt Addendum

`getSystemPromptAddendum()` 返回的文本会追加到 Agent 的 system prompt。用于：
- 告诉 LLM 何时使用你的工具
- 提供特殊指令（如"先调用 A 再调用 B"）
- 限制工具使用范围

```typescript
getSystemPromptAddendum(): string {
  return [
    "## Internal Docs Plugin",
    "Use docs.search to find internal documentation.",
    "Use docs.get to read a specific document by ID.",
    "Always search before answering questions about company policies.",
  ].join("\n");
}
```

## Plugin Commands

插件可以通过 `getCommandHandlers()` 注册用户可见的命令。命令格式为 `/{plugin-name} {subcommand} {args...}`。

```typescript
getCommandHandlers(): PluginCommandHandler {
  return {
    subcommands: {
      list: {
        description: "List all tracked items",
        async handle(args: string[], context: CommandCallContext): Promise<string> {
          // context.userId, context.chatType, context.chatId, context.logId
          return "Item 1\nItem 2\nItem 3";
        },
      },
      status: {
        description: "Show plugin status",
        async handle(args: string[], context: CommandCallContext): Promise<string> {
          return "All systems operational";
        },
      },
    },
  };
}
```

- 命令由 `FeishuAdapter` 通过 `ToolRegistry.handleCommand()` 路由
- `CommandCallContext` 包含调用者信息（userId、chatType、chatId、logId）
- 返回字符串作为回复消息，或 `null`（由 registry 返回）表示未匹配

## Background Services

插件可以通过 `start()` / `stop()` 管理后台服务（如定时轮询、Cron 任务）。

```typescript
async start(context: PluginContext): Promise<void> {
  // PluginContext 提供与核心交互的能力
  // 当前支持: context.sendFeishuMessage(chatId, msgType, content)
  this.timer = setInterval(() => this.poll(context), 60000);
}

async stop(): Promise<void> {
  if (this.timer) clearInterval(this.timer);
}
```

- `start()` 在所有插件加载并注册后调用
- `stop()` 在 `destroy()` 之前调用
- `PluginContext` 提供有限的核心能力（目前仅 `sendFeishuMessage`）

## Cheap vs Expensive Tools

- 默认所有工具视为 expensive，计入 `MAX_TOOL_ITERATIONS` (20) 限制
- 通过 `getCheapTools()` 标记快速/本地工具为 cheap，只计入 `MAX_TOTAL_ITERATIONS` (50)
- 标记为 cheap 的依据：响应快（< 1s）、无外部昂贵 API 调用、幂等

```typescript
getCheapTools(): string[] {
  return ["lookup", "list"];  // Fast local operations
  // Don't include: "analyze", "generate"  ← These are expensive
}
```

## Deployment

### 安装插件

```bash
cd agent/plugins/

# 从 git 克隆
git clone --depth 1 git@github.com:org/zhiliao-plugin-weather.git weather
(cd weather && npm install --production)

# 配置
cp weather/config.example.yaml weather/config.yaml
# 编辑 config.yaml 填入真实凭据
```

### Docker 环境

插件通过 volume mount 单独挂载进容器（插件可以在仓库外部独立管理）：

```yaml
services:
  agent:
    volumes:
      - /path/to/my-plugin:/app/plugins/my-plugin:ro
    environment:
      - MY_PLUGIN_API_KEY=${MY_PLUGIN_API_KEY}  # 插件 config.yaml 中引用的环境变量
```

插件的 `config.yaml` 使用 `${VAR_NAME}` 引用环境变量，需要在 `docker-compose.yml` 的 `environment` 中传入，并在 `.env` 文件中设置实际值。

**注意**: Dockerfile 使用 `--import tsx/esm` 启动 Node.js，因此插件可以直接使用 `.ts` 源码，无需预编译。

**Native modules**: 如果插件依赖原生模块（如 `better-sqlite3`），不要使用 `:ro` 挂载 — 容器启动时 entrypoint 脚本会自动检测并在容器内安装缺失的 `node_modules`。

### 验证

```bash
# 启动后检查日志
docker compose logs agent | grep "Plugin loaded"
# 预期: Plugin loaded: weather (2 tools)
```

## Testing

### 单元测试

插件可以在自己的目录中维护测试：

```typescript
// plugins/weather/tests/weather.test.ts
import WeatherPlugin from "../src/index.js";

describe("WeatherPlugin", () => {
  it("init fails without API key", async () => {
    const plugin = new WeatherPlugin();
    await expect(plugin.init({ api_key: "${WEATHER_API_KEY}" }))
      .rejects.toThrow("not configured");
  });

  it("returns tool definitions", () => {
    const plugin = new WeatherPlugin();
    const defs = plugin.getToolDefinitions();
    expect(defs.length).toBe(2);
    expect(defs.map(d => d.name)).toEqual(["current", "forecast"]);
  });
});
```

### 集成测试

在 `agent/tests/` 中可以编写集成测试，验证插件与 ToolRegistry 的协作：

```typescript
import { ToolRegistry } from "../src/agent/tool-registry.js";

it("plugin tools are namespaced", () => {
  const registry = new ToolRegistry();
  registry.register(mockPlugin);  // plugin.name = "weather"
  const defs = registry.getToolDefinitions();
  expect(defs.some(d => d.name === "weather.current")).toBe(true);
});
```

## Checklist

开发新插件时的检查清单：

- [ ] `config.yaml` 存在且可解析
- [ ] `config.example.yaml` 文档化所有字段
- [ ] `src/index.ts` default export 一个实现 `ToolPlugin` 的 class
- [ ] `init()` 验证必填配置，缺失时 throw 有意义的错误
- [ ] 工具名使用 snake_case，不含命名空间前缀
- [ ] 工具描述清晰，LLM 能理解何时调用
- [ ] `input_schema` 使用标准 JSON Schema，标注 required 字段
- [ ] `executeTool()` 返回字符串，不 throw
- [ ] 如有 API key，实现 `getSecretPatterns()`
- [ ] 如需引导 LLM，实现 `getSystemPromptAddendum()`
- [ ] 如有快速操作，实现 `getCheapTools()`
- [ ] 如需清理资源，实现 `destroy()`
- [ ] 如有后台服务，实现 `start()` / `stop()`
- [ ] 如需用户命令，实现 `getCommandHandlers()`
- [ ] 单元测试覆盖 init 失败、工具执行、错误处理
