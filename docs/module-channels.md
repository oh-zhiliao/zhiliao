# 通道层模块

统一的多通道接入层，抽象不同消息来源（飞书、WebChat）的消息收发接口，提供通用的命令路由和问答处理。

## 目录结构

```
agent/src/channels/
  channel.ts          — Channel 接口 + 类型定义
  channel-router.ts   — ChannelRouter: 统一命令/问答路由
  feishu/             — FeishuAdapter（尚未实现 Channel 接口）
    adapter.ts
    client.ts
    message-builder.ts
    secret-filter.ts
    thread-mapper.ts
  webchat/            — WebChatChannel（实现 Channel 接口）
    channel.ts        — WebChatChannel 类
    server.ts         — Express + WebSocket 服务器
```

## channel.ts — 核心类型

### ChannelMessageContext

通道消息上下文，作为消息处理的唯一传递对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `channelName` | `string` | 通道标识（如 `"webchat"`、`"feishu"`） |
| `userId` | `string` | 用户标识 |
| `sessionKey` | `string` | 会话标识 |
| `messageId` | `string?` | 消息 ID（用于回复引用） |
| `extra` | `Record<string, unknown>` | 通道自定义字段（如 WebChat 的 `sessionId`） |

### StreamDelta

流式传输的增量消息类型：

| 类型 | 字段 | 说明 |
|------|------|------|
| `text_delta` | `content` | 文本增量片段 |
| `tool_start` | `toolName`, `summary` | 工具调用开始 |
| `tool_end` | `toolName` | 工具调用结束 |
| `complete` | `content` | 回复完成（含完整文本） |
| `error` | `message` | 错误信息 |

### Channel 接口

```typescript
interface Channel {
  name: string;
  getSessionKey(context): string;
  sendReply(context, content): Promise<void>;
  sendProgress?(context, info): Promise<void>;
  supportsStreaming(): boolean;
  sendStreamDelta?(context, delta): Promise<void>;
}
```

| 方法 | 必选 | 说明 |
|------|------|------|
| `name` | 是 | 通道标识符 |
| `getSessionKey()` | 是 | 从 context 提取 session key |
| `sendReply()` | 是 | 发送完整回复 |
| `sendProgress()` | 否 | 发送进度提示（如"正在查阅资料..."） |
| `supportsStreaming()` | 是 | 是否支持流式输出 |
| `sendStreamDelta()` | 否 | 发送流式增量（仅 `supportsStreaming()=true` 时使用） |

## channel-router.ts — ChannelRouter

统一的消息路由器，将命令和问答的处理逻辑从通道实现中解耦。

**类**: `ChannelRouter`

**构造参数**: `AgentInvoker`, `ToolRegistry`, `secretPatterns[]`

### 路由逻辑

```
handleMessage(channel, context, text)
  │
  ├── parseCommand(text)
  │
  ├── 命令:
  │   ├── /new     → handleNew() → channel.sendReply()
  │   ├── /context → handleContext() → channel.sendReply()
  │   ├── /help    → handleHelp() → channel.sendReply()
  │   ├── /{plugin} {subcommand} → toolRegistry.handleCommand() → channel.sendReply()
  │   └── 未知命令 → "未知命令: /{command}"
  │
  └── 问答:
      ├── agent.ask(question, sessionKey, onProgress)
      ├── filterSecrets(response, patterns)
      ├── toolRegistry.filterOutput(filtered)
      └── channel.sendReply(context, finalText)
```

**错误处理**: 问答失败时返回 `处理失败 (code: {code})\n请稍后重试。`，不抛异常。

**使用方式**: WebChat 通过 `ChannelRouter` 路由命令；问答走独立的 streaming 路径（不经过 `ChannelRouter.handleQuestion`）。FeishuAdapter 有独立的路由逻辑（与 `ChannelRouter` 重复），尚未迁移。

## WebChatChannel

实现 `Channel` 接口的 WebSocket 通道，用于浏览器端聊天。

**类**: `WebChatChannel`（`channels/webchat/channel.ts`）

| 方法 | 说明 |
|------|------|
| `getSessionKey(ctx)` | 返回 `webchat:{ctx.extra.sessionId}` |
| `supportsStreaming()` | 返回 `true` |
| `registerSocket(sessionId, ws)` | 注册活跃 WebSocket 连接 |
| `unregisterSocket(sessionId)` | 移除连接 |
| `sendReply(ctx, content)` | 发送 `{ type: "message_complete" }` |
| `sendStreamDelta(ctx, delta)` | 转发 StreamDelta 到客户端 |

**连接管理**: `activeSockets: Map<sessionId, WebSocket>`，按 sessionId 索引。`sendProgress` 为空实现（WebChat 通过流式 delta 显示进度，不需要单独的进度消息）。

