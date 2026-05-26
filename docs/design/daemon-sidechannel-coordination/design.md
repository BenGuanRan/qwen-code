# Daemon side-channel coordination — Design (A1 / A2 / A4 / A5)

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Author: 秦奇. Date: 2026-05-25. Revised: 2026-05-26 (v2 — review fold-ins).
> **Docs-only / design-first.** Implementation PRs follow design-review approval.
>
> Source: cross-client real-time sync audit (2026-05-24) + PR #4484 post-merge review (the **A-series** follow-ups). The bugfix/cleanup follow-ups from the same review (D1 epoch-reset, A3 approval-mode serialization, D2/C3/D4, Provider catch-up) ship separately (PR #4510) and are **out of scope here**.

## Changelog

### v2 (2026-05-26) — review fold-ins (wenshao 4×Critical + 2×Suggestion, doudouOUC, Copilot 3×)

- **A1/A2 are NOT symmetric** — verified the two HTTP paths route differently into the agent. A1's `POST /model` goes through `Session.setModel`; A2's `POST /approval-mode` uses a separate extMethod that calls `config.setApprovalMode` directly, bypassing `Session.setMode`. The "single-emitter convergence" can't be applied uniformly. §3 rewritten; §6 split; §9 OQ1 **resolved** with a decision table (was an internal contradiction).
- **Demux contract added (§2.1)** — the bridge publishes every `sessionUpdate` notification as a generic `session_update` bus event; there is no sub-type demux today. A1's "map to `model_switched`" requires a new demux layer, with explicit rules for promotion + generic-wrapper suppression. `current_mode_update` already flows through this path generically.
- **A5 `pendingPermissionIds` removed** from the snapshot — it created an authorization gap (a freshly-attached client could vote on a request it never saw the context for). Snapshot now carries only mode/model/commands.
- **Anchor hygiene** — all anchors now use full `packages/...` paths. Note: `packages/acp-bridge/src/bridge.ts` (3923 LOC) and `permissionMediator.ts` (1291 LOC) are the **real** implementations (confirmed by doudouOUC); `packages/cli/src/serve/httpAcpBridge.ts` is a 101-line re-export shim — do not anchor against it.
- `current_mode_update` correctly noted as wired to **two** callers (exit_plan_mode + edit-tool `ProceedAlways`), not one.
- `voterClientId` specified **optional** (no-voter resolutions omit it); unknown-event compat note corrected (SDK surfaces them as `debug`, not silent).

---

## 0. Scope & non-goals

In scope — four side-channel state-coordination gaps where a session-state change made on one path is invisible to other attached clients (or to peer sessions):

| #      | One-liner                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | In-session model switch (`/model`, plan-mode) never reaches the bus.                                                                                                  |
| **A2** | In-session approval-mode change (`setMode`) emits no event; the HTTP path uses a different agent entry point; workspace-vs-persist visibility unclear.                |
| **A4** | `permission_resolved.originatorClientId` carries the _voter_, while `permission_request.originatorClientId` carries the _prompt originator_ — ambiguous.              |
| **A5** | A client attaching via `Last-Event-ID` gets ring replay + live tail but no snapshot of current model / approval-mode / available-commands; it must issue extra pulls. |

