# SPEC: ACP agent readiness: probe reasons, last-good offers, Re-check, and bare model ids (2026-11-21 A-Z e2e F3 and F18)

## Summary

This feature fixes the runner ACP probe findings from the 2026-11-21 A-Z end-to-end run on koda-wk (`2579ca3d`):
- F3: Claude Code, Codex and Cursor flap between ready and "Not ready" in the new-thread form, with nothing changed on the machine. The form gives no reason, no last-check time and no way to retry.
- F18: Codex's offer lists effort variants (`gpt-6.1-terra[low]` ... `[ultra]`) as models, so the 32-model cap crowds out real models.

The fixes:
- Each ACP offer carries the time of the probe it reports (`checkedAt`) and, after a failed probe, the failure code (`lastError`: `timeout`, `unavailable` or `error`).
- The runner keeps an agent's last confirmed offer through a failed probe for up to 30 minutes, instead of dropping the agent to "Not ready". An auth-required answer or a not-launchable agent still takes effect at once.
- Failed probes are logged on the runner (once per state).
- A global admin (`fleet.runner.update`) can press Re-check on a not-ready agent in the new-thread form. The API records a re-probe request on each runner concerned and hands it to the runner on its next sync. The runner re-probes at once, and the form refreshes until the new result arrives.
- The probe reports bare model ids only, as `nax chat` does: Claude and Codex drop every bracketed id; Cursor keeps each settings-carrying id under its bare name when that name is unique.

The findings report is `projects/koda/e2e-2026-11-21/koda-wk-a-z-e2e-findings-2026-11-21.md` in the workspace repo.

## Motivation

- F3 cause, verified 2026-11-22 on the koda-wk Mac:
  - Probed on its own, every agent answers in under 3 s (claude 0.4 s, codex 1.4-2.3 s).
  - In the daemon, `NaxCapabilityProbe.probe` runs `acpAgents()` in one `Promise.all` with about 75 nax profile probes, the sandbox probe and the tool checks. The runner log shows those nax calls hitting `NAX_TIMEOUT` under the same load.
  - Each agent has a fixed 20 s deadline (`ACP_PROBE_TIMEOUT_MS`). An agent that misses it is reported `loggedIn: null`, so it leaves `threadBackends.acp`, and the form shows "Not ready" until the next probe, 10 minutes later (`capabilityProbeMs`).
