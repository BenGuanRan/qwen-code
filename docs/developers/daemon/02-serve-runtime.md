# Serve 运行时
## 概览

`packages/cli/src/serve/` 是 `qwen serve` 的引导层，负责：把 CLI 参数翻译成 `ServeOptions`、启动期校验、构造 Express 应用、装配中间件链、注册路由、暴露 daemon-host 的 preflight/status provider、维护权限审计环、以及两阶段优雅退出序列。所有 HTTP 形态的东西都在这一层；所有 ACP 形态的东西在下一层 `@qwen-code/acp-bridge`（见 [`03-acp-bridge.md`](./03-acp-bridge.md)）。

## 职责

- 解析与校验 `ServeOptions`（`hostname`、`port`、`token`、`requireAuth`、`workspace`、`maxSessions`、`maxConnections`、`eventRingSize`、`mcpClientBudget`、`mcpBudgetMode`、`mcpPoolActive`）。
- 一次性 **canonicalize** 绑定的 workspace（同一份规范形式同时供 `/capabilities`、`POST /session` 兜底和 bridge 使用）。
- 拒绝以不安全的姿势启动：非 loopback 绑定无 token；`--require-auth` 无 token；`mcpBudgetMode='enforce'` 无正整数 `mcpClientBudget`；`--workspace` 不存在或不是目录。
- 构造 `WorkspaceFileSystem` 工厂、权限审计 publisher、`DaemonStatusProvider`、`acp-bridge`。
- 构造 Express 应用、装配中间件链（`bearerAuth` → `hostAllowlist` → `denyBrowserOriginCors` → 每路由 `mutationGate`）、挂载路由（session、workspace CRUD、文件、Device Flow auth、权限投票）。
- 绑定监听端口并注册信号 handler。
- 收到 SIGINT/SIGTERM 时两阶段退出；二次信号强退。

## 架构

**入口**：`runQwenServe(opts, deps)`，文件 `packages/cli/src/serve/runQwenServe.ts:308-994`，返回 `RunHandle`（`{ url, port, close, ... }`）。

**应用工厂**：`createServeApp(opts, getPort, deps)`，文件 `packages/cli/src/serve/server.ts:261-339`，构建 Express `Application`。直接嵌入和测试不走 bootstrap，直接调它。

**能力注册表**：`SERVE_CAPABILITY_REGISTRY`，文件 `packages/cli/src/serve/capabilities.ts:37-215`。每个 tag 带 `since` 版本和可选 `modes`，条件 tag（`require_auth`、`mcp_workspace_pool`、`mcp_pool_restart`）在开关关掉时不广播。详见 [`11-capabilities-versioning.md`](./11-capabilities-versioning.md)。

**中间件** `packages/cli/src/serve/auth.ts`：

