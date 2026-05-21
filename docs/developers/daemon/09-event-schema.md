# Typed Daemon Event Schema v1
## 概览

daemon 在 `GET /session/:id/events` 上发的每一帧 SSE 都形如 `{ id, v, type, data, originatorClientId?, _meta? }`，`v: 1` 是当前 `EVENT_SCHEMA_VERSION`。`type` 取自一个封闭的、版本固定的集合 —— `DAEMON_KNOWN_EVENT_TYPE_VALUES`（`packages/sdk-typescript/src/daemon/events.ts:13-63`）共 **29 种**。envelope 的 `_meta` 字段在 SSE 写边界（`server.ts` 的 `formatSseFrame()`）盖上 —— 详见下文 [Envelope 级元数据](#envelope-级元数据)。

SDK 暴露 `narrowDaemonEvent(evt)`，对已知 type 返回一个判别式 `KnownDaemonEvent`，对其他 type 返回 `{ kind: 'unknown' }` —— SDK 消费方无需固定 SDK 版本就能处理向前兼容（更新的 daemon 加了新 type 也不会崩）。

wire 格式见 [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)，本文是每个事件的 payload 契约。

## 职责

- 提供事件词汇表的唯一事实来源（line 13 那个常量数组）。
- 提供每种 type 的 typed envelope（`DaemonEventEnvelope<TType, TData>`）。
- 提供纯 reducer（`reduceDaemonSessionEvent`、`reduceDaemonAuthEvent`），把事件流投影成 SDK view-state。
- 通过 `typed_event_schema` 能力 tag 广播（信息性 —— 不广播时 `narrowDaemonEvent` 仍 fallback 到 `unknown`）。

## 事件词汇表（29 种）

按域分组。

### Core session

| Type                       | 方向         | 触发                                                                     | Payload 关键字段                                            |
| -------------------------- | ------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `session_update`           | S→C          | 任意 ACP `sessionUpdate` 通知（agent text / thought / tool call / plan） | `sessionUpdate: string, content?: ...`（不透明 ACP shape）  |
| `session_metadata_updated` | S→C          | `PATCH /session/:id/metadata`                                            | `sessionId, displayName?`                                   |
| `session_died`             | S→C **终态** | `channel.exited` 触发                                                    | `sessionId, reason, exitCode? \| null, signalCode? \| null` |
| `session_closed`           | S→C **终态** | `DELETE /session/:id` 或程序化关闭                                       | `sessionId, reason: 'client_close' \| string, closedBy?`    |

### Subscriber 级合成帧

| Type                    | 触发                                                                                                                                        | 备注                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_evicted`        | EventBus 每订阅者队列溢出。**无 `id`**                                                                                                      | `reason: string, droppedAfter?: number`；只对当前订阅者终态，session 还活着                                                                                                                                                                                                                                                           |
| `slow_client_warning`   | 队列 ≥ 75%（force-push，**无 `id`**）                                                                                                       | `queueSize, maxQueued, lastEventId`；37.5% 滞回 re-arm                                                                                                                                                                                                                                                                                |
| `stream_error`          | `SubscriberLimitExceededError` 或其他路由流错                                                                                               | `error: string`；订阅终态                                                                                                                                                                                                                                                                                                             |
| `state_resync_required` | `subscribe({lastEventId})` 时 daemon 环里已不再持有 `[lastEventId+1, earliestInRing-1]` 这段间隙。在剩余 replay 帧**之前**强推。**无 `id`** | `reason: string`（当前恒为 `'ring_evicted'`）、`lastDeliveredId: number`、`earliestAvailableId: number`。**面向恢复，非终态** —— SSE 流保持打开，replay + live 帧继续；SDK reducer 翻转 `awaitingResync = true`，自动跳过 delta，直到调用方调 `loadSession` 重置。daemon 端实现见 `eventBus.ts:359-402`，SDK 端见 `events.ts:870-905` |

### Permissions（F3 + base）

| Type                          | 方向 | 触发                                   | Payload 关键字段                                                                                                                       |
| ----------------------------- | ---- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `permission_request`          | S→C  | agent 调 `requestPermission`           | `requestId, sessionId, toolCall, options[]`；envelope 盖 `originatorClientId`（= prompt originator，F3 N3）                            |
| `permission_resolved`         | S→C  | mediator 已裁决                        | `requestId, outcome`（ACP `PermissionOutcome`）                                                                                        |
| `permission_already_resolved` | S→C  | 已裁决后投票才到                       | `requestId, sessionId, outcome`                                                                                                        |
| `permission_partial_vote`     | S→C  | `consensus` 策略记录了一次不裁决的投票 | `requestId, sessionId, votesReceived, votesNeeded (≥1), quorum, optionTallies: Record<string, number>, originatorClientId?`            |
| `permission_forbidden`        | S→C  | 投票被策略拒绝                         | `requestId, sessionId, clientId?, reason: 'designated_mismatch' \| 'remote_not_allowed', originatorClientId?`；匿名投票者无 `clientId` |

### Models

| Type                  | 方向 | Payload                                      |
| --------------------- | ---- | -------------------------------------------- |
| `model_switched`      | S→C  | `sessionId, modelId`                         |
| `model_switch_failed` | S→C  | `sessionId, requestedModelId, error: string` |

### MCP guardrails（PR 14b + F2）

| Type                         | 方向 | Payload                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_budget_warning`         | S→C  | `liveCount, reservedCount, budget, thresholdRatio: 0.75, mode: 'warn' \| 'enforce', scope?: 'workspace' \| 'session'`                                                                                                                                                                                                                                                                                                                   |
| `mcp_child_refused_batch`    | S→C  | `refusedServers: [{name, transport, reason: 'budget_exhausted'}], budget, liveCount, reservedCount, mode: 'enforce', scope?: 'workspace' \| 'session'`                                                                                                                                                                                                                                                                                  |
| `mcp_server_restarted`       | S→C  | `serverName, durationMs, entryIndex?`（F2 多 entry）                                                                                                                                                                                                                                                                                                                                                                                    |
| `mcp_server_restart_refused` | S→C  | `serverName, reason: 'budget_would_exceed' \| 'in_flight' \| 'disabled' \| 'restart_failed', entryIndex?, details?`。第 4 个值 `'restart_failed'`（F2 commit 5）携带底层硬失败，`details` 是自由格式字符串，给池模式多 entry restart 用。**封闭集判别**：`MCP_RESTART_REFUSED_REASONS` 拒绝未知 reason，老 SDK reducer 看到加法新值会**默默丢弃**事件（`parseDaemonEvent` 返回 `undefined`）。新 reason 值必须与认识它的 SDK 版本一起发 |

### Mutation control（Wave 4 PR 16+17）

| Type                    | 方向 | Payload                                                                               |
| ----------------------- | ---- | ------------------------------------------------------------------------------------- |
| `memory_changed`        | S→C  | `scope: 'workspace' \| 'global', filePath, mode: 'append' \| 'replace', bytesWritten` |
| `agent_changed`         | S→C  | `change: 'created' \| 'updated' \| 'deleted', name, level: 'project' \| 'user'`       |
| `approval_mode_changed` | S→C  | `sessionId, previous, next, persisted: boolean`                                       |
| `tool_toggled`          | S→C  | `toolName, enabled`（下次 ACP child spawn 才生效，不会回溯改动已在跑的 session）      |
| `workspace_initialized` | S→C  | `path, action: 'created' \| 'overwritten'`                                            |

### Auth device flow（PR 21）

这些是 workspace-keyed 不是 session-keyed。session reducer 对它们 no-op；`reduceDaemonAuthEvent` 投到 workspace-level state。

| Type                          | 方向 | Payload                                               |
| ----------------------------- | ---- | ----------------------------------------------------- |
| `auth_device_flow_started`    | S→C  | `deviceFlowId, providerId, expiresAt`                 |
| `auth_device_flow_throttled`  | S→C  | `deviceFlowId, intervalMs`                            |
| `auth_device_flow_authorized` | S→C  | `deviceFlowId, providerId, expiresAt?, accountAlias?` |
| `auth_device_flow_failed`     | S→C  | `deviceFlowId, errorKind, hint?`                      |
| `auth_device_flow_cancelled`  | S→C  | `deviceFlowId`                                        |

## 架构

| 关注点                                 | 文件:行                                              | 说明                                                               |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `EVENT_SCHEMA_VERSION = 1`             | `packages/acp-bridge/src/eventBus.ts:22`             | 每帧带                                                             |
| `DAEMON_KNOWN_EVENT_TYPE_VALUES`       | `packages/sdk-typescript/src/daemon/events.ts:13-63` | 封闭列表（长 28）                                                  |
| `DaemonEventEnvelope<TType, TData>`    | `events.ts:74-78`                                    | 泛型 envelope                                                      |
| `DaemonKnownEventType`                 | `events.ts:71-72`                                    | `typeof DAEMON_KNOWN_EVENT_TYPE_VALUES[number]`                    |
| 各事件 payload 类型                    | `events.ts:80+`                                      | 每种 type 一个 `DaemonXxxData` interface                           |
| `narrowDaemonEvent(evt)`               | `events.ts`                                          | 返回 `KnownDaemonEvent \| { kind: 'unknown', value: DaemonEvent }` |
| `reduceDaemonSessionEvent(state, evt)` | `events.ts`                                          | 投到 `DaemonSessionViewState`                                      |
| `reduceDaemonAuthEvent(state, evt)`    | `events.ts`                                          | 投到 `DaemonAuthState`                                             |
| `isWorkspaceScopedBudgetEvent(evt)`    | `events.ts`                                          | 判别 F2 `scope: 'workspace'`                                       |

### `DaemonSessionViewState`

`reduceDaemonSessionEvent` 填充，CLI TUI adapter、`DaemonChannelBridge`、VSCode IDE 都消费。关键字段：

- `messages: HistoryItem[]` — 由 `session_update` 派生。
- `pendingPermissionRequests: PermissionRequestData[]` — 当前打开的请求；`permission_resolved` / `permission_already_resolved` / 对自身的 `permission_forbidden` / cancel 时清掉。
- `latestPermissionResolution?: PermissionOutcome`。
- `currentModelId?: string` — 由 `model_switched`。
- `lastModelSwitchError?: string` — 由 `model_switch_failed`。
- `mcpBudgetWarningCount`、`lastMcpBudgetWarning?` — 由 `mcp_budget_warning`。
- `mcpChildRefusedBatchCount`、`lastMcpChildRefusedBatch?` — 由 `mcp_child_refused_batch`。
- `mcpRestartHistory[]` — 由 `mcp_server_restarted` / `mcp_server_restart_refused`。
- `terminal?: { kind, reason, ... }` — 任何终态帧。

### `DaemonAuthState`

按 `providerId` 一项，由 `auth_device_flow_*` 驱动。每个 flow 暴露 `{deviceFlowId, status, providerId, expiresAt?, lastThrottleIntervalMs?, lastError?}`。

## 流程

### Producer 端

```mermaid
flowchart LR
    A["ACP child notification"] --> B["BridgeClient.sessionUpdate /<br/>BridgeClient.extNotification"]
    B --> C{"Mapped to event type?"}
    C -->|yes| D["EventBus.publish({type, data, originatorClientId?})"]
    C -->|no| E["No emit (drop or log)"]
    D --> F["Assigns id + v=1, pushes to ring"]
    F --> G["Fans to all subscribers"]
```

### Consumer 端（SDK）

```mermaid
flowchart LR
    A["SSE bytes"] --> B["parseSseStream → DaemonEvent[]"]
    B --> C["narrowDaemonEvent(evt)"]
    C -->|"kind: 'session_update' | ..."| D["reduceDaemonSessionEvent(state, evt)"]
    C -->|"kind: 'auth_device_flow_*'"| E["reduceDaemonAuthEvent(state, evt)"]
    C -->|"kind: 'unknown'"| F["pass-through (forward-compat)"]
```

## Envelope 级元数据

除了每事件的 `data` payload，daemon 还在 envelope 上盖两个字段：

### `_meta.serverTimestamp` —— daemon 时钟

在 `formatSseFrame()`（`packages/cli/src/serve/server.ts:2602+`）的 SSE 写边界盖，**不**在 `EventBus.publish`。这样内存里的 `BridgeEvent` 类型不变，内部 daemon 消费方看不到 `_meta`，只有 wire 上的 SSE 帧带。

```jsonc
// 盖完之后 wire 上的一帧
{
  "id": 47,
  "v": 1,
  "type": "session_update",
  "data": { ... },
  "_meta": { "serverTimestamp": 1716287345123 }
}
```

merge 保留任何已有 `_meta` 键（`{...existingMeta, serverTimestamp: Date.now()}`）。**当前 daemon 没有任何生产者写 envelope 级 `_meta`** —— wenshao #4360 review 已确认 `ToolCallEmitter` 的元数据嵌在 `event.data._meta`（ACP `session/update` payload 自己的 `_meta`），不是 envelope。顶层 merge 是向前兼容逃生口。

**为什么重要**：多客户端 UI 渲「X 分钟前」或按 emit 时间排序 transcript 块时，老路径用各自本地时钟，跨浏览器 / 标签 / 手机漂几十秒到几分钟。服务端盖戳之后，所有客户端排序一致。

**SDK 访问**：3 处探针（`event.serverTimestamp` / `event._meta.serverTimestamp` / `event.data._meta.serverTimestamp`）在 chiga0 的 PR #4353 规划中。在那合入之前，SDK 消费方可以直接通过 `as any` cast 读 `event._meta?.serverTimestamp` —— wire 上字段已经在了。

### `originatorClientId`

上文事件表已经标注。带了已注册 `X-Qwen-Client-Id` 的请求触发的事件才有（规则见 [`08-session-lifecycle.md`](./08-session-lifecycle.md)）。

## Tool-call `_meta`（provenance / serverId）

跟上面 envelope 级 `_meta` 不是同一个：ACP `session/update` payload 自己也带 `_meta`，在 `event.data._meta`。`ToolCallEmitter`（`packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts`）在 `emitStart` / `emitResult` / `emitError` 上盖两个字段：

| 字段         | 类型                                       | 解析规则（`ToolCallEmitter.resolveToolProvenance`）                                                         |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `provenance` | `'builtin' \| 'mcp' \| 'subagent'`         | 有 `subagentMeta` → `subagent`（最高优先级）；tool 名匹配 `mcp__<server>__<tool>` → `mcp`；其它 → `builtin` |
| `serverId`   | `string`（仅 `provenance === 'mcp'` 时设） | 从 `mcp__<serverId>__<tool>` 命名启发提取                                                                   |

加上原本就有的 `_meta.toolName`（显示名）。

UI 据此渲染 builtin / MCP server badge / subagent 归属的 tool call，不必再去解析 tool 名字。

## SDK reducer 行为

`reduceDaemonSessionEvent(state, evt)`（`packages/sdk-typescript/src/daemon/events.ts:1100+`）把事件流投到 `DaemonSessionViewState`。三个 resync 相关字段：

- **`awaitingResync: boolean`** —— `state_resync_required` 时置 `true`；调用方代码自己清（典型路径：调 `POST /session/:id/load` 重置 view state）。
- **`resyncRequiredCount: number`** —— 观测帧计数（病态客户端可能不止一次 resync）。
- **`lastResyncRequired?: DaemonStateResyncRequiredData`** —— 最近一次 payload。

`awaitingResync = true` 期间 reducer **自动跳过** delta 应用，**只放行**封闭的 `RESYNC_PASSTHROUGH_TYPES` 集合（`packages/sdk-typescript/src/daemon/events.ts:896-902`）：

| 放行 type               | 为什么 resync 期间也要应用                                                   |
| ----------------------- | ---------------------------------------------------------------------------- |
| `state_resync_required` | 二次 resync（少见但可能）要更新 `lastResyncRequired` / `resyncRequiredCount` |
| `session_died`          | 流终态信号即便在 resync limbo 也必须可见                                     |
| `session_closed`        | 同上                                                                         |
| `client_evicted`        | 同上                                                                         |
| `stream_error`          | 同上                                                                         |

`lastEventId` 在 resync limbo 期间仍然通过 `advanceLastEventId(base)` 单调推进，调用方重置并清掉 `awaitingResync` 后，后续 delta 对齐到正确游标。

## 状态与向前兼容

- 新增已知 type → append 到 `DAEMON_KNOWN_EVENT_TYPE_VALUES`。老 SDK 看到 `kind: 'unknown'` 直接忽略；新 SDK 依赖判别式联合类型。
- 给已有 payload 加可选字段 → 安全（`{ [key: string]: unknown }` 是开的）。
- 改已有 payload 的**形状** → break；必须 bump `EVENT_SCHEMA_VERSION` 并依赖 `caps.features.typed_event_schema_v2` 之类的能力 tag 兼容。
- `id` 是每 session 单调，合成终态帧（`client_evicted`、`slow_client_warning`、`stream_error`）刻意无 id，防止其他订阅者看到序号断档。
- `originatorClientId` 在 envelope 而非 `data`。F3 的 partial-vote / forbidden payload 同时也把它盖到 `data`（`mergeOriginator`），view-state 消费方就不必保留 envelope。

## 依赖

- [`10-event-bus.md`](./10-event-bus.md) — 投递通道。
- [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) — SDK 怎么 pre-flight `typed_event_schema`、`mcp_guardrail_events`、`permission_mediation` tag。
- [`04-permission-mediation.md`](./04-permission-mediation.md) — 权限事件怎么产出。
- [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md) — `narrowDaemonEvent`、reducer、view-state 形状。

## 配置

- 默认广播：`typed_event_schema`（恒）、`mcp_guardrail_events`（恒）、`permission_mediation`（恒，`modes` 列出支持策略）。
- 没有 env / 参数直接控制 schema 本身；杀手锏 `QWEN_SERVE_NO_MCP_POOL=1` 会让 MCP 事件的 `scope` 字段从 `'workspace'` 变成 缺失 / `'session'`。

## 注意 & 已知局限

- 三种合成帧故意无 `id`，SDK 代码不能假设每个事件都有 id。
- `permission_partial_vote` 只在 `consensus` 下出现；`permission_forbidden` 在 `designated` / `consensus` / `local-only` 下出现，**不在** `first-responder` 下出现。
- `mcp_child_refused_batch` 只在 `mode: 'enforce'` 下出现，`warn` 模式从不拒绝。
- `auth_device_flow_*` 事件不是 session-keyed；通过 `DaemonSessionClient` 消费时必须走 `reduceDaemonAuthEvent`，不要走 session reducer。

## 参考

- `packages/sdk-typescript/src/daemon/events.ts`（整文件）
- `packages/acp-bridge/src/eventBus.ts:22`（`EVENT_SCHEMA_VERSION`）
- `packages/cli/src/serve/capabilities.ts:60`（`typed_event_schema`）、`:110`（`mcp_guardrail_events`）、`:211-214`（`permission_mediation`）。
- wire 参考：[`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)。
