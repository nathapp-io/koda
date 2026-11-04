<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Thread agents and modes (nax chat parity)

Closes: #368, #369

## Summary

koda threads reach parity with `nax chat`. A thread can run on any of four agents: koda's native agent, and Claude
Code, Codex and Cursor over ACP (`@nathapp/nax-agent-acp` 0.91.7 `acpBackend`). A thread runs in one of three modes,
`read` (today's behaviour, the default), `ask` (the agent may edit files and run commands, and every mutating action
waits for an Approve/Deny decision in the thread) and `full` (no prompts). The mode can change between turns. Who may
use `ask` and `full` is governed by two new configurable permission keys, `thread.mode.ask` and `thread.mode.full`.
Runners advertise which ACP agents they can start and their models; the web new-thread form offers only those. In
`ask` and `full`, publishing a thread commits its code changes too, not only docs.

## Motivation

A koda thread can only use the native agent and can only read code and write docs: `ThreadSessionFactory.open`
refuses every ACP backend with `backend_unavailable` and hard-codes `profile: 'read'`
(`apps/runner/src/thread/session-factory.ts:89,116`), and the runner advertises `acp: []` unconditionally
(`apps/runner/src/capabilities/nax-probe.ts:167`). To get code changes a person must dispatch a fleet RUN. `nax chat`
already offers all four agents with read/ask/full modes on one machine. The user has not started using koda day to
day; this slice is what makes threads worth using. Design: `docs/superpowers/specs/2026-11-04-thread-agents-and-modes-design.md`
(approved 2026-11-04).

## Design

### User rulings (2026-11-04)

- One spec for #368 + #369; #371 (credential vault) is its own later spec.
- Bar: parity with `nax chat`. All four agents. Modes `read`, `ask`, `full`; `full` included.
- ACP agents run unsandboxed on the runner host in every mode, exactly as `nax chat` opens them (`acpBackend({ agent,
  allowUnsandboxed: true, inheritEnv: true, model?, effort? })`, no sandbox option). Accepted by the user.
- Mode changes between turns. Permissions follow koda's configurable keys; default for `full` is owner and project
  admin.
- nax#2444 is done: `acpBackend` serves the session's declared tools over its loopback tool host, so ACP agents get
  koda's thread tools and are allowed on REPO, PROJECT and WORKSPACE threads.

### Integration

Read-only symbols (verified on `feat/thread-agents-modes` = main `7093ced1` + docs):

- `ThreadSessionFactory.open(input: OpenThreadSessionOptions): Promise<OpenThreadSessionResult>`
  (`apps/runner/src/thread/session-factory.ts:84`); `OpenThreadSessionOptions { jobId; thread: ThreadAssign; worktree;
  tools: CreateAgentSessionOptions['tools']; approvalTimeoutSec }`; it maps `AGENT_SESSION_AUTH_REQUIRED` to
  `agent_not_logged_in` and `AGENT_SESSION_BACKEND_UNAVAILABLE` to `backend_unavailable` (`:60-61`) and resumes with
  `resumeAgentSession`, falling back to `createAgentSession` on `AGENT_SESSION_NOT_FOUND` (`:126-144`).
- `ThreadJobRun` opens the session with the thread tools `[...buildThreadTools(...), ...this.kodaToolProxies(thread)]`
  (`apps/runner/src/thread/thread-job-run.ts:325-344`, PROJECT path `:397`).
