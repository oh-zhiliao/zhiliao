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
# 以下已迁移到插件 config.yaml，核心配置中可选保留
git:                                   # optional, used by git-repos plugin
  poll_interval_minutes: 5
  deep_scan_cron: "0 2 * * *"
  ssh_key_path: "./data/deploy_key"
admins:                                # optional, used by git-repos plugin
  - "ou_xxxxxxx"
```

**验证**: 必填字段 (`project.name`, `feishu.app_id`, `feishu.app_secret`, `llm.agent.model`) 缺失时 fail-fast 抛异常。`git`、`knowledge`、`admins` 为可选（已迁移到插件配置）。

## db.ts

SQLite 数据层。核心应用使用 DB 进行 session 持久化。

**类**: `ZhiliaoDB`

**注意**: `repos`、`repo_admins`、`repo_notify_targets` 表的 schema 仍在 db.ts 中定义（CREATE IF NOT EXISTS），但这些表现在由 **git-repos** 插件管理。核心应用不再直接读写这些表。

**特性**:
- WAL 模式，支持并发读
- Upsert 语义，幂等操作

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
