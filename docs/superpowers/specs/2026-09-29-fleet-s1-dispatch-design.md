# Fleet S1 — nax Dispatch to Machine Runners — Design

**Date:** 2026-09-29
**Base:** `main` @ `5ef74662` (Track 1 and Track 3 complete, PRs #133-#154)
**nax reference:** main `1c7aa52ee` (v0.83.0-canary.2)
**Source:** fleet platform design doc (`projects/koda/koda-fleet-platform-design-2026-09-13.md`, workspace repo) §3, §6, §7, the §9.2 native-agent amendments and the §9.12 Paperclip copy list C1-C9. This spec supersedes §7.
**Status:** Sectioned design approved in chat 2026-09-29 (seven sections). Spec review 2026-09-29 (two Sonnet reviewers, koda side and nax side): READY AFTER FIXES, all applied; isolation ruling R7 added. Awaiting user review.

## Goal

From koda's web UI or CLI, dispatch a `nax run` or `nax plan` for a registered repo to one of the user's own
macOS or Linux machines and follow it to COMPLETED, FAILED, ESCALATED, CRASHED or CANCELLED. Show state,
story progress and live cost, keep the run's artifact bundle, and never let two machines work the same job.

## Success criteria

1. A runner daemon on a second machine enrolls with a single-use token and appears online with its capability report.
2. A user with project DEVELOPER role dispatches a job for a registered repo. A matching runner clones via a
   koda-brokered git token, runs nax, and the job detail page shows state, current story and phase, and live
   cost as it runs.
3. The terminal state is correct for every nax outcome, judged from `status.json` (run status and finish
   result) or, for plans, the written PRD, per the verdict table in §5.2. nax exits 0 on failure, so the exit
   code never decides.
4. The artifact bundle is downloadable from the job.
5. Cancel stops the nax process group and ends in CANCELLED.
6. A machine that goes silent ends in CRASHED after the timeout. A daemon restart is detected at once from
   the new boot id, and the job is re-adopted or marked CRASHED without waiting out the timeout.
7. No job is ever executed or pushed by two machines (§6).

## Rulings (user, 2026-09-29)

| # | Ruling |
|:--|:--|
| R1 | S1 = the core dispatch loop (C2 reliable protocol, C3 boot id, C5 activity log, C6 storage seam, C7 git broker). Budgets (C1) and schedules (C4) are S1b. Every Paperclip item C1-C9 is **designed** here; deferred items get their tables in the phase that builds them. |
| R2 | C1 budgets: what happens to RUNNING jobs at hard stop is a **per-policy flag** `runningJobs: finish \| cancel`, default `finish`. |
| R3 | C7 git identity: **GitHub App**. |
| R4 | Protocol **A**: one long-polled `POST /fleet/runner/sync` plus a separate bundle upload. |
| R5 | **All** runner git traffic is brokered by koda: GitHub via per-job App installation tokens, GitLab via the project's stored `VcsConnection` token. Clone, fetch, nax finish push and `gh`/`glab` PR creation all use it. Machines hold no git credentials. This amends the 2026-09-13 ruling (§6 Q5, "git credentials stay machine-local"). Provider (LLM) credentials still stay on the machine; koda never stores them. |
| R6 | Cross-machine duplicate work is prevented by compare-and-set assignment, a lease epoch fence (also enforced by the git broker), and a partial unique index on active `(repoId, feature)` (§6). |
| R7 | Isolation: S1 runs jobs on the host through a `JobExecutor` seam (`HostExecutor`), under a dedicated OS user. A VM executor is a later phase; VMs are not required in S1 (§5.5). |

Earlier rulings that still hold (design doc §6): fleet = mixed macOS + Linux; runners auto-clone from a
platform repo registry; labels + auto-pick with a pin override; 1 job per runner by default; home server + VPN
now, VPS later, so the network is treated as untrusted from day one; requeue is manual only.

Why nax pushes matter (verified at nax `1c7aa52ee`): the finish phase runs `git push --set-upstream origin
<branch>` (`src/finish/commit.ts:158`) and `gh pr create` / `glab mr create` (`src/finish/pr/open.ts:70-71`) in
every `nax run`. An S1 job therefore needs push rights and an authenticated `gh`/`glab`, which is why the git
broker is in S1 and not S3.

## Out of scope

- Budgets and schedules (S1b), typed approvals and `bashMode: gated|escalate` (S1.5), full log streaming and
  a log viewer (S2a), dashboard, analytics, run DAG and ticket work products (S2b), rules/context editing
  through PRs (S3), brainstorming jobs via acpx (S5). Their designs are in §9 so S1 does not block them.
- Automatic requeue of crashed jobs.
- A multi-instance API. The API stays single-instance (in-process long-poll notifier, in-process sweeps).
- Object storage for artifacts (local disk behind an interface).
- Runners inside Docker. Linux runners install on the host because bubblewrap fails in stock Docker (§9.2).
- Revoking or rotating a GitLab token automatically. The stored token lives as long as the user made it.
- Editing machine-local `~/.nax` profiles or credentials from koda.

## 1. Architecture

```
koda monorepo
├ packages/fleet-protocol/          NEW  versioned sync DTOs, shared by api and runner
├ apps/api/src/fleet/               NEW  NestJS module group
│  ├ runners/     enrollment, runner CRUD, capability store, boot-id reconcile (C3)
│  ├ repos/       FleetRepo registry + reachability check through the broker
│  ├ jobs/        dispatch, state machine, placement, fencing, cancel, requeue
│  ├ sync/        POST /fleet/runner/sync: per-job seq cursors (C2), command queue, long-poll
│  ├ git-broker/  GitHubAppTokenMinter | GitLabStoredTokenMinter
│  ├ artifacts/   bundle upload, size cap, ArtifactStore interface (C6 seam)
│  └ activity/    FleetActivityService (C5)
├ apps/runner/                      NEW  Bun daemon, compiled binary, launchd + systemd units
│  ├ config · enroll · sync-loop · journal (SQLite, persist before send)
│  ├ job-executor (workspace → nax → watch → verdict → bundle)
│  ├ status-watcher (status.json + events.jsonl → journal events)
│  ├ capability-probe (§9.2)
│  └ git-cred (per-job unix socket, credential helper, gh/glab shims)
├ apps/web    /fleet pages
└ apps/cli    koda fleet … (generated from openapi.json, then wrapped)
```

Boundaries:

- The runner calls exactly three endpoints: enroll (once), sync, and bundle upload.
- `packages/fleet-protocol` carries `FLEET_PROTOCOL_VERSION`. The server answers an unsupported version with
  426 and a body naming the supported range. The runner logs it and stops syncing (no retry storm).
- Runner authentication reuses the agent API-key *hashing*: a random key, stored as an HMAC-SHA256 hash under
  `auth.apiKeySecret` (see `AgentsService.generateApiKey`, `apps/api/src/agents/agents.service.ts:79-91`).
  The guard does not generalise today: `CombinedAuthGuard.tryApiKey` looks up agents only
  (`combined-auth.guard.ts:83`, `findAgentByKeyHash`) and `KodaPrincipal = UserPrincipal | AgentPrincipal` is a
  closed union (`auth/principal/koda-principal.types.ts:27`). S1 therefore: gives runner keys a distinct prefix
  (`kr_`), routes prefixed keys to a `findRunnerByKeyHash` lookup, adds a third arm `RunnerPrincipal`
  (`actorType: 'runner'`) with `isRunnerPrincipal`, and audits every exhaustive match on `KodaPrincipal`. A
  `RunnerOnlyGuard` on `/fleet/runner/*` refuses user and agent principals, and every other route refuses runner
  principals (a global check in the guard, not per controller). The global `PermissionAuthGuard` allows routes
  without `@RequiredPermission`, so runner routes are not blocked by CASL.
- Job updates reach browsers through the existing `ProjectEventBus` (`apps/api/src/live/project-event-bus.ts`)
  and SSE stream. `LiveEvent` (`apps/api/src/live/live-event.ts:10-17`, today a one-member union) becomes a
  discriminated union with a `fleet_job` member carrying `id`, `projectId` (required: `ProjectEventBus.publish`
  routes on it, `project-event-bus.ts:26-33`), `jobId`, `state`, `at`; content-free, the page refetches the job.
  Every consumer that switches on `type` gets the new arm. The Runners page is not project-scoped and polls every 15s.
- Fleet adds no distributed machinery. The long-poll notifier and the silence sweep run in process.

## 2. Data model

New tables use native Postgres `Json`, `String[]` and Prisma enums (the String-JSON convention on older
tables is existing debt and not extended). `BigInt` and `Decimal` are new to the schema (no existing table uses
them) and do not survive `JSON.stringify`, so every response DTO maps them to `string` and the OpenAPI schema
declares them as `string`; a unit test serialises each fleet DTO.

```prisma
enum FleetJobState { QUEUED ASSIGNED RUNNING UPLOADING COMPLETED FAILED ESCALATED CRASHED CANCELLED }
enum FleetJobKind { RUN PLAN }
enum FleetCommandType { ASSIGN CANCEL READOPT ABANDON }
enum FleetProvider { GITHUB GITLAB }
enum FleetActorType { USER RUNNER SYSTEM }

model Runner {
  id              String    @id @default(cuid())
  name            String    @unique
  apiKeyHash      String    @unique
  os              String    // darwin | linux
  arch            String    // arm64 | x64
  labels          String[]
  capacity        Int       @default(1)
  capabilities    Json      // RunnerCapabilities, §2.1
  daemonVersion   String
  protocolVersion Int
  bootId          String
  enabled         Boolean   @default(true)
  lastSeenAt      DateTime
  createdById     String
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
}

model RunnerEnrollment {
  id          String    @id @default(cuid())
  tokenHash   String    @unique
  labels      String[]
  expiresAt   DateTime
  usedAt      DateTime?
  runnerId    String?
  createdById String
  createdAt   DateTime  @default(now())
}

model FleetRepo {
  id                   String        @id @default(cuid())
  projectId            String
  provider             FleetProvider
  owner                String
  name                 String
  defaultBranch        String
  githubInstallationId BigInt?
  createdById          String
  createdAt            DateTime      @default(now())
  @@unique([provider, owner, name])
}

model FleetJob {
  id               String          @id @default(cuid())   // = dispatchId
  projectId        String
  repoId           String
  ref              String
  command          FleetJobKind
  feature          String
  planFrom         String?         // repo-relative spec path, required for PLAN
  profiles         String[]
  maxCostUsd       Decimal
  bashMode         String          @default("raw")         // S1 accepts raw only
  selectorLabels   String[]
  pinnedRunnerId   String?
  runnerId         String?
  runnerBootId     String?
  leaseEpoch       Int             @default(0)
  state            FleetJobState   @default(QUEUED)
  stateReason      String?
  requestedById    String
  queuedAt         DateTime        @default(now())
  assignedAt       DateTime?
  startedAt        DateTime?
  finishedAt       DateTime?
  cancelRequestedAt DateTime?
  // nax's three run-id namespaces (design doc §1), filled as discovered
  naxRunId         String?
  naxLogRunId      String?
  naxCostRunId     String?
  // live mirror of status.json
  progress         Json?
  currentStoryId   String?
  currentPhase     String?
  costSpentUsd     Decimal         @default(0)
  lastHeartbeatAt  DateTime?
  finishResult     String?
  escalationReason String?
  exitCode         Int?
  resultBranch     String?
  resultSha        String?
  resultPrUrl      String?
  @@index([state])
  @@index([runnerId, state])
}

model FleetJobEvent {
  id        String   @id @default(cuid())
  jobId     String
  seq       Int
  type      String   // state | snapshot | lifecycle | log
  payload   Json
  createdAt DateTime @default(now())
  @@unique([jobId, seq])
}

model FleetCommand {
  id          String           @id @default(cuid())   // idempotency key
  runnerId    String
  jobId       String
  type        FleetCommandType
  leaseEpoch  Int
  payload     Json
  createdAt   DateTime         @default(now())
  deliveredAt DateTime?
  ackedAt     DateTime?
  ackResult   String?          // ok | rejected
  @@index([runnerId, ackedAt])
}

model FleetJobArtifact {
  id         String   @id @default(cuid())
  jobId      String
  kind       String   // bundle
  storageKey String
  sizeBytes  BigInt
  sha256     String
  createdAt  DateTime @default(now())
}

model FleetActivity {
  id                String         @id @default(cuid())
  actorType         FleetActorType
  actorId           String
  action            String
  entityType        String
  entityId          String
  jobId             String?
  responsibleUserId String?
  payload           Json
  createdAt         DateTime       @default(now())
  @@index([entityType, entityId])
  @@index([jobId])
}
```

Hand-written migration SQL adds the partial unique index that Prisma cannot express:

```sql
CREATE UNIQUE INDEX "FleetJob_active_repo_feature_key" ON "FleetJob" ("repoId", "feature")
  WHERE state IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING');
```

Foreign keys: `FleetJob.projectId → Project`, `repoId → FleetRepo`, `runnerId`/`pinnedRunnerId → Runner`
(`SetNull`), `requestedById → User`; events, commands and artifacts cascade from `FleetJob`. A `FleetRepo` or
`Runner` with a non-terminal job cannot be deleted (409). Runners are disabled, not deleted, while they have
job history; delete is allowed only when every job referencing them is terminal (history keeps `runnerId`
null after delete).

`FleetActivity` is a new table on purpose. `TicketActivity` is ticket-bound by foreign key and
`DecisionEvent` records ADRs; neither fits runner, repo and job actions.

### 2.1 RunnerCapabilities (the §9.2 report)

```ts
interface RunnerCapabilities {
  nax: { version: string; protocols: Array<'acp' | 'native'> };
  sandbox: { available: boolean; probedAt: string; error?: string }; // live probe, not checkDependencies()
  profiles: Record<string, ProfileNeeds>;                           // resolved locally by the runner
  credentials: Array<{ providerId: string; kind: string; expires?: string }>; // secret-free
  tools: { git: boolean; gh: boolean; glab: boolean };
  executors: Array<'host'>;                                          // §5.5; 'vm' later
}
interface ProfileNeeds { protocol: 'acp' | 'native'; providers: string[]; sandbox: boolean }
```

The server matches names and flags only; it never parses nax config.

- `profiles` covers **machine** profiles (the runner user's `~/.nax/profiles/`). Repo profiles
  (`<repo>/.nax/profiles/`) are unknowable before clone, so placement treats a profile name absent from
  `capabilities.profiles` as repo-provided and skips its needs check. After checkout the runner resolves the
  full chain; if a need is unmet it reports ASSIGNED→FAILED with `stateReason = 'capability mismatch: …'` (no
  automatic re-placement in S1).
- Resolving a chain's needs requires a small nax PR, because `nax config` has no `--profile` option and
  `nax config profile show <name>` shows one unmerged profile (nax `src/cli/config-profile.ts:116-130`). The PR
  adds `nax config --profile <chain> --json` (resolved `agent.protocol`, providers, sandbox) and
  `nax auth list --json`. Until it ships, `credentials` is read directly from the runner user's
  `~/.nax/credentials` (`{credentials: {<providerId>: {kind, expires}}}`, the file `readStoredEntries` reads,
  `src/agents/native/credentials.ts:57-90`; key material is never parsed).

### 2.2 Permissions

- Dispatch and cancel: project DEVELOPER or higher on the repo's project, via `@ProjectPermission`
  (`apps/api/src/projects/project-permission.decorator.ts`). The requester may always cancel their own job.
  Requeue: project DEVELOPER or higher.
- Job read: any member of the job's project.
- Runners, enrollment tokens and the repo registry: global ADMIN.
- `/fleet/runner/*`: RUNNER principal only.

## 3. Runner protocol (C2)

### 3.1 Enrollment

`POST /fleet/runner/enroll {enrollmentToken, name, os, arch, daemonVersion, protocolVersion, capabilities}`
→ `{runnerId, apiKey}`. The token row is marked used in the same transaction that creates the runner (a used,
expired or unknown token is 401 with one message). Enrollment tokens are 256-bit random values, stored hashed,
valid 24h by default, shown once. The runner stores its key in a 0600 file.

### 3.2 Sync

`POST /fleet/runner/sync` (RUNNER principal):

```
request  { protocolVersion, bootId, daemonVersion, capabilities?, freeSlots,
           jobs: [{ jobId, leaseEpoch, events: [{ seq, type, payload }] }],
           commandAcks: [{ commandId, leaseEpoch, result: 'ok' | 'rejected', detail? }],
           tokenRequests: [{ jobId, leaseEpoch }] }
response { jobAcks: [{ jobId, ackedSeq }],
           commands: [{ commandId, type, jobId, leaseEpoch, payload }],
           gitTokens: [{ jobId, token, expiresAt, username }],
           nextPollAfterMs? }
```

- Every sync updates `Runner.lastSeenAt`. `capabilities` is sent on the first sync after boot and whenever
  it changes.
- **Persist before send.** The runner writes each event to its local journal before sending it.
- **Idempotent events.** The server inserts with `ON CONFLICT (jobId, seq) DO NOTHING`. A duplicate `seq` with a
  different payload is rejected for that job, logged as a protocol error, and the job's ack does not advance.
- **Cumulative ack.** `ackedSeq` is the highest contiguous stored `seq` for the job. The runner deletes journal
  rows at or below it and, after a reconnect, resends everything above it.
- **Idempotent commands.** Every command has a unique id and is re-sent until acked. The runner records the
  ids it has applied per job, so a repeated command is acked again without being re-applied.
- **Long-poll.** The request is processed in two steps: (1) one short transaction stores events, applies acks
  and snapshot mirrors, runs placement when `freeSlots > 0`, and collects pending commands; (2) only if there is
  nothing to return, the handler waits up to 25s **holding no transaction or connection**, woken by an in-process
  notifier keyed by `runnerId`, then re-reads pending commands.
- **Mirror.** Snapshot events update the `FleetJob` mirror columns in the same transaction as the insert and
  publish a `fleet_job` live event after commit.
- **Log events** are excerpts: at most 8 KiB each and 60 per job per minute; excess is dropped by the runner
  and counted in the next snapshot. Full logs travel in the bundle (streaming is S2a).
- **Size.** A sync body is capped at 1 MiB; the runner batches below it.

### 3.3 Bundle upload

`PUT /fleet/runner/jobs/:jobId/bundle?leaseEpoch=` with `Content-Type: application/gzip`, header
`X-Content-SHA256`. Fenced like every other job call (§6.2) and accepted only while the job is RUNNING (partial
bundle on cancel) or UPLOADING. The server streams to the `ArtifactStore`, stops
at `FLEET_BUNDLE_MAX_BYTES` (default 200 MiB) with 413, verifies the hash, and creates `FleetJobArtifact`.
A re-upload for the same job and epoch replaces the previous bundle.

### 3.4 User-facing endpoints

| Route | Permission |
|:--|:--|
| `GET /fleet/runners`, `GET /fleet/runners/:id` | global ADMIN |
| `PATCH /fleet/runners/:id` (`enabled`, `labels`, `capacity`), `DELETE /fleet/runners/:id` | global ADMIN |
| `POST /fleet/enrollments` (returns the token once), `GET /fleet/enrollments` | global ADMIN |
| `GET /fleet/repos`, `POST /fleet/repos`, `DELETE /fleet/repos/:id` | global ADMIN |
| `GET /projects/:slug/fleet/repos` (repos usable for dispatch) | project member |
| `POST /projects/:slug/fleet/jobs` (dispatch) | project DEVELOPER+ |
| `GET /projects/:slug/fleet/jobs` (paged, filters: state, repo, runner, requester), `GET /projects/:slug/fleet/jobs/:id`, `GET …/:id/events` (paged by seq) | project member |
| `POST /projects/:slug/fleet/jobs/:id/cancel` | project DEVELOPER+ or requester |
| `POST /projects/:slug/fleet/jobs/:id/requeue` | project DEVELOPER+ |
| `GET /projects/:slug/fleet/jobs/:id/bundle` | project member |
| `GET /fleet/activity` | §8 |

Lists use the `@nathapp` `Page` pagination like the rest of the API. Responses use `JsonResponse.Ok`.

## 4. Placement

Runs on dispatch and whenever a runner syncs with `freeSlots > 0`.

1. Candidates: the pinned runner only, when `pinnedRunnerId` is set; otherwise runners that are `enabled`,
   online (`lastSeenAt` within `FLEET_RUNNER_OFFLINE_SEC`, default 90) and whose `labels` contain every
   `selectorLabels` entry.
2. Capability fit: every name in `profiles` exists in `capabilities.profiles`; the union of their `ProfileNeeds`
   is satisfied (protocol in `nax.protocols`, each provider present in `credentials` and not expired, and
   `sandbox.available` when needed); `tools.git` plus `tools.gh` (GitHub) or `tools.glab` (GitLab).
3. Load: no active job on the same repo on that runner, and active jobs below `capacity`. (nax keeps two
   locks: the checkout lock `<workdir>/nax.lock`, `src/execution/lock.ts:222`, which the shared clone still
   enforces, and a feature lock under `<outputDir>/features/<feature>/nax.lock`, `feature-lock.ts:107`, which is
   inert across jobs once `outputDir` is per job. This placement rule is the real guard; neither lock is relied on.)
4. Order: fewest active jobs, then oldest `lastSeenAt`.
5. Assign with the compare-and-set in §6.4, then queue an `ASSIGN` command.

No fit: an unpinned job stays QUEUED and the dispatch response lists each runner with the first rule it failed.
A pinned job whose runner can never fit (disabled, missing profile, provider, tool or sandbox) is rejected at
dispatch with 422. A pinned job whose runner is merely offline queues.

## 5. Job lifecycle

### 5.1 Dispatch

`POST /projects/:slug/fleet/jobs` validates: repo belongs to the project; `command=PLAN` requires `planFrom`;
`bashMode` must be `raw` (anything else 400 until S1.5); `feature` matches nax's feature-name rule;
`maxCostUsd > 0`. It inserts QUEUED (the partial index turns an active duplicate into 409 with the active job
id), records activity, and runs placement.

### 5.2 Runner executor

For each `ASSIGN`:

1. **Workspace.** One clone per repo at `<workspaceRoot>/<owner>/<repo>`, reused. Credential helper and shims
   installed (§7.2). Before checkout: `git fetch`, then clean the working tree. The exact clean scope, and
   what nax state under `.nax/` must survive between runs, is pinned by spike SP-4.
2. **Checkout** `ref` as a detached HEAD. nax creates its own feature branch.
3. **Per-job output.** `<workspaceRoot>/.jobs/<jobId>/` holds the nax output dir (`nax-out/`), the git-cred
   socket and shim `bin/`. Isolation uses `config.outputDir`, which moves only the run output tree
   (`projectOutputDir`, nax `src/runtime/paths.ts:19-32`; absolute paths accepted). `NAX_GLOBAL_CONFIG_DIR` is
   ruled out: it also relocates profiles and the credential store (`src/agents/native/credentials.ts:26`). nax
   has no CLI flag for `outputDir`, so the runner writes a per-job profile `koda-job-<jobId>.json` =
   `{"outputDir": "<abs>"}` into the runner user's `~/.nax/profiles/`, appends it last to the chain (profiles are
   raw overlays, later wins), and deletes it at the end. SP-1 verifies this end to end.
4. **Spawn.** `nax run --headless --json -f <feature> --profile <chain> --max-cost <n>` or `nax plan --from
   <planFrom> -f <feature> --profile <chain>`, in its own process group, started detached so it survives a daemon
   restart. PID and process group go to the journal. The job becomes RUNNING.
5. **Watch.** Poll `status.json` every 2s; tail `events.jsonl`. Each change is a journal event. The first
   snapshot carries the nax run ids.
6. **Verdict.**

   `RUN` jobs are judged from the final `status.json` (nax `src/execution/status-file.ts:125` run status enum,
   `:54-66` `FinishPhaseStatus`), first matching row wins:

   | Condition | State |
   |:--|:--|
   | `cancelRequestedAt` set and the process ended | CANCELLED (must stay first: SIGTERM makes nax write `run.status = crashed`, `src/execution/crash-writer.ts:105`) |
   | `postRun.finish.result` = `escalated` | ESCALATED (`escalationReason` from `postRun.finish.escalationReason`) |
   | `run.status` = `completed` and `postRun.finish` absent, skipped, or `result` in `opened`, `promoted`, `already-ready`, `nothing-to-finish` | COMPLETED |
   | anything else (`failed`, `stalled`, `crashed`, `precheck-failed`, `cost-limit`, `aborted`, no `status.json`) | FAILED (`stateReason` = run status or the missing file) |

   `PLAN` jobs: COMPLETED when the process exited and `.nax/features/<feature>/prd.json` exists and parses as
   JSON with a non-empty `userStories` array; otherwise FAILED. nax can exit 0 after writing an invalid PRD, so
   the file is checked, not the exit code.

   `resultPrUrl` comes from `postRun.finish.url`; `resultBranch` and `resultSha` from the `branch` and `headSha`
   fields of `finish-audit/<feature>/last.json` (nax `src/finish/audit.ts:51-52`) when present.

   `status.json` is written atomically (tmp + rename); a parse failure is treated as "no new snapshot" and
   retried on the next 2s tick. Five consecutive failures are logged as a watcher error in a `lifecycle` event.
7. **Upload.** UPLOADING, then a tar.gz of the run JSONL, cost ledger, review-audit, finish-audit,
   `metrics.json` and `status.json` (prompt-audit excluded), then the upload. Three failed attempts with
   backoff end the job in its verdict state with `stateReason='bundle upload failed'`; the bundle stays on disk.

### 5.3 Failure paths

- **Machine silent.** No sync for `FLEET_RUNNER_OFFLINE_SEC` (90) = offline. Its ASSIGNED or RUNNING jobs become
  CRASHED after `FLEET_JOB_CRASH_SEC` (300). An in-process sweep checks every 30s.
- **Daemon restart (C3).** A sync with a new `bootId` means the daemon restarted. The server updates
  `Runner.bootId` and queues `READOPT` for each of that runner's jobs whose `runnerBootId` differs. The runner
  re-adopts when the journaled PID is alive, `status.json` belongs to the job (matching `naxRunId`) and its
  heartbeat is under 2 minutes old: it re-attaches the watcher and acks `ok`, and the server sets
  `runnerBootId`. Otherwise it reaps `.nax-pids`, acks `rejected`, and the job becomes CRASHED. A job still
  ASSIGNED whose assign was never applied is re-sent the `ASSIGN`.
- **Cancel.** QUEUED: cancelled on the server. ASSIGNED with the assign never acked: cancelled on the server
  and the assign withdrawn. Otherwise `cancelRequestedAt` is set and `CANCEL` queued; the runner sends SIGTERM
  to the process group, SIGKILL after 30s, reaps `.nax-pids`, uploads a partial bundle, and reports CANCELLED.
- **Requeue.** CRASHED, FAILED or CANCELLED only, manual only. It moves the job back to QUEUED, clears the
  runner fields and increments `leaseEpoch`. The partial index still applies.

### 5.4a Service units

The nax child must survive a daemon restart (§5.3 readopt). The runner spawns nax with `setsid` (own session and
process group). The generated systemd unit sets `KillMode=process` (the default `control-group` would kill the
detached child on `systemctl restart`); the launchd plist sets `AbandonProcessGroup` to `true`. Both units run as
the dedicated runner user (§5.5). The runner test suite includes a restart test per platform.

### 5.4 State transitions

Server-owned: QUEUED→ASSIGNED (placement), QUEUED→CANCELLED, ASSIGNED→CANCELLED (unacked assign),
ASSIGNED|RUNNING→CRASHED (sweep or rejected readopt), CRASHED|FAILED|CANCELLED→QUEUED (requeue).
Runner-reported: ASSIGNED→RUNNING, ASSIGNED→FAILED (workspace or checkout failed, `stateReason` says which),
ASSIGNED→CANCELLED (cancel before spawn), RUNNING→UPLOADING, UPLOADING→COMPLETED|FAILED|ESCALATED|CANCELLED,
RUNNING→CANCELLED. Any other transition is rejected
and logged. Every transition writes a `state` event and `FleetActivity`.

### 5.5 Isolation (R7)

- **`JobExecutor` seam** in the runner: `prepare(job)`, `spawn()`, `watch()`, `kill(signal)`,
  `collectBundle()`, `cleanup()`. S1 ships `HostExecutor` only. The runner reports `executors: ['host']` in
  `RunnerCapabilities`; a later job field can require `vm` without protocol or server changes.
- **Dedicated OS user.** The daemon runs as a `koda-runner` user (installed by `koda-runner install-service`)
  with its own home and `~/.nax` (provider credentials provisioned there by a human, as today), no personal SSH
  keys, and access only to its workspace root. The P4 Bash sandbox still wraps agent Bash calls inside that.
- **Not covered:** the coding agent can still read the runner user's `~/.nax/credentials` (nax needs them) and
  the job's git-cred socket; a VM does not change the first point either.
- **VM executor (later phase, after S1b):** Lima or Tart on macOS (Linux guests; Apple allows two macOS guests
  per host), Firecracker or libvirt on Linux, warm images and a dependency cache, git-cred socket forwarded into
  the guest.

## 6. Exclusive execution (R6)

### 6.1 Compare-and-set assignment

```sql
UPDATE "FleetJob" SET state = 'ASSIGNED', "runnerId" = $r, "runnerBootId" = $b,
       "leaseEpoch" = "leaseEpoch" + 1, "assignedAt" = now()
 WHERE id = $j AND state = 'QUEUED'
RETURNING "leaseEpoch";
```

Zero rows means another placement won; no command is created. Placement also locks the runner row
(`SELECT … FOR UPDATE`) so its capacity count is exact.

### 6.2 Lease epoch fence

Every `ASSIGN` carries `leaseEpoch`. Every job event, command ack, token request and bundle upload carries the
epoch the runner holds. The server accepts them only when `(runnerId, leaseEpoch)` equals the job's current
values. A mismatch is not stored; the server queues `ABANDON` for that runner and job. On `ABANDON` the runner
kills the nax process group if it is still running, deletes the job's journal and socket, and pushes nothing.

### 6.3 Broker fence

The git broker mints only for the current `(runnerId, leaseEpoch)` of a job that is ASSIGNED, RUNNING or
UPLOADING. A stale runner that never syncs still loses git access when its token expires (GitHub, 1h), so its
finish push fails. This is the hard fence; §6.2 alone is advisory to a runner that ignores it.

### 6.4 One active job per repo and feature

The partial unique index in §2 blocks a second active job for the same `(repoId, feature)`, whether `RUN` or
`PLAN` (both write `prd.json` and the feature branch). Different features of one repo may run on different
machines at once.

## 7. Git credential broker (C7, R3, R5)

### 7.1 Server

- Config (Joi, `apps/api/src/config/env.validation.ts`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`,
  `GITHUB_APP_SLUG`. Unset means GitHub repos cannot be registered; the app still boots. `FLEET_GITLAB_BOT_NAME`
  and `FLEET_GITLAB_BOT_EMAIL` set the GitLab commit identity.
- **GitHub:** sign an App JWT (RS256, 10 min), `POST /app/installations/{id}/access_tokens` with
  `repositories: [name]` and `permissions: {contents: write, pull_requests: write, metadata: read}`. Cached in
  memory per `(jobId, leaseEpoch)` until 5 minutes before expiry.
- **GitLab:** decrypt the project's `VcsConnection.encryptedToken` (`common/utils/encryption.util`). The
  FleetRepo must equal that connection's `repoOwner`/`repoName`. `VcsConnection.projectId` is unique, so S1
  supports **one GitLab fleet repo per project** (the connected one); GitHub has no such limit. A per-repo GitLab
  token is a later extension if needed.
- Tokens are returned only in the sync response `gitTokens`, computed per request, never written to the
  database (including `FleetCommand`), never logged, and redacted from error bodies.
- **Registration checks.** GitHub: the installation exists and lists the repo; `githubInstallationId` is stored.
  GitLab: the token's access level on the project is Developer or higher and it has `write_repository` scope.
  A failing check is 422 with the reason.
- **Attribution.** When a job with `resultPrUrl` reaches a terminal state, koda posts one PR/MR comment with the
  broker token: "Dispatched by <user> via koda job <id>". Failure to comment is logged, not fatal.

### 7.2 Runner

- Per job, the daemon serves the current token on `<jobDir>/git-cred.sock` (mode 0600) and refreshes it through
  `tokenRequests` when it is within 10 minutes of expiry.
- Per clone: `git config credential.helper "!<runner>/bin/koda-git-cred <sock>"`, returning
  `username=x-access-token` (GitHub) or `oauth2` (GitLab) with the token as password; `user.name`/`user.email`
  set to the App bot (`<slug>[bot]`, GitHub noreply) or the GitLab bot identity.
- `gh`/`glab` shims first on the job's `PATH` (`<jobDir>/bin`) fetch the token and `exec` the real binary with
  `GH_TOKEN` / `GITLAB_TOKEN` set for that process only. No token is placed in the nax process environment.

Verified at nax `1c7aa52ee`: the finish phase's `git push` and `gh`/`glab` calls run through `Bun.spawn`
with `process.env` passed through (`src/forge/deps.ts:39-56`, `src/utils/git-env.ts:66-72`), **outside** the P4
Bash sandbox, which wraps only agent Bash tool calls (`src/agents/coding-tool-sandbox.ts`). So the socket and
shims are not blocked by srt/bubblewrap for the finish push. nax detects the forge from the `origin` hostname
first and probes `gh`/`glab` only for ambiguous hosts (`src/forge/detect.ts:54-58`); shim tests cover the
action calls (`pr create`, `pr view`, `pr ready`, `pr edit`) as well as the probe.

### 7.3 Known limits

The coding agent runs as the same OS user and can reach the socket; the protection is the token's scope (one
repo, about an hour for GitHub), not secrecy. The GitLab token lasts as long as the stored token. If koda is
unreachable for over an hour mid-run, the GitHub finish push fails and nax escalates; the branch stays in the
runner's clone.

## 8. Activity log and artifact storage (C5, C6 seam)

- `FleetActivityService.record(tx, entry)` is called inside the mutating transaction for: dispatch, cancel,
  requeue, state transitions, runner enroll/enable/disable/delete, enrollment token issue, repo create/delete,
  abandon. Runner-originated rows use `actorType=RUNNER` with `responsibleUserId = job.requestedById`.
  `GET /fleet/activity` is paged (`@nathapp` `Page`) and filterable by job, runner and user; global ADMIN sees
  all, project members see rows for their projects' jobs.
- `ArtifactStore { put(key, stream, maxBytes); get(key); stat(key); delete(key) }`, implemented by
  `LocalDiskArtifactStore` under `FLEET_ARTIFACT_DIR`. Keys are server-generated (`jobs/<jobId>/<epoch>.tar.gz`),
  never taken from the request. Bundle download: `GET /projects/:slug/fleet/jobs/:id/bundle` (project member).

## 9. Designed now, built later

### 9.1 C1 Budgets (S1b)

```
BudgetPolicy   { id, scopeType: global|project|repo|runner, scopeId?, windowKind: calendar_month_utc|lifetime,
                 amountUsd, warnPercent = 80, hardStop = true, runningJobs: finish|cancel = finish,
                 pausedAt?, pauseReason?, createdById }
BudgetIncident { id, policyId, kind: warn|hard_stop, windowStart, spentUsd, approvalId?, createdAt }
```

Window spend = sum of `costSpentUsd` of in-scope jobs started in the window, live from snapshots and corrected
from the bundle's cost ledger at ingest. Checked at dispatch (409 naming the policy) and again at placement (a
QUEUED job in a paused scope is cancelled, never assigned). Warn: incident + outbox notification. Hard stop:
pause the scope, cancel its QUEUED jobs, apply `runningJobs` to RUNNING jobs (`cancel` sends `CANCEL` as soon as
a snapshot crosses the limit), raise a `budget_override_required` approval. `--max-cost` per job stays the
innermost cap.

### 9.2 C4 Schedules (S1b)

`JobSchedule { id, projectId, repoId, cron, timezone, template (dispatch fields), enabled, lastFiredAt,
createdById }`; adds `FleetJob.scheduleId?` and `coalescedCount Int @default(0)`, with a partial unique index on
`(scheduleId) WHERE state = 'QUEUED'`. An in-process cron fires enabled schedules; a duplicate QUEUED becomes
`coalescedCount + 1`. Dispatch rules (feature index, budgets) apply; a schedule whose job is RUNNING skips the
tick and logs it.

### 9.3 C8 Typed approvals (S1.5)

`Approval { id, type: budget_override_required|nax_bash_escalate, status: pending|approved|rejected|cancelled|
expired, jobId?, policyId?, payload, requestedAt, decidedById?, decidedAt?, decision?, comment? }`. Budget
overrides decide `keep_paused` or `raise_budget_and_resume`. Bash escalations: the runner hosts nax's webhook
interaction URL on localhost and relays ask and answer over sync; timeout = deny (`expired`). One inbox page.
Unlocks `bashMode: gated|escalate`.

### 9.4 C9 Work products (S2b)

`TicketWorkProduct { id, ticketId, jobId?, kind: pull_request|branch|commit|artifact, url?, ref?, sha?, meta }`,
plus `FleetJob.ticketId?`. A linked job's result fields become work products at terminal state; an escalation
adds a ticket comment with the reason.

### 9.5 C6 remainder (S2a)

`ArtifactStore.putLogChunk(jobId, seqRange, stream)` for full JSONL streaming; `FleetJobEvent` stays the small
indexed timeline.

### 9.6 Phase order

S1 (this spec) → S1b (C1, C4) → S1.5 (C8 + approvals relay) → S2a (logs) → S2b (C9, dashboard, analytics) → S3
(rules/context PRs, now on the S1 broker) → S5 (acpx brainstorming).

## 10. Spikes before the plan

Local and read-only; none is a billed nax run.

| # | Question | Decides |
|:--|:--|:--|
| SP-1 | Answered by review (`config.outputDir`). Verify end to end that a per-job profile appended last to the chain moves `status.json`, run logs, finish-audit and the cost ledger under `<jobDir>/nax-out` while profiles and credentials still resolve from the runner user's `~/.nax`. | §5.2 step 3 |
| SP-2 | Answered by review: no nax command resolves a chain today. Replaced by a nax PR (`nax config --profile <chain> --json`, `nax auth list --json`), landed before slice 3. | §2.1 |
| SP-3 | Answered by review: the credentials file shape is `{credentials: {<providerId>: {kind, expires}}}`; read directly until the nax PR ships. | §2.1 |
| SP-4 | Which nax state under `.nax/` must survive between runs of the same repo on one machine, so the pre-checkout clean does not delete it? | §5.2 step 1 |

## 11. Web and CLI

Web, under `/fleet`:

- **Runners** (ADMIN): online state, labels, capacity, capability chips (sandbox, protocols, credential kinds
  and expiry), last seen, boot age; enable/disable; issue an enrollment token (shown once).
- **Repos** (ADMIN): registry with a reachability badge.
- **Dispatch** (project DEVELOPER+): repo, ref, command, feature, plan spec path, profile chain, max cost,
  labels or pin; shows why each runner does not fit; a 409 links to the active job.
- **Jobs**: list filterable by state, repo, runner and requester; detail with the event timeline, progress,
  current story and phase, live cost, finish result and escalation reason, branch/PR link, bundle download,
  cancel and requeue.

User-facing strings follow the repo's split i18n: API messages in `apps/api/src/i18n/{en,zh}`, web strings in
`apps/web/i18n/locales/{en,zh}.json`.

CLI: `koda fleet runner list|enable|disable|enroll-token`, `koda fleet repo add|list|rm`,
`koda fleet dispatch …`, `koda fleet job list|show|cancel|requeue|bundle`.

Runner packaging: `bun build --compile` for darwin-arm64, darwin-x64 and linux-x64; `koda-runner enroll
--server <url> --token <t>`; `koda-runner install-service` writes a launchd plist or systemd unit.
Config file: server URL, workspace root, labels, capacity. The server URL must be `https://` unless it is a
loopback or explicitly allowed with `--insecure-http` (VPN phase).

## 12. Testing

TDD throughout.

- **Unit:** placement rules and ordering, state transition table, verdict mapping (every row in §5.2 step 6),
  fence checks, capability matching, token cache expiry.
- **Integration (real Postgres, `KODA_DB_TESTS=1`):** two concurrent placements for one job → exactly one
  assigns; stale-epoch event, ack, token request and bundle → rejected plus `ABANDON`; active duplicate
  `(repoId, feature)` → 409; duplicate `seq` same payload → no-op, different payload → rejected; boot-id change
  → `READOPT`, ok and rejected paths; silence sweep with a fake clock; enrollment token reuse → 401; RUNNER key
  refused off `/fleet/runner/*`.
- **Runner:** against the real API in process, with a fake-nax fixture that writes real-shaped `status.json`,
  `events.jsonl` and run JSONL and ends in each finish result. Covers kill -9 of the daemon (readopt), a network
  cut (resend from the ack cursor), cancel, and `ABANDON`.
- **Broker:** GitHub and GitLab HTTP mocked; clone, push and `gh` through the helper and shims against a
  `file://` bare remote; assert no token in the nax environment, database or logs.
- **E2E (Playwright):** dispatch → job detail updates live → COMPLETED, with the fake-nax runner.
- **Live check (last, billed, needs user approval at launch):** one real two-machine run of a trivial feature.

## 13. Delivery

One plan per slice, each a PR, in order:

1. `packages/fleet-protocol`, Prisma models and migration, RUNNER principal and enrollment, repo registry with
   broker registration checks, `FleetActivity`.
2. Jobs: dispatch, placement, fencing, sync endpoint, commands, cancel, requeue, silence sweep, boot-id
   reconcile, bundle upload, token minting, `fleet_job` live events.
3. `apps/runner`: journal, sync loop, executor, watcher, git-cred, capability probe, service units. Adds
   `.nax/mono/apps/runner/context.md` (and regenerates agent files with `nax generate`), per the repo rule that
   every app has its own context file.
4. Web pages and CLI.

SP-1 and SP-4 run before the slice 3 plan; they do not change slices 1-2. The nax PR (§2.1) lands before slice 3.
