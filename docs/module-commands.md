# 命令模块

## router.ts

命令解析，区分 `/command` 和普通问题。

- 以 `/` 开头 → 解析为 `CommandResult { command, subcommand, args[] }`
- 其他 → `QuestionResult { question }`

命令路由由 `FeishuAdapter` 处理：
1. 内置会话命令优先匹配 (`/new`, `/context`, `/help`)
2. 未匹配则通过 `ToolRegistry.handleCommand(command, subcommand, args, context)` 路由到插件
3. 插件命令格式: `/{plugin-name} {subcommand} {args...}`

## session-commands.ts

内置会话管理命令，不经过插件路由。

| 命令 | 说明 |
|------|------|
| `/new` | 重置当前会话上下文 |
| `/context` | 查看当前会话信息（消息数、token 用量、时长） |
| `/help` | 显示帮助信息 |

## 插件命令

仓库管理命令 (`/repo`) 和权限系统已迁移到 **git-repos** 插件。现在通过 `/git-repos` 命令前缀访问。

其他插件也可通过 `getCommandHandlers()` 注册自己的命令。详见 [Plugin Development Guide](plugin-development.md)。