| 中间件                                               | 作用                                                                                                 | 说明                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denyBrowserOriginCors`                              | 拒绝任何带 `Origin` 头的请求                                                                         | CLI/SDK 永远不发 `Origin`，这是 CSRF 防护。                                                                                                                                                                                                                                      |
| `hostAllowlist(bind, getPort)`                       | Loopback 下校验 `Host` 头属于 `localhost`、`127.0.0.1`、`[::1]`、`host.docker.internal` 加端口的集合 | 防 DNS rebinding，按端口缓存，比较时大小写不敏感。                                                                                                                                                                                                                               |
| `bearerAuth(token)`                                  | 用 SHA-256 + `timingSafeEqual` 常量时间比较                                                          | 无 token（loopback dev 默认）就 open passthrough，`Bearer` 大小写不敏感。                                                                                                                                                                                                        |
| `createMutationGate({tokenConfigured, requireAuth})` | 路由级 opt-in 闸门，对 Wave 4 修改类路由即便在 loopback 也强制 token                                 | 返回 `401 { code: 'token_required' }`，区别于一般 `Unauthorized`。`/workspace/memory`、`/workspace/agents/*`、`/file/write`、`/workspace/tools/:name/enable`、`/workspace/mcp/:server/restart`、`/workspace/auth/device-flow`、`/workspace/init` 都调 `mutate({strict: true})`。 |

**子系统**：

| 路径                                                         | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve/fs/`                                                  | `WorkspaceFileSystem` 工厂 + `policy.ts`（大小/信任/二进制检查）+ `paths.ts`（canonicalize、resolveWithin、拒绝 symlink）+ `audit.ts` + `errors.ts`（typed `FsError`）                                                                                                                                                                                                                                                                                               |
| `serve/routes/workspaceFileRead.ts`、`workspaceFileWrite.ts` | `GET /file`、`GET /file/bytes`、`POST /file/write`、`POST /file/edit` 的 HTTP handler                                                                                                                                                                                                                                                                                                                                                                                |
| `serve/workspaceMemory.ts`                                   | `GET/POST /workspace/memory`（QWEN.md CRUD）                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `serve/workspaceAgents.ts`                                   | `GET/POST/DELETE /workspace/agents`（子 agent CRUD）                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `serve/daemonStatusProvider.ts:41-287`                       | env 快照 + daemon-host preflight cell（Node 版本、CLI 入口、workspace stat、ripgrep、git、npm）                                                                                                                                                                                                                                                                                                                                                                      |
| `serve/permissionAudit.ts:1-60`                              | `PermissionAuditRing`（FIFO 512 条）+ `createPermissionAuditPublisher`                                                                                                                                                                                                                                                                                                                                                                                               |
| `serve/auth/deviceFlow.ts`、`qwenDeviceFlowProvider.ts`      | Device Flow OAuth 路由（见 [`12-auth-security.md`](./12-auth-security.md)）                                                                                                                                                                                                                                                                                                                                                                                          |
| `serve/demo.ts`                                              | `GET /demo` 的自包含内联 HTML —— 一个浏览器可访问的调试控制台（聊天 UI + 事件日志 + workspace 检视器）。loopback 且不带 `--require-auth` 时注册在 `bearerAuth` **之前**，开发不带 token 就能从浏览器打开；非 loopback 或带 `--require-auth` 时注册在 `bearerAuth` **之后**，未认证探测不能枚举接口。Strict CSP（`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`）+ `X-Frame-Options: DENY`。 |

**Re-export shim**（为兼容 F1 前的 import 路径）：

- `serve/eventBus.ts` → `@qwen-code/acp-bridge/eventBus`
- `serve/status.ts` → `@qwen-code/acp-bridge/status`
- `serve/httpAcpBridge.ts` → `@qwen-code/acp-bridge`

## 流程

### 启动序列

1. **取并 trim token**：`opts.token` || `QWEN_SERVER_TOKEN`（启动时 trim 一次，防止 `cat token.txt` 把换行带进来导致永远比对不上）。
2. **hostname 错配兜底**：`--hostname localhost:4170` 直接报错并提示用 `--port`。
3. **auth 预检**：非 loopback 无 token → 拒绝；`--require-auth` 无 token → 拒绝。
4. **workspace 校验**：必须绝对路径、必须存在、必须是目录；`EACCES`/`EPERM` 包装成指向参数本身的错误。
5. **canonicalize workspace**：`canonicalizeWorkspace(rawWorkspace)` 走 `realpathSync.native` 一次，给 `/capabilities`、`POST /session` 兜底、bridge 共用，保证在 symlink / 大小写不敏感 FS 上不分叉。
6. **MCP 预算校验**：必须正整数；`enforce` 必须配 budget。
7. **MCP pool 开关推断**：父进程 env 里 `QWEN_SERVE_NO_MCP_POOL=1` 时，`mcpPoolActive` 默认 `false`，capabilities 也会诚实地不广播 `mcp_workspace_pool` + `mcp_pool_restart`。
8. **per-handle `childEnvOverrides`**：把 `QWEN_SERVE_MCP_CLIENT_BUDGET` 和 `QWEN_SERVE_MCP_BUDGET_MODE` 通过 `BridgeOptions.childEnvOverrides` 传给 ACP 子进程，**不**改 `process.env`（同进程跑两个 daemon 会出 race）。
9. **boot 一次 `settings.json`**：取 `context.fileName`、`policy.permissionStrategy`、`policy.consensusQuorum`；损坏文件 try/catch 走默认值。之后 **`validatePolicyConfig()`**（`runQwenServe.ts:89+`）解析 `policy.*`，未知 strategy（按 `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes` 单一事实源校验）或非正整数 `consensusQuorum` 时抛 `InvalidPolicyConfigError`。`consensusQuorum` 设了但策略非 `consensus` 时打 stderr 警告（默认会被静默忽略，浮出来防 operator 误以为它生效）。settings 读 I/O 失败回退默认；`InvalidPolicyConfigError` 重抛让 boot 显式失败。
10. **分配 `PermissionAuditRing`**（512 条）。
11. **建 `fsFactory`**：`runQwenServe` 路径默认 `trusted: true`；`createServeApp` 直接调时默认 `trusted: false` 并发警告一次。
12. **`createHttpAcpBridge`**，见 [`03-acp-bridge.md`](./03-acp-bridge.md)。
13. **`createServeApp`** 装配 Express。
14. **`server.listen(port, hostname)`**，resolve 后取真实 `getPort()` 给 host allowlist。
15. **注册 SIGINT / SIGTERM handler**，驱动优雅退出。

### 优雅退出（两阶段）

1. **第一阶段 —— bridge 收尾**（首次信号）：
   - dispose Device Flow registry（取消所有 pending flow）。
   - `bridge.shutdown()`：所有 channel 置 `isDying = true`；向每个 ACP 子进程 stdin 发 graceful close；每个 channel 等 `KILL_HARD_DEADLINE_MS`（10s）；不退就 `channel.kill()`。
2. **第二阶段 —— HTTP 收尾**：
   - `server.close()`（停止接收新连接，等飞行中请求收尾）。
   - 起 `SHUTDOWN_FORCE_CLOSE_MS`（5s）定时器，到点 `server.closeAllConnections()` 强切 socket。
   - 起二次 2s deadline，到点继续升级。
3. **退出中再来一次信号**：
   - `bridge.killAllSync()` + `process.exit(1)`。防孤儿 —— 子进程卡死也不能拖死 daemon 进程。

## 状态与生命周期

`RunHandle` 暴露：

- `url`：实际监听 URL（ephemeral 端口取 `getPort()` 之后）。
- `port`：实际端口（`0` 解析后的真实值）。
- `close({ timeoutMs? })`：给嵌入方 / 测试用的程序化关闭。

`createServeApp` 直接调时只返回 `Application`，不持有生命周期；嵌入方自己写 `listen` 和 shutdown。

## 依赖

| 上游（`serve/` 用了什么）                                                                      | 下游（谁用了 `serve/`）              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| `@qwen-code/acp-bridge`：bridge、event bus、status 类型                                        | `qwen` CLI 的 `serve` 子命令处理函数 |
| `packages/core`：`loadSettings`、`getCurrentGeminiMdFilename`、`Config`、`WorkspaceContext`    | 任何直接嵌入方（测试、程序化调用）   |
| ACP SDK（`@agentclientprotocol/sdk`）：`PROTOCOL_VERSION`、`ClientSideConnection`（经 bridge） |                                      |
| Express + body-parser、`node:crypto`、`node:fs`、`node:path`                                   |                                      |

## 配置

| 来源            | Key                                                             | 效果                                                                    |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Env             | `QWEN_SERVER_TOKEN`                                             | Bearer token（trim 后）。                                               |
| Env             | `QWEN_SERVE_NO_MCP_POOL=1`                                      | 强制 `mcpPoolActive=false`。                                            |
| Env             | `QWEN_SERVE_MCP_CLIENT_BUDGET` / `QWEN_SERVE_MCP_BUDGET_MODE`   | 通过 `childEnvOverrides` 传给 ACP 子进程。                              |
| Env             | `QWEN_SERVE_DEBUG=1`                                            | 详细 stderr 日志（见 [`19-observability.md`](./19-observability.md)）。 |
| 参数            | `--hostname`、`--port`                                          | 监听绑定。                                                              |
| 参数            | `--token`                                                       | Bearer token（覆盖 env）。                                              |
| 参数            | `--require-auth`                                                | 把 bearer 强制到 loopback；无 token 直接拒启动。                        |
| 参数            | `--workspace`                                                   | 覆盖 `process.cwd()`。                                                  |
| 参数            | `--max-sessions`、`--max-connections`、`--event-ring-size`      | bridge / Express 上限。                                                 |
| 参数            | `--mcp-client-budget=N`、`--mcp-budget-mode={off,warn,enforce}` | 传给 ACP 子进程。                                                       |
| `settings.json` | `policy.permissionStrategy`、`policy.consensusQuorum`           | `MultiClientPermissionMediator` 的策略与法定人数。                      |
| `settings.json` | `context.fileName`                                              | bridge 的 `getCurrentGeminiMdFilename` 覆盖。                           |

合并参考见 [`17-configuration.md`](./17-configuration.md)。

## 注意 & 已知局限

- `createServeApp` 没传 `deps.fsFactory` 或 `deps.bridge` 时默认 `trusted: false`，agent 侧 ACP `writeTextFile` 会拒为 `untrusted_workspace`。提示只打一次。
- `denyBrowserOriginCors` 拒绝**所有**带 `Origin` 的请求；demo 页能跑是因为另一个中间件先把匹配本机 origin 的剥掉了。
- body-parser 顺序：`mutateGate({strict: true})` 的 401 在 `express.json()` 之后才触发；strict 路径最坏放大成 `--max-connections × express.json({limit: '10mb'})` ≈ 2.5 GB 瞬时（loopback only，刻意接受）。
- 同进程跑两个 daemon 时必须用 per-handle `childEnvOverrides`；改 `process.env` 会 race（`defaultSpawnChannelFactory` 在 spawn 时刻快照 env）。

## 参考

- `packages/cli/src/serve/runQwenServe.ts:308-994`
- `packages/cli/src/serve/server.ts:261-339`
- `packages/cli/src/serve/auth.ts:1-294`
- `packages/cli/src/serve/capabilities.ts:1-220`
- `packages/cli/src/serve/types.ts:37-155`（`ServeOptions`、`CapabilitiesEnvelope`）
- `packages/cli/src/serve/daemonStatusProvider.ts:41-287`
- `packages/cli/src/serve/permissionAudit.ts:1-60`
- Issue：[#3803](https://github.com/QwenLM/qwen-code/issues/3803)、[#4175](https://github.com/QwenLM/qwen-code/issues/4175)。
