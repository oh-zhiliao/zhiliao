# 分层测试框架 (Zhiliao Layered Testing)

> 参考: [felix021 gist — 分层测试框架实践](https://gist.github.com/felix021/33f733c6502961577db992947969b5f9)
> 基于 Rust 金字塔移植到 zhiliao (TypeScript + Python) 的实践。

## 架构

```
┌──────────────────────────────────────────────────┐
│  L4: E2E 测试                                      │
│  Playwright + ws + jsdom → 浏览器 → 全链路        │
├──────────────────────────────────────────────────┤
│  L3: Lint + Typecheck                             │
│  eslint + tsc --noEmit + ruff                     │
├──────────────────────────────────────────────────┤
│  L2: 前端 JS 单元测试                              │
│  vitest + jsdom → agent/web/js/                   │
├──────────────────────────────────────────────────┤
│  L1: 后端单元 + 集成测试                           │
│  vitest (agent) + pytest (memo)                   │
└──────────────────────────────────────────────────┘
```

## 执行矩阵

| 层级 | 命令 (在 `agent/` 下) | 何时执行 | 当前耗时 |
|------|----------------------|---------|---------|
| L1-ts | `npm run test` | 每次提交前 | ~5s |
| L1-py | `cd ../memo && .venv/bin/pytest -q` | 每次提交前 | ~3s |
| L2 | `npm run test:web` | 每次提交前 | ~1s |
| L3-lint | `npm run lint` | 每次提交前 | ~3s |
| L3-type | `npm run typecheck` | 每次提交前 | ~3s |
| L3-ruff | `cd ../memo && .venv/bin/ruff check` | 每次提交前 | <1s |
| L4 | `npm run test:e2e` | deploy 前 | ~30s |

**铁律**：L1–L3 全部通过才能 `deploy-local.sh start` / `docker compose build`。
`deploy-local.sh preflight` 聚合以上全部，失败即 exit 1，绝不带病上线。

一键跑 L1-L3：`npm run test:all`（在 `agent/` 下执行，会触发 memo 的 pytest + ruff）。

## 目录结构

```
agent/
  eslint.config.js          # L3 lint config (flat)
  vitest.config.ts          # L1 (node) 配置
  vitest.web.config.ts      # L2 (jsdom) 配置
  playwright.config.ts      # L4 配置
  tests/
    *.test.ts               # L1 后端 (196 tests)
    web/                    # L2 前端 (jsdom)
      *.test.ts
    e2e-web/                # L4 浏览器 E2E (playwright)
      fixture-server.ts     # 启动 webchat 服务（in-process，fake agent）
      cdp-helpers.ts        # __zhiliao_cdp + test-token helper
      failure-log.ts        # JSONL 失败日志 writer
      *.spec.ts             # 5 个 smoke 场景
      failures.jsonl        # 失败日志（gitignored）
    e2e/                    # 旧 API 集成测试（vitest）
  web/
    js/
      app.js etc.           # IIFE 模块，L2 通过 jsdom 加载
      cdp-debug.js          # Debug API 注入点（Pattern 2）
memo/
  pyproject.toml            # ruff 配置
  tests/*.py                # L1 (pytest)
```

## 各层实现要点

### L1 — 后端单元 + 集成

**TypeScript (vitest)**：
- `vi.mock()` mock 外部 SDK（Anthropic、Feishu、fetch）
- 不 mock SQLite，用 `:memory:` 真实数据库
- 长运行测试放 `tests/e2e/` 走 `test:e2e` 脚本

**Python (pytest)**：
- `tmp_path` fixture 隔离 SQLite
- HTTP mock 用 `httpx` 拦截

### L2 — 前端 JS 单元

zhiliao 的 `agent/web/js/` 是 IIFE 风格（`var Markdown = (function(){...})()`），
不是 ES modules。测试策略：
- `vitest` + `environment: "jsdom"`
- 在测试里 `readFileSync(...).then(eval)` 加载 IIFE，访问其导出的全局
- 纯函数部分（markdown 渲染、i18n、消息解析）直接单元测
- DOM 交互部分（sidebar、chat）用 jsdom 断言 `document.querySelector(...)`

### L3 — Lint + Typecheck

**ESLint**（flat config）：
- `eslint:recommended` + `typescript-eslint` 推荐
- 关键规则：`no-unused-vars`、`no-explicit-any`（warn）、`prefer-const`
- `--max-warnings=0` 强制 warnings 清零

**tsc --noEmit**：
- 作为独立步骤，比 build 快（不输出文件）

**ruff**（Python memo）：
- `pyproject.toml` 配置 E, F, W, I, B
- `ruff check` 用于 CI，`ruff format` 本地用

### L4 — E2E WebChat

参考 gist 的 Pattern 2/3/8。完整链路：

**Pattern 3 — 启动参数隔离**：
WebChat 支持 `--test-token <token>` 启动参数（见 `webchat.test_token` 配置），
测试模式下前端带 `?test_token=xxx` 访问即可拿到 JWT，跳过密码/OAuth。
生产环境 `test_token` 为空 → 前端无此旁路。

**Pattern 2 — Debug API**：
`agent/web/cdp-debug.js` 在 URL 带 `?debug=1` 或 `test_token=*` 时注入：

```js
window.__zhiliao_cdp = {
  state() { return { loggedIn, currentSessionId, streaming } },
  events: [],                    // 时序事件日志
  waitForEvent(name, timeout) {  // 等待特定事件
    // e.g. "ws-connected", "message-complete"
  },
}
```

**Pattern 8 — 失败日志回归**：
`tests/e2e/utils/failure-log.ts` 导出 `logFailure()`，E2E afterEach 钩子
写入 `tests/e2e/failures.jsonl`，追踪历史失败模式。

**当前 E2E 覆盖**（`tests/e2e-web/smoke.spec.ts`，5 passed）：
1. `/api/health` 返回 ok
2. test-token 旁路拒绝错误 token（401）
3. test-token 旁路签发合法 JWT（三段式）
4. 登录 → 发 `/help` → WS 收到 `message_complete`（含"命令列表"）
5. 登录 → 发 echo 问题 → 收到 `text_delta` + `message_complete`

## 8 个 Pattern 在 zhiliao 的状态

| Pattern | zhiliao 采纳状态 | 实现位置 |
|---------|-----------------|---------|
| 1. 可编程模态框 | 不适用（WebChat 无 confirm/prompt） | — |
| 2. Debug API | ✅ L4 | `agent/web/js/cdp-debug.js` |
| 3. 启动参数隔离 | ✅ L4 | `webchat.test_token` config |
| 4. 进程守护 | 已有（`deploy-local.sh`） | — |
| 5. 验证构建产物 | ✅ 集成到 preflight | `deploy-local.sh preflight` |
| 6. 自愈选择器 | 延后（UI 规模小） | — |
| 7. CDP 原生截图 | Playwright 自带 `page.screenshot()` | — |
| 8. 失败日志回归 | ✅ L4 | `tests/e2e-web/failures.jsonl` |

## 插件仓库的 preflight 约定

核心的 L1-L4 铁律同样适用于 3 个独立插件仓库（`git-repos` / `cls-query` / `mysql-query`）。
由于插件没有前端 JS 和浏览器 UI，只落地 **L1 + L3**（L2/L4 不适用）。

每个插件都必须具备：

| 文件 | 作用 |
|------|------|
| `eslint.config.js` | flat config，与核心同构（`recommended` + `typescript-eslint` + `--max-warnings 0`） |
| `tsconfig.test.json` | `extends ./tsconfig.json`，`rootDir: "."` + `noEmit: true` + `"types": ["node"]`，`include` 覆盖 `src/` `tests/` `types/` |
| `types/plugin-core.d.ts` | **通配符 ambient module**：`declare module "*/tool-plugin.js" { ... }`，让插件脱离核心源码也能独立 typecheck。与 `zhiliao/agent/src/agent/tool-plugin.ts` 保持同步 |
| `tests/` | vitest L1 单测，覆盖 `init` 校验、`getToolDefinitions`、`getSecretPatterns`、`summarizeInput`、`executeTool` 错误路径等纯函数面 |

统一脚本（每个插件 `package.json`）：

```json
{
  "scripts": {
    "lint": "eslint src/ tests/ --max-warnings 0",
    "typecheck": "tsc --noEmit -p tsconfig.test.json",
    "test": "vitest run",
    "test:all": "npm run lint && npm run typecheck && npm run test",
    "preflight": "npm run test:all"
  }
}
```

**铁律**：插件改动 → 在插件目录执行 `npm run preflight` → 绿了才能合并/部署。

### 为什么用通配符 ambient module

插件在部署布局中通过 `../../agent/src/agent/tool-plugin.js` 相对路径 import 核心接口，
但在插件仓库独立 clone 时这个相对路径不存在，`tsc --noEmit` 会失败。

TypeScript 禁止 ambient 声明使用相对路径（TS2436），所以用通配符：
`declare module "*/tool-plugin.js"` 匹配 **任何**以 `/tool-plugin.js` 结尾的 import
specifier，让标准 typecheck 通过。运行时仍走真实路径解析，不受影响。

> 注意：`.d.ts` 注释里严禁出现 `*/` 字面量（会被解析器当成注释结束符）。

## 给 AI Agent 的协作规则

1. **改代码 → 跑 preflight → 贴输出**。无输出证据 = 未完成。
2. 每次修一个问题，独立验证。堆叠部署等于赌运气。
3. "接口通" ≠ "功能通"。health 200 不代表 WS 中继在工作。
4. 单方向尝试 3 次无果 → 换架构/换算法/换方向，不调参死磕。
5. 新增 bug fix 同时要为该 bug 写一个能复现的测试（参考 EDD）。

## 本框架的边界

当前不做：
- Ollama Vision 视觉回归（WebChat UI 简单，pixel-diff 足够）
- LLM-as-Judge trace 评估（L4 断言已够覆盖）
- 自愈选择器（测试规模小，维护成本 < 实现成本）

这些是明确"延后"，不是"不会做"——当 E2E 测试数量 > 30 或 UI 复杂度提升时重新评估。