- F3 visibility:
  - `probeAgent` throws away why a probe failed (deadline, `AGENT_SESSION_BACKEND_UNAVAILABLE` with the agent's stderr, any other error).
  - `NaxCapabilityProbe.acpAgents` returns no warnings for a failed agent, so the runner log is silent.
  - The web reason `notReady` cannot say more.
- F3 retry: the only re-probe triggers are the 10-minute timer and SIGHUP on the runner host. The API has no way to ask for one.
- F18: nax-agent-acp's `offeredModels` merges the agent's config-option model ids with its legacy model list. Codex has no effort config option: its effort variants are legacy model ids. A Codex probe on the koda-wk Mac reports 50 ids, 41 of them `[effort]` variants, and `offeredEfforts: []`. `nax chat` (`packages/nax/src/chat/acp/acp-model.ts`, `acpModelRows`) lists only bare ids:
  - Claude and Codex drop every id holding `[` or `]`.
  - Cursor drops one trailing `[...]` group and keeps a bare name only when exactly one offered id maps to it.
  - At session open, nax-agent-acp's `resolveModelValue` maps a bare Cursor name back to its full id.
  - Effort comes only from `offeredEfforts`, so Codex effort cannot be chosen in `nax chat`.

## Design

### Integration

These symbols are read only:
- `parseAcpOffers(v: unknown): ThreadAcpOffer[] | null` (`apps/api/src/fleet/common/capabilities-core.ts`) is the single validator for stored and incoming offers. `RunnerSummaryDto.from` calls it through `threadBackends()`.
- `CapabilityReporter.refresh(): Promise<boolean>` (`apps/runner/src/capabilities/capability-probe.ts`) serialises probes: a request while one runs queues exactly one more. It logs `warnings` only when their joined set changes.
- `hashCapabilities` hashes every field except `sandbox.probedAt`. `checkedAt` therefore changes the hash on every probe, so the runner sends its report once per probe (every 10 minutes, or after a Re-check). That is deliberate: the form shows the last-check time. No change to `hashCapabilities`.
- `daemon.reprobe()` (`apps/runner/src/daemon/daemon.ts`) calls `reporter.refresh()` and wakes the sync loop when the report changed.
- `RunnerNotifier.notify(runnerId)` / `wait(runnerId, ms, ready)` (`apps/api/src/fleet/jobs/runner-notifier.ts`) are the in-process long-poll wake-ups.
- `bookkeeping(reason, fn)` (`apps/api/src/action-context/audit-coverage.ts`) marks an uncounted write. `AuditRecorder.record(...)` records an audit entry.
- `eligibleAgents(runners, kind): AgentChoice[]` (`apps/web/lib/thread-create.ts`) decides `available` from the eligible runners' `threadBackends.acp` lists only. Both new-thread pages move `values.agent` to an available agent whenever the chosen one is unavailable (`watch(agents)`), and `BackendPicker.vue` disables unavailable options. So a not-ready agent is never the chosen agent.
- `useGlobalPermissions()` (`apps/web/composables/usePermissions.ts`) returns `{ permissions: ComputedRef<PermissionSet>, ... }`; a key is checked with `permissions.value.has(key)` (as in `pages/agents.vue`). `formatDateTime(iso, locale)` (`apps/web/lib/format-date-time.ts`).

These symbols change. Each **Baseline** exists only to locate the code; implement the **Target**:

- `packages/fleet-protocol/src/threads.ts` (edited by US-001; the runner imports its runtime values).
  - Baseline: `ThreadAcpOffer` is `{ agent; launchable; loggedIn: boolean | null; models: string[]; efforts: string[] }`.
  - Target: `ThreadAcpOffer` adds `checkedAt?: string` (ISO time of the probe whose result this offer reports) and `lastError?: AcpProbeError`, plus:

    ```ts
    export const ACP_PROBE_ERROR_CODES = ['timeout', 'unavailable', 'error'] as const;
    export type AcpProbeErrorCode = (typeof ACP_PROBE_ERROR_CODES)[number];
    /** The latest failed probe of an agent: why, and when. No agent text crosses the wire. */
    export interface AcpProbeError { code: AcpProbeErrorCode; at: string }
    /** A probe time: UTC ISO-8601 with at most millisecond precision, as `Date.prototype.toISOString` writes it. */
    export const ACP_PROBE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
    ```

- `apps/api/src/fleet/common/thread-jobs.ts`: the API may only `import type` from the package (`protocol.spec.ts`), so it mirrors `ACP_PROBE_ERROR_CODES` and `ACP_PROBE_TIME_RE` as runtime values next to its other mirrors, and re-exports the two types. `thread-jobs.spec.ts` pins the mirrors equal to the package's.
- `SyncResponse` (`packages/fleet-protocol/src/index.ts`, types only, edited by US-005).
  - Target: adds `reprobe?: true` ("the runner should re-probe its capabilities now; absent otherwise"). This is optional and additive, so `FLEET_PROTOCOL_VERSION` stays 4.
- `parseAcpOffer` (`capabilities-core.ts`).
  - Baseline: refuses any key outside `agent, launchable, loggedIn, models, efforts`.
  - Target: also admits `checkedAt` and `lastError`.
    - `checkedAt`: a string matching the mirrored `ACP_PROBE_TIME_RE` for which `Date.parse` is not `NaN`.
    - `lastError`: an object with exactly the keys `code` (one of the mirrored `ACP_PROBE_ERROR_CODES`) and `at` (same rule as `checkedAt`).
    - A malformed value refuses the offer, so the whole list is dropped, as today.
    - Each key is copied to the result only when present.
- `RunnerSummaryDto` `threadBackends` `@ApiProperty` schema: the `acpOffers` item gains `checkedAt` (string, date-time) and `lastError` (object with `code` enum and `at`).
- `probeAgent` / `probeAcpAgents` (`apps/runner/src/capabilities/acp-agent-probe.ts`, US-002).
  - Target: every offer carries `checkedAt: now().toISOString()` (new optional dep `AcpProbeDeps.now?: () => Date`, default `() => new Date()`).
  - A failed probe also carries `lastError: { code, at: checkedAt }`. Its `loggedIn` stays `null` and its lists stay empty:

    | Probe outcome | `launchable` | `loggedIn` | `lastError.code` |
    |:--|:--|:--|:--|
    | launch check says not installed | false | null | (none) |
    | session opened | true | true | (none) |
    | open rejected `AGENT_SESSION_AUTH_REQUIRED` | true | false | (none) |
    | open missed `ACP_PROBE_TIMEOUT_MS` | true | null | `timeout` |
    | open rejected `AGENT_SESSION_BACKEND_UNAVAILABLE` | true | null | `unavailable` |
    | open rejected with any other error, or workdir/backend construction threw | true | null | `error` |

- `offeredModels(capabilities)` (same file, US-003).
  - Target: takes the agent too, and mirrors `nax chat` `acpModelRows`, in this order:
    1. Keep string ids.
    2. Claude and Codex keep only ids with no `[` or `]`, de-duplicated in offer order.
    3. Cursor maps each distinct id to its bare name by removing one trailing `[...]` group (regex `/\[[^[\]]*\]$/`). It keeps a bare name, in first-seen order, only when exactly one distinct offered id maps to it and the name is non-empty and holds no bracket. An id with no group maps to itself, so `x` and `x[a=1]` both map to `x` and drop it.
    4. Filter by `ACP_MODEL_ID_RE`.
    5. Cap at `MAX_OFFERED_MODELS` (32).
  - `offeredEfforts` is unchanged.
- New `createAcpOfferMemory(probe: AcpAgentProbe, options?: { now?: () => Date; maxAgeMs?: number }): AcpAgentProbe` (`apps/runner/src/capabilities/acp-offer-memory.ts`, US-004), with `ACP_LAST_GOOD_MAX_AGE_MS = 1_800_000` (three default probe intervals). It holds per agent the last offer with `launchable: true, loggedIn: true`. For each offer the wrapped probe returns:
  - A confirmed offer replaces the agent's memory and is returned unchanged.
  - An offer with `lastError`: when memory holds a confirmed offer whose `checkedAt` is at most `maxAgeMs` before `now()`, the wrapper returns that remembered offer with the new `lastError` added; `checkedAt` stays the remembered one. Otherwise memory is cleared and the failed offer is returned unchanged.
  - Any other offer (`loggedIn: false`, or `launchable: false`) clears memory and is returned unchanged.
  - A remembered offer without a parseable `checkedAt` is never kept.
- `NaxCapabilityProbe.acpAgents` (`apps/runner/src/capabilities/nax-probe.ts`, US-004).
  - Baseline: returns `warnings: []` on success.
  - Target: one warning per offer with `lastError`:
    - kept offer (`loggedIn: true`): `ACP agent <agent> probe failed (<code>); reporting the offer confirmed at <checkedAt>`
    - otherwise: `ACP agent <agent> is not ready: probe <code>`
    - These texts change only when the state changes, so the reporter logs each state once.
  - The `acp` list rule is unchanged: launchable and `loggedIn === true`, so a kept offer stays in `acp`.
- `RunDeps` / `runCommand` (`apps/runner/src/commands/run.ts`, US-004).
  - Baseline: `deps.start({ ..., acpProbe: probeAcpAgents })`.
  - Target: `RunDeps` gains optional `acpProbe?: AcpAgentProbe` (default `() => probeAcpAgents()`), and the daemon gets `acpProbe: createAcpOfferMemory(deps.acpProbe ?? (() => probeAcpAgents()))`.
- Re-check request on the API (US-005).
  - New migration `apps/api/prisma/migrations/20261218090000_runner_reprobe_request/migration.sql`: `ALTER TABLE "Runner" ADD COLUMN "reprobeRequestedAt" TIMESTAMP(3);` with `reprobeRequestedAt DateTime?` on `model Runner`.
  - `IRunnerRepository.requestReprobe(id: string, now: Date): Promise<boolean>`: sets the column, and is false when no runner has the id.
  - `RunnersService.requestReprobe(actorId: string, id: string, now = new Date()): Promise<{ requestedAt: string }>`:
    - inside `txManager.run`: `requestReprobe`; for an unknown id it throws `NotFoundAppException({}, 'fleet.runners')`; otherwise it records `AuditRecorder.record({ key: 'fleet.runner.update', resourceType: 'fleet-runner', resourceId: id, projectId: null, summary: 'reprobe requested' })`;
    - after the transaction, `RunnerNotifier.notify(id)`.
  - Route `POST /fleet/runners/:id/reprobe` on `RunnersController`, built exactly like `update`:
    - `@HttpCode(200)`, `@UseGuards(RequiresGuard)`, `@Requires('fleet.runner.update')`, `@ApprovalGated()`, `@ApiOperation({ summary: 'Ask a runner to re-probe its capabilities now (fleet.runner.update, global)' })`, `@ApiResponse` 200, 403 and 404 (the gate adds the 202 pending response).
    - `fleet.runner.update` is approvable (high-risk `fleet.runner.` prefix), and the permission contract (`permission-contract.ts`, `ungated-approvable-write`) refuses an ungated write route on an approvable key.
    - `RUNNER_ROUTE_VARIANTS` gains `reprobe: 'rest:fleet-runners.reprobe'`. `RunnerRouteCommands.onModuleInit` registers a `routeCommand<{ id: string }, { requestedAt: string }>` with key `fleet.runner.update` and that variant: `parse` takes `parseRouteInput(input, ['id'])`, and `run` calls `runners.requestReprobe(principal.id, input.id)`.
    - The controller calls `routeGate.run({ key: 'fleet.runner.update', variant: RUNNER_ROUTE_VARIANTS.reprobe, projectId: null, input: { id } })`, throws `ApprovalPending` when pending, and otherwise returns `JsonResponse.Ok(outcome.result)`.
- `SyncService.sync` (`apps/api/src/fleet/sync/sync.service.ts`, US-005) uses two new methods on the fleet-job repository it already holds (`IFleetJobRepository` in `fleet/jobs/domain/fleet-job.domain.ts`, `PrismaFleetJobRepository`), so its constructor is unchanged:
  - `hasPendingReprobe(runnerId): Promise<boolean>`.
  - `takeReprobeRequest(runnerId): Promise<boolean>`: one conditional `UPDATE "Runner" SET "reprobeRequestedAt" = NULL WHERE "id" = $1 AND "reprobeRequestedAt" IS NOT NULL`. It is true when a row changed, so two concurrent syncs deliver one request once. The sync calls it inside `bookkeeping('runner.command-delivery', ...)`, since a re-probe request is a command handed to the runner.
  - The idle long-poll's `ready` predicate also answers true when `hasPendingReprobe(runnerId) === true`.
  - After the wait (or when not idle), the response carries `reprobe: true` only when `takeReprobeRequest` resolved exactly `true`. The key is absent otherwise.
- `SyncLoopDeps` (`apps/runner/src/sync/sync-loop.ts`, US-006) gains `onReprobe?: () => void`. After the response is applied (next to `onArchivedThreads`), `response.reprobe === true` calls it once. `startDaemon` wires `onReprobe: () => { void reprobe(); }`.
- Web.
  - `apps/web/lib/thread-types.ts` adds its own `AcpProbeErrorCode` (`'timeout' | 'unavailable' | 'error'`) and `AcpProbeError` types, and `ThreadAcpOffer` gains `checkedAt?: string` and `lastError?: AcpProbeError` (US-007).
  - `AgentChoice` gains `probe?: AgentProbeState` (US-007):

    ```ts
    /** Why an unavailable ACP agent is not ready, from the eligible runners' offers (set only for notReady / notLoggedIn). */
    export interface AgentProbeState {
      /** The `lastError.code` of the offer with the latest `checkedAt` among the not-ready launchable offers (ties: first in runner order); null when that offer has none. */
      code: AcpProbeErrorCode | null
      /** That latest `checkedAt`; null when no such offer carries one (an older runner). */
      checkedAt: string | null
      /** Eligible runners whose launchable offer for this agent is not `loggedIn: true`, in runner order. */
      runnerIds: string[]
    }
    ```

  - `eligibleAgents` sets `probe` only on an unavailable ACP agent whose reason is `notReady` or `notLoggedIn`.
  - New `components/fleet/threads/AgentReadinessNotice.vue` (US-008), one per agent. Props: `choice: AgentChoice`, `canRecheck: boolean`, `rechecking: boolean`. Emits `recheck`. When `choice.probe` is set it renders, inside `data-testid="agent-readiness-<agent>"`:
    - the agent label and the reason line `fleet.threads.new.agent.probe.<code|unconfirmed|notLoggedIn>`;
    - `fleet.threads.new.agent.checkedAt` with `formatDateTime(checkedAt, locale)` when `checkedAt` is set;
    - a `Re-check` button (`data-testid="agent-recheck-<agent>"`) when `canRecheck`.
  - New `composables/useAgentRecheck.ts` (US-009): `useAgentRecheck(reload: () => Promise<void>, read: (agent: ThreadAgent) => AgentChoice | undefined, options?: { intervalMs?: number; attempts?: number })`, defaults 10 000 ms and 12 attempts. It returns `{ recheck(agent), rechecking: Ref<ThreadAgent | null> }`.
    - `recheck(agent)` posts `POST /fleet/runners/:id/reprobe` (no body) through `useApi()` for each id in `read(agent).probe.runnerIds`, then toasts `fleet.threads.new.agent.recheckRequested` through `useAppToast()`.
    - It then calls `reload()` every `intervalMs` until `read(agent)` has a `probe.checkedAt` different from its value before the click, or `read(agent).available` is true, or `attempts` reloads have run.
    - `rechecking` holds the agent from the click until then, and is null otherwise.
    - A rejected post toasts `extractApiError(error)` and stops.
    - It is created during page setup, never inside an async callback.
  - Both new-thread pages (US-009) render one `AgentReadinessNotice` for each agent in `agents` that has `probe`, under the backend picker, whichever agent is chosen. They import `AgentReadinessNotice` and `useAgentRecheck` explicitly.
    - `canRecheck` is `useGlobalPermissions().permissions.value.has('fleet.runner.update')`.
    - `reload` must not blank the runner list first, or `watch(agents)` would move the chosen agent: `pages/[project]/threads/new.vue` passes `options.load`; `pages/threads/new.vue` passes `() => runnerSummaries.load(<the slug its last loadRunners used>)`, not `loadRunners`.
    - The existing `thread-new-unavailable` paragraph is unchanged.

### Failure Handling

- An agent's probe misses its deadline: offer `loggedIn: null` with `lastError.code 'timeout'`. If a confirmed offer from the last 30 minutes is remembered, that offer is reported instead, with the new `lastError`.
- The agent process exits during initialize (`AGENT_SESSION_BACKEND_UNAVAILABLE`, e.g. a locked macOS keychain): `lastError.code 'unavailable'`, same carry-over.
- Any other open error, or a workdir/backend construction failure: `lastError.code 'error'`, same carry-over.
- The remembered offer is older than `ACP_LAST_GOOD_MAX_AGE_MS`: it is dropped, and the failed offer is reported.
- A stored or incoming offer with a malformed `checkedAt` or `lastError`: `parseAcpOffers` drops the whole list, and the report's `acp` list still stands.
- Re-check for an unknown runner id: 404 `fleet.runners`. Without `fleet.runner.update`: 403.
- An approval policy covers `fleet.runner.update`: the Re-check answers 202 pending, and the request is made once an approver approves it.
- Two syncs race for one request: exactly one response carries `reprobe: true`.
- A Re-check post fails: the form toasts `extractApiError(error)` and stops refreshing; the button is enabled again.
- The re-probe result never arrives (runner offline): after 12 reloads the form stops refreshing, and the notice shows whatever the last reload returned.

## Out of Scope

- The agent's error text (stderr) never leaves the runner, and the runner does not log it either: only the code travels and is logged. An operator reproduces a failure on the runner host.
- No change to `ACP_PROBE_TIMEOUT_MS`, `ACP_INITIALIZE_TIMEOUT_MS`, `capabilityProbeMs`, or to the concurrency of `NaxCapabilityProbe.probe`.
- Codex effort stays unselectable, as in `nax chat`: the probe does not turn `model[effort]` ids into efforts, and the session factory does not compose them.
- Threads already stored with a bracketed model id keep it; nothing migrates them.
- The admin runners page (`/admin/fleet/runners`) gets no Re-check button and shows no probe detail.
- `RunnerSummaryDto` does not expose `reprobeRequestedAt`.
- US-005 only: the reprobe route has no rate limit of its own beyond the global throttler. A repeated request only re-sets `reprobeRequestedAt`, and the runner's `CapabilityReporter` queues at most one extra probe.
- US-009 only: when the Re-check answers 202 (approval pending), the form treats it like a made request: same toast, same refreshes. It shows no approval state, and the re-probe happens only after approval.
- The offer memory is in-process: the first probe after a runner restart has no remembered offer.
- US-005 only: a sync response lost in transit after `takeReprobeRequest` cleared the column loses that request; the user presses Re-check again.
- US-006 only: a `reprobe: true` that arrives while a probe is running relies on `CapabilityReporter.refresh` queuing exactly one more, which its existing tests cover.
- `.nax/mono/apps/runner/context.md` and `.nax/mono/apps/web/context.md` notes about the offer memory and Re-check: a manual edit after merge, not story work.
- Checking the Re-check flow and the kept offers on koda-wk: a post-deploy manual check, not a story.
- F11 and F13 (readable names, dashboard rows), and the follow-up `e2e-1121-confirm-dialogs`: separate features.

## Stories

### US-001: Offer probe time and failure code on the wire

No dependencies. Workdir: `apps/api`.

Add `checkedAt`, `lastError`, `AcpProbeError`, `ACP_PROBE_ERROR_CODES` and `ACP_PROBE_TIME_RE` to `packages/fleet-protocol/src/threads.ts`, mirror the runtime values in `thread-jobs.ts`, teach `parseAcpOffer` the two keys, and add them to the `RunnerSummaryDto` schema, as in Design. Then run `bun run generate` from the repo root, so that `openapi.json` documents the new offer fields.

### US-002: Probe failure codes and probe time

Depends on US-001. Workdir: `apps/runner`.

In `acp-agent-probe.ts`, add the `now` dep, stamp `checkedAt` on every offer and classify a failed probe into `lastError`, as in Design.

### US-003: Bare model ids, as nax chat lists them

Depends on US-002. Workdir: `apps/runner`.

Replace `offeredModels` in `acp-agent-probe.ts` with the `nax chat` bare-id rule, as in Design. It depends on US-002 because both edit the same file.

### US-004: Keep the last confirmed offer and log probe failures

Depends on US-002. Workdir: `apps/runner`.

Add `acp-offer-memory.ts` (`createAcpOfferMemory`, `ACP_LAST_GOOD_MAX_AGE_MS`), wrap the run command's probe with it, and add the ACP warnings to `NaxCapabilityProbe.acpAgents`, as in Design.

### US-005: Re-probe request route and sync delivery

No dependencies. Workdir: `apps/api`.

Add `SyncResponse.reprobe` to `packages/fleet-protocol/src/index.ts` (types only), the `reprobeRequestedAt` migration and schema field, `requestReprobe` on the runner repository and service (with its audit entry), the `POST /fleet/runners/:id/reprobe` route, and the sync delivery, as in Design. Then run `bun run generate` from the repo root for the new route.

### US-006: Runner re-probes on request

Depends on US-005. Workdir: `apps/runner`.

Add `onReprobe` to `SyncLoopDeps`, call it from the sync loop, and wire it in `startDaemon`, as in Design.

### US-007: Not-ready reason, last check and Re-check runners in the agent choices

Depends on US-001. Workdir: `apps/web`.

Add the probe types and offer fields to `thread-types.ts`, add `AgentProbeState` and `probe` to `eligibleAgents`, and add the `fleet.threads.new.agent.probe.*`, `checkedAt`, `recheck`, `recheckRequested` and `rechecking` keys in en and zh, as in Design.

### US-008: Agent readiness notice component

Depends on US-007. Workdir: `apps/web`.

Add `components/fleet/threads/AgentReadinessNotice.vue`, as in Design.

### US-009: Re-check on both new-thread pages

Depends on US-005, US-008. Workdir: `apps/web`.

Add `composables/useAgentRecheck.ts`, and render one `AgentReadinessNotice` per not-ready agent on `pages/[project]/threads/new.vue` and `pages/threads/new.vue`, as in Design.

### Context Files

**US-001**
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseAcpOffer`, `parseAcpOffers`
- `apps/api/src/fleet/common/capabilities-thread.spec.ts` — offer parsing tests to extend
- `apps/api/src/fleet/common/thread-jobs.ts` — runtime mirrors of protocol constants
- `apps/api/src/fleet/runners/dto/runner-summary.dto.ts` — `threadBackends` schema and `from`
- `packages/fleet-protocol/src/threads.ts` — `ThreadAcpOffer`, `ACP_OFFER_LIMITS`

**US-002**
- `apps/runner/src/capabilities/acp-agent-probe.ts` — `probeAgent`, `withinDeadline`
- `apps/runner/src/capabilities/acp-agent-probe.spec.ts` — its `harness`, `HarnessInput` and `offerFor` helpers
- `apps/runner/src/thread/session-factory.ts` — `agentSessionCode`

**US-003**
- `apps/runner/src/capabilities/acp-agent-probe.ts` — `offeredModels`, `MAX_OFFERED_MODELS`
- `apps/runner/src/capabilities/acp-agent-probe.spec.ts` — its `harness` helper

**US-004**
- `apps/runner/src/capabilities/nax-probe.ts` — `acpAgents`, the `acp` list rule
- `apps/runner/src/capabilities/nax-probe.spec.ts` — the ACP tests (AC-10 to AC-12)
- `apps/runner/src/commands/run.ts` — where the daemon gets its `acpProbe`
- `apps/runner/src/commands/run.spec.ts` — `harness` capturing `started` options

**US-005**
- `apps/api/src/fleet/sync/sync.service.ts` — the idle wait and the response
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `recordRunnerSync`, `findPendingCommands`
- `apps/api/src/fleet/runners/runners.service.ts` — `update` (transaction, audit, notifier)
- `apps/api/src/fleet/runners/runner-route.commands.ts` — `RUNNER_ROUTE_VARIANTS`, the `update` route command
- `apps/api/src/fleet/runners/runners.controller.ts` — the gated `update` route
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — `SyncService` unit construction

**US-006**
- `apps/runner/src/sync/sync-loop.ts` — response handling next to `onArchivedThreads`
- `apps/runner/src/sync/sync-loop.spec.ts` — fake client precedent
- `apps/runner/src/daemon/daemon.ts` — `reprobe`, the sync-loop deps
- `apps/runner/test/unit/daemon.spec.ts` — `fakeServer` and its hard-coded sync response

**US-007**
- `apps/web/lib/thread-create.ts` — `eligibleAgents`, `AgentChoice`
- `apps/web/lib/thread-types.ts` — `ThreadAcpOffer`
- `apps/web/tests/lib/thread-create-agents.spec.ts` — runner fixtures for agent choices
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the reason-key pins

**US-008**
- `apps/web/components/fleet/threads/BackendPicker.vue` — agent labels and reason keys
- `apps/web/lib/format-date-time.ts` — `formatDateTime`
- `apps/web/tests/components/thread-backend-picker.spec.ts` — component mount precedent with `enI18n`

**US-009**
- `apps/web/pages/[project]/threads/new.vue` — `agents`, `options.load`, `watch(agents)`
- `apps/web/pages/threads/new.vue` — `agents`, `loadRunners`, the setup-time composable note
- `apps/web/composables/usePermissions.ts` — `useGlobalPermissions`
- `apps/web/tests/helpers/permission-nav.ts` — `globalPermissionsStub`
- `apps/web/tests/pages/threads-new-page.spec.ts` — page mount precedent

### Creates

**US-004**
- `apps/runner/src/capabilities/acp-offer-memory.ts`
- `apps/runner/src/capabilities/acp-offer-memory.spec.ts`

**US-005**
- `apps/api/prisma/migrations/20261218090000_runner_reprobe_request/migration.sql`
- `apps/api/src/fleet/sync/sync-reprobe.spec.ts`
- `apps/api/test/integration/fleet/runner-reprobe.integration.spec.ts`

**US-008**
- `apps/web/components/fleet/threads/AgentReadinessNotice.vue`
- `apps/web/tests/components/agent-readiness-notice.spec.ts`

**US-009**
- `apps/web/composables/useAgentRecheck.ts`
- `apps/web/tests/composables/use-agent-recheck.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/common/thread-jobs.spec.ts` — add a pin that the mirrored `ACP_PROBE_ERROR_CODES` and `ACP_PROBE_TIME_RE` equal the package's, as the existing mirror pins do. Every existing pin stays.
- `openapi.json` — regenerated by `bun run generate` for the `checkedAt` and `lastError` offer fields.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.

**US-002**
- `apps/runner/src/capabilities/acp-agent-probe.spec.ts` — add a `now` clock to `HarnessInput` and `harness`, passed as the new `now` dep (fixed at `2026-11-22T02:00:00.000Z`). The whole-offer `toEqual` assertions of tests AC-1, AC-2, AC-5, AC-15, AC-6 and AC-7 ("a session that opens after its timeout is closed when it settles") gain `checkedAt` equal to that clock's ISO time. The failed-probe ones also gain `lastError`: AC-15 claude `{ code: 'error', at }`, AC-6 and AC-7 claude `{ code: 'timeout', at }`. The invariant is unchanged: launchability, login state and the lists are as before.

**US-003**
- `apps/runner/src/capabilities/acp-agent-probe.spec.ts` — test AC-3 offers the claude agent `gpt-5.5[context=272k,reasoning=medium]` and expects it kept. Claude now drops bracketed ids, so the expected list becomes `['claude-sonnet-4-5']`. The invariant that an id failing `ACP_MODEL_ID_RE` is dropped while valid ones are kept still holds.

**US-004**
- `apps/runner/src/commands/run.spec.ts` — test "US-002 AC-13" expects the daemon's `acpProbe` to be `probeAcpAgents` itself. The daemon now gets the memory wrapper, so the test changes to this story's run-command AC: with an injected base probe, the started daemon's `acpProbe` reports the remembered offer after a timeout. The invariant: the production runner still probes ACP agents through `probeAcpAgents` when no base probe is injected.

**US-005**
- `apps/api/prisma/schema.prisma` — `reprobeRequestedAt DateTime?` on `model Runner`.
- `apps/api/src/fleet/runners/runner-route.commands.spec.ts` — test "AC-13: registers both matching variants" asserts `RUNNER_ROUTE_VARIANTS` has length 2. It becomes 3, and the test also asserts the `fleet.runner.update` key with variant `rest:fleet-runners.reprobe` is registered. The update and delete checks stay.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — "AC-12 (US-007): collects exactly 149 gated routes" becomes 150 for the gated reprobe route, with the history comment above it extended. Every other assertion stays.
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — add an entry for method post, path /api/fleet/runners/{id}/reprobe to `gatedOperations` and change the gated-operation count from 149 to 150 in the `describe` title and in "AC-5: 202 responses exist on exactly the 149 gated operations". The invariant: 202 responses exist on exactly the gated operations.
- `apps/api/src/fleet/runners/runners.service.spec.ts` — add the `requestReprobe` cases next to the existing `update` tests; every existing case stays.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — add a row for path /api/fleet/runners/{id}/reprobe, method post, key fleet.runner.update to the documented-routes table; every existing row stays.
- `openapi.json` — regenerated by `bun run generate` for the new route.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated by `bun run generate` for the new route; never hand-edited.

**US-006**
- `apps/runner/test/unit/daemon.spec.ts` — add an optional `reprobe` knob to `fakeServer` that puts `reprobe: true` on one chosen sync response. With the knob unset every response is as today, so every existing test stays unchanged.

**US-007**
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — add the new `fleet.threads.new.agent.probe.*`, `checkedAt`, `recheck`, `recheckRequested` and `rechecking` keys to its pinned list. Every existing pin stays.
- `apps/web/i18n/locales/en.json` — add the new `fleet.threads.new.agent.*` keys.
- `apps/web/i18n/locales/zh.json` — add the new `fleet.threads.new.agent.*` keys.

**US-008**
None. The component is new, and no existing test mounts it.

**US-009**
- `apps/web/tests/pages/threads-new-page.spec.ts` — the page now calls `useGlobalPermissions()`, which the mount harness leaves undefined unless supplied. Add `useGlobalPermissions: globalPermissionsStub()` to the mount globals; every existing assertion stays.
- `apps/web/tests/pages/workspace-threads-new-page.spec.ts` — the same `useGlobalPermissions` global, plus a `useAppToast` double, because `useAgentRecheck` calls `useAppToast()` at setup. Every existing assertion stays.
- `apps/web/tests/pages/project-permission-gates.spec.ts` — `mountNewThreadPage` gains the same `useGlobalPermissions` global; every existing assertion stays.

### Seams

- US-001 -> US-007: the web reads `checkedAt` and `lastError` exactly as `RunnerSummaryDto` returns them (US-007 ACs use offers in that shape).
- US-002 -> US-004: the memory wraps the real probe's offer shape (`checkedAt`, `lastError`); the run-command AC runs the wrapper the daemon really gets.
- US-004 internal: `NaxCapabilityProbe` keeps a remembered offer in `acp`.
- US-005 -> US-006: the runner acts on `response.reprobe === true`.
- US-005 -> US-009: the form posts `POST /fleet/runners/:id/reprobe` with no body, once per runner id.
- US-007 -> US-008 and US-009: the notice and the Re-check read `AgentChoice.probe` from the real `eligibleAgents` on the page.

## Acceptance Criteria

### US-001

`offer()` below is `{ agent: 'codex', launchable: true, loggedIn: true, models: [], efforts: [] }`.

1. [unit] `parseAcpOffers([{ ...offer(), checkedAt: '2026-11-22T02:00:00.000Z' }])` returns one offer whose `checkedAt` is `'2026-11-22T02:00:00.000Z'`.
2. [unit] `parseAcpOffers([{ ...offer(), loggedIn: null, lastError: { code: 'timeout', at: '2026-11-22T02:00:00.000Z' } }])` returns one offer whose `lastError` is `{ code: 'timeout', at: '2026-11-22T02:00:00.000Z' }`.
3. [unit] `parseAcpOffers` accepts `lastError.code` `'unavailable'` and `'error'`, each returning an offer with that code.
4. [unit] `parseAcpOffers` with `lastError.code` `'oops'` returns null.
5. [unit] `parseAcpOffers` with `lastError` `{ code: 'timeout', at: '2026-11-22T02:00:00.000Z', detail: 'x' }` returns null.
6. [unit] `parseAcpOffers` with `checkedAt` `'not-a-date'` returns null.
7. [unit] `parseAcpOffers` with `checkedAt` `1732240800000` (a number) returns null.
8. [unit] `parseAcpOffers` with `checkedAt` `'2026-11-22T02:00:00.0000000000Z'` (ten fraction digits) returns null.
9. [unit] `parseAcpOffers` with `lastError.at` `'2026-13-45T99:00:00.000Z'` (ISO shape, impossible date) returns null.
10. [unit] `parseAcpOffers([offer()])` (no new keys) returns one offer that has neither a `checkedAt` nor a `lastError` key.
11. [unit] `parseCapabilities` of a valid report whose `threadBackends` is `{ native: [], acp: ['codex'], acpOffers: [{ ...offer(), checkedAt: 'x' }] }` returns `threadBackends.acp` `['codex']` and no `acpOffers` key.
12. [unit] `RunnerSummaryDto.from` on a runner at protocol 4 whose stored `capabilities.threadBackends.acpOffers` holds an offer with `checkedAt` and `lastError` returns `threadBackends.acpOffers[0]` carrying both, unchanged.
13. [unit] The `ACP_PROBE_ERROR_CODES` mirror in `thread-jobs.ts` equals `['timeout', 'unavailable', 'error']`.

### US-002

The harness clock returns `2026-11-22T02:00:00.000Z`; `at` below is that ISO string.

1. [unit] `probeAcpAgents` with a launchable claude whose session opens returns a claude offer with `loggedIn: true`, `checkedAt` `at` and no `lastError` key.
2. [unit] A launchable claude whose open never settles before `ACP_PROBE_TIMEOUT_MS` (fake timers) yields `loggedIn: null` and `lastError` `{ code: 'timeout', at }`.
3. [unit] An open that rejects with an error whose `agentSessionCode` is `AGENT_SESSION_BACKEND_UNAVAILABLE` yields `loggedIn: null` and `lastError` `{ code: 'unavailable', at }`.
4. [unit] An open that rejects with a plain `Error('boom')` yields `loggedIn: null` and `lastError` `{ code: 'error', at }`.
5. [unit] A `makeWorkdir` that throws yields `launchable: true` and `lastError` `{ code: 'error', at }`.
6. [unit] An open that rejects with `AGENT_SESSION_AUTH_REQUIRED` yields `loggedIn: false` and no `lastError` key.
7. [unit] An agent the launch check reports as not installed yields `launchable: false`, `checkedAt` `at` and no `lastError` key.
8. [unit] Without a `now` dep, a launchable claude whose session opens yields a `checkedAt` that `Date.parse` reads as a time within 5 s of the test's own clock.

### US-003

1. [unit] A claude session offering models `['claude-sonnet-4-5', 'claude-sonnet-4-5[1m]', 'opus']` yields `models` `['claude-sonnet-4-5', 'opus']`.
2. [unit] A codex session offering `['gpt-6.1-terra', 'gpt-6.1-terra[low]', 'gpt-6.1-terra[high]', 'gpt-6-luna', 'gpt-6-luna']` yields `models` `['gpt-6.1-terra', 'gpt-6-luna']`.
3. [unit] A cursor session offering `['default[]', 'grok-4.7[context=256k,fast=true]', 'composer-2.5[fast=true]', 'composer-2.5[fast=false]', 'gemini-3.1-pro']` yields `models` `['default', 'grok-4.7', 'gemini-3.1-pro']`.
4. [unit] A cursor session offering `['gemini-3.1-pro', 'gemini-3.1-pro[reasoning_effort=high]', 'gpt-5.5[a=1]']` yields `models` `['gpt-5.5']`.
5. [unit] A codex session offering 40 bare ids `model-0` to `model-39`, each followed by its `[low]` variant, yields `models` equal to `model-0` to `model-31`.
6. [unit] A claude session offering `['claude-sonnet-4-5', 'bad model!']` yields `models` `['claude-sonnet-4-5']`.
7. [unit] A codex session offering efforts `['low', 'high']` yields `efforts` `['low', 'high']`.

### US-004

`T1` is `2026-11-22T02:00:00.000Z`. `confirmed(t, agent = 'codex')` is `{ agent, launchable: true, loggedIn: true, models: ['gpt-6-luna'], efforts: [], checkedAt: t }`. `failed(code, t)` is `{ agent: 'codex', launchable: true, loggedIn: null, models: [], efforts: [], checkedAt: t, lastError: { code, at: t } }`. In the `createAcpOfferMemory` ACs the wrapper's `now` always equals the `checkedAt` of the offer the probe returns on that call.

1. [unit] `createAcpOfferMemory` over a probe answering `[confirmed(T1)]` returns `[confirmed(T1)]`.
2. [unit] Over a probe answering `[confirmed(T1)]` then `[failed('timeout', T1 + 10 min)]`, the second call returns `{ ...confirmed(T1), lastError: { code: 'timeout', at: T1 + 10 min } }`.
3. [unit] The same with `failed('unavailable', T1 + 10 min)` returns the remembered offer with `lastError.code` `'unavailable'`.
4. [unit] Over `[confirmed(T1)]` then `[failed('timeout', T1 + ACP_LAST_GOOD_MAX_AGE_MS + 1 min)]`, the second call returns that failed offer unchanged, and `ACP_LAST_GOOD_MAX_AGE_MS` is `1_800_000`.
5. [unit] Over `[confirmed(T1)]` then `[failed('timeout', T1 + 30 min)]` (exactly `ACP_LAST_GOOD_MAX_AGE_MS`), the second call returns the remembered offer with `lastError.code` `'timeout'`.
6. [unit] Over `[confirmed(T1)]`, `[failed('timeout', T1 + 31 min)]`, then `[failed('timeout', T1 + 32 min)]`, the third call returns `failed('timeout', T1 + 32 min)` unchanged.
7. [unit] Over `[confirmed(T1)]`, a codex offer with `loggedIn: false` at `T1 + 5 min`, then `[failed('timeout', T1 + 10 min)]`, the third call returns `failed('timeout', T1 + 10 min)` unchanged.
8. [unit] Over `[confirmed(T1)]`, a codex offer with `launchable: false` at `T1 + 5 min`, then `[failed('timeout', T1 + 10 min)]`, the third call returns `failed('timeout', T1 + 10 min)` unchanged.
9. [unit] Over `[confirmed(T1)]`, `[{ ...confirmed(T1 + 10 min), models: ['gpt-6.1-sol'] }]`, then `[failed('error', T1 + 20 min)]`, the third call returns an offer with `models` `['gpt-6.1-sol']` and `checkedAt` `T1 + 10 min`.
10. [unit] Over a probe answering `confirmed(T1, 'claude')` and `confirmed(T1)`, then `{ ...failed('timeout', T1 + 10 min), agent: 'claude' }` and `confirmed(T1 + 10 min)`, both at `T1 + 10 min`, the second call's claude offer has `loggedIn: true` and a `lastError`.
11. [unit] `NaxCapabilityProbe.probe` with an `acpProbe` answering `{ ...confirmed(T1), lastError: { code: 'timeout', at: T1 } }` reports `threadBackends.acp` containing `'codex'`.
12. [unit] The same probe's warnings include `ACP agent codex probe failed (timeout); reporting the offer confirmed at 2026-11-22T02:00:00.000Z`.
13. [unit] `NaxCapabilityProbe.probe` with an `acpProbe` answering a cursor offer with `loggedIn: null` and `lastError.code` `'unavailable'` reports warnings including `ACP agent cursor is not ready: probe unavailable`.
14. [unit] `runCommand` with `RunDeps.acpProbe` answering first `[confirmed(c)]` and then `[failed('timeout', f)]`, where `c` and `f` are the real clock's ISO time at each call, starts the daemon with an `acpProbe` whose second call returns a codex offer with `loggedIn: true` and `lastError.code` `'timeout'`.
15. [unit] `runCommand` with no `RunDeps.acpProbe` starts the daemon with an `acpProbe` that is a function.

### US-005

1. [integration] `POST /api/fleet/runners/:id/reprobe` as a global admin (no approval policy) returns 200 with `data.requestedAt` an ISO time, and the runner row's `reprobeRequestedAt` equals it.
2. [integration] `POST /api/fleet/runners/:id/reprobe` for an unknown id returns 404.
3. [integration] `POST /api/fleet/runners/:id/reprobe` as a user without `fleet.runner.update` returns 403, and the runner row's `reprobeRequestedAt` stays null.
4. [integration] After a reprobe request, `POST /api/fleet/runner/sync` with that runner's key returns `reprobe: true`, and the row's `reprobeRequestedAt` is null afterwards.
5. [integration] After a reprobe request and one sync that returned `reprobe: true`, the next `POST /api/fleet/runner/sync` returns a body with no `reprobe` key.
6. [integration] A successful reprobe request leaves one audit row with key `fleet.runner.update` and resource id the runner's id.
7. [unit] `SyncService.sync` (new `sync-reprobe.spec.ts`, fleet-job repository mock with `findPendingCommands` resolving `[]`, `takeReprobeRequest` resolving `false`) for an idle request with `hasPendingReprobe` resolving `true` calls `RunnerNotifier.wait` with a `ready` predicate that resolves true.
8. [unit] `SyncService.sync` with `takeReprobeRequest` resolving `true` returns `reprobe: true`.
9. [unit] `SyncService.sync` with `takeReprobeRequest` resolving a non-boolean truthy value (`{}`) returns a response with no `reprobe` key.
10. [unit] `RunnersService.requestReprobe('u1', 'r1')` with the repository's `requestReprobe` resolving true calls `RunnerNotifier.notify` with `'r1'`.
11. [unit] `RunnersService.requestReprobe('u1', 'missing')` with the repository's `requestReprobe` resolving false rejects with `NotFoundAppException` and never calls `RunnerNotifier.notify`.
12. [unit] `RunnerRouteCommands`, after `onModuleInit`, has the route command for key `fleet.runner.update` and variant `rest:fleet-runners.reprobe`, and its `run` with input `{ id: 'r1' }` and principal `u1` calls `RunnersService.requestReprobe('u1', 'r1')`.
13. [integration] `PrismaFleetJobRepository.takeReprobeRequest` called twice at once (`Promise.all`) for a runner with a pending request resolves exactly one `true` and one `false`.

### US-006

1. [unit] `SyncLoop` whose client answers one sync with `reprobe: true` calls `onReprobe` exactly once for that response.
2. [unit] `SyncLoop` whose client answers a sync without `reprobe` never calls `onReprobe`.
3. [unit] `SyncLoop` whose client answers `reprobe: true` with no `onReprobe` dep completes the sync and hands the response's `commands` to `handleCommands`.
4. [integration] `startDaemon` with an injected `acpProbe` counting its calls and `fakeServer`'s `reprobe` knob on its second sync response: the probe's call count after that response is one more than before it, without waiting for `capabilityProbeMs`.

### US-007

The runner fixtures are online, enabled and REPO-capable. `t1` is `2026-11-22T02:00:00.000Z` and `t2` is `2026-11-22T02:10:00.000Z`.

1. [unit] `eligibleAgents` with runner `r1` (codex not in `acp`, offer `launchable: true, loggedIn: null, checkedAt: t1, lastError: { code: 'timeout', at: t1 }`) returns codex with `reason` `'notReady'` and `probe` `{ code: 'timeout', checkedAt: t1, runnerIds: ['r1'] }`.
2. [unit] With `r1` (codex offer `loggedIn: null, checkedAt: t1, lastError: { code: 'timeout', at: t1 }`) and `r2` (codex not in `acp`, offer `loggedIn: null, checkedAt: t2, lastError: { code: 'unavailable', at: t2 }`), codex's `probe` is `{ code: 'unavailable', checkedAt: t2, runnerIds: ['r1', 'r2'] }`.
3. [unit] With `r1` whose codex offer is `loggedIn: false` with `checkedAt: t1` and no `lastError`, codex has `reason` `'notLoggedIn'` and `probe` `{ code: null, checkedAt: t1, runnerIds: ['r1'] }`.
4. [unit] With `r1` whose codex offer is `loggedIn: null` with neither `checkedAt` nor `lastError` (an older runner), codex's `probe` is `{ code: null, checkedAt: null, runnerIds: ['r1'] }`.
5. [unit] With `r1` listing codex in `acp` (offer `loggedIn: true`, `lastError` present), codex is available and has no `probe` key.
6. [unit] With no eligible runner offering cursor as launchable, cursor has `reason` `'notInstalled'` and no `probe` key.
7. [unit] With `r1` (codex in `acp`, offer `loggedIn: true`) and `r2` (codex offer `loggedIn: null`), codex is available and has no `probe` key.
8. [unit] For each locale (`en`, `zh`), every key in the list `fleet.threads.new.agent.probe.timeout`, `.probe.unavailable`, `.probe.error`, `.probe.unconfirmed`, `.probe.notLoggedIn`, `fleet.threads.new.agent.recheck`, `.recheckRequested`, `.rechecking` and `.checkedAt` is a non-empty string, and `fleet.threads.new.agent.checkedAt` contains `{time}`.

### US-008

The component is mounted with the real English translator (`enI18n()` from the web test helpers) and locale `en`. `choice` is a codex `AgentChoice` with `available: false`, `reason: 'notReady'` and `probe` `{ code: 'timeout', checkedAt: '2026-11-22T02:00:00.000Z', runnerIds: ['r1', 'r2'] }`.

1. [unit] `AgentReadinessNotice` mounted with `choice`, `canRecheck: true` and `rechecking: false` renders, inside `agent-readiness-codex`, the en `fleet.threads.new.agent.probe.timeout` text.
2. [unit] The same mount renders the en `fleet.threads.new.agent.checkedAt` text with `time` equal to `formatDateTime('2026-11-22T02:00:00.000Z', 'en')`.
3. [unit] With a `probe` whose `code` is null and reason `'notReady'`, it renders the en `fleet.threads.new.agent.probe.unconfirmed` text.
4. [unit] With a `probe` whose `code` is null and reason `'notLoggedIn'`, it renders the en `fleet.threads.new.agent.probe.notLoggedIn` text.
5. [unit] With a `probe` whose `checkedAt` is null, it renders no `checkedAt` text.
6. [unit] With `canRecheck: false`, it renders no `agent-recheck-codex` button.
7. [unit] Clicking `agent-recheck-codex` emits `recheck` once.
8. [unit] With `rechecking: true` the `agent-recheck-codex` button is disabled and shows the en `fleet.threads.new.agent.rechecking` text.
9. [unit] A `choice` with no `probe` renders no `agent-readiness-codex` element.

### US-009

`codexChoice(checkedAt)` is a codex `AgentChoice` with `available: false`, `reason: 'notReady'` and `probe` `{ code: 'timeout', checkedAt, runnerIds: ['r1', 'r2'] }`. `T0` is `'2026-11-22T02:00:00.000Z'`.

1. [unit] `useAgentRecheck(reload, read).recheck('codex')` with `read('codex')` returning `codexChoice(T0)` calls `$api.post` with `/fleet/runners/r1/reprobe` and then `/fleet/runners/r2/reprobe`, each with no body.
2. [unit] The same call toasts `fleet.threads.new.agent.recheckRequested` once.
3. [unit] With fake timers and `intervalMs` 10 000: when `read('codex')` returns `codexChoice(T0)` after the first reload and `codexChoice('2026-11-22T02:05:00.000Z')` after the second, `reload` is called exactly twice and `rechecking.value` is null afterwards.
4. [unit] When `read('codex')` returns an available codex choice after the first reload, `reload` is called exactly once.
5. [unit] When `read('codex')` keeps returning `codexChoice(T0)`, `reload` is called exactly 12 times and `rechecking.value` is null afterwards.
6. [unit] After `recheck('codex')` posted and before its first reload resolves, `rechecking.value` is `'codex'`.
7. [unit] When the first `$api.post` rejects with an `ApiError`, `useAgentRecheck` toasts `extractApiError(error)`, makes no second post, never calls `reload`, and `rechecking.value` is null afterwards.
8. [integration] `pages/[project]/threads/new.vue` mounted with one runner summary `r1` (online, enabled, REPO-capable, native model `m1`, codex not in `acp`, codex offer `launchable: true, loggedIn: null, checkedAt: T0, lastError: { code: 'timeout', at: T0 }`) and `fleet.runner.update` granted globally renders `agent-readiness-codex` with the timeout text while the chosen agent is native.
9. [integration] On that mount, clicking `agent-recheck-codex` posts `/fleet/runners/r1/reprobe`.
10. [integration] On that mount with fake timers, after the click and an advance of 10 000 ms, the runner list has been reloaded through `options.load` (one more runners request than before the click) and the chosen agent is still native.
11. [integration] `pages/threads/new.vue` mounted with the same runner summary for its home project, without `fleet.runner.update`, renders `agent-readiness-codex` with the timeout text and no `agent-recheck-codex` button.
12. [integration] `pages/[project]/threads/new.vue` mounted with a runner whose codex is in `acp` renders no `agent-readiness-codex` element.
