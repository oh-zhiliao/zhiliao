# 测试

## 框架

- **TypeScript**: Vitest + `vi.fn()` / `vi.mock()` mock
- **Python**: pytest (memo)

## 运行

```bash
# TypeScript 全量 (from agent/)
cd agent && npm test

# TypeScript 单文件
cd agent && npm test -- tests/agent/invoker.test.ts

# Python
cd memo && .venv/bin/python -m pytest tests/ -v
```

## 测试结构

```
agent/tests/
  config.test.ts              # 配置加载
  db.test.ts                  # 数据库 CRUD
  git/
    repo-manager.test.ts      # Git 操作（真实 git repo）
    tracker.test.ts           # 轮询逻辑（mock deps）
    scanner.test.ts           # 扫描逻辑（mock deps）
  channels/feishu/
    adapter.test.ts           # 消息路由（mock client/agent）
    client.test.ts            # Feishu API（mock SDK）
    thread-mapper.test.ts     # Session key 生成
    message-builder.test.ts   # 消息格式化
  agent/
    invoker.test.ts           # Agent loop + 迭代限制
    plugin-integration.test.ts # 插件集成测试
    session-compressor.test.ts # 会话压缩
    tool-loader.test.ts       # 插件加载
    tool-registry.test.ts     # 工具注册 + 命令路由
  commands/
    router.test.ts            # 命令解析
  notifier/
    change-notifier.test.ts   # 通知格式
  memo/
    client.test.ts            # Memo HTTP 客户端（mock fetch）
  e2e/
    api-flow.test.ts          # API 端到端测试
```

**插件测试**: 插件（git-repos, memo-tools）在各自的仓库中维护独立的测试。

## 测试策略

- **单元测试为主**: 通过依赖注入 mock 外部依赖
- **真实 Git 测试**: repo-manager 使用临时 git 仓库
- **不 mock SQLite**: db.test.ts 使用内存数据库
- **API mock**: Feishu SDK、Anthropic SDK、fetch 均通过 `vi.mock()` 替换
- **插件隔离**: 核心测试不依赖具体插件实现，使用 mock plugin 验证注册/路由逻辑
