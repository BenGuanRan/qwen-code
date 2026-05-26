# Daemon side-channel coordination — Design (A1 / A2 / A4 / A5)

> Targets `daemon_mode_b_main` (per #4175 branching strategy). Author: 秦奇. Date: 2026-05-25. Revised: 2026-05-26 (v3 — second review round).
> **Docs-only / design-first.** Implementation PRs follow design-review approval.
>
> Source: cross-client real-time sync audit (2026-05-24) + PR #4484 post-merge review (the **A-series** follow-ups). The bugfix/cleanup follow-ups from the same review ship separately (PR #4510) and are **out of scope here**.

## Changelog

### v3 (2026-05-26) — second review round (doudouOUC 4×Critical/Important, wenshao 3×Suggestion)

- **Core model reframed: NOT "single-emitter (agent sole source)".** v2's convergence broke the bridge's `modelChangeQueue` serialization + timeout/failure handling. New model (§1.1): **the bridge stays the authoritative emitter for changes it drives; in-session changes (which bypass the bridge) get a new agent notification that the bridge demuxes; the bridge suppresses demux-promotion while it has an in-flight roundtrip for that session** (avoids double-emit without losing the bridge's race/failure ownership).
- **A1: all three `model_switched` publish sites enumerated** (`setSessionModel`, `applyModelServiceId`, + the new notification path) with an explicit failure-path / `model_switch_failed` carve-out and the timeout-race contract.
- **A1: workspace-mirror decision made explicit** (was silent) — model persistence does session-scoped only in phase 1; rationale given.
- **`current_mode_update` payload + helper**: enrich with `previousModeId`; `persisted` stays bridge-sourced; acknowledge `sendCurrentModeUpdateNotification` must be generalized to represent all `ApprovalMode` values (today it only derives `auto-edit`/`default` from a tool outcome).
- **A4: SDK-API compat fixed** — expose BOTH `originatorClientId` and `voterClientId` on the SDK typed event (no rename), so SDK consumers don't break.
- **A5: snapshot now emitted AFTER `replay_complete`** (was before replay) — fixes the reducer state-corruption where stale replayed `*_changed` events overwrote a pre-replay snapshot. `?snapshot=1` sub-contract specified.
- **Test plan expanded** (§8): A2 HTTP path, A1 plan-mode + failure paths, A5 opt-out, A4 SDK fallback, snapshot/replay ordering.

### v2 (2026-05-26) — first review round

A1/A2 asymmetry made explicit; §2.1 demux contract added; §9 emitter-ownership table; A5 `pendingPermissionIds` removed (auth gap); anchor hygiene (full `packages/...` paths; `bridge.ts`/`permissionMediator.ts` are the real files, `packages/cli/src/serve/httpAcpBridge.ts` is a re-export shim); `current_mode_update` noted as two callers; `voterClientId` optional; unknown-event compat corrected.

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

**Anchor convention:** full repo-root paths. Bridge = `packages/acp-bridge/src/bridge.ts` (the real 3923-LOC impl; `packages/cli/src/serve/httpAcpBridge.ts` is a 101-LOC re-export shim — not an anchor target). Agent = `packages/cli/src/acp-integration/acpAgent.ts`. Session = `packages/cli/src/acp-integration/session/Session.ts`.

---

## 1. Background — the side-channel coordination invariant

The daemon broadcasts _transcript_ deltas and HTTP-route-initiated _control_ changes (`model_switched`, `approval_mode_changed`) over each session's `EventBus`. The gap: **the same logical change has two entry paths and only the HTTP one broadcasts**:

```
HTTP route  → bridge.setSessionModel / setSessionApprovalMode → publishes event  ✅
in-session  → Session.setModel / setMode (slash command, plan-mode)              ❌ silent
```

`current_mode_update` exists today (`Session.ts:1645`; helper `sendCurrentModeUpdateNotification` at `Session.ts:1625`) but is wired only to **tool-confirmation paths** — `exit_plan_mode` (`Session.ts:2160`) and edit-tool `ProceedAlways` (`Session.ts:2168`) — not to the generic `Session.setMode`/`setModel`. There is no `current_model_update` type at all.

### 1.1 Coordination model (the load-bearing decision)

v2 proposed "the agent becomes the single emitter; the bridge drops its publish." **Rejected** — the bridge owns serialization (`modelChangeQueue`), timeout handling, failure events (`model_switch_failed`), and the persist/workspace distinction; none of that lives in the agent. Dropping the bridge publish loses all of it.

**Adopted model:**

1. **The bridge remains the authoritative emitter for any change it drives** (HTTP `setSessionModel`/`setSessionApprovalMode`, attach-time `applyModelServiceId`). It keeps its serialization, timeout, failure, and workspace/persist logic unchanged.
2. **In-session changes that bypass the bridge** (slash `/model`, `/approval-mode`, plan-mode) gain a **new agent `sessionUpdate` notification** (`current_model_update` / `current_mode_update` from `Session.setModel`/`setMode`). The bridge **demuxes** that notification into the named bus event (§2.1).
3. **Suppress-during-roundtrip dedup.** The HTTP path flows through `Session.set*` too (so the notification WILL fire there), and the bridge also publishes. To avoid a double-emit, the bridge **suppresses demux-promotion of a `current_*_update` while it has an in-flight roundtrip for that session** (tracked via the existing per-session change queue). In-session changes (no in-flight bridge roundtrip) get promoted; bridge-driven ones are published by the bridge as today.

This keeps the bridge's race/failure ownership intact and closes the in-session gap with one added notification + one demux suppression rule.

---

## 2. A1 — in-session model switch on the bus

### Problem

`Session.setModel` (`Session.ts:1580`) → `config.switchModel()` (`:1601`), no `sessionUpdate`. `model_switched` is published from **three** sites, all bridge-side:

1. `bridge.ts:2883` — `setSessionModel` post-roundtrip (HTTP `POST /session/:id/model`).
2. `bridge.ts:1172` — `applyModelServiceId` post-roundtrip (attach-time `modelServiceId` reconciliation; same `unstable_setSessionModel` → `Session.setModel` path).
3. (none for in-session — the gap.)

A `/model` slash command or plan-mode switch is invisible to peers.

### Proposed design

1. Add ACP `current_model_update`: `{ sessionUpdate: 'current_model_update', currentModelId, previousModelId?, authType? }`. Emit from `Session.setModel` after `switchModel` resolves (**success only** — on failure `Session.setModel` throws and emits nothing).
2. Bridge demuxes `current_model_update` → `model_switched` (§2.1), **only when no bridge-driven model roundtrip is in flight for that session** (suppress-during-roundtrip, §1.1). Sites #1 and #2 are unchanged and remain the emitter for HTTP/attach changes.
3. **`model_switch_failed` is a bridge-only event and survives this design.** `Session.setModel` throws on failure with no notification; the bridge keeps publishing `model_switch_failed` on the `setSessionModel`/`applyModelServiceId` failure paths.
4. **Timeout-race contract.** The bridge's `withTimeout` (`bridge.ts:2837-2840`) can reject (publishing `model_switch_failed`) while the ACP call later succeeds and the agent emits `current_model_update`. Contract: events are ordered; a `model_switched` arriving after a `model_switch_failed` means the switch actually succeeded — consumers treat the later event as authoritative. The suppress-during-roundtrip window is released when the bridge's roundtrip settles, so this late notification IS promoted (correctly reflecting the true final state).

### 2.1 Demux contract (prerequisite for A1 and A2)

The bridge publishes every `sessionUpdate` notification as a generic `session_update` bus event (`bridge.ts:352`); no sub-type demux today.

- **Promotion table:** `current_model_update → model_switched`, `current_mode_update → approval_mode_changed` (session-scoped, see §3).
- **Suppress-during-roundtrip:** promote only when no bridge-driven roundtrip for that session is in flight (§1.1).
- **Generic-wrapper suppression:** a promoted sub-type publishes the named event **only**, never also the generic `session_update`.
- **Payload enrichment is required** for `approval_mode_changed` (needs `{previous,next,persisted}`); see §3. A bare notification cannot reconstruct it.
- **Compat call-out:** `current_mode_update` already reaches SDK consumers as generic `session_update` today; promotion changes the observed event type — a deliberate, documented change requiring lockstep SDK normalizer/reducer updates.
- **Unknown sub-types:** unchanged (generic `session_update`).

### Workspace mirror (explicit decision)

`Session.setModel` defaults `persistDefault: true` (`Session.ts:1610`), writing `model.name` to user-scope settings — the default for future sessions. Unlike A2 (which keeps a workspace mirror for persisted approval-mode), **A1 phase 1 does session-scoped broadcast only**. Rationale: a persisted model change becomes peer sessions' default on their _next spawn_ (they re-read settings), and there is no cross-session in-flight "model badge" correctness requirement comparable to approval-mode's security-relevant gating. A workspace mirror for persisted model changes is a possible follow-up, explicitly deferred — not silently omitted.

### Wire / compat

Additive sessionUpdate. SDK sees the existing `model_switched` (+ the §2.1 compat note for `current_mode_update`).

### Risk

Double-broadcast (mitigated by §1.1 suppression + §2.1). Failure-event loss (mitigated by item 3 carve-out). Tests in §8.

---

## 3. A2 — in-session approval-mode change (asymmetric to A1)

### Problem

1. **Silent in-session change.** `Session.setMode` (`Session.ts:1561`) → `config.setApprovalMode()` (`:1573`), no notification.
2. **HTTP bypasses `Session.setMode`.** `setSessionApprovalMode` drives extMethod `qwen/control/session/approval_mode` (`acpAgent.ts:2200`) → `config.setApprovalMode()` directly (`acpAgent.ts:2228`). So the in-session emit alone does **not** cover the HTTP path.
3. **Payload + persist.** `approval_mode_changed` needs `{previous,next,persisted}` (`bridge.ts:2979` session-scoped, `:3007` workspace-scoped). `current_mode_update` carries only `currentModeId`; the agent has no `persist` concept.

### Proposed design

**Session-scoped visibility — both agent entry points emit, bridge stays authoritative for HTTP:**

1. Emit `current_mode_update` from `Session.setMode` (covers ACP `setSessionMode`, `acpAgent.ts:922`, and in-session `/approval-mode`).
2. The HTTP extMethod path keeps the **bridge's** session-scoped `approval_mode_changed` publish (`bridge.ts:2979`) — it has `previous` (from the extMethod response) and the originator. Per §1.1 suppress-during-roundtrip, the bridge does **not** also promote the agent notification for the same HTTP change.
3. Enrich `current_mode_update` with `previousModeId` so the demux can build a session-scoped `approval_mode_changed{previous,next,persisted:false}` for **in-session** changes (which are never persisted to workspace — they go through `Session.setMode`, not the bridge's persist hook).
4. **Generalize the helper.** `sendCurrentModeUpdateNotification` (`Session.ts:1625`) today derives `newModeId` from a `ToolConfirmationOutcome` and can only express `auto-edit`/`default`/current. It must be generalized (or split) to represent every `ApprovalMode` (`plan`/`yolo`/`auto`/…) that `Session.setMode` sets; the two existing tool-confirmation callers pre-compute or keep the outcome variant.

**Workspace-scoped (persist) stays bridge-only:**

5. The persist + workspace broadcast (`bridge.ts:3007`) remains a bridge-level publish gated on the bridge's `persist` flag. `persisted:true` only ever appears on the workspace-scoped event, set by the bridge. The agent never sees `persist`.
6. Add a `scope: 'session' | 'workspace'` discriminator to `approval_mode_changed`: session-scoped fires on every change; workspace-scoped only on `persist=true`.

### Double-emit edge (acknowledged)

If a user types `/approval-mode` while a tool-confirmation dialog is open, `Session.setMode` and the tool's `ProceedAlways` handler can both emit `current_mode_update` within milliseconds. Acceptable — the end state converges; optionally the emit is skipped when the resulting mode equals the current mode at emit time. Documented, not gated.

### Alternatives

- Route the extMethod through `Session.setMode` and drop the bridge publish (full A1 symmetry). Rejected: loses the persist/workspace distinction only the bridge can make.

### Risk / compat

Additive (`current_mode_update` reuse + `previousModeId` + `scope`). Dedup against the bridge's session-scoped publish via §1.1. Coordinate with PR #4510 (`approvalModeQueue`).

---

## 4. A4 — `permission_resolved` originator/voter semantics

### Problem

`permission_request.originatorClientId` = prompt originator. `permission_resolved.originatorClientId` = voter (`permissionMediator.ts:1125` emit, stamped from `resolverClientId` at `:1143`, the voter's trusted clientId, O8 pre-F3 compat). Consumers must special-case `permission_resolved`.

### Proposed design (additive on both wire and SDK)

- **Wire:** emit `voterClientId` alongside `originatorClientId` on `permission_resolved` (same value). Both **optional** — no-voter resolutions (timer expiry, session-closed, loopback voter with no `X-Qwen-Client-Id`) carry neither, as today.
- **SDK typed event:** expose **both** `originatorClientId` (unchanged — no rename, no break for existing consumers) **and** a new optional `voterClientId`. New consumers prefer `voterClientId`; the old field is documented as deprecated-alias for a future major. (This corrects v2, which renamed the SDK field — a breaking change for SDK consumers reading `originatorClientId`.)
- Prompt originator remains available by correlating with the matching `permission_request`.

### Wire / compat

Additive on both layers — no SDK consumer breaks. Mirrors the D4 aliasing pattern (PR #4510).

### Risk

Minimal. Internal audit/bridge code reading `permission_resolved.originatorClientId` migrates to `voterClientId` for clarity (behavior unchanged).

---

## 5. A5 — attach-time side-channel snapshot

### Problem

A `Last-Event-ID` attach gets replay + live tail but no current side-channel snapshot (approval mode, model, commands). Today it pulls `qwen/status/session/context` (`packages/acp-bridge/src/status.ts:96`), supported-commands, `POST /load`. `replay_complete` says _when_ the transcript caught up, not _what_ the current state is.

### Proposed design

Emit a single synthetic **`session_snapshot`** frame **after `replay_complete`** (id-less), opt-in via `?snapshot=1`:

```
session_snapshot { approvalMode, model, availableCommands? }
```

- **Ordering: replay frames → `replay_complete` → `session_snapshot`.** Emitting AFTER replay (not before) makes the snapshot the **authoritative final word**: historical `model_switched`/`approval_mode_changed` in the replay ring establish state first, then the snapshot corrects any drift. (v2 placed it before replay, which let a stale replayed `*_changed` overwrite the snapshot in the reducer — wenshao's state-corruption finding.)
- **`pendingPermissionIds` is excluded** (Security, below).
- SDK: normalize to a typed `session.snapshot` event that seeds the view-state reducer's side-channel fields (applied last, so it wins over replayed deltas).

### `?snapshot=1` sub-contract

- **First attach** (`Last-Event-ID` absent or `0`): snapshot **off** by default unless `?snapshot=1`.
- **Reconnect** (`Last-Event-ID: N>0`): opt-in; this is where it's most useful (catch up side-channel state without polls).
- **Toggling** across reconnects: legal and idempotent — each subscribe is independent.
- **Atomicity:** best-effort. The snapshot reads current state at subscribe time and may observe a mutation mid-flight (extMethod sent at `bridge.ts:2929`, bus publish at `:2978` not yet). Because it is emitted _after_ `replay_complete` and applied last, and subsequent live `*_changed` deltas reconcile any post-snapshot change, the contract is "best-effort latest; deltas reconcile". A reducer test covers a mutation racing the snapshot.

### Security: why no `pendingPermissionIds`

Including pending IDs would let a fresh client vote (`POST /session/:id/permission/:requestId`) on a request whose context it never received — `respondToSessionPermission` validates session/pending/option-legality but not whether the voter saw the original `permission_request`. A collaborator could attach, read a pending ID, and approve a destructive op. Clients that legitimately need pending permissions learn them from replay (where the full `permission_request` context travels). (Also moots the snapshot/resolution-race concern — a dropped field can't go stale.)

### Wire / compat

Additive, opt-in. An old SDK does not silently ignore the frame — the normalizer's default case turns it into a `debug` UI event; harmless but noisy, an additional reason to keep it opt-in.

### Alternatives

- Phase-1: document the pull contract only (pull after `replay_complete`); defer the frame. Acceptable interim.

---

## 6. Cross-cutting

- **Bridge-authoritative model (§1.1)**, not single-emitter: the bridge owns events for changes it drives (serialization, timeout, `model_switch_failed`, persist/workspace); in-session changes add an agent notification the bridge demuxes; suppress-during-roundtrip prevents double-emit. Applies to A1 (model) and A2 (approval-mode, session-scoped only — workspace stays bridge-only).
- **Demux contract (§2.1) is a hard prerequisite** for A1/A2.
- **Failure events stay bridge-only** (`model_switch_failed`) — no agent-side counterpart.
- **Additive everywhere** (A4 wire + SDK, A5 opt-in, demux). No consumer breaks.
- **SDK reducer** updates: demux'd `current_mode_update` type change (A1/A2), optional `voterClientId` (A4), `session.snapshot` seeding applied last (A5).

---

## 7. Sequencing

1. **A4** — additive wire + SDK alias. Smallest.
2. **§2.1 demux + suppress-during-roundtrip + A1** — `current_model_update` emit, demux, generic-wrapper suppression, `model_switch_failed` carve-out, SDK update.
3. **A2** — both-entry-point session emit, `previousModeId`, helper generalization, retain bridge workspace publish, `scope` field.
4. **A5** — phase 1 pull-contract docs; phase 2 opt-in `session_snapshot` after `replay_complete`.

Each lands as its own implementation PR after this design is approved.

---

## 8. Test plan

- **Demux/§1.1:** promoted sub-type publishes the named event and suppresses generic `session_update`; a notification during an in-flight bridge roundtrip is NOT promoted (bridge publishes); an in-session notification IS promoted; unknown sub-type still generic.
- **A1:** in-session `/model` **and** plan-mode switch each publish exactly one `model_switched`; HTTP `POST /session/:id/model` publishes exactly one (no double); attach-time `applyModelServiceId` publishes exactly one; **failed** `setModel` (in-session and HTTP) emits no `model_switched` and the HTTP path still emits `model_switch_failed`; a `model_switched` arriving after a timeout `model_switch_failed` is delivered (ordered, authoritative-latest).
- **A2:** in-session `setMode` AND HTTP `POST /approval-mode` each publish exactly one session-scoped `approval_mode_changed{scope:'session'}` (no double); non-persisted change does NOT workspace-broadcast; persisted change emits an additional `scope:'workspace'` event with `persisted:true`; failed `setMode` emits nothing.
- **A4:** voter resolution carries `voterClientId` (= `originatorClientId`); timer/no-clientId resolution carries neither; SDK exposes both fields; with an old daemon (only `originatorClientId`) the SDK still surfaces the voter via fallback.
- **A5:** attach with `?snapshot=1` yields `session_snapshot` (mode/model/commands, no pendingPermissionIds) **after** `replay_complete`; attach WITHOUT the flag yields NO snapshot; reducer applies snapshot last so a stale replayed `model_switched` does not win; a mutation racing snapshot construction reconciles via the subsequent live delta.

---

## 9. Resolved decisions (emitter ownership)

| Entry                                              | agent path                                                                   | through `Session.*`?          | session-scoped emitter                                                        | workspace publish                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `POST /session/:id/model`                          | `unstable_setSessionModel` (`acpAgent.ts:925`) → `session.setModel` (`:935`) | ✅                            | **bridge** (`bridge.ts:2883`); agent notification suppressed during roundtrip | n/a                                        |
| attach `applyModelServiceId`                       | same path                                                                    | ✅                            | **bridge** (`bridge.ts:1172`); suppressed during roundtrip                    | n/a                                        |
| in-session `/model`, plan-mode                     | `Session.setModel` directly                                                  | ✅                            | **agent** `current_model_update` → demux                                      | n/a (phase-1 deferred)                     |
| `POST /session/:id/approval-mode`                  | extMethod (`acpAgent.ts:2200`) → `config.setApprovalMode` (`:2228`)          | ❌ bypasses `Session.setMode` | **bridge** (`bridge.ts:2979`); suppressed during roundtrip                    | bridge, `persist`-gated (`bridge.ts:3007`) |
| ACP `setSessionMode` / in-session `/approval-mode` | `acpAgent.ts:922` → `Session.setMode`                                        | ✅                            | **agent** `current_mode_update` → demux                                       | n/a                                        |

`model_switch_failed` is bridge-only on all paths (no agent counterpart).

## 10. Open questions

1. **A2 extMethod emit (if symmetry desired later):** route `acpAgent.ts:2228` through `Session.setMode`? Not required by this design (the bridge already publishes the HTTP path), but would let in-session and HTTP share one agent emit. Pending a check that `Session.setMode`'s ApprovalMode mapping covers every extMethod value.
2. **A1 workspace mirror:** ship the deferred persisted-model workspace mirror, or leave model persistence session-scoped permanently?
3. **A5 default:** keep `?snapshot=1` opt-in (current lean) vs always-on for reconnects.
