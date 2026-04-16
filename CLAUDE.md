# 知了 (Zhiliao) — 项目宪法

多通道智能问答助手 — 支持飞书（私聊/群聊）和 WebChat（浏览器 UI），通过插件机制接入 Git 仓库、CLS 日志查询、MySQL 数据库查询等数据源，问答知识持久化。通道层可扩展（`Channel` 接口 + `ChannelRouter`）。

## AI Agent 开发流程

### 1. 需求理清

开始编码前，必须先理解和确认需求：

- **简单需求**（单文件改动、bug fix、配置调整）：使用 superprompt，直接描述清楚即可
- **复杂需求**（跨模块、新功能、架构变更）：使用 superpowers skill 生成 spec + plan，写入 `docs/superpowers/`

### 2. 验证方案先行

编码前必须回答：**怎么知道做对了？**

制定验证清单：
- **自动化验证**（绝大部分需求都应该做到）：
  - 单元测试：`npm test` / `pytest`
  - 集成测试：真实 git repo 操作、HTTP endpoint 调用
  - E2E 测试：playwright 或类似工具模拟用户交互
  - 如果想不到如何自动化验证，使用 pua skill 深度思考
- **人工验证**（仅当自动化确实不可行时）：
  - 飞书消息格式/样式
  - 部署后的实际行为
  - 列出具体检查步骤

验证清单确认后才进入编码。

### 3. 任务拆分与 Subagent 开发

- 将需求拆分为独立的子任务，每个子任务 context 足够小
- 使用 subagent 并行开发，每个 subagent 只处理一个明确的子任务
- **目标：避免 compact**。单个 agent 的 context 膨胀是质量下降的首要原因
- 每完成一个子任务，运行验证，确认通过后再继续

### 4. 代码审查

- 重大变更完成后使用 code-reviewer agent 审查，对照 plan 和本文档规范。
- 不允许将隐私信息（用户名、密码、环境IP等）提交到代码库。

### 5. 避免重复犯错

**每次开发前必读 @docs/mistakes.md**。

- 发现错误（人类反馈或自己发现的）时，分析根因，抽象为模式，追加到 mistakes.md
- 不是记录"某个 bug"，而是提炼"哪类错误、为什么会犯、怎么避免"
- 定期合并相似条目，保持精简

## Rules

- Never touch `.worktrees/` directories created by other sessions. Only remove worktrees you created in the current session.
- 不要重复造轮子：修改前先读懂现有代码
- 不要过度设计：只实现需求要求的，不加额外功能
- 安全第一：路径穿越防护、secret 过滤、输入校验
- 错误信息要可追踪：包含 logId、error code、上下文

## Commands

```bash
# TypeScript tests (from agent/)
cd agent && npm test

# Python tests
cd memo && .venv/bin/python -m pytest tests/ -v

# Dev run (from agent/)
cd agent && npx tsx src/index.ts ../config.yaml

# Docker
docker compose build
docker compose up -d
```

## Architecture Note

Core app is a thin shell (Channel layer + Agent loop + Session + Plugin loading). Channels (Feishu, WebChat) route messages through ChannelRouter to the Agent; builtin tools handle knowledge base; everything else comes from plugins:
- **memo-tools** (builtin): memory_search, get_memory — knowledge base search
- **git-repos** plugin: git tools, tracker, scanner, notifier, `/git-repos` commands — [oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos)
- **cls-query** plugin: Tencent CLS log query — [oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query)
- **mysql-query** plugin: MySQL database query — [oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query)

Plugin commands: `/{plugin-name} {subcommand}` (e.g. `/git-repos list`, `/git-repos status`)
Session commands: `/new`, `/context`, `/help` (builtin)

## 文档规范

文档存放在 `docs/` 下，按模块或功能拆分，避免单个文件过大污染 context。

### 项目文档

- @docs/architecture.md — 架构总览、技术栈、数据流、全插件架构
- @docs/module-config-db.md — 配置加载、数据库、入口启动流程
- @docs/module-git.md — Git 操作（共享基础，被 git-repos 插件使用）
- @docs/module-feishu.md — 飞书通道：client、adapter、路由、消息格式、secret 过滤
- @docs/module-channels.md — 通道抽象层：Channel 接口、ChannelRouter、WebChat、新通道开发指南
- @docs/module-agent.md — Agent invoker、agentic loop、插件系统
- @docs/module-memo.md — Memo 知识服务：索引、搜索、衰减、embedding 模型
- @docs/module-commands.md — 命令路由、会话命令、插件命令
- @docs/module-notifier.md — 飞书变更通知推送（已迁移到 git-repos 插件）
- @docs/plugin-development.md — 插件开发指南：接口、命令、后台服务、生命周期、完整示例
- @docs/testing.md — 测试框架、测试结构、运行方式
- @docs/testing-framework.md — 分层测试金字塔 (L1-L4) 与 deploy preflight 门禁
- @docs/deployment.md — 部署手册
- @docs/mistakes.md — 常见错误模式（**每次开发前必读**）

## Implementation Status

All phases complete. Historical design docs in `docs/superpowers/` for reference.

# 部署

- @deployment.md 具体的部署信息（通过 .gitignore 排除，不会提交到 repo）
