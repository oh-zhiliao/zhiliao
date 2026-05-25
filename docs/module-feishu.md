# 飞书通道模块

处理飞书消息收发、路由、格式转换和安全过滤。

## client.ts

飞书 SDK 封装，管理 WebSocket 连接和消息 API。

**类**: `FeishuClient`

| 方法 | 说明 |
|------|------|
| `connect()` | 建立 WS 连接 + 获取 bot identity |
| `onMessage(handler)` | 注册消息回调 |
| `sendToChat(chatId, type, content)` | 发送到群/私聊 |
| `replyMessage(messageId, type, content)` | 回复指定消息 |
| `addReaction(messageId, emoji)` | 添加表情回应 |
| `getBotOpenId()` | 获取 bot 的 open_id |

**Bot 身份获取**: 通过 `GET /open-apis/bot/v3/info` 原始 API 调用（SDK 无此封装）。

## adapter.ts

消息路由核心，连接飞书事件与业务逻辑。

**类**: `FeishuAdapter`

### 消息路由逻辑

```
收到消息
  ├── 解析 text content（JSON → 纯文本）
  ├── 去除 @mention 文本
  ├── 添加 OK emoji 回应（ACK）
  │
  ├── 私聊 (p2p):
  │   ├── /command →
  │   │   ├── 内置会话命令 (/new, /context, /help)
  │   │   ├── ToolRegistry.handleCommand() → 插件命令
  │   │   └── 未知命令 → 错误提示
  │   └── 其他 → Agent 问答
  │
  └── 群聊 (group):
      ├── 被 @mention → 响应（命令路由同上）
      └── 否则 → 忽略
```

### 权限模型

飞书入口在处理消息前会实时解析本次请求的 `role`，解析顺序如下：

1. 先按 `chat_id` 查询 SQLite `role_bindings`
2. 若未命中，再按 `chat_type` (`group` / `p2p`) 查询 `role_defaults`
3. 若仍未命中，直接拒绝，不进入 Agent，也不调用插件

`chat_id` 显式绑定优先级高于默认角色。命中后会把 `role` 连同 `channel/chatType/chatId/userId/logId` 一起放入请求上下文，传给 Agent 和插件工具链。

### 角色缺失时的行为

- `/help` 放行
- 管理员 `/role ...` 放行
- 其他消息直接回复未配置提示，文案包含 `chat_id`，方便管理员复制去配置

### /role 管理命令

`/role` 仅管理员可用；管理员身份按消息发送者的飞书 `open_id` 与 `config.yaml` 中的 `admins` 列表匹配。

支持的子命令：

- `/role help` — 查看所有子命令说明
- `/role assign <chat_id> <role>` — 为指定会话绑定 role
- `/role revoke <chat_id>` — 删除指定会话绑定
- `/role get <chat_id>` — 查看指定会话当前绑定的 role
- `/role list` — 列出所有 `chat_id` 绑定和 `group/p2p` 默认角色
- `/role default <group|p2p> <role>` — 为未单独配置的 `group/p2p` 会话设置默认 role
- `/role default-revoke <group|p2p>` — 删除 `group/p2p` 默认 role

当参数不完整或错误时，每个子命令都会返回各自的“用法 + 作用 + 示例”，而不是只返回命令骨架。

### 入口日志

每次飞书请求在入口都会记录 role 解析结果：

- 命中时：`role matched: role=<role> source=<chat|chat_type_default> chatType=<...> chat=<chat_id>`
- 未命中时：`role missing: chatType=<...> chat=<chat_id>`

### 特性

- **logId 追踪**: 每条消息生成 `genLogId()`，贯穿整个处理链路
- **Debug 模式**: `/debug` 前缀，返回 tool call 详情
- **进度回调**: 仅在 agent 首次调用 tool 时发送"正在查阅资料..."
- **输出过滤**: agent 回复经过 `filterSecrets()` → `toolRegistry.filterOutput()` 两层过滤（先 regex secret 脱敏，再插件自定义结构化过滤）

## thread-mapper.ts

会话标识生成，确保不同线程/用户的上下文隔离。

| 场景 | Session Key 格式 |
|------|------------------|
| 私聊 | `feishu:p2p:{user_id}` |
| 群聊主线程 | `feishu:{chat_id}:main` |
| 话题群线程 | `feishu:{chat_id}:{thread_id}` |

**Context 字段**: `chatId`, `chatType`, `messageId`, `threadId`, `senderId`, `logId`, `debugMode`

## message-builder.ts

飞书消息构建，使用 interactive 卡片格式发送 markdown 内容。

- `buildTextMessage(text)` — 纯文本消息
- `buildCardMessage(markdown, options?)` — interactive 卡片消息（`msg_type: "interactive"`）
  - `options.title` — 卡片标题（不传则无 header）
  - `options.template` — 卡片颜色：blue/orange/red/green/purple（默认 blue）
  - 卡片 elements 使用 `{ tag: "markdown", content }` 渲染

**飞书卡片 markdown 支持的语法**: `**粗体**`、`*斜体*`、`~~删除线~~`、`[链接](url)`、无序/有序列表、代码块（三反引号）
**不支持的语法**: 行内代码（单反引号）、引用块（>）、markdown 表格（| |）
**替代方案**: 行内代码用 `**粗体**` 替代；表格用卡片 `column_set` 组件

## secret-filter.ts

Agent 输出安全过滤，防止凭据泄露。

**检测模式**:
- 通用 key=value（password, token, secret, api_key 等）
- Bearer tokens (20+ 字符)
- AWS keys (AKIA/ASIA 前缀)
- GitHub/GitLab tokens (ghp_, glpat_ 前缀)
- SSH private key blocks
- 数据库连接串中的密码

**策略**: 连接串保留协议/host 仅脱敏密码，key=value 保留 key 名称，其他替换为 `[REDACTED]`。
