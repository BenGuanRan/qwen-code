# Daemon side-channel coordination — Design (A1 / A2 / A4 / A5)

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Author: 秦奇. Date: 2026-05-25. Revised: 2026-05-26 (v4 — third review round).
> **Docs-only / design-first.** Implementation PRs follow design-review approval.
>
> Source: cross-client real-time sync audit (2026-05-24) + PR #4484 post-merge review (the **A-series** follow-ups). The bugfix/cleanup follow-ups from the same review ship separately (PR #4510) and are **out of scope here**.

## Changelog

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

1. Add ACP `current_model_update`: `{ sessionUpdate, currentModelId, previousModelId?, authType? }`. Emit from `Session.setModel` after `switchModel` resolves (**success only**; on failure it throws and emits nothing).
2. `BridgeClient.sessionUpdate()` demuxes `current_model_update` → `model_switched` (§2.1), **only when no bridge model roundtrip is in flight** for that session.
3. **`model_switch_failed` stays bridge-only** — `Session.setModel` throws with no notification; the bridge keeps publishing it on both failure paths.
4. **Timeout-race contract.** The bridge's `withTimeout` (`bridge.ts:2844-2849`, inside `modelChangeQueue.then`) can reject (publishing `model_switch_failed`) while the ACP call later succeeds and the agent emits `current_model_update`. Events are ordered; a `model_switched` after a `model_switch_failed` means the switch actually succeeded — consumers treat the later event as authoritative. The suppress window releases when the roundtrip settles, so the late notification is promoted (true final state).

### 2.1 Demux contract (in `BridgeClient.sessionUpdate()`, `bridgeClient.ts:397`)

Today this method publishes every notification verbatim as `{ type: 'session_update', data: params }`. The demux adds:

- **Promotion table:** `current_model_update → model_switched`; `current_mode_update → approval_mode_changed` (session-scoped; deferred to step 3, see §7).
- **Suppress-during-roundtrip:** promote only when no bridge-driven roundtrip for that session is in flight (model path; §1.1).
- **Drop-when-suppressed (third rule):** when a _promotable_ sub-type is NOT promoted because a roundtrip is in flight, **drop it entirely** — do **not** fall back to publishing the generic `session_update`. The bridge is already publishing the authoritative named event; emitting the generic wrapper too would double-signal.
- **Generic-wrapper suppression:** a promoted sub-type publishes the named event only.
- **Payload enrichment required** for `approval_mode_changed` (`{previous,next,persisted}`); a bare notification can't build it (§3).
- **Compat call-out:** `current_mode_update` already reaches consumers as generic `session_update`; promotion changes the observed type — a **lockstep** change (see §6 affected consumers), not additive.
- **Unknown sub-types:** unchanged (generic `session_update`).

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
3. **`previousModeId` capture:** `Session.setMode` reads `this.config.getApprovalMode()` **before** the mutation and passes it to the generalized helper, so the demux can build `approval_mode_changed{previous,next,persisted:false}` for in-session changes (never workspace-persisted — they don't go through the bridge's persist hook). The two existing tool-confirmation callers (`Session.ts:2160`,`:2168`) bypass `setMode` and need their own previous-mode capture.
4. **Helper generalization:** `sendCurrentModeUpdateNotification` (`Session.ts:1625`) today derives `newModeId` from a `ToolConfirmationOutcome` (only `auto-edit`/`default`/current). It must be generalized/split to represent every `ApprovalMode` (`plan`/`yolo`/`auto`/…) `Session.setMode` sets, taking explicit `{currentModeId, previousModeId}`.

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