Non-goals: multimodal user-content echo (PR #4353 §D), the A3 race fix (PR #4510), clientId anti-forgery (A6 — separate security track), the streamable-HTTP transport (#4472).

**Anchor convention:** all file references use full repo-root paths. The bridge lives at `packages/acp-bridge/src/bridge.ts`; the agent at `packages/cli/src/acp-integration/acpAgent.ts`; the session at `packages/cli/src/acp-integration/session/Session.ts`.

---

## 1. Background — the side-channel coordination invariant

The daemon already broadcasts _transcript_ deltas (assistant text, tool calls) and the HTTP-route-initiated _control_ changes (`model_switched`, `approval_mode_changed`) over each session's `EventBus`. The gap is that **the same logical state change has two entry paths** and only one of them broadcasts:

```
HTTP route  → bridge.setSessionModel / setSessionApprovalMode → publishes event  ✅
in-session  → Session.setModel / setMode (slash command, plan-mode, agent)       ❌ silent
```

The invariant we want: **every model / approval-mode / permission state transition produces exactly one bus broadcast regardless of which path initiated it**, and **a freshly attached client can reconstruct current side-channel state without out-of-band pulls**.

The agent already has a primitive for the in-session direction: ACP `sessionUpdate` notifications. `current_mode_update` exists today (`Session.ts:1645`, helper `sendCurrentModeUpdateNotification` at `Session.ts:1625`) but is wired only to **agent-tool confirmation paths** — `exit_plan_mode` (`Session.ts:2160`) and the edit-tool `ProceedAlways` path (`Session.ts:2168`). It is **not** wired to the generic `Session.setMode` / `Session.setModel` entry points, and there is no `current_model_update` type at all.

---

## 2. A1 — in-session model switch on the bus

### Problem

`Session.setModel` (`packages/cli/src/acp-integration/session/Session.ts:1580`) calls `config.switchModel()` (`:1601`) and returns — it emits no `sessionUpdate`. Only the bridge's HTTP path publishes `model_switched` (`packages/acp-bridge/src/bridge.ts:2883`; also `:1172` for the `applyModelServiceId` path). So a `/model` slash command, a plan-mode-driven switch, or any agent-internal model change is **invisible to peer clients** — their model badge silently drifts. There is no `current_model_update` sessionUpdate type today.

### Proposed design

1. Add an ACP `current_model_update` sessionUpdate (mirrors `current_mode_update`): `{ sessionUpdate: 'current_model_update', currentModelId: string, previousModelId?: string, authType? }`.
2. Emit it from `Session.setModel` after `switchModel` resolves (a `sendCurrentModelUpdateNotification` helper, symmetric to `sendCurrentModeUpdateNotification`).
3. The bridge **demuxes** the inbound `current_model_update` sub-type and re-publishes it as the existing `model_switched` bus event (see §2.1 for the demux contract), stamping `originatorClientId` from the active prompt's originator when known.
4. **Single-emitter (A1 only — safe here).** Verified: the HTTP `POST /session/:id/model` path drives `unstable_setSessionModel` (`acpAgent.ts:925`) → `session.setModel` (`acpAgent.ts:935`). So **both** the in-session and HTTP paths flow through `Session.setModel`. Emitting from there covers both; the bridge's separate post-roundtrip `model_switched` publish in `setSessionModel` is then removed to avoid a double-broadcast. (This is **not** transferable to A2 — see §3.)

### 2.1 Demux contract (prerequisite for A1 and A2)

Today the bridge's `sessionUpdate` handler publishes **every** notification verbatim as a generic `session_update` bus event (`packages/acp-bridge/src/bridge.ts:352`); it does **not** demux by `sessionUpdate` sub-type into named events. Promoting `current_model_update` / `current_mode_update` to `model_switched` / `approval_mode_changed` therefore requires a new demux layer with an explicit contract:

- **Promotion table.** A fixed map of `sessionUpdate` sub-type → named bus event: `current_model_update → model_switched`, `current_mode_update → approval_mode_changed`.
- **Generic-wrapper suppression.** For a promoted sub-type, the bridge publishes the named event **only** — it does **not** also publish the generic `session_update`. Otherwise consumers see both (double event).
- **Compat call-out.** `current_mode_update` **already** flows through this handler today (from the tool-confirmation paths) and currently reaches SDK consumers as a generic `session_update`. Promoting it changes the event type existing listeners observe — this is a deliberate, documented behavior change, not silent. SDK normalizer + reducer must be updated in lockstep.
- **Unknown sub-types.** Continue to pass through as generic `session_update` (default, unchanged).

### Wire / compat

Additive sessionUpdate; pre-rename agents simply never send it. SDK consumers see the existing `model_switched` event — but note the demux compat call-out above for `current_mode_update`.

### Risk

Double-broadcast on the HTTP path (mitigated by item 4 + the §2.1 suppression rule). Test: an HTTP `POST /session/:id/model` yields exactly one `model_switched`, and the generic `session_update` is suppressed for the promoted sub-type.

---

## 3. A2 — in-session approval-mode change (asymmetric to A1)

### Problem

Two issues, and a structural asymmetry that breaks the A1 recipe:

1. **Silent in-session change.** `Session.setMode` (`Session.ts:1561`) calls `config.setApprovalMode()` (`:1573`) and returns — it does **not** call `sendCurrentModeUpdateNotification`. So an in-session approval-mode change reaches neither peer clients of the same session nor the bridge.
2. **The HTTP path bypasses `Session.setMode`.** Unlike A1, the bridge's `setSessionApprovalMode` drives a **separate extMethod** `qwen/control/session/approval_mode` (`acpAgent.ts:2200`) which calls `config.setApprovalMode()` **directly** (`acpAgent.ts:2228`) — it does **not** go through `Session.setMode`. Therefore "emit from `Session.setMode` + remove the bridge publish" (the A1 recipe) would leave **HTTP-initiated approval changes emitting nothing at all** — a regression.
3. **Workspace-vs-persist.** The bridge workspace-broadcasts only when `persist=true` (`bridge.ts:3007`); the session-scoped publish (`bridge.ts:2979`) fires unconditionally. `persist` is a bridge-level concept the agent has no knowledge of.

### Proposed design

**Session-scoped visibility (both entry points must emit):**

1. Emit `current_mode_update` from `Session.setMode` (covers the ACP `setSessionMode` path, `acpAgent.ts:922`).
2. **Also** emit it for the HTTP extMethod path — either route `acpAgent.ts:2228` through `Session.setMode` instead of calling `config.setApprovalMode` directly, or add the emit in the extMethod handler. Both agent entry points must produce the notification.
3. Enrich the payload: `{ currentModeId, previousModeId }`. The bridge's `approval_mode_changed` bus event needs `{ previous, next, persisted }`; `previousModeId` supplies `previous`, `currentModeId` supplies `next`.

**Workspace-scoped visibility stays at the bridge (NOT single-emitter):**

4. The persist + workspace broadcast (`bridge.ts:3007`) remains a **bridge-level** publish gated on the bridge's own `persist` flag — the agent has no `persist` concept, so this cannot move to the notification path. `persisted` is therefore set only on the workspace-scoped event, by the bridge.
5. Document the split explicitly with a `scope: 'session' | 'workspace'` discriminator on `approval_mode_changed`:
   - **session-scoped** fires on every change (same-session peers must always reflect current mode);
   - **workspace-scoped** fires only on `persist=true` (only then does it become peer _sessions_' future default; a transient per-session mode is ACP-spec session-local and would mislead a peer session that didn't change).

### Alternatives

- Always workspace-broadcast (drop the persist gate). Rejected: leaks a session-local transient mode to peer sessions.
- Force the HTTP path through `Session.setMode` _and_ remove the bridge publish entirely (full A1 symmetry). Rejected: loses the persist/workspace distinction, which only the bridge can make.

### Wire / compat

Additive: `current_mode_update` reuse + `previousModeId` + `scope`. Coordinate with PR #4510 (shared approval-mode code path / `approvalModeQueue`).

### Risk

Medium — the dual emit must be deduped against the bridge's session-scoped publish so a single HTTP change doesn't emit twice on the session bus. The demux suppression (§2.1) plus removing the bridge's session-scoped publish (while keeping the workspace one) is the intended end state. Test matrix in §8.

---

## 4. A4 — `permission_resolved` originator/voter semantics

### Problem

`permission_request.originatorClientId` = the **prompt originator**. `permission_resolved.originatorClientId` = the **voter** (`packages/acp-bridge/src/permissionMediator.ts:1125` emit, stamped from the `resolverClientId` param at `:1143`, itself the voter's trusted clientId for O8 pre-F3 wire compat). A consumer correlating the two events must special-case `permission_resolved`. The inconsistency is load-bearing wire shape (changing it is breaking).

### Proposed design (non-breaking)

- Emit `voterClientId` (canonical) alongside the existing `originatorClientId` on `permission_resolved`, **both optional and carrying the same value**.
- **No-voter resolutions** (timer-driven expiry, session-closed, or a loopback voter with no `X-Qwen-Client-Id`) carry **neither** field — matching today's behavior where `originatorClientId` is omitted entirely. `voterClientId` is therefore `string | undefined`; consumers must handle its absence (a system-initiated resolution).
- SDK normalizer reads `voterClientId ?? originatorClientId` and exposes it as optional `voterClientId`; the prompt originator stays available via correlation with the matching `permission_request`.
- Document: `originatorClientId` on `permission_resolved` is frozen for back-compat; new consumers use `voterClientId`.

### Alternatives

- **Unify semantics** (make `permission_resolved.originatorClientId` carry the prompt originator). Rejected: breaking; pre-F3 consumers rely on the voter value.

### Wire / compat

Purely additive. Mirrors the D4 `lastReplayedEventId` aliasing pattern accepted in PR #4510.

### Risk

Minimal. Audit point: internal bridge/audit code reading `permission_resolved.originatorClientId` migrates to `voterClientId` for clarity (behavior unchanged).

---

## 5. A5 — attach-time side-channel snapshot

### Problem

A client attaching with `Last-Event-ID` (incl. `0`) gets ring replay + live tail, but **not** a snapshot of current side-channel state: approval mode, model, available commands. Today it must issue extra pulls (`requestSessionStatus` → `qwen/status/session/context`, `packages/acp-bridge/src/status.ts:96`; supported-commands; `POST /load`). `replay_complete` (#4484) says _when_ the transcript caught up, not _what_ the current side-channel state is.

### Proposed design

Emit a single synthetic **`session_snapshot`** frame at subscribe time, before replay (id-less, same no-burn pattern as `state_resync_required` / `replay_complete`):

```
session_snapshot { approvalMode, model, availableCommands? }
```

- **`pendingPermissionIds` is deliberately excluded** (see Security below).
- Built from the same sources the pull endpoints read, captured at subscribe time.
- Ordering: `session_snapshot` → (optional `state_resync_required`) → replay frames → `replay_complete`. The snapshot is the baseline; subsequent `*_changed` deltas refine it.
- SDK: normalize to a typed `session.snapshot` UI event that seeds the view-state reducer's side-channel fields, so a fresh attach renders correct mode/model immediately.

### Security: why no `pendingPermissionIds`

Including pending request IDs in the snapshot would let a freshly-attached client immediately vote (`POST /session/:id/permission/:requestId`) on a request whose **context it never received** — `respondToSessionPermission` validates session/pending-state/option-legality but does **not** verify the voter ever observed the original `permission_request`. Under the `first-responder` policy a collaborator could attach, read a pending ID from the snapshot, and approve a destructive operation the original user was about to deny. A client that legitimately needs pending permissions learns them from replay (if still in the ring) where the full `permission_request` context travels with them.

### Alternatives

- **Document the pull contract only** (no snapshot frame): client pulls `GET context` + supported-commands after `replay_complete`. Lower effort; keeps the round-trips + a stale-UI window. Acceptable as **phase 1** if the frame is deferred.

### Wire / compat

Additive synthetic frame, **opt-in** via a subscribe flag (`?snapshot=1`). Note: an old SDK does not silently ignore an unknown frame — the UI normalizer's default case turns it into a `debug` UI event (`packages/sdk-typescript/src/daemon/ui/normalizer.ts`). That won't break, but it surfaces as debug noise, which is an additional reason to keep the frame opt-in.

### Risk

Snapshot captured at subscribe time may be marginally stale vs the first live delta — acceptable, since deltas refine it and ordering guarantees the snapshot precedes them. Cost: one status read per opted-in attach.

---

## 6. Cross-cutting

- **Single-emitter applies to session-scoped broadcast only, and only where the HTTP path flows through the agent's `Session.*` method.** Verified asymmetry: A1's HTTP path goes through `Session.setModel` (single-emitter safe); A2's HTTP path uses a separate extMethod bypassing `Session.setMode` (needs a dedicated emit at that handler). **Workspace-scoped** broadcast (A2 persist) stays a bridge-level publish — the agent has no `persist` concept.
- **Demux contract (§2.1) is a hard prerequisite** for A1/A2: without it, promoting a sessionUpdate sub-type either double-publishes (generic + named) or never promotes.
- **Additive-alias pattern (A4, D4).** Emit canonical + deprecated alias; SDK prefers canonical. Every change non-breaking.
- **SDK reducer.** A1 needs the demux + normalizer/reducer update for the promoted `current_mode_update` type change; A4/A5 add typed fields/events the `reduceDaemonSessionEvents` view-state reducer consumes.

---

## 7. Sequencing

1. **A4** (smallest, purely additive alias) — land first.
2. **§2.1 demux layer + A1** — the demux contract, then `current_model_update` emit + promotion + generic-wrapper suppression + SDK update.
3. **A2** — both-entry-point emit (incl. the extMethod handler change), `previousModeId`, `scope` field, retain the bridge workspace publish.
4. **A5** — phase 1 documents the pull contract; phase 2 adds the opt-in `session_snapshot` frame.

Each lands as its own implementation PR after this design is approved.

---

## 8. Test plan

- **Demux (§2.1):** a promoted sub-type publishes the named event and **suppresses** the generic `session_update`; an unknown sub-type still publishes generic.
- **A1:** in-session `/model` publishes exactly one `model_switched`; HTTP `POST /session/:id/model` publishes exactly one (no double); peer subscriber observes it.
- **A2:** in-session `setMode` AND HTTP `POST /approval-mode` each publish a session-scoped `approval_mode_changed` (`scope:'session'`); non-persisted change does NOT workspace-broadcast; persisted change emits an additional `scope:'workspace'` event; no double-emit on the session bus.
- **A4:** voter resolution carries `voterClientId` (= `originatorClientId`); timer/no-clientId resolution carries neither; SDK surfaces optional `voterClientId`; correlation with `permission_request` still yields the prompt originator.
- **A5:** attach with `?snapshot=1` yields a `session_snapshot` (mode/model/commands, **no** pendingPermissionIds) before replay; ordering snapshot → resync? → replay → replay_complete; SDK seeds side-channel state.

---

## 9. Resolved decisions

**Emitter ownership (resolves the former Open Question — verified against code):**

| HTTP / in-session entry           | agent path                                                                   | flows through `Session.*`?        | session-scoped emit source                      | workspace publish                          |
| --------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `POST /session/:id/model`         | `unstable_setSessionModel` (`acpAgent.ts:925`) → `session.setModel` (`:935`) | ✅ `Session.setModel`             | agent `current_model_update`                    | n/a                                        |
| in-session `/model`               | `Session.setModel` directly                                                  | ✅                                | agent `current_model_update`                    | n/a                                        |
| ACP `setSessionMode`              | `acpAgent.ts:922` → `session.setMode`                                        | ✅ `Session.setMode`              | agent `current_mode_update` (to add)            | n/a                                        |
| `POST /session/:id/approval-mode` | extMethod `acpAgent.ts:2200` → `config.setApprovalMode` (`:2228`)            | ❌ **bypasses** `Session.setMode` | **emit must be added at the extMethod handler** | bridge, `persist`-gated (`bridge.ts:3007`) |

Conclusion: A1 can drop the bridge-side publish (agent is sole session-scoped emitter). A2 must add an emit at the extMethod handler AND retain the bridge's workspace-scoped publish.

## 10. Open questions

1. **A2 extMethod emit placement:** route `acpAgent.ts:2228` through `Session.setMode`, or add a parallel `current_mode_update` emit in the extMethod handler? The former is DRY-er but changes the call graph; the latter is more local. Lean toward routing through `Session.setMode` for symmetry, pending a check that `Session.setMode`'s ApprovalMode mapping covers every value the extMethod accepts.
2. **A5 default:** snapshot opt-in (`?snapshot=1`) vs always-on. Lean opt-in (the `debug`-noise + status-read cost on anonymous/high-churn attaches).
3. **A2 `scope` field:** new discriminator vs documenting the implicit behavior only. Lean toward the explicit field.
