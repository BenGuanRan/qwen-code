# Daemon side-channel coordination — Design (A1 / A2 / A4 / A5)

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Author: 秦奇. Date: 2026-05-25.
> **Docs-only / design-first.** Implementation PRs follow design-review approval.
>
> Source: cross-client real-time sync audit (2026-05-24) + PR #4484 post-merge review (the **A-series** follow-ups). The bugfix/cleanup follow-ups from the same review (D1 epoch-reset, A3 approval-mode serialization, D2/C3/D4, Provider catch-up) ship separately as the implementation PR for that batch and are **out of scope here**.

---

## 0. Scope & non-goals

In scope — four side-channel state-coordination gaps where a session-state change made on one path is invisible to other attached clients (or to peer sessions):

| #      | One-liner                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | In-session model switch (`/model`, plan-mode) never reaches the bus.                                                                                                                        |
| **A2** | In-session approval-mode change (`setMode`) emits no event; workspace visibility vs persist semantics unclear.                                                                              |
| **A4** | `permission_resolved.originatorClientId` carries the _voter_, while `permission_request.originatorClientId` carries the _prompt originator_ — ambiguous, consumers must special-case.       |
| **A5** | A client attaching via `Last-Event-ID` gets ring replay + live tail but no snapshot of current model / approval-mode / available-commands / pending-permissions; it must issue extra pulls. |

