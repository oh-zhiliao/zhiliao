# 常见错误模式

每次开发前必读。遇到新错误时追加，定期抽象合并。

## 1. 常量散落多处

**规则**: 常量只定义一次、export 出去，消费方引用符号而非数值。测试中尤其如此。

## 2. 无限循环缺少退出点

**规则**: `for(;;)` / `while(true)` 必须标注所有退出点。重构循环结构时逐一核对每个退出路径。

## 3. 配置引用不存在的资源

**规则**: 修改外部资源引用（模型名、URL、路径）后，立即验证资源存在且可访问。

## 4. Docker host networking 下用错地址

**规则**: `network_mode: host` 时服务间通信用 `127.0.0.1`，不用 `host.docker.internal` 或容器名。

## 5. 飞书用户 ID 体系混淆

**规则**: 飞书有 user_id / open_id / union_id 三种体系，确认上下游使用同一种，代码中注释说明。

## 6. 臆测 SDK 方法

**规则**: 调用第三方 SDK 新 API 前，先 grep 类型定义确认方法存在。不确定时用原始 HTTP 请求。

## 7. 增量管道修复后忘记回填历史

**规则**: 修复数据管道后，评估是否需要回填历史数据。回填脚本需幂等。

## 8. Docker 容器内外 UID 不一致

**规则**: 操作容器创建的文件用 `sudo`。或在 Dockerfile 中指定与宿主机一致的 UID。

## 9. 代码变更后忘记 rebuild + deploy

**规则**: 代码变更 → `npm test` → `docker compose build` → `docker compose up -d` → 验证日志。四步闭环。

## 10. docker compose 在错误目录执行

**规则**: 必须在 `docker-compose.yml` 和 `.env` 所在的项目根目录执行。部署后用 `docker ps | grep <name>` 确认只有一个实例在运行。排查"消息收不到"时，先检查是否有幽灵容器抢占 WebSocket。

## 11. Prompt 禁止性指令导致模型拒绝正常功能

**规则**: 如果有后处理兜底（如 sanitizeMarkdown），prompt 中应说明"系统会自动转换"，而非禁止使用。禁止性指令只用于真正无法兜底的场景。

## 12. Write 工具写入中文产生乱码

**规则**: 对已有文件的局部修改用 Edit 而非 Write。如必须用 Write 重写，写入后 grep 检查乱码。

## 13. 网络不稳定导致级联静默失败

**规则**: 外部调用（LLM API、飞书 API、Git SSH）必须设置显式超时、对瞬态错误重试、失败时给用户可见反馈。绝不能让用户的消息石沉大海——即使是错误提示也比沉默好。

## 14. 顺序轮询让一个失败阻塞所有

**规则**: 轮询多个独立资源时用 `Promise.allSettled()` 而非顺序 `for...of`。对持续失败的资源加熔断器（指数退避），减少日志噪音和无效工作。

## 15. 多用途 JWT 共享 secret 时必须用 `aud` 隔离

**规则**: 同一 secret 签发多种用途的 JWT（如 OAuth state / session / API token）时，必须通过 `audience` claim 隔离。签发用 `{ audience: "xxx" }`，校验用 `{ algorithms: ["HS256"], audience: "xxx" }`。否则任意一处 JWT 泄露会被复用到其他鉴权入口（如 OAuth state JWT 被当作 session Bearer token 调 DELETE /api/sessions）。纵深防御，别指望调用者"不会拿错"。
