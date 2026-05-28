# 配置与数据库模块

## config.ts

YAML 配置加载，支持可选的环境变量替换 (`${VAR_NAME}`)。密钥可直接写入 config.yaml（已 gitignore）。

**函数**: `loadConfig(path: string): ZhiliaoConfig`

**配置结构**:
```yaml
project:
  name: "my-project"
  timezone: "Asia/Shanghai"          # optional, IANA timezone for agent responses
feishu:
  app_id: "cli_xxx"
  app_secret: "your-secret-here"  # 直接写入或用 ${FEISHU_APP_SECRET}
  event_mode: "websocket"
llm:
  agent:
    provider: "anthropic"          # "anthropic" 或 "openai_compatible"
    base_url: "https://api.anthropic.com"  # openai_compatible 时必填
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
  auth_token: "replace-with-random-token"
# 以下已迁移到插件 config.yaml，核心配置中可选保留
git:                                   # optional, used by git-repos plugin
  poll_interval_minutes: 5
  deep_scan_cron: "0 2 * * *"
  ssh_key_path: "./data/deploy_key"
admins:                                # optional, Feishu admin open_id allowlist
  - "ou_xxxxxxx"
```

`admins` 为可选字段，表示飞书管理员的 `open_id` 白名单，用于 `/role` 管理命令权限校验。例如：

```yaml
admins:
  - "ou_e821f98839568fee66f98eed73c1770f"
```

**验证**: 必填字段 (`project.name`, `feishu.app_id`, `feishu.app_secret`, `llm.agent.model`) 缺失时 fail-fast 抛异常。启用 WebChat 时必须显式配置非默认 `webchat.password`。`git` 和 `admins` 为可选。

## db.ts

SQLite 数据层。核心应用使用 DB 进行 session 持久化。

**类**: `ZhiliaoDB`

**注意**: `repos`、`repo_admins`、`repo_notify_targets` 表的 schema 仍在 db.ts 中定义（CREATE IF NOT EXISTS），但这些表现在由 **git-repos** 插件管理。核心应用不再直接读写这些表。

**特性**:
- WAL 模式，支持并发读
- Upsert 语义，幂等操作

### 角色权限相关表

飞书 role-based permission 使用以下两张表：

#### `role_bindings`

按 `chat_id` 绑定显式角色。

| 列 | 说明 |
|---|---|
| `subject_type` | 当前固定为 `chat` |
| `subject_id` | 飞书 `chat_id` |
| `role` | 绑定的角色名 |
| `created_at` / `updated_at` | 毫秒时间戳 |
| `created_by` / `updated_by` | 操作人的飞书 `open_id` |

主键为 `(subject_type, subject_id)`。

#### `role_defaults`

按 `chat_type` 设置默认角色。

| 列 | 说明 |
|---|---|
| `chat_type` | `group` 或 `p2p` |
| `role` | 默认角色名 |
| `updated_at` | 毫秒时间戳 |
| `updated_by` | 操作人的飞书 `open_id` |

### 运行时解析顺序

每次收到飞书消息时，系统都会实时读表解析最新 role：

1. `role_bindings(chat_id)`
2. `role_defaults(chat_type)`
3. 仍未命中则拒绝请求

不会把 role 常驻缓存到内存，因此管理员执行 `/role assign` / `/role default` 后，后续消息会立即生效。

### 角色值约束

`role` 只允许字母、数字、下划线和短横线，即正则：

```text
^[A-Za-z0-9_-]+$
```

## index.ts — 入口

应用启动流程:
1. 加载 config.yaml + 环境变量替换
2. 创建数据目录 (repos, memo, memo/memory, memo/dialog)
3. 初始化 DB
4. 加载 SOUL.md 人格配置（不存在则用内置默认）+ CLAUDE.md 系统 prompt，组装为完整 system prompt
5. 设置 Agent（Anthropic 或 OpenAI-compatible）
6. 加载所有插件 (`loadPlugins`) 并注册到 `ToolRegistry`
7. 初始化飞书 WebSocket
8. 启动插件后台服务 (`toolRegistry.startAll(context)`)
9. 注册 SIGINT/SIGTERM 优雅退出（`toolRegistry.stopAll()` → `toolRegistry.destroyAll()`）