- Each turn is a THREAD job: `createThreadJob` creates the job and a `FleetThreadTurn` row snapshotting `backend`,
  `skills`, `instructions` and `resume` (`apps/api/src/fleet/threads/prisma-chat-thread.repository.ts:513-536`);
  `findThreadAssign(jobId)` builds the `ThreadAssign` from that row (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:274-291`).
  Messages to a live session go as `THREAD_INPUT`; `command(scope, threadId, userId, type, payload, canOperate)`
  (`prisma-chat-thread.repository.ts:195-235`) sends `THREAD_ANSWER`, `THREAD_STOP_TURN`, `THREAD_CLOSE` to the
  thread's RUNNING job.
- Route gating: thread routes run through `this.routeGate.run({ key, variant: THREAD_ROUTE_VARIANTS.<x>, ... })` with
  `@Requires(key)` and `@ApprovalGated()`; precedent `PATCH :id` (`thread.cap.update`, `threads.controller.ts:91-98`)
  and `POST :id/answer` (`thread.answer`, `:175-187`); workspace equivalents in `workspace-threads.controller.ts`
  (`PATCH :id` `:136-143`, `POST :id/answer` `:187`), variants in `thread-route.commands.ts:13-25` and
  `workspace-thread-route.commands.ts:11+`.
- Service-level key check precedent: `this.permissions.can(principal, key, { projectId })`
  (`apps/api/src/fleet/threads/workspace-threads.service.ts:190,199`).
- `acpBackend`, `launchCandidateKind`, `isAgentLaunchable` from `@nathapp/nax-agent-acp/client` 0.91.7;
  `AcpAgentName` includes `claude | codex | cursor`. `AnswerReply = { decision: 'allow' | 'deny' } | { text }` and the
  `approval_requested` session event `{ requestId; callId?; tool; summary; command?; reason; expiresAt;
  unsandboxed?: true; answerable?: false }` from `@nathapp/nax-agent` 0.91.7.
- `nax chat` reference (nax `f5902e425`): agent probe `chat/acp/acp-probe.ts` (tool-less memory-only `ask` session,
  read `backend.capabilities`, 20 s timeout), installed check `launchCandidateKind`, ACP open options
  `chat/acp/acp-session-options.ts:61-68`.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `ThreadAgent` (`packages/fleet-protocol/src/threads.ts:12`). Baseline: `'claude' | 'codex'`. Target:
  `'claude' | 'codex' | 'cursor'`.
- `ThreadBackends` (`threads.ts:26`). Baseline: `{ native: string[]; acp: ThreadAgent[] }`. Target: `{ native:
  string[]; acp: ThreadAgent[]; acpOffers?: ThreadAcpOffer[] }`, where `acp` lists the agents that are launchable AND
  logged in (placement keeps `acp.includes(agent)`), and new `ThreadAcpOffer { agent: ThreadAgent; launchable:
  boolean; loggedIn: boolean | null; models: string[]; efforts: string[] }` (`loggedIn: null` = not yet probed).
- New `ThreadMode = 'read' | 'ask' | 'full'` in `threads.ts`; `ThreadAssign` gains `mode?: ThreadMode` (absent means
  `read`).
- `ThreadAnswerPayload` (`threads.ts:97`). Baseline: `{ requestId: string; text: string }`. Target: `{ requestId:
  string; text: string } | { requestId: string; decision: 'allow' | 'deny' }`.
- `ThreadRunnerLine` gains `{ type: 'mode_applied'; at: string; mode: ThreadMode }` (written once per session open).
- `parseThreadBackends` (`apps/api/src/fleet/common/capabilities-core.ts:64-80`). Baseline: exactly two keys,
  `THREAD_AGENTS = ['claude', 'codex']`. Target: `THREAD_AGENTS` adds `cursor`; an optional `acpOffers` array (at most
  `THREAD_LIMITS.maxAcpAgents` entries, each agent once, `models` at most `maxNativeModels` ids matching
  `THREAD_MODEL_ID_RE`, `efforts` at most 8 short strings) is kept when valid and dropped when malformed (the rest of
  the report is still accepted).
- The create normalisers in `apps/api/src/fleet/threads/thread-input.ts` (REPO/PROJECT, `:72-79`, and
  `validateCreateWorkspaceThread` for WORKSPACE). Baseline: `acp` agent must be `claude|codex`; PROJECT (and WORKSPACE) is
  native-only. Target: `acp` agent may be `claude|codex|cursor` on every kind; an optional `mode` (`read|ask|full`,
  default `read`) is accepted.
- Prisma `ChatThread` gains `mode String @default("read")`; `FleetThreadTurn` gains `mode String @default("read")`;
  `ChatThread` gains `pendingApprovals Json?` (list of pending session approvals). Migration
  `20261124090000_thread_modes`.
- `ApprovalRequestedThreadLine` (`apps/api/src/fleet/threads/ingest/thread-line.ts:71-75`). Baseline: `{ type;
  requestId; callId? }`. Target: also keeps `tool`, `summary`, `command?`, `reason`, `expiresAt`, `unsandboxed?`,
  `answerable` (each bounded like the existing string fields; malformed optional fields are dropped, a missing
  `tool`/`summary`/`expiresAt` keeps today's minimal line).
- `ThreadDto` (`apps/api/src/fleet/threads/dto/thread.dto.ts:9`) gains `mode: ThreadMode` and `pendingApprovals:
  ThreadPendingApprovalDto[]`; `CreateThreadDto` gains optional `mode`.
- `publishThreadDocs` (`apps/runner/src/thread/thread-publish.ts`). Baseline: stages only paths passing
  `isAllowedThreadDocPath(path, feature)`, message `docs(<feature>): spec from koda thread "<title>"`. Target: takes
  `mode: ThreadMode`; in `ask`/`full` it stages every changed regular file (the regular-file and size checks stay), and
  when any staged path is not a doc path the message is `feat(<feature>): changes from koda thread "<title>"`.
- `readAnswer` (`apps/runner/src/thread/thread-job-run.ts:171-175`) and `applyAnswer` (`:921-935`). Baseline: text
  only, `session.answer(requestId, { text })`. Target: also accepts `{ requestId, decision }` and calls
  `session.answer(requestId, { decision })`.
- `ThreadSessionFactory.open`. Baseline: `acp` → `backend_unavailable`; `profile: 'read'`. Target: opens `acp` through
  `acpBackend` and sets `profile` from `thread.mode`.
- `NaxCapabilityProbe.probe` (`nax-probe.ts:145-180`). Baseline: `threadBackends: { native, acp: [] }`. Target: fills
  `acp` and `acpOffers` from an ACP agent probe.
- Assign parser (`apps/runner/src/supervisor/assign-parser.ts:34-60,320-337`). Baseline: `acp` agent `claude|codex`
  only; builds `ThreadAssign` field by field (unknown fields dropped). Target: accepts `cursor`, and keeps a valid
  `mode` (`read|ask|full`; an invalid value refuses the assign as `bad('thread')`).
- Web: `BackendPicker.vue` (`apps/web/components/fleet/threads/BackendPicker.vue:4`, props `{ models; model; effort }`)
  gains an agent choice; `eligibleModels(runners, kind)` (`apps/web/lib/thread-create.ts:105-111`) gets an ACP
  counterpart; `apps/web/lib/thread-types.ts:21` `acp` agent union adds `cursor`.

### Approach

**Agents (US-001..US-003).** The runner probes `claude`, `codex` and `cursor` once per capability probe:
`launchCandidateKind(agent, env)` decides `launchable` (a local binary or the `npx` fallback both count, as in
`nax chat`); for each launchable agent a tool-less, memory-only `ask` session is opened through `acpBackend` with a
20 s timeout and closed, reading models and effort levels from `backend.capabilities`; an
`AGENT_SESSION_AUTH_REQUIRED` failure sets `loggedIn: false`; a timeout or other failure leaves `loggedIn: null` and
empty models. The agent probes run in parallel, so the capability probe waits at most 20 s longer. `acp` lists agents
with `launchable && loggedIn === true`. Opening a thread on `acp` calls `acpBackend({ agent, allowUnsandboxed: true,
inheritEnv: true, model?, effort? })` with the same session options as native (workdir, instructions, declared thread
tools, transcript store, approval timeout, turn timeout); declared tools reach the agent through the tool host.

**Modes (US-004..US-006).** Profile mapping: `read` → `read`; `ask` → `ask`; `full` → `full`, for native and ACP
alike (native keeps its existing backend options; ACP gets no sandbox). `mode` lives on `ChatThread` and is
snapshotted onto each `FleetThreadTurn`, so `findThreadAssign` carries the turn's mode. Creating a thread with `ask` or
`full` requires `thread.mode.ask` / `thread.mode.full` (service-level `permissions.can` against the thread's project).
`PATCH /projects/:slug/threads/:id/mode` (and `PATCH /threads/:id/mode` for WORKSPACE) body `{ mode }`, gated with
the key of the TARGET mode (`read` needs `thread.cap.update`, the existing thread-settings key), changes the stored
mode between turns: a SESSION turn whose job is RUNNING with a turn in progress answers 409 `threads.turnRunning`; when
the session is live but idle the route sends `THREAD_CLOSE` to its job in the same transaction, so the next message
starts a new turn that resumes the same session id with the new profile (the existing resume path, as `nax chat`
closes and reopens). The change appends a system `mode_changed` message `{ from, to, by }` to the thread and an audit
entry. On the runner, each opened session writes a `mode_applied` line; if a resume with the new profile fails and the
create fallback runs, the existing `session_started { resumed: false }` line already tells the reader context was not
kept.

**Approvals (US-007, US-008).** The ingest keeps an answerable `approval_requested` line's fields and appends it to
`ChatThread.pendingApprovals` (oldest first, at most 20 entries; an entry beyond that is dropped and the turn's tool
summary still shows it); the matching `approval_resolved` line, or the end of the session (`session_closed` /
`session_failed`), removes it. `POST /projects/:slug/threads/:id/approvals/:requestId` (and the WORKSPACE route) body
`{ decision: 'allow' | 'deny' }`, gated `thread.answer` like the text answer, checks the request is pending on the
thread (409 `threads.noApproval` otherwise) and sends `THREAD_ANSWER { requestId, decision }` through `command()`
(same live-session and requester checks as a text answer). The runner passes it to `session.answer(requestId, {
decision })`.

**Publish (US-009).** The thread job knows its mode from the assign; `publishThreadDocs` receives it. Doc-path
handling in `read` is unchanged.

**Web (US-010, US-011).** New-thread form: an agent select (Native, Claude Code, Codex, Cursor) built from the
eligible runners' `threadBackends` and `acpOffers`; an agent no eligible runner can start is shown disabled with its
reason (`not installed` when no runner has it launchable, `not logged in` when launchable but `loggedIn === false`);
models and efforts come from the chosen agent; a mode select (Read, Ask, Full) shows only the modes the caller may use
(from the caller's permissions). Thread page: a mode control (same options) calling the mode route, a pending approval
card per `pendingApprovals` entry (tool, summary, command, reason, an "unsandboxed" badge when set, Approve / Deny),
and `mode_changed` system messages rendered as "Mode changed from X to Y by Z".

### Failure Handling

| Case | Behaviour |
|:--|:--|
| US-002: an ACP agent probe times out (20 s) or fails | the agent is advertised with `loggedIn: null` and empty models; the probe still completes |
| US-002: `AGENT_SESSION_AUTH_REQUIRED` from the probe session | `loggedIn: false`; the agent is not in `acp` |
| US-003: the ACP agent cannot be launched at open | the session fails with `backend_unavailable` |
| US-003: the ACP agent needs login at open | the session fails with `agent_not_logged_in` |
| US-001: a runner reports malformed `acpOffers` | `acpOffers` is dropped; `native` and `acp` are still accepted |
| US-004: create with `ask`/`full` without the mode's key | 403 `permissions`; no thread written |
| US-005: mode change while a turn is running | 409 `threads.turnRunning`; mode unchanged |
| US-005: mode change without the target mode's key | 403; mode unchanged |
| US-005: mode change to the current mode | 200, no message, no `THREAD_CLOSE` |
| US-007: decision for a request that is not pending | 409 `threads.noApproval`; nothing sent |
| US-007: decision when the session is not live | 409 `threads.noSession` (existing `command()` check) |
| US-008: malformed decision payload on the runner | the command is rejected with detail `invalid payload` |
| US-009: publish in `ask`/`full` with only doc paths changed | message stays `docs(<feature>): ...` |

## Out of Scope

- The central credential vault (#371): credentials stay on the runner (the agent's own login for ACP, the nax auth store or its existing `credentials.source: exec` config for native).
- Any sandbox for ACP agents: they run unsandboxed on the runner host in every mode, as in `nax chat` (user ruling).
- PR creation or a hand-off to a fleet RUN from a thread; changes leave only through the existing publish (commit to `feat/<feature>`) and discard.
- CLI commands for thread agents, modes or approvals.
- Changing a thread's agent (backend) after creation; only the mode changes.
- Switching mode during a running turn.
- Per-thread or per-turn time limits for ACP turns; the existing cost cap applies to reported usage only, and an ACP agent that reports no usage counts as zero.
- ACP agents other than `claude`, `codex` and `cursor` (nax-agent-acp also knows `gemini`, `opencode`, `pi`).
- Bumping `@nathapp/nax-agent` beyond `0.91.7`.

## Stories

### US-001: API and protocol accept ACP agents on every thread kind

Workdir: `apps/api`. No dependencies. Protocol `ThreadAgent` adds `cursor`, `ThreadAcpOffer` and
`ThreadBackends.acpOffers`; `parseThreadBackends` accepts `cursor` and validates `acpOffers`; create input accepts
`acp` with `claude|codex|cursor` on REPO, PROJECT and WORKSPACE threads; placement accepts an ACP thread only on a
runner whose `threadBackends.acp` lists the agent (existing rule, now reached for every kind).

### US-002: Runner advertises its ACP agents

Workdir: `apps/runner`. Depends on US-001. Add `@nathapp/nax-agent-acp` `0.91.7` (exact pin); a `probeAcpAgents`
helper (launch check, 20 s tool-less probe session per launchable agent, in parallel) feeding
`threadBackends.acp` and `threadBackends.acpOffers` in `NaxCapabilityProbe.probe`. The ACP probe is a dependency of
`NaxCapabilityProbe` (`NaxProbeDeps.acpProbe`), passed through `createCapabilityProbe` and an optional daemon option,
so tests inject it; the production default is the real `probeAcpAgents`. `acpOffers` is omitted when the probe
reports no agents.

### US-003: Runner opens ACP thread sessions

Workdir: `apps/runner`. Depends on US-001, US-002. `ThreadSessionFactory.open` builds the backend with `acpBackend` for
`acp` threads (unsandboxed, `inheritEnv`, model and effort) and passes the declared thread tools; the assign parser
accepts `cursor`.

### US-004: Thread mode stored, permissioned and carried to the runner

Workdir: `apps/api`. Depends on US-001. `ThreadMode`, `ThreadAssign.mode`, the `ChatThread.mode` and
`FleetThreadTurn.mode` columns (migration `20261124090000_thread_modes`), keys `thread.mode.ask` and `thread.mode.full`
(catalog `NEW_KEY_SCOPES`, project scope, not ownable; developer role gets `thread.mode.ask`), create with `mode`
(REPO/PROJECT and WORKSPACE), `ThreadDto.mode`, and `findThreadAssign` carrying the turn's mode.

### US-005: Change a thread's mode between turns

Workdir: `apps/api`. Depends on US-004. `PATCH /projects/:slug/threads/:id/mode` and `PATCH /threads/:id/mode`, route
variants `rest:threads.mode` and `rest:workspace-threads.mode`, the target-mode key check, the running-turn refusal,
`THREAD_CLOSE` of an idle live session, the `mode_changed` system message and the audit entry.

### US-006: Runner opens sessions in the thread's mode

Workdir: `apps/runner`. Depends on US-003, US-004. The assign parser keeps `mode`; `ThreadSessionFactory.open` sets
`profile` from it (absent → `read`) for native and ACP; each open writes a `mode_applied` runner line.

### US-007: Session approvals are pending on the thread and decidable

Workdir: `apps/api`. Depends on US-004. `ApprovalRequestedThreadLine` keeps the event's fields; ingest maintains
`ChatThread.pendingApprovals` (append on an answerable request, remove on resolve or session end, cap 20);
`ThreadAnswerPayload` decision form; `POST .../approvals/:requestId` (both scopes, `thread.answer`, variants
`rest:threads.approve` and `rest:workspace-threads.approve`); `ThreadDto.pendingApprovals`.

### US-008: Runner hands decisions to the session

Workdir: `apps/runner`. Depends on US-007. `readAnswer` accepts `{ requestId, decision }`; `applyAnswer` calls
`session.answer(requestId, { decision })`.

### US-009: Publish commits code changes in ask and full modes

Workdir: `apps/runner`. Depends on US-006. `publishThreadDocs` takes `mode`; in `ask`/`full` it stages every changed
regular file and uses the `feat(...)` message when a non-doc path is staged; the thread job passes the assign's mode.

### US-010: Web new-thread form chooses agent and mode

Workdir: `apps/web`. Depends on US-001, US-004. Agent select with disabled reasons, models and efforts per agent, mode
select limited by the caller's permissions, and the create body carrying `backend` and `mode`.

### US-011: Web thread page changes mode and decides approvals

Workdir: `apps/web`. Depends on US-005, US-007. Mode control, pending approval cards with Approve/Deny, and the
`mode_changed` message rendering.

### Context Files

**US-001**
- `packages/fleet-protocol/src/threads.ts` — the types this story changes
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseThreadBackends`
- `apps/api/src/fleet/threads/thread-input.ts` — REPO/PROJECT create input
- `apps/api/src/fleet/jobs/placement-rules.ts` — the ACP placement rule

**US-002**
- `apps/runner/src/capabilities/nax-probe.ts` — the probe this story extends
- `apps/runner/src/capabilities/create-probe.ts` — probe construction (the injection seam)
- `apps/runner/src/daemon/daemon.ts` — daemon options passing the probe dependencies
- `apps/runner/package.json` — dependency pins

**US-003**
- `apps/runner/src/thread/session-factory.ts` — the open path
- `apps/runner/src/supervisor/assign-parser.ts` — thread backend parsing

**US-004**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `createThreadJob`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign`
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `OWNABLE_KEYS`
- `apps/api/src/permissions/system-roles.ts` — developer grants
- `apps/api/src/fleet/threads/workspace-threads.service.ts` — `permissions.can` precedent

**US-005**
- `apps/api/src/fleet/threads/threads.controller.ts` — `PATCH :id` precedent
- `apps/api/src/fleet/threads/workspace-threads.controller.ts` — workspace routes
- `apps/api/src/fleet/threads/thread-route.commands.ts` — route variants
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `command()` and turn lookup

**US-006**
- `apps/runner/src/thread/session-factory.ts` — profile setting
- `apps/runner/src/supervisor/assign-parser.ts` — `ThreadAssign` construction
- `apps/runner/src/thread/thread-event-writer.ts` — runner lines

**US-007**
- `apps/api/src/fleet/threads/ingest/thread-line.ts` — line parsing
- `apps/api/src/fleet/threads/ingest/prisma-thread-ingest.repository.ts` — ingest folding
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `command()`
- `apps/api/src/fleet/threads/threads.controller.ts` — answer route precedent

**US-008**
- `apps/runner/src/thread/thread-job-run.ts` — `readAnswer`, `applyAnswer`

**US-009**
- `apps/runner/src/thread/thread-publish.ts` — publish
- `apps/runner/src/thread/thread-action-run.ts` — the publish caller

**US-010**
- `apps/web/pages/threads/new.vue` — workspace new-thread page
- `apps/web/pages/[project]/threads/new.vue` — project new-thread page
- `apps/web/components/fleet/threads/BackendPicker.vue` — the picker
- `apps/web/lib/thread-create.ts` — `eligibleModels`

**US-011**
- `apps/web/pages/[project]/threads/[id].vue` — project thread page
- `apps/web/pages/threads/[id].vue` — workspace thread page
- `apps/web/components/fleet/threads/ThreadQuestionCard.vue` — answer card precedent
- `apps/web/composables/useThread.ts` — thread controller

### Creates

**US-002**
- `apps/runner/src/capabilities/acp-agent-probe.ts`
- `apps/runner/src/capabilities/acp-agent-probe.spec.ts`

**US-004**
- `apps/api/prisma/migrations/20261124090000_thread_modes/migration.sql`

**US-011**
- `apps/web/components/fleet/threads/ThreadApprovalCard.vue`
- `apps/web/components/fleet/threads/ThreadModeControl.vue`
- `apps/web/tests/components/thread-approval-card.spec.ts`
- `apps/web/tests/components/thread-mode-control.spec.ts`

### Modifies

**US-001**
- `apps/api/src/fleet/threads/thread-input.spec.ts` — its case asserting that a PROJECT thread with an `acp` backend is refused with `backend` becomes: a PROJECT thread with an `acp` backend (`claude`, `codex` or `cursor`) is accepted; an unknown agent is still refused with `backend`.
- `apps/api/src/fleet/threads/workspace-thread-input.spec.ts` — its case asserting WORKSPACE threads refuse an `acp` backend becomes: an `acp` backend with `claude`, `codex` or `cursor` is accepted.
- `apps/api/src/fleet/common/capabilities-thread.spec.ts` — its assertion that `threadBackends` must have exactly the keys `native` and `acp` becomes: an optional `acpOffers` key is accepted and validated; any other extra key is still refused.

**US-002**
- `apps/runner/src/capabilities/nax-probe.spec.ts` — its assertion that `threadBackends.acp` is `[]` becomes: `acp` and `acpOffers` come from the injected ACP agent probe (an empty probe still yields `acp: []` and no `acpOffers`).
- `apps/runner/test/unit/daemon-thread.spec.ts` — its daemon setup injects an ACP probe reporting no agents, so its assertion `threadBackends` equals `{ native: [...], acp: [] }` stays exact and independent of what the test machine has installed.
- `apps/runner/test/unit/thread-log-backends.spec.ts` — its probe setup injects an ACP probe reporting no agents, so its assertions `threadBackends` equals `{ native: [...], acp: [] }` stay exact and machine-independent.

**US-003**
- `apps/runner/test/unit/thread-session-factory.spec.ts` — its case asserting an `acp` backend fails with `backend_unavailable` becomes: an `acp` backend opens through the injected `acpBackend` factory; `backend_unavailable` remains for an agent that cannot be launched.
- `apps/runner/src/supervisor/assign-parser-thread.spec.ts` — its case refusing an `acp` agent other than `claude`/`codex` becomes: `cursor` is accepted; an unknown agent is still refused.

**US-004**
- `apps/api/src/permissions/role-matrix.spec.ts` — its per-role cell count `toHaveLength(227)` becomes 229 for the two new keys; the role-matrix snapshot is regenerated with `thread.mode.ask` granted to developer and above and `thread.mode.full` granted to owner and project admin (and global admin through `*`).
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated snapshot adding the two keys' cells for every role.
- `apps/api/src/permissions/catalog.spec.ts` — its `NEW_KEY_SCOPES` mirror gains `thread.mode.ask: 'project'` and `thread.mode.full: 'project'`.

**US-005**
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the gated-operation list gains the two mode routes (PATCH /api/projects/{slug}/threads/{id}/mode and PATCH /api/threads/{id}/mode); the count 131 becomes 133.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated route count 131 becomes 133 (the two mode routes).

**US-006**
- `apps/runner/test/unit/thread-session-factory.spec.ts` — its assertion that the session opens with `profile: 'read'` becomes: the profile follows `thread.mode` (`read` when absent).

**US-007**
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — the gated-operation list gains the two approval routes (POST /api/projects/{slug}/threads/{id}/approvals/{requestId} and POST /api/threads/{id}/approvals/{requestId}); the count 133 becomes 135.
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated route count 133 becomes 135 (the two approval routes).
- `apps/api/src/fleet/threads/ingest/thread-line.spec.ts` — its expectation that a parsed `approval_requested` line has only `requestId` (and `callId`) becomes: the line also keeps `tool`, `summary`, `command`, `reason`, `expiresAt`, `unsandboxed` and `answerable` when present and valid.

**US-008**
None. `readAnswer` and `applyAnswer` gain a branch; the existing text-answer tests keep passing unchanged.

**US-009**
- `apps/runner/test/unit/thread-publish.spec.ts` — its case asserting a non-doc changed path is reported in `ignored` becomes: that holds in `read` mode; in `ask`/`full` the path is staged in `paths` and the commit message starts with `feat(`.

**US-010**
- `apps/web/tests/components/thread-backend-picker.spec.ts` — its props-only `{ models, model, effort }` rendering becomes: the picker also renders the agent select and emits `update:agent`.
- `apps/web/tests/pages/threads-new-page.spec.ts` — its expectation that the submit body's `backend` is always `{ kind: 'native', ... }` becomes: the body carries the chosen agent's backend and the chosen `mode`.

**US-011**
None. The new cards are additive components; the existing page specs mount them only when `pendingApprovals` is non-empty.

### Seams

- US-001 → US-010: `ThreadAcpOffer` produced in the capability report, consumed by the new-thread form (agent availability and models).
- US-004 → US-006: `ThreadAssign.mode` set by `findThreadAssign`, consumed by the runner's assign parser and session factory.
- US-007 → US-008: `ThreadAnswerPayload` decision form sent by the approval route, consumed by `applyAnswer`.
- US-005 → US-011 and US-007 → US-011: the mode route and the approval route called from the thread page; `ThreadDto.mode` and `ThreadDto.pendingApprovals` rendered there.

## Acceptance Criteria

### US-001: API and protocol accept ACP agents on every thread kind

- [unit] `parseThreadBackends({ native: [], acp: ['cursor'] })` returns `{ native: [], acp: ['cursor'] }`.
- [unit] `parseThreadBackends` with `acp: ['gemini']` throws the same refusal as any unknown agent.
- [unit] `parseThreadBackends` with a valid `acpOffers: [{ agent: 'claude', launchable: true, loggedIn: true, models: ['claude-sonnet-4-5'], efforts: ['high'] }]` returns it unchanged under `acpOffers`.
- [unit] `parseThreadBackends` with an `acpOffers` entry whose `models` contains an id failing `THREAD_MODEL_ID_RE` returns the result without an `acpOffers` key and keeps `native` and `acp`.
- [unit] `parseThreadBackends` with two `acpOffers` entries for the same agent returns the result without an `acpOffers` key.
- [unit] `parseThreadBackends` with an extra key other than `acpOffers` still throws.
- [unit] The REPO/PROJECT create normaliser accepts a PROJECT thread with backend `{ kind: 'acp', agent: 'codex' }` and returns it with that backend.
- [unit] The REPO/PROJECT create normaliser accepts a REPO thread with backend `{ kind: 'acp', agent: 'cursor', model: 'auto' }`.
- [unit] The REPO/PROJECT create normaliser refuses backend `{ kind: 'acp', agent: 'gemini' }` with a validation error naming `backend`.
- [unit] The WORKSPACE create normaliser accepts backend `{ kind: 'acp', agent: 'claude' }`.
- [unit] The placement rule answers no misfit for a SESSION job of a PROJECT thread with backend `{ kind: 'acp', agent: 'cursor' }` on a runner whose `threadBackends.acp` is `['cursor']`.
- [unit] The placement rule answers `thread_backend` for the same job on a runner whose `threadBackends.acp` is `['claude']`.

### US-002: Runner advertises its ACP agents

- [unit] `probeAcpAgents` with an injected launch check answering no candidate for `codex` reports `{ agent: 'codex', launchable: false, loggedIn: null, models: [], efforts: [] }` and opens no probe session for it.
- [unit] `probeAcpAgents` with a launchable `claude` whose injected probe session reports capabilities with models `['claude-sonnet-4-5']` and efforts `['high']` reports `{ agent: 'claude', launchable: true, loggedIn: true, models: ['claude-sonnet-4-5'], efforts: ['high'] }` and closes the probe session.
- [unit] `probeAcpAgents` with a launchable `cursor` whose probe open throws an error with code `AGENT_SESSION_AUTH_REQUIRED` reports `loggedIn: false` and empty models.
- [unit] `probeAcpAgents` with a probe open that does not settle within the 20 s timeout (injected clock) reports `loggedIn: null` and empty models for that agent and still returns the other agents' results.
- [unit] `probeAcpAgents` opens the probe sessions of two launchable agents concurrently (both opens start before either resolves).
- [unit] `NaxCapabilityProbe.probe` with an injected ACP probe reporting `claude` launchable and logged in and `codex` launchable but `loggedIn: false` reports `threadBackends.acp` equal to `['claude']` and `threadBackends.acpOffers` with both entries.
- [unit] `NaxCapabilityProbe.probe` with an injected ACP probe that throws still resolves with `threadBackends.acp` equal to `[]` and no `acpOffers`.
- [unit] `NaxCapabilityProbe.probe` with an injected ACP probe reporting no agents resolves with `threadBackends` equal to `{ native: [...], acp: [] }` (no `acpOffers` key).
- [unit] Importing `acpBackend` and `launchCandidateKind` from `@nathapp/nax-agent-acp/client` succeeds and both are functions.

### US-003: Runner opens ACP thread sessions

- [unit] `ThreadSessionFactory.open` with `thread.backend` `{ kind: 'acp', agent: 'codex', model: 'gpt-5-codex' }` calls the injected `acpBackend` factory once with `{ agent: 'codex', allowUnsandboxed: true, inheritEnv: true, model: 'gpt-5-codex' }` and returns `{ ok: true }`.
- [unit] `ThreadSessionFactory.open` with an `acp` backend carrying `effort: 'high'` passes `effort: 'high'` to the `acpBackend` factory.
- [unit] `ThreadSessionFactory.open` with an `acp` backend passes the input's `tools`, `worktree` (as `workdir`) and `thread.instructions` to the created session's options.
- [unit] `ThreadSessionFactory.open` with an `acp` backend whose session creation throws code `AGENT_SESSION_AUTH_REQUIRED` returns `{ ok: false, reason: 'agent_not_logged_in' }`.
- [unit] `ThreadSessionFactory.open` with an `acp` backend whose session creation throws code `AGENT_SESSION_BACKEND_UNAVAILABLE` returns `{ ok: false, reason: 'backend_unavailable' }`.
- [unit] `ThreadSessionFactory.open` with a native backend never calls the `acpBackend` factory.
- [unit] The assign parser accepts a THREAD assign whose backend is `{ kind: 'acp', agent: 'cursor' }` and returns a `ThreadAssign` with that backend.
- [unit] The assign parser refuses a THREAD assign whose backend is `{ kind: 'acp', agent: 'gemini' }`.

### US-004: Thread mode stored, permissioned and carried to the runner

- [unit] `findCatalogEntry('thread.mode.ask')` returns an entry with scope `project`, `ownable` false and an approvable approval.
- [unit] `findCatalogEntry('thread.mode.full')` returns an entry with scope `project` and `ownable` false.
- [unit] The developer system role grants `thread.mode.ask` and does not grant `thread.mode.full`.
- [integration] Creating a REPO thread with no `mode` stores `mode` `read`, and the thread's response has `mode: 'read'`.
- [integration] A developer creating a REPO thread with `mode: 'ask'` gets 201 and the stored mode is `ask`.
- [integration] A developer creating a REPO thread with `mode: 'full'` gets 403 and no thread is written.
- [integration] A project admin creating a PROJECT thread with `mode: 'full'` gets 201 and the stored mode is `full`.
- [integration] Creating a WORKSPACE thread with `mode: 'ask'` by a user holding `thread.mode.ask` in the home project gets 201 and the stored mode is `ask`.
- [integration] Creating a thread with `mode: 'write'` gets 400 naming `mode`.
- [integration] After a thread's first message, the created turn row has the thread's mode, and `findThreadAssign` for that job returns `mode` equal to it.
- [integration] A turn created before the thread's mode changes keeps its own `mode` in `findThreadAssign` (the turn snapshot, not the thread's current mode).

### US-005: Change a thread's mode between turns

- [integration] `PATCH /projects/:slug/threads/:id/mode` with `{ mode: 'ask' }` by a developer on an idle thread with no live session answers 200, stores `ask`, and appends a system message `mode_changed` with `{ from: 'read', to: 'ask' }` and the caller as `by`.
- [integration] The same PATCH with `{ mode: 'full' }` by a developer answers 403 and the mode is unchanged.
- [integration] The same PATCH with `{ mode: 'full' }` by a project admin answers 200 and stores `full`.
- [integration] The same PATCH with `{ mode: 'read' }` from `ask` by the thread's creator holding `thread.cap.update.own` answers 200 and stores `read`.
- [integration] The PATCH while the thread's SESSION job is RUNNING with a turn in progress answers 409 `threads.turnRunning` and the mode is unchanged.
- [integration] The PATCH while the thread's SESSION job is RUNNING and idle (no turn in progress) answers 200, stores the new mode, and creates exactly one `THREAD_CLOSE` command for that job.
- [integration] The PATCH to the thread's current mode answers 200 and creates no system message and no `THREAD_CLOSE` command.
- [integration] An agent principal holding `thread.mode.ask` with no approval policy calling the PATCH with `{ mode: 'ask' }` gets 202 with an approval request and the mode is unchanged until it is approved.
- [integration] A successful PATCH records an audit entry whose summary names the from and to modes.
- [integration] `PATCH /threads/:id/mode` on a WORKSPACE thread with `{ mode: 'ask' }` by its creator holding `thread.mode.ask` in the home project answers 200 and stores `ask`.
- [integration] The PATCH with `{ mode: 'bogus' }` answers 400 naming `mode`.

### US-006: Runner opens sessions in the thread's mode

- [unit] `ThreadSessionFactory.open` with `thread.mode` `ask` creates the session with `profile: 'ask'`.
- [unit] `ThreadSessionFactory.open` with `thread.mode` `full` creates the session with `profile: 'full'`.
- [unit] `ThreadSessionFactory.open` with no `thread.mode` creates the session with `profile: 'read'`.
- [unit] `ThreadSessionFactory.open` with an `acp` backend and `thread.mode` `full` creates the session with `profile: 'full'` and the `acpBackend` options still carry `allowUnsandboxed: true`.
- [unit] `ThreadSessionFactory.open` on the resume path passes the same `profile` to `resumeAgentSession` as the create path would.
- [unit] The assign parser keeps `mode: 'full'` from a THREAD assign in the returned `ThreadAssign`.
- [unit] The assign parser refuses a THREAD assign with `mode: 'write'`.
- [unit] The assign parser returns a `ThreadAssign` without `mode` when the assign has none.
- [unit] A thread job whose session opens writes one `mode_applied` line with the assign's mode (`read` when absent) to the thread stream.

### US-007: Session approvals are pending on the thread and decidable

- [unit] The thread-line parser keeps `tool`, `summary`, `command`, `reason`, `expiresAt` and `unsandboxed: true` from a valid `approval_requested` line.
- [unit] The thread-line parser reads `answerable: false` from a line that says so and `answerable: true` when the field is absent.
- [integration] Ingesting an answerable `approval_requested` line for a thread appends `{ requestId, tool, summary, command, reason, expiresAt, unsandboxed }` to `pendingApprovals`.
- [integration] Ingesting an `approval_requested` line with `answerable: false` leaves `pendingApprovals` unchanged.
- [integration] Ingesting the matching `approval_resolved` line removes that request from `pendingApprovals`.
- [integration] Ingesting a `session_closed` line clears `pendingApprovals`.
- [integration] Ingesting a 21st pending request leaves 20 entries (the oldest 20).
- [integration] `POST /projects/:slug/threads/:id/approvals/:requestId` with `{ decision: 'allow' }` by the turn's requester for a pending request on a live session answers 200 and creates one `THREAD_ANSWER` command with payload `{ requestId, decision: 'allow' }`.
- [integration] The same POST with `{ decision: 'deny' }` creates the command with `decision: 'deny'`.
- [integration] The POST for a request id not in `pendingApprovals` answers 409 `threads.noApproval` and creates no command.
- [integration] The POST with `{ decision: 'maybe' }` answers 400 naming `decision`.
- [integration] The POST when the thread has no RUNNING job answers 409 `threads.noSession`.
- [integration] `POST /threads/:id/approvals/:requestId` on a WORKSPACE thread with `{ decision: 'allow' }` creates the `THREAD_ANSWER` decision command.
- [integration] `GET` of the thread returns `pendingApprovals` with the pending entries, oldest first.

### US-008: Runner hands decisions to the session

- [unit] A `THREAD_ANSWER` command with payload `{ requestId: 'r1', decision: 'allow' }` calls the session's `answer('r1', { decision: 'allow' })` and acks `ok` when it answers `accepted`.
- [unit] A `THREAD_ANSWER` command with payload `{ requestId: 'r1', decision: 'deny' }` calls `answer('r1', { decision: 'deny' })`.
- [unit] A `THREAD_ANSWER` command with payload `{ requestId: 'r1', decision: 'maybe' }` is rejected with detail `invalid payload` and `answer` is not called.
- [unit] A `THREAD_ANSWER` command with payload `{ requestId: 'r1', text: 'yes' }` still calls `answer('r1', { text: 'yes' })`.
- [unit] A `THREAD_ANSWER` decision whose session answers a status other than `accepted` is rejected with that status as the detail.

### US-009: Publish commits code changes in ask and full modes

- [unit] `publishThreadDocs` with `mode: 'ask'` and a changed `src/math.ts` stages it, reports it in `paths`, and commits with a message starting `feat(<feature>): changes from koda thread`.
- [unit] `publishThreadDocs` with `mode: 'full'` and both a changed doc path and a changed `src/math.ts` stages both and uses the `feat(` message.
- [unit] `publishThreadDocs` with `mode: 'ask'` and only a changed doc path commits with the existing `docs(<feature>): spec from koda thread` message.
- [unit] `publishThreadDocs` with `mode: 'read'` and a changed `src/math.ts` reports it in `ignored` and does not stage it.
- [unit] `publishThreadDocs` with `mode: 'full'` and a changed symlink reports the symlink in `ignored`.
- [unit] A thread PUBLISH job whose assign has `mode: 'full'` calls the publisher with `mode: 'full'`.
- [unit] A thread PUBLISH job whose assign has no `mode` calls the publisher with `mode: 'read'`.

### US-010: Web new-thread form chooses agent and mode

- [unit] The ACP eligibility helper for runners whose `acpOffers` list `claude` launchable and logged in returns `claude` as available with its models.
- [unit] The ACP eligibility helper returns `codex` as unavailable with reason `not logged in` when every eligible runner reports `codex` launchable with `loggedIn: false`.
- [unit] The ACP eligibility helper returns `cursor` as unavailable with reason `not installed` when no eligible runner reports `cursor` launchable.
- [unit] The backend picker renders an agent select with Native, Claude Code, Codex and Cursor, and an unavailable agent's option is disabled with its reason as text.
- [unit] Choosing Claude Code in the backend picker emits `update:agent` with `claude` and lists Claude Code's models in the model select.
- [unit] The mode select lists Read and Ask, and not Full, when the caller's permissions hold `thread.mode.ask` but not `thread.mode.full`.
- [unit] The mode select lists Read, Ask and Full when the caller holds both mode keys.
- [unit] Submitting the project new-thread form with Codex, model `gpt-5-codex` and mode Ask posts a body whose `backend` is `{ kind: 'acp', agent: 'codex', model: 'gpt-5-codex' }` and whose `mode` is `ask`.
- [unit] Submitting the form with the Native agent posts `backend.kind` `native` and `mode` `read` when the mode was not changed.
- [unit] The workspace new-thread page offers the same agent select and posts the chosen `acp` backend.
- [unit] The new English and Chinese locale keys for the agent select, the disabled reasons and the mode select are non-empty in both files.

### US-011: Web thread page changes mode and decides approvals

- [unit] `ThreadModeControl` shows the thread's current mode as selected.
- [unit] Choosing Ask in `ThreadModeControl` calls the mode endpoint for the thread with `{ mode: 'ask' }`.
- [unit] `ThreadModeControl` disables Full when the caller lacks `thread.mode.full`.
- [unit] `ThreadModeControl` renders the API error text when the mode endpoint answers 409.
- [unit] `ThreadApprovalCard` renders the request's tool, summary, command and reason.
- [unit] `ThreadApprovalCard` renders an "unsandboxed" badge when the request has `unsandboxed: true`, and none otherwise.
- [unit] Clicking Approve on `ThreadApprovalCard` posts `{ decision: 'allow' }` to the approval endpoint for its request id.
- [unit] Clicking Deny posts `{ decision: 'deny' }`.
- [unit] The project thread page renders one `ThreadApprovalCard` per `pendingApprovals` entry and none when the list is empty.
- [unit] The workspace thread page renders the same approval cards from its thread's `pendingApprovals`.
- [unit] A `mode_changed` system message renders as text naming the from mode, the to mode and who changed it.
- [unit] The new English and Chinese locale keys for the mode control, approval card and mode-changed message are non-empty in both files.
