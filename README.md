# 知了 (Zhiliao)

飞书智能问答 Bot -- 支持私聊和群聊，通过插件机制接入 Git 仓库、CLS 日志查询、MySQL 数据库查询等数据源，问答知识持久化。

> "知了"既是蝉的别名，也是"知道了"的缩写 —— 你问，它都知道。

[English](README.en.md)

## 功能

- **飞书集成**: 通过 WebSocket 接入飞书，支持群聊 @提问、话题群上下文跟踪、私聊直接对话
- **Agent 问答**: 基于 LLM 的 Agent 循环，支持 Anthropic (Claude) 和 OpenAI 兼容 (Doubao/GLM/DeepSeek) 双 provider
- **插件系统**: 零修改核心代码扩展能力，插件自动发现、命名空间隔离、独立配置
- **知识持久化**: 自动索引 Git commit，LLM 生成摘要 + 向量 embedding，支持 BM25 + 向量混合检索
- **变更通知**: 定时轮询 Git 仓库，新 commit 自动推送到飞书群
- **知识衰减**: 每日全量扫描，标记过时知识，自动归档和清理

## 插件

知了通过插件连接外部数据源。核心应用内置知识库搜索（memo-tools），其他能力由插件提供：

| 插件 | 功能 | 仓库 |
|------|------|------|
| **git-repos** | Git 工具、仓库跟踪、变更通知、代码搜索 | [oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos) |
| **cls-query** | 腾讯云 CLS 日志查询 | [oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query) |
| **mysql-query** | MySQL 数据库查询 | [oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query) |
| **memo-tools** | 知识库搜索（内置） | 随核心发布 |

## 架构

```
Feishu WebSocket --> FeishuAdapter --> Agent Invoker --> LLM (Claude/GLM/DeepSeek)
                                            |
                     +----------------------+------------------+----------------------+
                     |                      |                  |                      |
                     v                      v                  v                      v
               git-repos plugin      cls-query plugin   mysql-query plugin    memo-tools (builtin)
               - 代码搜索/阅读        - 日志查询          - 数据库查询           - 知识库搜索
               - Tracker/Scanner                                                |
               - 变更通知                                                          v
                     |                                                      Memo Service
                     v                                                     (Python/FastAPI)
               Git Repos (local)                                          - 索引 + 混合检索
                                                                          - 知识衰减
                                                                              |
                                                                              v
                                                                       knowledge.db
                                                                       (SQLite + FTS5)
```

两个服务：
- **agent** (TypeScript/Node.js) -- 飞书接入、Agent 问答、插件管理
- **memo** (Python/FastAPI) -- 知识索引、混合检索、知识衰减

## 快速开始

### 1. 克隆项目

```bash
git clone git@github.com:oh-zhiliao/zhiliao.git
cd zhiliao
```

### 2. 安装插件

```bash
# 在项目同级目录克隆插件
cd ..
git clone git@github.com:oh-zhiliao/git-repos.git
git clone git@github.com:oh-zhiliao/cls-query.git     # 可选
git clone git@github.com:oh-zhiliao/mysql-query.git   # 可选
cd zhiliao
```

### 3. 配置

```bash
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，填入以下配置（密钥可直接写入，文件已 gitignore）：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `feishu.app_id` | 飞书应用 ID | `cli_xxx` |
| `feishu.app_secret` | 飞书应用 Secret | 从飞书开放平台获取 |
| `llm.agent.api_key` | Agent LLM API Key | Anthropic / 智谱 / 豆包 API Key |
| `llm.memo.api_key` | Memo LLM API Key | DeepSeek / 智谱 API Key |
| `admins` | 管理员飞书 open_id 列表 | `["ou_xxx"]` |

可选创建 `.env`（仅需构建加速时）：

```bash
USE_CN_MIRROR=true   # 使用国内镜像加速 Docker 构建
```

### 4. SSH Deploy Key

```bash
mkdir -p data
ssh-keygen -t ed25519 -f data/deploy_key -N "" -C "zhiliao-deploy"
# 将 data/deploy_key.pub 添加为 Git 仓库的只读 Deploy Key
```

### 5. 部署

```bash
docker compose build
docker compose up -d
```

### 6. 配置仓库

编辑 `git-repos` 插件配置，或私聊飞书机器人：

```
/git-repos list
/git-repos status
```

## 使用 AI Agent 部署

知了支持通过 AI Agent（Claude Code、Cursor 等）交互式完成部署配置。

### 前提条件

- 目标机器已安装 Docker 和 Docker Compose
- 目标机器已安装 Ollama 并拉取 embedding 模型（`ollama pull qwen3-embedding:0.6b`）
- 已创建飞书机器人应用（[飞书开放平台](https://open.feishu.cn)），开启 WebSocket 事件订阅
- 已准备 LLM API Key（Anthropic / 智谱 / DeepSeek 等）

### 部署步骤

将以下 prompt 发送给你的 AI Agent：

```
请帮我部署知了到 <目标机器>。

