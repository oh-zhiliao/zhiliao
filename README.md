# 知了 (Zhiliao) — 多通道智能问答助手

多通道智能问答助手，支持飞书和浏览器 WebChat，通过插件机制接入 Git 仓库、CLS 日志查询、MySQL 数据库查询等数据源，问答知识持久化。

> "知了"既是蝉的别名，也是"知道了"的缩写 —— 你问，它都知道。

[English](README.en.md)

## 特性

- **多通道接入**：飞书（WebSocket 私聊/群聊/话题线程）+ 浏览器 WebChat（JWT 认证、WebSocket 流式响应、多会话）
- **Agent 问答**：LLM 驱动的 Agentic Loop，支持 Anthropic Claude 和 OpenAI 兼容 API（Doubao/GLM/DeepSeek）
- **全插件架构**：核心不含任何工具实现，所有能力由插件提供，自动发现、命名空间隔离、独立配置
- **知识持久化**：自动索引 Git commit，LLM 生成摘要 + 向量 embedding，BM25 + 向量混合检索（RRF 融合）
- **变更通知**：定时轮询 Git 仓库，新 commit 自动推送飞书群
- **知识衰减**：每日全量扫描，标记过时知识，自动归档和清理

## 架构

```
 ┌─────────────┐   WebSocket    ┌───────────────┐
 │  Feishu SDK  │◄─────────────►│ FeishuAdapter │──┐
 └─────────────┘                └───────────────┘  │
                                                   │
 ┌─────────────┐  HTTP + WS     ┌──────────────┐   │
 │   Browser   │◄──────────────►│  WebChat     │──┤
 └─────────────┘                └──────────────┘   │
                                                    ▼
                        ┌───────────────────────────────────┐
                        │          Agent Invoker            │
                        │   (Session / Tool Loop / LLM)     │
                        └───────────────┬───────────────────┘
                                        │
           ┌────────────┬───────────────┼───────────────┬────────────┐
           ▼            ▼               ▼               ▼            ▼
     ┌──────────┐ ┌──────────┐  ┌──────────────┐ ┌──────────┐ ┌──────────┐
     │ git-repos│ │cls-query │  │ mysql-query  │ │memo-tools│ │   ...    │
     │ 7 tools  │ │ 2 tools  │  │   2 tools    │ │ (内置)   │ │  更多插件 │
     └────┬─────┘ └──────────┘  └──────────────┘ └────┬─────┘ └──────────┘
          │                                           │
          ▼                                           ▼
    Git Repos (local)                          Memo Service (Python/FastAPI)
                                               - 索引 + 混合检索 + 知识衰减
                                                     │
                                                     ▼
                                              knowledge.db (SQLite + FTS5)
```

核心是薄壳：通道层 + Agent 循环 + 会话管理 + 插件加载。详见 [架构文档](docs/architecture.md)。

## 快速开始

### 1. 克隆与初始化

```bash
git clone https://github.com/oh-zhiliao/zhiliao.git
cd zhiliao
bash setup.sh
```

### 2. 配置

```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml，填入飞书凭据和 LLM API Key（密钥直接写入，文件已 gitignore）
```

### 3. 生成 SSH Deploy Key

```bash
mkdir -p data
ssh-keygen -t ed25519 -f data/deploy_key -N "" -C "zhiliao-deploy"
# 将 data/deploy_key.pub 添加为 Git 仓库的只读 Deploy Key
```

### 4. 启动

**本地部署**（推荐，需 Node.js 22 和 Python 3.12+）：

```bash
bash deploy-local.sh setup    # 安装依赖
bash deploy-local.sh start    # 启动 memo + agent
bash deploy-local.sh status   # 查看状态
```

**Docker 部署**：

```bash
docker compose build && docker compose up -d
```

### 5. 配置仓库

编辑 `plugins/git-repos/config.yaml` 添加仓库，或私聊机器人使用 `/git-repos list` 和 `/git-repos status`。

完整部署指南参见 [部署手册](docs/deployment.md)。

## 配置

YAML 配置文件（gitignored），支持环境变量替换 `${VAR_NAME}`。关键字段：

```yaml
project:
  name: "my-project"
feishu:
  app_id: "cli_xxx"
  app_secret: "your-secret"
llm:
  agent:
    provider: "anthropic"         # 或 openai_compatible
    model: "claude-sonnet-4-20250514"
    api_key: "sk-ant-xxx"
  memo:
    provider: "openai_compatible"
    base_url: "https://api.deepseek.com/v1"
    model: "deepseek-chat"
    api_key: "sk-xxx"
  embedding:
    provider: "openai_compatible"
    base_url: "http://127.0.0.1:11434/v1"
    model: "qwen3-embedding:0.6b"
webchat:                          # 可选
  enabled: true
  port: 8080
  password: "your-password"
```

详见 [配置文档](docs/module-config-db.md) 和 [部署手册](docs/deployment.md)。

## 插件生态

| 插件 | 仓库 | 工具数 | 说明 |
|------|------|--------|------|
| **git-repos** | [oh-zhiliao/git-repos](https://github.com/oh-zhiliao/git-repos) | 7 | Git 工具、变更追踪、扫描、通知 |
| **cls-query** | [oh-zhiliao/cls-query](https://github.com/oh-zhiliao/cls-query) | 2 | 腾讯云 CLS 日志查询 |
| **mysql-query** | [oh-zhiliao/mysql-query](https://github.com/oh-zhiliao/mysql-query) | 2 | MySQL 数据库查询 |
| **memo-tools** | 随核心发布 | 2 | 知识库搜索（内置） |

插件开发指南：[docs/plugin-development.md](docs/plugin-development.md)

## 使用方式

### 飞书

| 场景 | 用法 |
|------|------|
| 群聊提问 | `@知了 认证中间件怎么实现的？` |
| 话题群跟进 | 同一话题内直接提问，无需 @ |
| 私聊 | 直接发消息，无需前缀 |
| 仓库管理 | `/git-repos list`、`/git-repos status` |
| 重置会话 | `/new`、`/context`、`/help` |

### WebChat

启用 `webchat` 配置后，访问 `http://localhost:8080`，输入密码登录即可使用。支持多会话管理、实时工具调用可视化、流式响应。

## 开发

```bash
# 安装依赖
cd agent && npm install

# 运行测试
npm test

# 开发模式启动
npx tsx src/index.ts ../config.yaml
```

测试框架：Vitest（TypeScript）+ pytest（Python）。详见 [测试文档](docs/testing.md)。

## 技术栈

- **TypeScript 5+ / Node.js 22 (LTS)** — 主框架
- **Python 3.12+ / FastAPI** — Memo 知识服务
- **SQLite** (better-sqlite3 + WAL) — 会话持久化
- **SQLite + FTS5** — 知识存储 + 全文检索
- **Docker Compose** — 部署编排（host network mode）
- **LLM**: Anthropic Claude 或 OpenAI 兼容 (Doubao/GLM/DeepSeek)
- **Embedding**: qwen3-embedding:0.6b (本地 Ollama)

## 文档

- [架构总览](docs/architecture.md)
- [部署手册](docs/deployment.md)
- [配置与数据库](docs/module-config-db.md)
- [飞书通道](docs/module-feishu.md)
- [通道抽象层](docs/module-channels.md)
- [Agent 模块](docs/module-agent.md)
- [Memo 知识服务](docs/module-memo.md)
- [插件开发指南](docs/plugin-development.md)
- [测试](docs/testing.md)

## License

MIT
