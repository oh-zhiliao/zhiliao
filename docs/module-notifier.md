# 通知模块

> **已迁移**: `ChangeNotifier` 已迁移到 **git-repos** 插件。核心代码中的 `notifier/change-notifier.ts` 保留为共享基础实现，由 git-repos 插件通过 `PluginContext.sendFeishuMessage()` 发送通知。

## change-notifier.ts

飞书变更通知推送。

**类**: `ChangeNotifier`

**方法**: `notify(repoName, commits, chatIds)`

**通知格式**:
```
代码变更通知
- 2eb954f feat: 快钱对账。 (author)
- e98d058 feat: 快钱对账。 (author)
```

- 使用 post 富文本格式
- 逐群发送，单个群失败不影响其他
- commit hash 截取前 7 位
- 错误日志包含 error code 和 apiLogId
