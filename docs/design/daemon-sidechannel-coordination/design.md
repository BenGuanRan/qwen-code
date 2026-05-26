# Daemon side-channel coordination — Design (A1 / A2 / A4 / A5)

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Author: 秦奇. Date: 2026-05-25. Revised: 2026-05-26 (v5 — fourth review round).
> **Docs-only / design-first.** Implementation PRs follow design-review approval. A4 already implemented + approved (PR #4539).
>
> Source: cross-client real-time sync audit (2026-05-24) + PR #4484 post-merge review (the **A-series** follow-ups). The bugfix/cleanup follow-ups from the same review ship separately (PR #4510) and are **out of scope here**.

## Changelog

### v6 (2026-05-26) — fifth review round (wenshao 2×Critical + 4×Suggestion)

- **Timeout-race + intervening change (Critical):** "later event is authoritative" was wrong when a change B intervenes — a stale late `current_model_update(A)` would promote after `model_switched(B)`. Replaced with a **staleness check**: the demux promotes a `current_model_update` only if its `currentModelId` equals the agent's actual current model at promotion time; stale notifications are dropped. §2 item 4 / §2.1.
- **`previousModeId` made MANDATORY (Critical):** the SDK normalizer `normalizeApprovalModeChanged` (`normalizer.ts:754`) requires `previous` or it `fallbackDebug`-drops the event. An optional `previousModeId` would silently eat in-session approval-mode changes. §3.
- **Suppress is now per-change-type, not per-session:** a model roundtrip must not suppress an in-session `current_mode_update` (and vice-versa). §2.1.
- **`current_model_update` payload:** dropped the undefined `authType?` (dead data — `model_switched` is `{sessionId,modelId}`); `previousModelId` stays optional (the `model_switched` normalizer needs only `modelId`). §2.
- Fixed two text/cross-ref errors that wrote `current_mode_update` (A2) where `current_model_update` (A1) was meant. §2 wire/compat, §6.

### v5 (2026-05-26) — fourth review round (wenshao 2×Critical + 8×Suggestion)

- **Concurrent-in-session-`/model` drift (Critical) → reconciliation rule.** Drop-when-suppressed can drop an in-session `/model B` that fires during a bridge `setSessionModel(A)` roundtrip (in-session `/model` bypasses `modelChangeQueue`), leaving the bus on A while the session runs B. Added §2.2: on roundtrip settle the bridge **reconciles** — re-reads the agent's current model and emits a corrective `model_switched` if it diverges from what it published.
- **IDE-companion lockstep (Critical) → one-release dual-emit transition.** Promotion can't flip atomically (daemon vs Marketplace ship channels), and the upstream dispatch (`daemonIdeConnection.ts`, `DaemonChannelBridge.ts`) drops unknown event types before they reach the handler. Added a **dual-emit transition window** (publish BOTH generic `session_update` and the promoted named event for one release) and enumerated the upstream dispatch sites as affected (§2.1, §6).
- **`model_switched` payload mapping specified** — `currentModelId → modelId`, envelope `sessionId → data.sessionId`; without it the SDK validator (`events.ts:1910`, requires non-empty `modelId`) drops every promoted event (A1 non-functional). §2.1.
- **Demux observability required** — structured log at every decision point (promoted / dropped / suppressed / generic). §2.1.
- **`replay_complete` correction** — it **does** exist (`eventBus.ts:444`, shipped by merged #4484); the reviewer's "zero matches" was against a stale tree. A5 phase 2 depends on the new `session_snapshot` frame, not on introducing `replay_complete`. §5/§7.
- **First-attach no longer synthesizes `replay_complete{0}`** (would widen that event's contract for existing "replaying→live" consumers) — the snapshot is self-delimiting on first attach. §5.
- **Capture-at-emission tightened** — snapshot field reads + publish MUST be one synchronous block (no `await` between), else the stale-overwrite window reopens. §5.
- **Helper migration model + Q3 resolved** (keep the extMethod bypass — §1.1 holds); A4 distinguishing test added (done in #4539). §3, §8, §9.

### v4 (2026-05-26) — third review round (wenshao 2×Critical + 9×Suggestion, Copilot 5×)

- **Demux insertion point corrected** — the generic `sessionUpdate → session_update` forwarding is in `packages/acp-bridge/src/bridgeClient.ts:397` (`BridgeClient.sessionUpdate()`), **not** `bridge.ts:352` (that's the prompt-echo). The §2.1 demux hook lives in `bridgeClient.ts`. Added a **third demux rule**: a promotion blocked by an in-flight roundtrip is **dropped**, not published as generic `session_update` (else the bridge's authoritative event + the generic wrapper double-signal).
- **`approvalModeQueue` does not exist yet** — it ships in PR #4510. A2's suppress window depends on a per-session in-flight tracker, so A2 is now marked a **hard prerequisite on #4510** (§3, §7), not a soft "coordinate".
- **A2 HTTP path emits no agent notification** (it bypasses `Session.setMode` via the extMethod) → the bridge is the **sole** emitter there; "suppress-during-roundtrip" applies to the **model** path only. §1.1 / §9 corrected.
- **Step-2 demux covers `current_model_update` only.** `current_mode_update` promotion is deferred to step 3 (needs `previousModeId`); until then it keeps flowing as generic `session_update` (no regression).
- **A5 snapshot stale-overwrite fixed** — capture the snapshot **at emission time (after `replay_complete`)**, not at subscribe time, so a live delta delivered during replay isn't overwritten by a stale snapshot. First-attach ordering defined.
- **Not "additive everywhere"** — promoting `current_mode_update` is a lockstep change; `packages/vscode-ide-companion/.../qwenSessionUpdateHandler.ts:177` is a named affected consumer.
- **`previousModeId` capture point specified**; helper-generalization detailed; persist-scope description corrected (`getPersistScopeForModelSelection` → workspace or user); security enumeration completed (`resolveTrustedClientId`); test plan + anchors fixed.

### v3 (2026-05-26) — second round

Reframed to the bridge-authoritative model (§1.1, not single-emitter); A1 three publish sites + `model_switch_failed` carve-out + timeout-race; explicit A1 workspace-mirror decision; `previousModeId`; A4 exposes both SDK fields; A5 snapshot after `replay_complete`; expanded tests.

### v2 (2026-05-26) — first round

A1/A2 asymmetry; §2.1 demux contract; §9 table; A5 `pendingPermissionIds` removed; anchor hygiene; `voterClientId` optional.

---

## 0. Scope & non-goals

Four side-channel state-coordination gaps where a session-state change on one path is invisible to other attached clients (or peer sessions):

| #      | One-liner                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | In-session model switch (`/model`, plan-mode) never reaches the bus.                                                                                        |
| **A2** | In-session approval-mode change (`setMode`) emits no event; the HTTP path uses a different agent entry point; workspace-vs-persist visibility unclear.      |
| **A4** | `permission_resolved.originatorClientId` carries the _voter_, while `permission_request.originatorClientId` carries the _prompt originator_ — ambiguous.    |
| **A5** | A client attaching via `Last-Event-ID` gets ring replay + live tail but no snapshot of current model / approval-mode / commands; it must issue extra pulls. |

Non-goals: multimodal user-content echo (PR #4353 §D), the A3 race fix (PR #4510), clientId anti-forgery (A6), the streamable-HTTP transport (#4472).

**Anchor convention:** full repo-root paths.

- **`packages/acp-bridge/src/bridgeClient.ts`** — the ACP→bus client; `sessionUpdate()` forwards agent notifications to the EventBus (the demux insertion point).
- **`packages/acp-bridge/src/bridge.ts`** — the 3923-LOC orchestrator (HTTP control methods, publish sites). `packages/cli/src/serve/httpAcpBridge.ts` is a 101-LOC re-export shim — not an anchor target.
- **`packages/acp-bridge/src/permissionMediator.ts`** — permission voting/resolution.
- **`packages/cli/src/acp-integration/acpAgent.ts`** / **`.../session/Session.ts`** — agent + session.

---

## 1. Background — the side-channel coordination invariant

The daemon broadcasts _transcript_ deltas and HTTP-route-initiated _control_ changes (`model_switched`, `approval_mode_changed`). The gap: **the same logical change has two entry paths and only the HTTP one broadcasts** for slash/plan-mode changes.

`current_mode_update` exists today (`Session.ts:1645`; helper `sendCurrentModeUpdateNotification` at `Session.ts:1625`) but is wired only to tool-confirmation paths — `exit_plan_mode` (`Session.ts:2160`) and edit-tool `ProceedAlways` (`Session.ts:2168`) — not the generic `Session.setMode`/`setModel`. There is no `current_model_update` type. Both flow to the bus today via `BridgeClient.sessionUpdate()` (`bridgeClient.ts:397`) as a **generic `session_update`** with no sub-type demux.

### 1.1 Coordination model (the load-bearing decision)

v1's "agent is the single emitter; bridge drops its publish" was **rejected** — the bridge owns serialization (`modelChangeQueue`), timeout handling, `model_switch_failed`, and the persist/workspace distinction. Adopted model:

1. **The bridge remains the authoritative emitter for changes it drives** (HTTP `setSessionModel`/`setSessionApprovalMode`, attach-time `applyModelServiceId`) — unchanged serialization/timeout/failure/persist logic.
2. **In-session changes that bypass the bridge** gain a new agent `sessionUpdate` notification (`current_model_update`/`current_mode_update` from `Session.setModel`/`setMode`), which `BridgeClient.sessionUpdate()` **demuxes** into the named bus event (§2.1).
3. **Suppress-during-roundtrip — model path only.** The HTTP **model** path flows through `Session.setModel` (`acpAgent.ts:935`), so the agent notification WILL fire there in addition to the bridge publish; the demux suppresses promotion while a bridge model roundtrip is in flight. The HTTP **approval-mode** path does **not** flow through `Session.setMode` (it uses the extMethod, `acpAgent.ts:2228`), so no agent notification fires there at all — the bridge is the sole emitter and there is nothing to suppress. Suppression is meaningful only for the model path.

---

## 2. A1 — in-session model switch on the bus

### Problem

`Session.setModel` (`Session.ts:1580`) → `config.switchModel()` (`:1601`), no `sessionUpdate`. `model_switched` is published from three bridge-side sites: `bridge.ts:2883` (`setSessionModel`), `bridge.ts:1172` (`applyModelServiceId`), and none for in-session — the gap.

### Proposed design

1. Add ACP `current_model_update`: `{ sessionUpdate, currentModelId, previousModelId? }`. Emit from `Session.setModel` after `switchModel` resolves (**success only**; on failure it throws and emits nothing). (`authType` was dropped — the `model_switched` bus event is `{sessionId,modelId}` and the SDK `model.changed` normalizer reads only `modelId`, so `authType` would be dead data; `previousModelId` is optional since the normalizer doesn't require it.)
2. `BridgeClient.sessionUpdate()` demuxes `current_model_update` → `model_switched` (§2.1), **only when no bridge model roundtrip is in flight** for that session.
3. **`model_switch_failed` stays bridge-only** — `Session.setModel` throws with no notification; the bridge keeps publishing it on both failure paths.
4. **Timeout-race contract (staleness check, not "later wins").** The bridge's `withTimeout` (`bridge.ts:2844-2849`) can reject (publishing `model_switch_failed(A)`) while A's ACP call keeps running (FIXME `bridge.ts:2836-2840`). If a change B then succeeds (`model_switched(B)`) and A's call finally completes, A's late `current_model_update(A)` would — under a naive "later event is authoritative" rule — promote to `model_switched(A)` and make A the apparent final state, though B was the last intentional change. **Fix:** the demux promotes a `current_model_update` **only if its `currentModelId` equals the agent's actual current model at promotion time** (a staleness check); a stale A-after-B notification is dropped. This is the same freshness predicate the §2.2 reconciliation uses, applied at the promotion gate.

### 2.1 Demux contract (in `BridgeClient.sessionUpdate()`, `bridgeClient.ts:397`)

Today this method publishes every notification verbatim as `{ type: 'session_update', data: params }`. The demux adds:

- **Promotion table:** `current_model_update → model_switched`; `current_mode_update → approval_mode_changed` (session-scoped; deferred to step 3, see §7).
- **Payload mapping (both sub-types must be specified, else SDK validation drops them):**
  - `current_model_update → model_switched`: map `currentModelId → data.modelId` and lift the envelope/`params.sessionId` into `data.sessionId`. The SDK validator requires a non-empty `data.modelId` (`events.ts:1910`); a verbatim promote (which keeps `currentModelId`) would fail validation and be silently dropped — **A1 non-functional**. So promotion is a field-mapping, not a relabel.
  - `current_mode_update → approval_mode_changed`: build `{previous,next,persisted:false}` from `{previousModeId,currentModeId}` (§3); a bare notification can't build it.
- **Suppress-during-roundtrip (per change-type, not per-session):** promote a `current_model_update` only when no bridge-driven **model** roundtrip is in flight for that session; promote a `current_mode_update` only when no bridge-driven **approval-mode** roundtrip is in flight. A model roundtrip must NOT suppress an in-session `current_mode_update` (and vice-versa) — cross-attribute suppression would silently drop the other axis's change.
- **Staleness check (model):** even when no roundtrip is in flight, promote a `current_model_update` only if its `currentModelId` matches the agent's actual current model at promotion time (§2 item 4) — drops a stale late notification from a timed-out earlier change.
- **Drop-when-suppressed (third rule):** when a _promotable_ sub-type is NOT promoted (suppressed or stale), **drop it entirely** — do **not** fall back to publishing the generic `session_update`. The bridge is already publishing the authoritative named event; emitting the generic wrapper too would double-signal. (Residual concurrent-in-session drift is handled by the §2.2 reconciliation.)
- **Generic-wrapper suppression:** a promoted sub-type publishes the named event only — **except during the dual-emit transition window (below)**.
- **Dual-emit transition (IDE-companion lockstep, see §6):** because the daemon and the VS Code IDE companion ship on different channels and can't flip atomically, the FIRST release of `current_mode_update` promotion publishes **both** the promoted `approval_mode_changed` AND the legacy generic `session_update{sessionUpdate:'current_mode_update'}` for one release cycle. The IDE companion's existing `case 'current_mode_update'` keeps working; once its `approval_mode_changed` handler ships, the next release drops the dual-emit. `current_model_update` is brand-new (no legacy consumer) so it promotes directly without dual-emit.
- **Observability (required, not optional):** emit a structured log at every demux decision — `[demux] session=<id> type=<sub> action=promoted|dropped|suppressed|generic reason=<why>`. `BridgeClient.sessionUpdate()` has zero logging today; the `dropped` case especially must be visible so oncall can distinguish "agent didn't emit" / "demux dropped" / "SSE lost".
- **Unknown sub-types:** unchanged (generic `session_update`).

### 2.2 Post-roundtrip reconciliation (concurrent-in-session drift)

Suppress + drop assumes the bridge roundtrip and the agent describe the **same** change. That breaks under a concurrent in-session change, because in-session `/model` calls `Session.setModel` **directly and does NOT enter `modelChangeQueue`**:

1. Bridge `setSessionModel(A)` starts → suppress window opens.
2. User types `/model B` in the terminal → `Session.setModel(B)` (bypasses the queue) → agent emits `current_model_update(B)`.
3. Demux **drops** B (suppress window open).
4. Bridge publishes the authoritative `model_switched(A)`; **bus shows A, session runs B — nothing reconciles.**

**Contract:** when a bridge model roundtrip settles, the bridge **reconciles** — it re-reads the agent's actual current model (via the session-status read it already has) and, if it diverges from the `model_switched` it just published, emits a corrective `model_switched` with the true current model. This bounds the divergence to the roundtrip window instead of leaving it permanent. (The longer-term alternative — routing in-session `/model` through `modelChangeQueue` — is noted in §10 as it requires the in-session handler to reach the bridge entry.) The same reconciliation applies to A2 approval-mode once `approvalModeQueue` exists.

### Workspace mirror (explicit decision)

`Session.setModel` defaults `persistDefault:true` (`Session.ts:1610`) and writes `model.name` via `getPersistScopeForModelSelection(this.settings)` (`Session.ts:1611`) — **workspace scope for a trusted workspace owning `modelProviders`, otherwise user scope**. Either way, **A1 phase 1 does session-scoped broadcast only**; rationale: peer sessions pick up the persisted default on next spawn, and there is no security-relevant cross-session gating like approval-mode. A persisted-model workspace mirror is an explicit deferred follow-up (§10), not silently omitted.

### Risk

Double-broadcast (mitigated by §1.1 + the three §2.1 rules); failure-event loss (item 3 carve-out). Tests in §8.

---

## 3. A2 — in-session approval-mode change (asymmetric; blocked on #4510)

### Problem

1. **Silent in-session change.** `Session.setMode` (`Session.ts:1561`) → `config.setApprovalMode()` (`:1573`), no notification.
2. **HTTP bypasses `Session.setMode`.** `setSessionApprovalMode` drives extMethod `qwen/control/session/approval_mode` (`acpAgent.ts:2200`) → `config.setApprovalMode()` directly (`acpAgent.ts:2228`). The in-session emit alone doesn't cover HTTP, and HTTP emits no agent notification.
3. **Payload + persist.** `approval_mode_changed` needs `{previous,next,persisted}` (`bridge.ts:2979` session-scoped, `:3007` workspace-scoped). `current_mode_update` carries only `currentModeId`; the agent has no `persist` concept.
4. **No serialization primitive yet.** `approvalModeQueue` **does not exist** in the codebase today; the approval-mode HTTP path (`bridge.ts:2893-3020`) runs extMethod + publish inline with no per-session queue (unlike the model path's `modelChangeQueue`). The suppress/race window is therefore unbounded until #4510 lands it.

### Proposed design

**Session-scoped — in-session emits; bridge stays sole emitter for HTTP:**

1. Emit `current_mode_update` from `Session.setMode` (covers ACP `setSessionMode`, `acpAgent.ts:922`, and in-session `/approval-mode`).
2. The HTTP extMethod path keeps the **bridge's** session-scoped `approval_mode_changed` publish (`bridge.ts:2979`) and emits **no** agent notification (it bypasses `Session.setMode`) — the bridge is the sole emitter; nothing to suppress.
3. **`previousModeId` is MANDATORY (not optional).** The SDK normalizer `normalizeApprovalModeChanged` (`normalizer.ts:754`) requires `previous` and `fallbackDebug`-drops the event if it's missing — so an optional `previousModeId` would let the demux build an `approval_mode_changed` without `previous`, which the SDK then silently eats (the exact gap this design closes). `Session.setMode` therefore reads `this.config.getApprovalMode()` **before** the mutation and passes it to the generalized helper, so the demux can always build `approval_mode_changed{previous,next,persisted:false}` for in-session changes (never workspace-persisted — they don't go through the bridge's persist hook). The two existing tool-confirmation callers (`Session.ts:2160`,`:2168`) bypass `setMode` and capture the previous mode the same way.
4. **Helper generalization (migration model specified):** `sendCurrentModeUpdateNotification` (`Session.ts:1625`) today derives `newModeId` from a `ToolConfirmationOutcome` (only `auto-edit`/`default`/current). Introduce a new core helper that takes explicit `{currentModeId, previousModeId}` and emits the notification. The two existing tool-confirmation callers (`Session.ts:2160`, `:2168`) keep their `ToolConfirmationOutcome` entry point, which is updated to **capture `previousModeId` from `this.config.getApprovalMode()` before the mutation** and delegate to the new helper (so all three emit sites produce the same `{previous,next}`-complete payload). This is NOT a flag-day removal of the old signature — the outcome-derived wrapper is retained for those two callers; its deprecation is tracked separately. Avoids two payload shapes (one with, one without `previousModeId`).

**Workspace-scoped (persist) stays bridge-only:**

5. The persist + workspace broadcast (`bridge.ts:3007`) stays a bridge-level publish gated on the bridge's `persist` flag; `persisted:true` appears only on the workspace event. Add a `scope: 'session' | 'workspace'` discriminator.

### Hard prerequisite (blocks A2)

A2 is **blocked on PR #4510 landing `approvalModeQueue`** (or an equivalent per-session in-flight tracker for approval-mode roundtrips). Without it the suppress/coordination window is unbounded. Concretely (the divergence this prevents): bridge starts `setSessionApprovalMode('default')`; in-session `/approval-mode yolo` fires meanwhile; if promotion is suppressed for the whole unbounded window the `yolo` notification is dropped and never re-fires → bus shows `default` while actual mode is `yolo` (security-relevant). The bounded `approvalModeQueue` window is the mitigation.

### Double-emit edge

`/approval-mode` during an open tool-confirmation dialog can fire two `current_mode_update` within ms (user `setMode` + the tool's `ProceedAlways` handler). Acceptable (converges); optionally skip emit when the resulting mode equals current. Documented, not gated.

### Risk / compat

Additive wire (`current_mode_update` reuse + `previousModeId` + `scope`) but **not** SDK-additive for the promoted type (see §6). Hard-blocked on #4510.

---

## 4. A4 — `permission_resolved` originator/voter semantics

### Problem

`permission_request.originatorClientId` = prompt originator. `permission_resolved.originatorClientId` = voter — the emit at `permissionMediator.ts:1125` stamps `originatorClientId` from `resolverClientId` in the spread at `permissionMediator.ts:1135-1137` (the voter's trusted clientId, O8 pre-F3 compat). Consumers must special-case `permission_resolved`.

### Proposed design (additive on wire and SDK)

- **Wire:** emit `voterClientId` alongside `originatorClientId` (same value). Both **optional** — no-voter resolutions (timer expiry, session-closed, loopback voter without `X-Qwen-Client-Id`) carry neither, as today.
- **SDK typed event:** expose **both** `originatorClientId` (unchanged — no rename, no break) **and** a new optional `voterClientId`; old field documented as deprecated-alias for a future major.
- Prompt originator remains available by correlating with the matching `permission_request`.

### Wire / compat

Additive on both layers — no consumer breaks. Mirrors the D4 aliasing (PR #4510).

---

## 5. A5 — attach-time side-channel snapshot

### Problem

A `Last-Event-ID` attach gets replay + live tail but no current side-channel snapshot. Today it pulls `qwen/status/session/context` (`packages/acp-bridge/src/status.ts:96`), supported-commands, `POST /load`.

### Proposed design

Opt-in via `?snapshot=1`; emit a synthetic **`session_snapshot`** frame after replay:

```
session_snapshot { approvalMode, model, availableCommands? }
```

- **`replay_complete` already exists** (`eventBus.ts:444`, shipped by merged #4484) — A5 phase 2 introduces only the new `session_snapshot` frame, not `replay_complete`.
- **Resume ordering: replay → `replay_complete` → `session_snapshot`.** The snapshot is the authoritative final word.
- **Capture at emission time, NOT subscribe time, in a single synchronous block.** v3's "capture at subscribe (T0), emit after replay" had a stale-overwrite bug: a live `model_switched` delivered during replay (newer) would be overwritten by the T0 snapshot applied last. Capturing the snapshot **immediately before emission** fixes it — **but only if the field reads (`approvalMode`/`model`/`availableCommands`) and the publish happen in one synchronous turn with no `await` between**, otherwise a mutation can interleave and reopen the window. This is a hard contract requirement, not a convention.
- **First-attach ordering** (no `Last-Event-ID`): `replay_complete` is NOT force-pushed (no replay occurred), and the design does **not** synthesize a `replay_complete{replayedCount:0}` — doing so would widen that event's "replaying→live" contract for existing consumers. Instead `session_snapshot` is **self-delimiting on first attach**: it is emitted as the first frame, before live tail; consumers treat a `session_snapshot` as "baseline established". (Resume keeps the replay → `replay_complete` → snapshot order above.)
- **`pendingPermissionIds` excluded** (Security, below).
- SDK: typed `session.snapshot` event seeds the view-state reducer's side-channel fields, applied last (on resume) / first (on first-attach).

### `?snapshot=1` sub-contract

First attach: off unless `?snapshot=1`. Reconnect: opt-in (most useful). Toggling across reconnects: legal + idempotent (each subscribe independent). Atomicity: best-effort — capture-at-emission + subsequent live deltas reconcile; reducer test covers a racing mutation.

### Security: why no `pendingPermissionIds`

Including pending IDs would let a client vote on a request whose context it never received. `respondToSessionPermission` validates session existence, requestId/pending state, **clientId registration** (`resolveTrustedClientId` against `entry.clientIds`, `bridge.ts:2271`), and option legality — but **not** whether the voter observed the original `permission_request`. The attacker is therefore a registered session collaborator (already bearer-authenticated + clientId-registered), not an anonymous client — narrower than "any fresh client", but the gap is real: they could approve a destructive op they have no context for. Clients that legitimately need pending permissions learn them from replay (full context travels). Dropping the field also moots the snapshot/resolution race.

### Wire / compat

Additive, opt-in. An old SDK surfaces the unknown frame as a `debug` UI event (noisy, not broken) — another reason to keep it opt-in.

### Alternatives

Phase-1: document the pull contract only (pull after `replay_complete`); defer the frame.

---

## 6. Cross-cutting

- **Bridge-authoritative model (§1.1)**: bridge owns events for changes it drives; in-session changes add a notification the bridge demuxes (`bridgeClient.ts:397`); suppress + drop-when-suppressed prevent double-signal. Suppression is meaningful for the model path only; HTTP approval-mode has no agent notification.
- **Demux (§2.1) is a hard prerequisite**; A2 additionally **blocked on #4510** (`approvalModeQueue`).
- **NOT additive everywhere; handled by a dual-emit transition.** Promoting `current_mode_update` → `approval_mode_changed` changes the observed event type. The daemon and the VS Code IDE companion ship on **different channels** (CLI auto-update vs Marketplace), so the flip can't be atomic. **Affected consumer chain (all must gain an `approval_mode_changed` path):**
  - `packages/vscode-ide-companion/src/services/qwenSessionUpdateHandler.ts:177` (`case 'current_mode_update'`) — the leaf handler;
  - the upstream dispatch that routes daemon events to it — `daemonIdeConnection.ts` and `DaemonChannelBridge.ts` switch on `event.type` and drop unrecognized types via `default`, so even an updated leaf handler never receives a bare `approval_mode_changed` until these are extended.
  - **Mitigation (§2.1 dual-emit):** the first release emits BOTH the legacy generic `session_update{current_mode_update}` AND the promoted `approval_mode_changed`; the IDE companion keeps working on the legacy frame; once its `approval_mode_changed` path ships, the next release drops the dual-emit. A4 (`voterClientId`) and A5 (opt-in frame) ARE additive (no transition needed).
- **Failure events stay bridge-only** (`model_switch_failed`).
- **Concurrent-in-session drift** is bounded by §2.2 post-roundtrip reconciliation.
- **SDK reducer updates** (naming, to avoid the A1/A2 mix-up): A1 introduces **`current_model_update`** → `model.changed`; A2 promotes **`current_mode_update`** → `approval_mode_changed`; A4 adds optional `voterClientId`; A5 seeds side-channel state from `session.snapshot`.

---

## 7. Sequencing

1. **A4** — additive wire + SDK alias. Smallest, unblocked.
2. **§2.1 demux skeleton + A1** — implement the demux in `bridgeClient.ts` covering **`current_model_update` → `model_switched` only** (with the field mapping `currentModelId→data.modelId` + `sessionId`); `current_mode_update` keeps flowing as generic `session_update` (no regression) until step 3. Includes suppress + drop-when-suppressed + §2.2 reconciliation + `model_switch_failed` carve-out + demux observability + SDK update.
3. **A2 — BLOCKED on PR #4510** (`approvalModeQueue`). Adds `current_mode_update` promotion (with `previousModeId`), `Session.setMode` emit + previous-mode capture, helper generalization, `scope`, retained bridge workspace publish, the **dual-emit transition** + IDE-companion + upstream-dispatch updates.
4. **A5** — phase 1 pull-contract docs; phase 2 opt-in `session_snapshot` (capture-at-emission in a synchronous block; after `replay_complete` on resume, self-delimiting first frame on first-attach). `replay_complete` already exists (#4484); only `session_snapshot` is new.

Each lands as its own implementation PR after this design is approved.

---

## 8. Test plan

- **Demux/§1.1:** promoted `current_model_update` publishes `model_switched` and suppresses the generic wrapper; a notification during an in-flight bridge model roundtrip is **dropped** (not generic-published, not promoted); an in-session notification IS promoted; unknown sub-type still generic.
- **A1:** in-session `/model` AND plan-mode each publish exactly one `model_switched`; HTTP `POST /model` and attach-time `applyModelServiceId` each publish exactly one (no double); failed `setModel` (in-session + HTTP) emits no `model_switched`, HTTP still emits `model_switch_failed`; a `model_switched` after a timeout `model_switch_failed` is delivered (authoritative-latest).
- **A2:** in-session `setMode` publishes one session-scoped `approval_mode_changed{scope:'session',persisted:false}`; HTTP `POST /approval-mode` publishes one (bridge, sole emitter, no double); non-persisted does NOT workspace-broadcast; persisted adds a `scope:'workspace',persisted:true` event; failed `setMode` emits nothing; the unbounded-window divergence is prevented once `approvalModeQueue` lands.
- **A4:** **distinguishing case** — client A submits the prompt (so `permission_request.originatorClientId === A`), a DIFFERENT client B casts the resolving vote (so `permission_resolved.voterClientId === B`), assert the two differ (the disambiguation A4 exists for, not just the same-client value); timer/no-clientId resolution carries neither field; SDK exposes both; old-daemon fallback surfaces the voter via `originatorClientId`. (Done in PR #4539.)
- **A5:** `?snapshot=1` resume yields `session_snapshot` (mode/model/commands, no pendingPermissionIds) after `replay_complete`; first-attach yields `session_snapshot` as the first frame with **no** synthetic `replay_complete`; attach WITHOUT the flag yields NO snapshot; toggling the flag across reconnects is idempotent; a `model_switched` delivered during replay is NOT overwritten by the (emission-time, synchronous-capture) snapshot.
- **Compat migration (§2.1):** an SDK reducer previously fed `current_mode_update` as generic `session_update` reaches identical state once it's promoted to `approval_mode_changed`.
- **Helper regression (§3.4):** `exit_plan_mode` and `ProceedAlways` callers still produce correct `current_mode_update` payloads after the helper is generalized.
- **Double-emit edge (§3):** concurrent `/approval-mode` + `ProceedAlways` both emit; reducer converges.

---

## 9. Resolved decisions (emitter ownership)

| Entry                                              | agent path                                                                   | through `Session.*`?          | session-scoped emitter                                                            | workspace publish                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `POST /session/:id/model`                          | `unstable_setSessionModel` (`acpAgent.ts:925`) → `session.setModel` (`:935`) | ✅                            | **bridge** (`bridge.ts:2883`); agent notification **suppressed during roundtrip** | n/a                                        |
| attach `applyModelServiceId`                       | same path                                                                    | ✅                            | **bridge** (`bridge.ts:1172`); suppressed during roundtrip                        | n/a                                        |
| in-session `/model`, plan-mode                     | `Session.setModel` directly                                                  | ✅                            | **agent** `current_model_update` → demux                                          | n/a (deferred)                             |
| `POST /session/:id/approval-mode`                  | extMethod (`acpAgent.ts:2200`) → `config.setApprovalMode` (`:2228`)          | ❌ bypasses `Session.setMode` | **bridge** (`bridge.ts:2979`); **no agent notification** (nothing to suppress)    | bridge, `persist`-gated (`bridge.ts:3007`) |
| ACP `setSessionMode` / in-session `/approval-mode` | `acpAgent.ts:922` → `Session.setMode`                                        | ✅                            | **agent** `current_mode_update` → demux                                           | n/a                                        |

`model_switch_failed` is bridge-only on all paths.

**Resolved: A2 keeps the extMethod bypass (do NOT route the HTTP approval-mode path through `Session.setMode`).** This was an open question; it is load-bearing (if flipped, the HTTP path would fire an agent notification and §1.1's "no agent notification, nothing to suppress" would become wrong, producing a double-emit). Decision: keep the bypass — the bridge stays the sole emitter for HTTP approval-mode, no suppress logic needed there. Revisiting it would require adding suppress logic + the `approvalModeQueue` dependency to that path, so it is explicitly out of scope.

## 10. Open questions

1. **A1 workspace mirror:** ship the deferred persisted-model workspace mirror, or leave model session-scoped permanently? (Persist scope itself is workspace-or-user per `getPersistScopeForModelSelection`.)
2. **A5 default:** keep `?snapshot=1` opt-in vs always-on for reconnects.
3. **Reconciliation vs queue (A1):** §2.2 specifies post-roundtrip reconciliation as the v1 mitigation for concurrent-in-session drift; a later cleanup could route in-session `/model` through `modelChangeQueue` (requires the in-session handler to reach the bridge entry) to prevent the drift at source rather than correct it after.