- **Ordering: replay → `replay_complete` → `session_snapshot`.** The snapshot is the authoritative final word.
- **Capture at emission time, NOT subscribe time.** v3's "capture at subscribe (T0), emit after replay" had a stale-overwrite bug: a live `model_switched` delivered during replay (newer) would be overwritten by the T0 snapshot applied last, with no later delta to reconcile. Capturing the snapshot **immediately before emission** (after `replay_complete`) guarantees it reflects state at-or-after every already-delivered delta. (Alternatively the SDK reducer rejects a snapshot dominated by applied deltas; capture-at-emission is simpler.)
- **First-attach ordering** (no `Last-Event-ID`): `replay_complete` is only force-pushed when a `Last-Event-ID` was provided. For a `?snapshot=1` first attach the daemon still emits a `replay_complete{replayedCount:0}` immediately, then `session_snapshot`, so the ordering contract is uniform regardless of resume.
- **`pendingPermissionIds` excluded** (Security, below).
- SDK: typed `session.snapshot` event seeds the view-state reducer's side-channel fields, applied last.

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
- **NOT additive everywhere.** Promoting `current_mode_update` → `approval_mode_changed` is a lockstep change. **Affected consumers** that must update in the same release: the SDK normalizer/reducer, AND `packages/vscode-ide-companion/src/services/qwenSessionUpdateHandler.ts:177` (`case 'current_mode_update'`, fed from the daemon bus) — it would silently lose mode-change notifications otherwise. A4 (`voterClientId`) and A5 (opt-in frame) ARE additive.
- **Failure events stay bridge-only** (`model_switch_failed`).

---

## 7. Sequencing

1. **A4** — additive wire + SDK alias. Smallest, unblocked.
2. **§2.1 demux skeleton + A1** — implement the demux in `bridgeClient.ts` covering **`current_model_update` → `model_switched` only**; `current_mode_update` keeps flowing as generic `session_update` (no regression) until step 3. Includes suppress + drop-when-suppressed + `model_switch_failed` carve-out + SDK update.
3. **A2 — BLOCKED on PR #4510** (`approvalModeQueue`). Adds `current_mode_update` promotion (with `previousModeId`), `Session.setMode` emit + previous-mode capture, helper generalization, `scope`, retained bridge workspace publish, and the lockstep IDE-companion update.
4. **A5** — phase 1 pull-contract docs; phase 2 opt-in `session_snapshot` (capture-at-emission, after `replay_complete`).

Each lands as its own implementation PR after this design is approved.

---

## 8. Test plan

- **Demux/§1.1:** promoted `current_model_update` publishes `model_switched` and suppresses the generic wrapper; a notification during an in-flight bridge model roundtrip is **dropped** (not generic-published, not promoted); an in-session notification IS promoted; unknown sub-type still generic.
- **A1:** in-session `/model` AND plan-mode each publish exactly one `model_switched`; HTTP `POST /model` and attach-time `applyModelServiceId` each publish exactly one (no double); failed `setModel` (in-session + HTTP) emits no `model_switched`, HTTP still emits `model_switch_failed`; a `model_switched` after a timeout `model_switch_failed` is delivered (authoritative-latest).
- **A2:** in-session `setMode` publishes one session-scoped `approval_mode_changed{scope:'session',persisted:false}`; HTTP `POST /approval-mode` publishes one (bridge, sole emitter, no double); non-persisted does NOT workspace-broadcast; persisted adds a `scope:'workspace',persisted:true` event; failed `setMode` emits nothing; the unbounded-window divergence is prevented once `approvalModeQueue` lands.
- **A4:** voter resolution carries `voterClientId` (= `originatorClientId`); timer/no-clientId resolution carries neither; SDK exposes both; old-daemon fallback surfaces the voter via `originatorClientId`.
- **A5:** `?snapshot=1` yields `session_snapshot` (mode/model/commands, no pendingPermissionIds) after `replay_complete`; first-attach emits `replay_complete{0}` then snapshot; attach WITHOUT the flag yields NO snapshot; toggling the flag across reconnects is idempotent; a `model_switched` delivered during replay is NOT overwritten by the (emission-time-captured) snapshot.
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

## 10. Open questions

1. **A1 workspace mirror:** ship the deferred persisted-model workspace mirror, or leave model session-scoped permanently? (Persist scope itself is workspace-or-user per `getPersistScopeForModelSelection`.)
2. **A5 default:** keep `?snapshot=1` opt-in vs always-on for reconnects.
3. **A2 emit symmetry (optional):** route the extMethod through `Session.setMode` later so HTTP + in-session share one agent emit — pending a check that `Session.setMode`'s ApprovalMode mapping covers every extMethod value.