Non-goals: multimodal user-content echo (PR #4353 §D), the A3 race fix (separate PR), clientId anti-forgery (A6 — separate security track), the streamable-HTTP transport (#4472).

---

## 1. Background — the side-channel coordination invariant

The daemon already broadcasts _transcript_ deltas (assistant text, tool calls) and the HTTP-route-initiated _control_ changes (`model_switched`, `approval_mode_changed`) over each session's `EventBus`. The gap is that **the same logical state change has two entry paths** and only one of them broadcasts:

```
HTTP route  → bridge.setSessionModel / setSessionApprovalMode → publishes event  ✅
in-session  → Session.setModel / setMode (slash command, plan-mode, agent)       ❌ silent
```

The invariant we want: **every model / approval-mode / permission state transition produces exactly one bus broadcast regardless of which path initiated it**, and **a freshly attached client can reconstruct current side-channel state without out-of-band pulls**.

The agent already has the right primitive for the in-session direction: ACP `sessionUpdate` notifications. `current_mode_update` exists today (`Session.ts:1646`) but is wired only to the `exit_plan_mode` path (`Session.ts:2155`), not to the generic `setMode` / `setModel` entry points.

---

## 2. A1 — in-session model switch on the bus

### Problem

`Session.setModel` (`Session.ts:1580`) calls `config.switchModel()` (`:1601`) and returns — it emits no `sessionUpdate`. Only the HTTP path `bridge.setSessionModel` (`bridge.ts:2798`) publishes `model_switched`. So a `/model` slash command, a plan-mode-driven switch, or any agent-internal model change is **invisible to peer clients** — their model badge silently drifts. There is no `current_model_update` sessionUpdate type at all today.

### Proposed design

1. Add an ACP `current_model_update` sessionUpdate (mirrors `current_mode_update`): `{ sessionUpdate: 'current_model_update', currentModelId: string, authType?: string }`.
2. Emit it from `Session.setModel` after `switchModel` resolves (one helper `sendCurrentModelUpdateNotification`, symmetric to `sendCurrentModeUpdateNotification`).
3. The bridge maps an inbound `current_model_update` sessionUpdate to the **existing** `model_switched` bus event and fans it out (with `originatorClientId` from the active prompt's originator when known).
4. **Converge to one source of truth.** The HTTP `setSessionModel` path's `unstable_setSessionModel` already runs inside the agent, which (after this change) emits `current_model_update`. So the bridge should publish `model_switched` from the **notification path only** and stop the separate post-roundtrip publish in `setSessionModel` — otherwise an HTTP switch double-broadcasts (once from the route, once from the agent notification). This is the central design decision: the agent becomes the single emitter; the HTTP route just drives the agent and lets the notification carry the broadcast.

### Alternatives

- **agent→bridge side-channel callback** (extNotification) instead of a sessionUpdate. Rejected: `current_mode_update` already establishes the sessionUpdate pattern; reusing it keeps the two control axes (mode, model) symmetric and avoids a second mechanism.

### Wire / compat

Additive sessionUpdate; pre-rename SDKs ignore unknown `sessionUpdate` values. SDK consumers continue to see the existing `model_switched` bus event — **no SDK change required** for basic correctness. (Optional: SDK could surface `authType` if present.)

### Risk

Double-broadcast on the HTTP path (mitigated by item 4 — pick the agent as the single emitter and remove the route-side publish). Needs a test that an HTTP `POST /session/:id/model` yields exactly one `model_switched`.

---

## 3. A2 — in-session approval-mode change + workspace-visibility semantics

### Problem

Two distinct issues:

1. **Silent in-session change.** `Session.setMode` (`Session.ts:1561`) calls `config.setApprovalMode()` (`:1573`) and returns — unlike the exit_plan_mode path it does **not** call `sendCurrentModeUpdateNotification`. So an in-session approval-mode change (e.g. an `/approval-mode` slash command) reaches neither peer clients of the same session nor the bridge. Symmetric to A1.
2. **Workspace visibility vs persist.** `bridge.setSessionApprovalMode` workspace-broadcasts only when `persist=true`; a non-persisted change publishes only on the originating session's own bus. Whether peer _sessions_ in the same workspace should see a non-persisted change is currently undefined-by-omission.

### Proposed design

1. **Fix the in-session gap (the real bug):** emit `current_mode_update` from `Session.setMode`, so the change flows to the bridge and gets published as `approval_mode_changed` on the session bus — same treatment as the HTTP path. Reuse the existing `sendCurrentModeUpdateNotification` machinery (generalize it to take an explicit mode rather than deriving from a tool outcome).
2. **Affirm + document the persist/visibility split** rather than change it:
   - **Session-scoped broadcast** (peers attached to the _same_ session) fires on **every** change — they are viewing the same session, so they must always reflect its current mode.
   - **Workspace-scoped broadcast** (peer _different_ sessions) stays gated on `persist=true`, because only a persisted change becomes those sessions' future default; a transient per-session mode is per-ACP-spec session-local and would mislead a peer session that didn't change.
   - Encode this explicitly in the `approval_mode_changed` doc + a `scope: 'session' | 'workspace'` discriminator on the payload so consumers stop inferring it.

### Alternatives

- Always workspace-broadcast (drop the persist gate). Rejected: leaks a session-local transient mode to peer sessions, contradicting ACP's per-session approval semantics.

### Wire / compat

Item 1 is additive (reuses `current_mode_update`). Item 2's `scope` field is additive; existing consumers ignore it.

### Risk

Low. Main care: don't double-emit when an HTTP `setSessionApprovalMode` already publishes and the agent's `setMode` notification would also publish — same single-emitter convergence decision as A1 (§2 item 4) applies. Coordinate with the A3 serialization PR (shared code path).

---

## 4. A4 — `permission_resolved` originator/voter semantics

### Problem

`permission_request.originatorClientId` = the **prompt originator**. `permission_resolved.originatorClientId` = the **voter** (`permissionMediator.ts:1124-1134`, stamped from `vote.clientId` for O8 pre-F3 wire compat). A consumer correlating the two events must special-case `permission_resolved` to know its `originatorClientId` means something different. The inconsistency is currently load-bearing wire shape (changing it is breaking).

### Proposed design (non-breaking)

Add a dedicated, unambiguous field on `permission_resolved` and **deprecate the overloaded one** without removing it:

- Emit `voterClientId` (canonical) alongside the existing `originatorClientId` (kept as a deprecated alias, same value) on `permission_resolved`.
- SDK normalizer reads `voterClientId ?? originatorClientId` and exposes it as `voterClientId` in the typed UI event; the prompt originator stays available via correlation with the matching `permission_request`.
- Document the deprecation: `originatorClientId` on `permission_resolved` is frozen for back-compat and will not change meaning; new consumers use `voterClientId`.

### Alternatives

- **Unify semantics** (make `permission_resolved.originatorClientId` carry the prompt originator). Rejected: breaking wire change; pre-F3 consumers rely on the voter value.

### Wire / compat

Purely additive — old consumers keep reading `originatorClientId`; new consumers prefer `voterClientId`. Mirrors the D4 `lastReplayedEventId` aliasing pattern already accepted in the bugfix PR.

### Risk

Minimal. One audit point: any internal bridge/audit code reading `permission_resolved.originatorClientId` should be migrated to `voterClientId` for clarity (behavior unchanged).

---

## 5. A5 — attach-time side-channel snapshot

### Problem

A client attaching with `Last-Event-ID` (incl. `0`) gets ring replay + live tail, but **not** a snapshot of current side-channel state: approval mode, model, available commands, pending permissions. Today it must issue extra pulls (`requestSessionStatus` → `qwen/status/session/context` (`status.ts:96`), supported-commands, `POST /load`). `replay_complete` (added in #4484) tells the client _when_ it has caught up on the transcript, but not _what_ the current side-channel state is.

### Proposed design

Emit a single synthetic **`session_snapshot`** frame at subscribe time, before replay (id-less, same no-burn pattern as `state_resync_required` / `replay_complete`):

```
session_snapshot {
  approvalMode, model, availableCommands?, pendingPermissionIds?
}
```

- Built from the same sources the pull endpoints read, captured at subscribe time.
- Ordering: `session_snapshot` → (optional `state_resync_required`) → replay frames → `replay_complete`. The snapshot is the baseline; subsequent `*_changed` deltas refine it.
- SDK: normalize to a typed `session.snapshot` UI event that seeds the view-state reducer's side-channel fields, so a fresh attach renders correct mode/model immediately without a pull.

### Alternatives

- **Document the pull contract only** (no snapshot frame): client issues `GET context` + supported-commands after `replay_complete`. Lower effort, but keeps the extra round-trips and a window where the UI shows stale/empty side-channel state. Acceptable as a _phase 1_ if the snapshot frame is deferred.

### Wire / compat

Additive synthetic frame; unknown-type frames are already ignored by SDKs (`asKnownDaemonEvent → undefined`). Opt-in via a subscribe flag (`?snapshot=1`) if we want to avoid the cost for clients that don't need it.

### Risk

Snapshot captured at subscribe time could be marginally stale vs the first live delta — acceptable because deltas refine it and ordering guarantees the snapshot precedes them. Cost: one extra status read per attach (gate behind the opt-in flag for high-churn anonymous attaches).

---

## 6. Cross-cutting

- **Single-emitter convergence (A1+A2).** The recurring decision: when both an HTTP route and an in-session notification can publish the same control event, make the **agent notification the single source** and have the HTTP route drive the agent without separately publishing. This removes double-broadcast risk and is the cleanest invariant. Requires touching `bridge.setSessionModel` / `setSessionApprovalMode` publish sites.
- **Additive-alias pattern (A4).** Same shape as the accepted D4 `lastReplayedEventId` rename: emit canonical + deprecated alias, SDK prefers canonical. Keeps every change non-breaking.
- **SDK reducer.** A1/A2 need no SDK change for basic correctness (reuse `model_switched` / `approval_mode_changed`); A4/A5 add typed fields/events the `reduceDaemonSessionEvents` view-state reducer should consume.

---

## 7. Sequencing

1. **A4** (smallest, purely additive alias) — land first.
2. **A1 + A2** together (shared single-emitter convergence in the bridge + symmetric `current_*_update` emits in `Session`).
3. **A5** — phase 1 documents the pull contract; phase 2 adds the opt-in `session_snapshot` frame.

Each lands as its own implementation PR after this design is approved.

---

## 8. Test plan

- **A1:** in-session `/model` switch publishes exactly one `model_switched`; HTTP `POST /session/:id/model` publishes exactly one (no double); peer subscriber observes the change.
- **A2:** in-session `setMode` publishes `approval_mode_changed` on the session bus; non-persisted change does NOT workspace-broadcast to peer sessions; persisted change does; `scope` field correct on both.
- **A4:** `permission_resolved` carries both `voterClientId` and `originatorClientId` with the voter value; SDK normalizer surfaces `voterClientId`; correlation with `permission_request` still yields the prompt originator.
- **A5:** attach with `?snapshot=1` yields a `session_snapshot` before replay with correct mode/model/pending-permissions; ordering snapshot → resync? → replay → replay_complete; SDK seeds side-channel state from it.

---

## 9. Open questions

1. **A1/A2 emitter ownership:** confirm the agent can always emit `current_model_update` / `current_mode_update` for HTTP-initiated changes too (so the route can drop its own publish), or whether some HTTP paths bypass the agent and must keep publishing.
2. **A5 default:** snapshot opt-in (`?snapshot=1`) vs always-on. Lean opt-in to protect anonymous/high-churn attaches.
3. **A2 `scope` field:** new discriminator vs documenting the existing implicit behavior only.
