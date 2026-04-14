# Git 模块

负责 Git 仓库的本地管理操作。

> **已迁移**: `GitTracker` (tracker.ts) 和 `DeepScanner` (scanner.ts) 已迁移到 **git-repos** 插件，作为插件后台服务运行。核心代码中的文件保留为共享基础实现。

## repo-manager.ts

低层 Git 操作封装，通过 `child_process.execFile` 调用 git CLI。被 git-repos 插件使用。

**类**: `GitRepoManager`

| 方法 | 说明 |
|------|------|
| `cloneRepo(repoId, url, branch)` | 单分支 clone 到 `reposDir/{repoId}` |
| `fetchAndDetectChanges(path, branch)` | fetch + `HEAD..origin/branch` 检测新 commit |
| `pull(path, branch)` | fast-forward merge（只支持快进） |
| `getDiffStat(path, from, to)` | 两个 commit 间的 diff stat |
| `repoExists(repoId)` | 检查本地 clone 是否存在 |
| `extractRepoName(url)` | 从 URL 提取仓库名 |

**安全措施**:
- branch name 白名单: `/^[a-zA-Z0-9._\/-]+$/`
- commit hash 白名单: `/^[a-f0-9]{4,40}$/`
- 防止命令注入

## tracker.ts / scanner.ts

这些文件的功能现在由 **git-repos** 插件的 `start()` 方法启动和管理：

- **GitTracker**: 定时轮询检测新 commit，触发 Memo 索引和飞书通知
- **DeepScanner**: 每日全量扫描，维护知识库时效性（标记已删除文件为 stale）

详细文档参见 git-repos 插件。