### Session Key 格式

| 场景 | Session Key |
|------|-------------|
| WebChat 会话 | `webchat:{sessionId}` (UUID) |

## WebChat Server

Express + WebSocket 服务器，由 `createWebChatServer()` 创建。

**文件**: `channels/webchat/server.ts`

### HTTP 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 密码认证 → JWT（1h 有效期） |
| DELETE | `/api/sessions/:id` | 清除指定 session |
| GET | `/api/health` | 健康检查 |
| * | `/` | 静态前端（`agent/web/`） |

### WebSocket 协议

连接地址: `/ws?token={jwt}`，JWT 验证失败返回 4001 关闭。

**客户端 → 服务端消息**:

| type | 字段 | 说明 |
|------|------|------|
| `message` | `sessionId`, `content` | 发送消息（命令或问答） |
| `stop` | `sessionId` | 中断当前处理 |
| `history` | `sessionId` | 请求历史（当前返回空数组） |

**服务端 → 客户端消息**:

| type | 字段 | 说明 |
|------|------|------|
| `text_delta` | `sessionId`, `content` | 文本增量 |
| `tool_start` | `sessionId`, `toolName`, `summary` | 工具调用开始 |
| `tool_end` | `sessionId`, `toolName` | 工具调用结束 |
| `message_complete` | `sessionId`, `content` | 回复完成 |
| `error` | `sessionId`, `message` | 错误 |
| `history` | `sessionId`, `messages` | 历史消息 |

### 消息处理流程

```
WebSocket message
  ├── type=stop → AbortController.abort()
  ├── type=history → 返回空数组
  └── type=message:
      ├── /debug 前缀 → 设置 debug 模式，发送 session key
      ├── /command → ChannelRouter.handleMessage()（非流式）
      └── question → agent.askStreaming()（流式）
          ├── onTextDelta → filterSecrets → 发送 text_delta
          ├── onToolStart → 发送 tool_start
          ├── onToolEnd → 发送 tool_end
          ├── onComplete → filterSecrets + filterOutput → 发送 message_complete
          └── onError → 发送 error
```

**中断支持**: 每个活跃会话绑定 `AbortController`，客户端发送 `stop` 即可中断 LLM 推理。

**并发保护**: 同一 sessionId 的并发请求返回 `"Already processing"` 错误。

**输出过滤**: 流式增量中的文本仅经过 `filterSecrets()`（逐片段脱敏）；最终完成时经过 `filterSecrets()` + `toolRegistry.filterOutput()` 双层过滤。

### 配置

```yaml
webchat:
  enabled: true
  port: 8080
  password: "changeme"      # 首次运行自动哈希为 bcrypt
  jwt_secret: "auto"        # "auto" = 每次启动随机生成，持久化到 data/webchat-jwt-secret
```

## 当前状态

- **WebChatChannel** 完整实现 `Channel` 接口，命令路由使用 `ChannelRouter`
- **FeishuAdapter** 尚未实现 `Channel` 接口，保留独立的命令/问答路由逻辑（与 `ChannelRouter` 重复）。原因：飞书特有的 @mention 处理、群聊/私聊区分、emoji ACK 等逻辑尚未抽象到通用层
- **后续计划**: 将 FeishuAdapter 迁移为实现 `Channel` 接口，所有通道统一通过 `ChannelRouter` 路由

## 新增通道指南

### 1. 实现 Channel 接口

```typescript
import type { Channel, ChannelMessageContext, StreamDelta } from "../channel.js";

export class MyChannel implements Channel {
  name = "my-channel";

  getSessionKey(context: ChannelMessageContext): string {
    return `my-channel:${context.extra.myId}`;
  }

  supportsStreaming(): boolean {
    return false; // 或 true，按需实现 sendStreamDelta
  }

  async sendReply(context: ChannelMessageContext, content: string): Promise<void> {
    // 发送完整回复给用户
  }
}
```

### 2. Session Key 约定

格式: `{channel_name}:{unique_id}`，确保跨通道不冲突。例如:
- `webchat:{sessionId}` (UUID)
- `feishu:{chat_id}:{thread_id}`
- `feishu:p2p:{user_id}`

### 3. 接入 ChannelRouter

通道可选择使用 `ChannelRouter.handleMessage()` 进行命令/问答路由（推荐），或自行处理路由（如当前 FeishuAdapter 所做）。

### 4. 流式支持

流式为可选能力。若 `supportsStreaming()` 返回 `false`，`sendStreamDelta()` 不会被调用，通道只需实现 `sendReply()` 即可。

### 5. 在 index.ts 中注册

在应用启动流程中创建通道实例，调用 `channel.start()` 启动服务，关闭时调用 `channel.stop()`。