仓库地址: git@github.com:oh-zhiliao/zhiliao.git

请按以下步骤执行，每一步需要我提供信息时请暂停询问：

1. 克隆仓库
2. 向我询问以下配置信息，逐项确认：
   - 飞书 App ID 和 App Secret
   - Agent LLM 配置（provider、base_url、model、api_key）
   - Memo LLM 配置（provider、base_url、model、api_key）
   - Embedding 配置（默认使用本地 Ollama qwen3-embedding:0.6b）
   - 管理员飞书 open_id
3. 根据我的回答生成 config.yaml
4. 生成 SSH deploy key，输出公钥让我添加到 Git 仓库
5. 如果目标机器在中国，创建 .env 启用 USE_CN_MIRROR=true
6. 执行 docker compose build && docker compose up -d
7. 检查日志确认服务启动成功（应看到 "Zhiliao is running" 和 "ws client ready"）
```

Agent 会交互式向你收集配置，生成配置文件并完成部署。

### 配置参考

config.yaml 完整结构：

```yaml
project:
  name: "my-project"            # 项目显示名

feishu:
  app_id: "cli_xxx"             # 飞书应用 ID
  app_secret: "your-secret"     # 飞书应用 Secret
  event_mode: "websocket"       # 固定值

llm:
  agent:                        # Agent 问答用的 LLM（支持 tool-use 的模型）
    provider: "anthropic"       # anthropic / openai_compatible
    base_url: "https://api.anthropic.com"  # openai_compatible 时填对应 base_url
    model: "claude-sonnet-4-20250514"      # 或 doubao-seed-2-0-pro-260215 等
    api_key: "sk-ant-xxx"
  memo:                         # Memo 摘要/索引用的 LLM
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
    api_key: "sk-xxx"
  embedding:                    # 向量 Embedding
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"  # 本地 Ollama
    model: "qwen3-embedding:0.6b"

# 知识库工具（内置，设 enabled: false 可禁用）
memo:
  enabled: true
  url: "http://127.0.0.1:8090"

admins:
  - "ou_xxxxxxx"                # 管理员飞书 open_id
```

## 使用方式

| 场景 | 用法 |
|------|------|
| 群聊提问 | `@知了 认证中间件怎么实现的？` |
| 话题群跟进 | 同一话题内直接提问，无需 @ |
| 私聊 | 直接发消息，无需前缀 |
| 仓库管理 | `/git-repos list`、`/git-repos status` |

## 项目结构

```
zhiliao/
  docker-compose.yml          # 部署编排
  config.yaml                 # 配置文件（gitignored）
  config.example.yaml         # 配置模板
  SOUL.example.md             # Bot 人格配置模板
  agent/                      # TypeScript/Node.js 服务
    Dockerfile
    src/
      builtin/memo-tools.ts   # 内置知识库工具
      agent/                  # Agent 核心、插件系统
      channels/feishu/        # 飞书通道
    tests/                    # 测试
    prompt/CLAUDE.md          # Bot 系统提示词
    plugins/                  # 第三方插件目录（gitignored）
  memo/                       # Python/FastAPI 知识服务
    Dockerfile
    server.py, config.py ...
  nanoclaw/                   # 飞书 SDK submodule
  docs/                       # 项目文档
  data/                       # 运行时数据（gitignored）
```

## 技术栈

- TypeScript 5+ / Node.js 20+
- Python 3.12+ / FastAPI
- SQLite (better-sqlite3 + WAL / FTS5)
- Docker Compose (host network mode)
- LLM: Claude / Doubao / GLM / DeepSeek (Anthropic + OpenAI-compatible 双 provider)
- Embedding: qwen3-embedding:0.6b (Ollama)

## 文档

- [架构总览](docs/architecture.md)
- [部署手册](docs/deployment.md)
- [配置与数据库](docs/module-config-db.md)
- [飞书通道](docs/module-feishu.md)
- [Agent 模块](docs/module-agent.md)
- [Memo 知识服务](docs/module-memo.md)
- [Git 模块](docs/module-git.md)
- [命令与权限](docs/module-commands.md)
- [通知模块](docs/module-notifier.md)
- [插件开发指南](docs/plugin-development.md)
- [测试](docs/testing.md)

## License

MIT
