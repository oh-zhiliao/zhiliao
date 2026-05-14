# Role-Based Permission Design

## Goal

Add runtime-managed role-based permission for Feishu messages in zhiliao.

When a Feishu message arrives, zhiliao must resolve a `role` from SQLite based on the message `chat_id`, then send that role along with plugin requests so plugins can enforce fine-grained authorization. The default behavior is deny with a clear error when no explicit chat role or chat-type fallback role exists.

This design also adds an admin-only builtin `/role` command family for managing role bindings without editing config files or restarting the service.

## Scope

In scope:

- SQLite-backed role binding storage
- Runtime role resolution on every Feishu message
- Admin-only builtin `/role` commands
- Propagating per-request role context into plugin commands and LLM-triggered plugin tool calls
- Clear user-facing denial messages when no role is configured
- Tests for DB, command routing, Feishu routing, and tool context propagation

Out of scope:

- WebChat-specific role mapping
- Role inheritance trees or multi-role merging
- Plugin-specific policy semantics beyond receiving `context.role`
- UI for role management

## Requirements

1. Role resolution priority is:
   1. explicit `chat_id -> role` binding
   2. `chat_type -> fallback role` binding (`group` or `p2p`)
   3. deny request with explicit guidance
2. Role lookup must read SQLite at request time so changes take effect immediately.
3. `/role` commands are builtin commands, not plugin commands.
4. `/role` commands are admin-only, using the existing `admins` list from main config.
5. Missing `/role` subcommand defaults to help output.
6. Plugins must receive the resolved role through structured context, not prompt text injection.

## Architecture

### Database

Add two SQLite tables through core DB migration:

`role_bindings`
- `subject_type TEXT NOT NULL`
- `subject_id TEXT PRIMARY KEY`
- `role TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `created_by TEXT NOT NULL`
- `updated_by TEXT NOT NULL`

For this feature, only `subject_type = 'chat'` is used. The column remains to allow future extension without another schema break.

`role_defaults`
- `subject_type TEXT PRIMARY KEY`
- `role TEXT NOT NULL`
- `updated_at INTEGER NOT NULL`
- `updated_by TEXT NOT NULL`

For this feature, `subject_type` is the Feishu `chat_type`: `group` or `p2p`.

### Runtime Components

Introduce a small core role service around `ZhiliaoDB`:

- assign chat role
- revoke chat role
- get chat role
- assign chat-type default role
- revoke chat-type default role
- get effective role for a request

The role service should stay synchronous internally because `better-sqlite3` is synchronous and current DB usage already follows that model.

### Request Context

Add a structured per-request context shared by agent/tool/plugin execution:

- `channel`
- `chatType`
- `chatId`
- `userId`
- `role`
- `logId`

This context is created at message-routing time and propagated through:

- builtin command handling where relevant
- plugin command handling
- `AgentInvoker.ask()` / `askStreaming()`
- `ToolRegistry.executeTool()`
- plugin `executeTool()`

## Command Design

Add builtin `/role` subcommands:

- `/role help`
- `/role assign <chat_id> <role>`
- `/role revoke <chat_id>`
- `/role get <chat_id>`
- `/role default <group|p2p> <role>`
- `/role default-revoke <group|p2p>`

Behavior:

- `/role` with no subcommand behaves the same as `/role help`
- non-admin callers get a clear denial message
- invalid argument counts return usage guidance
- writes are immediately effective for subsequent messages because all reads hit SQLite directly

Example success messages:

- `已设置 role: chat_id=oc_xxx, role=prod-readonly`
- `已删除 role: chat_id=oc_xxx`
- `当前 role: chat_id=oc_xxx, role=prod-readonly`
- `已设置默认 role: chat_type=group, role=default`
- `已删除默认 role: chat_type=p2p`

## Message Routing

### Feishu

For every incoming Feishu message:

1. Extract `chat_id`, `chat_type`, `sender open_id`, and `logId`
2. Resolve effective role from SQLite
3. If no role is found:
   - reply immediately with a clear message containing `chat_type` and `chat_id`
   - do not call builtin session commands other than `/role`
   - do not call plugin commands
   - do not enter the agent loop
4. If role is found:
   - continue normal command/question routing
   - attach request context with resolved role

`/role` is an exception to the deny-fast path: admins must still be able to repair missing role configuration from the chat itself.

### WebChat

No behavior change in this feature. WebChat can keep running without role enforcement until a separate design adds a source of truth for its identity model.

## Plugin Contract Changes

Extend the core plugin interfaces:

- command context gains `role`
- tool execution gains optional request context

Expected plugin contract:

- command handlers can authorize on `context.role`
- LLM-triggered tools can authorize on the same `context.role`
- plugins that do not care about roles can ignore the new field

Builtin `memo-tools` should accept the new optional argument and ignore it.

## Error Handling

### Missing Role

Reply with a stable copy-friendly message:

`当前会话未配置权限角色。chat_type=<group|p2p>, chat_id=<chat_id>。请管理员执行 /role assign <chat_id> <role>，或为该 chat_type 设置默认 role。`

### Unauthorized `/role`

Reply with:

`只有管理员可以执行 /role 命令。`

### Invalid `/role` Usage

Return explicit per-subcommand usage, not a generic parse failure.

## Testing Strategy

Follow TDD:

1. DB tests
   - migrate new tables
   - assign/get/revoke chat role
   - assign/get/revoke fallback role
   - role resolution priority works as designed
2. Role command tests
   - `/role` defaults to help
   - admin can assign/revoke/get/default/default-revoke
   - non-admin is rejected
   - invalid args return usage
3. Feishu adapter tests
   - missing role rejects normal messages with `chat_id`
   - `/role` still works in unbound chats for admins
   - resolved role is attached to plugin command context
   - resolved role is attached to agent request context
4. Tool registry / invoker tests
   - plugin tool execution receives per-request role context
   - tool context stays request-scoped and does not leak across sessions

## Rollout Notes

- Existing deployments need one automatic DB migration only.
- Existing plugins will need a small interface update to accept the new optional context argument.
- Missing-role denial is intentionally strict and may block previously working chats until admins bind roles or set chat-type defaults.

## Open Decisions Resolved

- Role source of truth is SQLite, not config files.
- Primary identity key is Feishu `chat_id`.
- Fallback is per `chat_type`, not per user.
- No fallback means deny by default.
- `/role help` is builtin and `/role` without subcommand maps to help.
