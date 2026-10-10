# Fleet S5a — Brainstorm Threads (Runner-Hosted Chat, Skill Catalog, Thread → Plan → Run) — Design

First part of fleet phase S5 (fleet design doc §3 (e) + (i), §5). S4 is complete and deployed on koda-wk (§9.52).
This is also the koda side of nax-agent master plan S6 ("koda agent chat"); the nax side was a capability check
(master plan §5 S6 row).

- **S5a (this spec): repo-grounded brainstorm threads.** A person chats with an agent that runs on a fleet runner,
  reads the repo, writes a spec with the spec-writing and spec-review skills, and hands it to the existing PLAN and RUN
  jobs.
- S5b (later, own spec): the standalone assistant over koda data (koda tools, RAG/memory as retrieval).
- Later: interactive coding threads (writes beyond docs), deferred by ruling D537.

**One spec, four phases (D545).** Each phase gets its own implementation plan and PRs and leaves main green and
deployable:

| Phase | Delivers | Sections |
|---|---|---|
| **A** Skill catalog | global skill sources (public GitHub), project enablement, admin + project UI | §1 |
| **B** Native chat, read-only | protocol v4, `THREAD` jobs, placement, ingest, content SSE, runner session host (native backend), read/search/skill tools, minimal chat page | §2, §3, §4 (native), §6.1 |
| **C** Write path and handoff | `write_doc`, detached worktree, Publish, Plan, Run, action bar | §4.4 (`write_doc`), §5, §6.2 |
| **D** ACP backends | Claude/Codex threads, `threadBackends` for ACP, canary and resume live checks | §4.2 (acp), §4.6, §11 |

Phase B ships behind a kill switch (§2.6) and pins nax-agent 0.85.0; threads are enabled once the nax release with
#2427 and #2346 exists and the floor is raised (§4.2).

## Goal

From koda's web UI a project member opens a thread against a project repo, brainstorms with an agent (nax native or
Claude Code over ACP) that can read and search the code, and ends with `.nax/features/<feature>/spec.md` committed on a
runner-local branch. From the same thread they dispatch PLAN and then RUN on that branch. No provider credential leaves
the runner, transcripts live in koda, and every billed step is an explicit click.

## Success criteria

1. A global admin registers a public skill source (GitHub URL, ref, path); koda pins it to a commit SHA and lists the
   skills found. A project admin enables skills for the project. (A)
2. A DEVELOPER+ member creates a thread (repo, base ref, feature, backend) and chats with the agent; replies stream
   into the page as they are produced. (B)
3. The agent can list and search tracked files, read files inside its checkout, and load enabled skills (B); it can
   write Markdown only under the allowlist (C). It cannot read outside the checkout, run a shell, or reach the web.
4. A live thread never blocks PLAN or RUN jobs of other features on the same repo and runner. (B)
5. Publish commits only the files the thread wrote, on the runner's local `feat/<feature>` branch, and pushes nothing.
   (C)
6. Plan dispatches a PLAN job pinned to the thread's runner with `planFrom` = the spec; Run dispatches RUN on the same
   branch; RUN's finish phase opens a PR carrying spec + PRD + code. A crashed session never blocks Plan or Run. (C)
7. Project members read every thread live; only the creator acts. Agent keys are refused on every thread route. (B)
8. An idle session closes and the next message resumes it with the earlier context; a runner crash mid-turn marks the
   job CRASHED and the next message resumes. No chat event is lost when the API restarts. (B; ACP resume in D)
9. A thread records the exact skill SHAs it ran with; updating a source does not change existing threads. (A + B)
10. Thread spend counts toward fleet budgets. (B)

## Rulings (user, 2026-10-10)

- D535: first use = brainstorm and write specs in a repo (Q1 A). The assistant over koda data is S5b.
- D536: the agent writes only docs, through an allowlisted tool (Q2 A).
- D537: unrestricted writes (interactive coding) are deferred (Q2 C, "defer C").
- D538: the flow is brainstorm → spec (spec-writing skill) → spec review (spec-review skill) → Plan → Run, with no
  separate docs PR. Publish commits locally and does not push; PLAN keeps its existing branch push; RUN's finish phase
  opens the PR.
- D539: both backends: nax native (nax-ai, credentials in the runner's `~/.nax`) and ACP agents (Claude Code, Codex,
  logged in on the runner), chosen per thread (Q3 C).
- D540: skills come from a **global catalog of source records kept in koda** (GitHub URL + ref + path, pinned to a
  commit SHA). Runners fetch the pinned content. Projects enable skills individually (Q4 revised, Q5 A).
- D541: visibility = project members read every thread; only the creator sends, stops, answers, publishes, ends the
  session, plans, runs and raises the cap (Q6 B).
- D542: architecture = approach 1: a thread is a long-lived record whose live session is a finite `THREAD` fleet job;
  the session runs inside the runner daemon on `@nathapp/nax-agent`. Sessions stay on the runner (fleet design doc §3
  (e), credentials never leave the machine).
- D543: sessions always use nax-agent profile `read`. Bash and web tools are denied by the profile's auto-reject;
  `ask` and `full` are never used for threads.
- D544: koda injects `list_files` and `search_repo` because Claude Code in `read` mode has no Grep or Glob tool
  (canary probe, below).
- D545: one spec, delivered in phases A-D, each with its own plan (final review 2026-10-10).
- D546: v1 skill sources are **public GitHub repos only**; private sources are deferred (no token path exists for a
  non-fleet repo).
- D547: the thread worktree is **always detached**; Publish moves the branch with `update-ref` (final review B4).
- D548: no ACP login probe; a runner reports an ACP agent when it is launchable, and a missing login fails the session
  with `agent_not_logged_in`.

## Ground truth (verified on koda main `3162822d` and nax main `4544297ea`, 2026-10-10)

koda:
- The runner talks to the API only through `POST /fleet/runner/sync` (long-poll; `syncTimeoutMs` 35 s, `syncMinGapMs`
  250 ms, `apps/runner/src/daemon/tuning.ts:45-49`) plus the log and bundle PUTs
  (`apps/api/src/fleet/logs/log-upload.controller.ts:19`). `FLEET_PROTOCOL_VERSION = 3`
  (`packages/fleet-protocol/src/index.ts:7`); the sync request carries one `freeSlots` number (`index.ts:212`). The API
  mirrors the protocol in `apps/api/src/fleet/common/protocol.ts` (the image does not ship the package), with parity
  tests.
- Job kinds are `FleetJobKindName = 'RUN' | 'PLAN' | ConfigJobKind` (`index.ts:104`). `FleetJob` has no payload
  column; config jobs keep their input in the 1:1 `FleetConfigEdit` table (`apps/api/prisma/schema.prisma:983`).
- Server → runner messages are `FleetCommand` rows re-sent until acked (`schema.prisma:1029`); types `ASSIGN | CANCEL |
  READOPT | ABANDON | APPROVAL_ANSWER`. `CommandAckProcessor` (`apps/api/src/fleet/sync/command-ack.processor.ts`)
  acts on acks of those types only; any other acked command changes nothing. Unknown command types are acked
  `rejected` by the runner.
- Job states: the runner may go `RUNNING → UPLOADING → COMPLETED` without a bundle (`apps/api/src/fleet/jobs/job-state.ts`
  RUNNER table). READOPT rejects config jobs explicitly (`apps/runner/src/supervisor/supervisor.ts:107`,
  `isConfigKind`).
- Placement (`apps/api/src/fleet/jobs/placement-rules.ts`, `placement.service.ts`): `firstMisfit` returns `busy_repo`
  when the runner already holds any job of the repo (`placement-rules.ts:101`) and `capacity` when active jobs ≥
  `Runner.capacity` (`schema.prisma:706`). `fillRunner` runs when a runner syncs with free slots.
- A partial unique index allows one active job per `(repoId, feature)` over QUEUED, ASSIGNED, RUNNING, UPLOADING
  (`FleetJob_active_repo_feature_key`, migration `20260930090000_fleet_jobs`:152).
- Budgets: `windowSpend` sums `FleetJob.costSpentUsd` (+ carried) (`fleet/budgets/prisma-budget.repository.ts:107`);
  hard stops cancel `BUDGET_STOP_COMMANDS = [RUN, PLAN]` (`:22`) via `cancelForBudget`
  (`fleet/budgets/budget-evaluator.ts:117`).
- Log streams are `['run', 'stdout', 'stderr']` (`apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts:1`), read by
  project members through `FleetJobLogsController` (`fleet/logs/fleet-job-logs.controller.ts:30-60`), backfilled from
  bundles by `log-fallback.service`, and shipped by the runner's `LogShipper` (`apps/runner/src/logs/log-shipper.ts:72`)
  on its 2 s status tick.
- Live: `LiveStreamRegistry` (`apps/api/src/live/live-stream-registry.ts:5`) only counts streams per user (10);
  fan-out is `ProjectEventBus` / `UserEventBus` (`live/project-event-bus.ts:16`, `live/user-event-bus.ts:22`);
  `createLiveStream` (`live/live-stream.ts:31`) re-checks access on heartbeat and closes at JWT expiry. All existing
  streams are content-free.
- Runner: one job per repo checkout (`RepoMutex`, `apps/runner/src/supervisor/repo-mutex.ts:2`, held prepare →
  cleanup); `planBranch` keeps a local-only branch (`apps/runner/src/executor/branch.ts:19-30`, D51); PLAN commits and
  pushes `prd.branchName` (`executor/plan-commit.ts:62-103`); RUN checks out the PRD's `branchName`. ASSIGN payloads are
  parsed by `parseAssign` (`supervisor/assign-parser.ts:37`).
- S3 config jobs check paths with `isAllowedNaxPath` (`packages/fleet-protocol/src/nax-config-paths.ts:29-42`), which
  allows `.nax/` config files only; it is not reusable for docs.
- Git tokens: `GitTokenBroker.mint({ jobId, leaseEpoch, repo })` mints only for `FleetRepo` rows with an installation
  (`fleet/git-broker/git-token.broker.ts:20`). Forge HTTP goes through `FleetHttpClient`
  (`fleet/git-broker/fleet-http-client.ts:10`); `getTree` exists in `github-app-client.ts:143`.
- Web renders untrusted Markdown with `renderMarkdownOrEscape` (`apps/web/lib/markdown.ts:42`).

nax (`@nathapp/nax-agent` 0.85.0 published; main `4544297ea`):
- `createAgentSession({ backend, sessionId?, profile, workdir, instructions, tools, transcriptStore,
  approvalTimeoutMs?, turnTimeoutSeconds?, metadata })`; `resumeAgentSession` (rejects a different backend kind;
  `lastTurn.status = interrupted` after a dead process); `session.send(text)` → `AsyncIterable<SessionEvent>`;
  `answer(requestId, reply: AnswerReply) → AnswerStatus`; `close()`
  (`packages/nax-agent/src/session/agent-session-types.ts:53-171`). `createFileTranscriptStore(dir: string)` (an
  absolute path). `redactSecrets` is a public export.
- `SessionEvent` bodies: `turn_start`, `text_delta`, `thinking_delta`, `stream_reset { round, attempt }`, `tool_call`,
  `tool_result`, `approval_requested` / `approval_resolved` (`answerable?: false` when decided by the profile),
  `question` (`answerable?: false` when informational), `usage` (with `costSource`), `compaction`, `turn_end { status,
  output }`; `output` is the final round's text and empty when the turn did not complete. `TurnEndStatus = completed |
  cancelled | timed_out | interrupted | errored`.
- Native `read` tools: `Read`, `Glob`, `Grep`, read-only `Git`, scratchpad tools, plus embedder tools; no Bash, write or
  web tools; paths realpath-checked inside `workdir`; `.git` refused; the configured credentials directory and any
  `hostPorts.protectedPaths` refused. No OS sandbox for `read`.
- ACP Claude `read`: mode `default`, write tools disallowed, `settingSources: []`, every permission request
  auto-rejected (`decidedBy: profile`). Embedder tools go through a loopback MCP host (127.0.0.1, per-session token)
  and are pre-approved. Resume uses `session/resume` when the agent advertises it, else `session/load`
  (`packages/nax-agent-acp/src/client/resume.ts`). `isAgentLaunchable` checks the command only; there is no login
  probe.
- nax plan defaults the PRD `branchName` to `feat/<feature>` (`packages/nax/src/plan/strategies/context-builder.ts:81`).
- **Canary probe (2026-10-10, runner host, Claude via ACP, profile `read`):** Read inside workdir allowed; Read of a
  `$HOME` file, a `/private/tmp` file, a committed symlink to `$HOME`, a symlinked directory and a `..` path all denied
  by the profile; Bash `cat`, WebFetch and WebSearch denied; no Grep or Glob tool; an embedder tool ran without
  approval. The canary never appeared in any event.
- #2427 (facade compaction) and #2346 (JSON/env secret redaction) are merged (`4544297ea`, `97e02b874`) and
  unreleased.

## 1. Skill catalog (phase A)

### 1.1 Data

```prisma
model SkillSource {
  id           String    @id @default(cuid())
  gitUrl       String    // https://github.com/<owner>/<repo>, normalized (no .git, lowercase owner/repo)
  owner        String
  repo         String
  ref          String    // branch or tag as entered
  path         String    // repo-relative directory holding skill directories; "" = repo root
  resolvedSha  String?
  resolvedAt   DateTime?
  status       String    // OK | RESOLVE_FAILED
  statusReason String?
  createdById  String
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  skills       Skill[]
  @@unique([owner, repo, ref, path])
}

model Skill {
  id          String   @id @default(cuid())
  sourceId    String
  name        String   @unique   // SKILL.md frontmatter; ^[a-z0-9][a-z0-9-]{0,63}$
  description String   // ≤ 1 KiB
  dir         String   // repo-relative directory at resolvedSha
  source      SkillSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  projects    ProjectSkill[]
}

model ProjectSkill {
  projectId   String
  skillId     String
  enabledById String?
  createdAt   DateTime @default(now())
  skill       Skill    @relation(fields: [skillId], references: [id], onDelete: Cascade)
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@id([projectId, skillId])
}
```

### 1.2 Resolve (API)

- `SkillResolver` (interface; v1 `GitHubSkillResolver`) runs on create and on Update, never in the background, through
  `FleetHttpClient`:
  1. ref → commit SHA (`GET /repos/{owner}/{repo}/commits/{ref}`);
  2. the recursive tree at the SHA (`getTree`); every directory directly under `path` that contains `SKILL.md` is a
     skill (at most 50);
  3. each `SKILL.md` blob (≤ 256 KiB): YAML frontmatter `name` and `description`, bounded as in §1.1.
- **Public repos only (D546).** Calls use an App installation token when the App happens to be installed on the repo
  (better rate limit), else anonymous. A 404 or a private repo → `RESOLVE_FAILED` with reason `not_public_or_missing`.
  Anonymous calls are limited by GitHub (60/h per IP), acceptable because resolves only run on an admin click.
- Only `https://github.com/<owner>/<repo>` URLs are accepted (400 `skills.unsupportedHost`).
- A name already owned by another source → 409 `skills.nameConflict` (naming the source); nothing is written. Update
  replaces the source's `Skill` rows in one transaction; `ProjectSkill` rows survive for skills whose name survives;
  if the new tree brings a name owned by another source the whole update is refused with the same 409 and the old pin
  stays.

### 1.3 Routes

- Global ADMIN: `GET/POST /admin/skills/sources`, `POST /admin/skills/sources/:id/update`,
  `DELETE /admin/skills/sources/:id`.
- Project: `GET /projects/:slug/skills` (any member; catalog skills with `enabled`), `PUT` / `DELETE
  /projects/:slug/skills/:skillId` (project ADMIN or global ADMIN). Agents 403.

### 1.4 UI

- `/admin/skills` (global admin): sources table (url, ref → short SHA, path, status and reason, skill count) with Add,
  Update, Remove; each row expands to its skills. ADMIN sidebar entry **Skills** and a palette entry.
- Project settings → **Skills** tab (project ADMIN): every catalog skill with an on/off switch, source and SHA.

### 1.5 Runner fetch and agent access (built in phase B)

- A thread's skill snapshot (§2.1) lists `{ sourceId, owner, repo, sha, skills: [{ name, dir }] }`.
- During thread prepare the runner ensures `~/.koda-runner/skills/<sourceId>/<sha>/` exists; if absent it runs, with
  `GIT_TERMINAL_PROMPT=0`, an empty credential helper list, `-c core.hooksPath=/dev/null` and
  `GIT_LFS_SKIP_SMUDGE=1`: `git init`, `git fetch --depth 1 --no-recurse-submodules https://github.com/<owner>/<repo>
  <sha>`, `git checkout --detach <sha>`; a 50 MiB tree cap (abort and delete above it). Every path segment goes through
  `paths/safe-segment.ts`. Failure fails the job with `skill_fetch_failed`.
- Cached SHAs are shared; the daily prune deletes SHA directories not used for 30 days (mtime touched on use).
- The system prompt lists each snapshot skill as `name — description`. `load_skill(name)` returns `SKILL.md`;
  `read_skill_file(name, relPath)` returns a UTF-8 text file inside the skill directory (≤ 256 KiB, realpath inside the
  directory, symlinks and binary refused).

## 2. Threads (phase B)

### 2.1 Data

```prisma
model ChatThread {
  id              String    @id @default(cuid())
  projectId       String
  repoId          String
  baseRef         String
  feature         String    // slug; branch feat/<feature>
  title           String
  createdById     String
  runnerId        String?   // pinned at first assignment, never changed
  backend         Json      // { kind: "native" | "acp", agent?: "claude" | "codex", model?: string, effort?: string }; immutable
  status          String    @default("ACTIVE") // ACTIVE | ARCHIVED
  skills          Json      // snapshot (§1.5) taken at creation
  maxCostUsd      Decimal   @default(5) @db.Decimal(12, 4)
  costUsd         Decimal   @default(0) @db.Decimal(12, 4)
  tokens          Json      // { input, output, cacheRead, cacheWrite }
  specPath        String    // .nax/features/<feature>/spec.md
  writtenPaths    String[]  // hint for the UI; the runner computes the real set at publish (C)
  publishedSha    String?   // (C)
  specPublished   Boolean   @default(false) // specPath exists at publishedSha (C)
  pendingQuestion Json?     // { requestId, text, expiresAt }
  nextSeq         Int       @default(1)
  lastActivityAt  DateTime  @default(now())
  createdAt       DateTime  @default(now())
  messages        ChatMessage[]
  @@index([projectId, lastActivityAt])
}

model ChatMessage {
  id              String   @id @default(cuid())
  threadId        String
  seq             Int
  jobId           String?  // the THREAD job that produced (assistant) or received (user) it
  turnId          String?
  role            String   // user | assistant
  authorUserId    String?
  clientMessageId String?
  content         String   @db.Text
  toolSummary     Json?    // ≤ 50 × { callId, name, input (redacted, ≤ 512 B), isError, preview (≤ 512 B), decidedBy? }
  status          String   // pending | streaming | complete | cancelled | errored | timed_out | interrupted
  usage           Json?
  costUsd         Decimal? @db.Decimal(12, 4)
  costSource      String?  // computed | reported | unpriced
  createdAt       DateTime @default(now())
  @@unique([threadId, seq])
  @@unique([threadId, clientMessageId])
}

/// One THREAD job's input (1:1, like FleetConfigEdit for config jobs).
model FleetThreadTurn {
  jobId            String  @id
  threadId         String
  action           String  // SESSION | PUBLISH
  initialMessageId String? // SESSION: the user message that started the job
  instructions     String  @db.Text  // system prompt (§4.5)
  backend          Json    // copy of ChatThread.backend
  skills           Json    // copy of ChatThread.skills
  resume           Boolean // false only for the thread's first session
}

/// Durable ingest position of a job's thread stream (§3.3).
model ThreadIngestCursor {
  jobId      String
  leaseEpoch Int
  offset     BigInt  @default(0)
  updatedAt  DateTime @updatedAt
  @@id([jobId, leaseEpoch])
}
```

- `FleetJob` gains `threadId String?` (indexed); `command` gains `THREAD`. A `THREAD` job has `feature =
  "thread-<threadId>"` (so the `(repoId, feature)` active index never collides with the thread's own PLAN/RUN on
  `<feature>`), `ref = baseRef`, `maxCostUsd = maxCostUsd - costUsd` at dispatch, empty `profiles`, `bashMode raw`, no
  PRD, bundle, nax run ids or stories. PLAN and RUN dispatched from a thread carry `threadId` (C).
- `Runner` gains `threadCapacity Int @default(2)` (server-owned, editable like `capacity`).
- `feature` passes `validateBranchName` for `feat/<feature>` (logic mirrored in the API) and is unique among ACTIVE
  threads of the same repo (409 `threads.featureTaken`).
- `seq` is allocated by `UPDATE ChatThread SET nextSeq = nextSeq + 1 ... RETURNING` inside the inserting transaction.

### 2.2 Lifecycle

"Live session" = a `THREAD` job of the thread in RUNNING with `action = SESSION` and no `THREAD_CLOSE` queued for it.

1. **Create** (DEVELOPER+, who becomes the creator): stores the thread with the skill snapshot; no job.
2. **First message:** stores the user message (`pending`), creates a `THREAD` job + `FleetThreadTurn` (`resume:
   false`), places it (§2.3). The assignment transaction also writes `ChatThread.runnerId` (§2.3).
3. **Later messages:** with a live session, the message is stored `pending` and a `THREAD_INPUT { messageId, text }`
   command is queued. Without one, a new `THREAD` job is created pinned to `runnerId` (`resume: true`). The message
   becomes `complete` when the runner reports it consumed (`input_consumed { messageId }`, §3.2).
4. **One turn at a time:** a send while a message of the thread is `pending` or `streaming` → 409
   `threads.turnRunning`.
5. **Stop:** `POST .../stop` queues `THREAD_STOP_TURN` (no turn id: the runner stops whatever turn is current, or the
   queued input if it has not started). The session stays open.
6. **Idle:** the idle timer (`THREAD_IDLE_SEC`, default 900) runs only while no turn is active and restarts at each
   `turn_end`. On expiry the runner closes the session; the job goes `RUNNING → UPLOADING → COMPLETED`
   (`stateReason = idle`).
7. **End session** (creator, C uses it before Plan): queues `THREAD_CLOSE`; the runner cancels a running turn first,
   then closes as for idle (`stateReason = closed`).
8. **Closing window:** while the previous `THREAD` job is in UPLOADING (draining its stream), a send → 409
   `threads.closing` (retryable; the web retries after 2 s up to 15 s).
9. **Rejected input:** a `THREAD_INPUT` acked `rejected` or `stale` marks its message `errored` with the reason
   (`CommandAckProcessor` gains this branch); the user resends.
10. **Crash / daemon restart:** READOPT rejects a RUNNING `THREAD` job (`isThreadKind` branch next to `isConfigKind`);
    the server marks it CRASHED. Every terminal transition of a `THREAD` job (CRASHED, ABANDON, sweeper "runner
    silent", CANCELLED, FAILED) runs one hook in `JobTransitionsService.apply` that sets the thread's `pending` and
    `streaming` messages to `errored` (keeping streamed text) and clears `pendingQuestion`.
11. **Runner offline:** a send while the pinned runner is offline → 409 `threads.runnerOffline`. Nothing is queued.
12. **Cost cap:** a send when `costUsd >= maxCostUsd` → 409 `threads.costCap`. `unpriced` usage adds tokens only.
13. **Archive** (creator or project ADMIN): status ARCHIVED, a live session gets `CANCEL`; archived threads are
    read-only. The runner removes `~/.koda-runner/threads/<id>/` in its daily prune when the API lists the thread as
    archived in the sync response (`archivedThreadIds`, bounded to 100).

### 2.3 Placement and capacity

- The v4 sync request gains `freeThreadSlots` (runner-side: `threadCapacity` from `/fleet/runner/me` minus live
  `THREAD` jobs). `fillRunner` places queued `THREAD` jobs only against `freeThreadSlots`, other jobs only against
  `freeSlots`.
- `placement-rules` treats `THREAD` as its own load class: it is exempt from `busy_repo` (it works in a worktree, §4.3)
  and from `capacity`; it gets `thread_capacity` (live THREAD jobs ≥ `threadCapacity`), `thread_backend` (the runner's
  `threadBackends` lacks the thread's backend), `protocol` (runner below v4) and `threads_disabled` (kill switch)
  misfits; profile, sandbox, interaction and approvals-relay checks do not apply. Other jobs ignore THREAD jobs when
  computing `busy_repo` and `capacity`.
- A thread's first `THREAD` job is unpinned; `casAssign` of a `THREAD` job writes `ChatThread.runnerId` in the same
  transaction when it is null. Later jobs are pinned (`pinnedRunnerId = runnerId`).

### 2.4 Cost and budgets

- The ingestor adds each `usage.costUsd` (priced only) to `ChatMessage.costUsd`, `ChatThread.costUsd` **and the THREAD
  job's `costSpentUsd`**, so `windowSpend` and the dashboard count thread spend.
- `THREAD` joins `BUDGET_STOP_COMMANDS`: a hard stop cancels queued and held THREAD jobs like RUN and PLAN. Dispatch of a
  THREAD job passes `BudgetGate`; a paused scope → 409 `threads.budgetPaused`.
- The runner stops the session when its job's `maxCostUsd` is exceeded mid-turn (cancel the turn, close; `stateReason
  = cost_cap`).

### 2.5 Access

Read (list, get, messages, events): any project member and global ADMIN. Act (send, stop, answer, end session,
publish, plan, run, cap, archive): the creator; archive also project ADMIN. Agents (API keys) 403 on every thread
route. Thread routes are users-only.

### 2.6 Kill switch

`FLEET_THREADS_ENABLED` (API env, default `false` until the nax floor is raised): when false, thread create and send
→ 409 `threads.disabled`, placement refuses THREAD jobs (`threads_disabled`), the web hides New thread. Reads stay
available.

## 3. Transport (phase B)

### 3.1 Down: commands

- `POST /projects/:slug/threads/:id/messages { text, clientMessageId }` (≤ 32 KiB). A repeated `clientMessageId`
  returns the existing message (200) and queues nothing. Checks in order: access, kill switch, archived, cost cap,
  budget, runner online, closing window, no pending/streaming message, no other active thread job (C, §5.1).
- New command types (all `FleetCommand`, fenced by `(runnerId, leaseEpoch)`, re-sent until acked, deduplicated on the
  runner by command id): `THREAD_INPUT { messageId, text }`, `THREAD_ANSWER { requestId, text }`, `THREAD_STOP_TURN`,
  `THREAD_CLOSE`, `THREAD_PUBLISH` (C). `ASSIGN` carries `THREAD` jobs with the `FleetThreadTurn` fields (and the
  initial message text for `SESSION`).
- On ack, `THREAD_INPUT` / `THREAD_ANSWER` payloads are replaced with `{ messageId }` / `{ requestId }`; the message
  row is the record.
- Commands for a THREAD job are only queued to a v4 runner; if the pinned runner reports v3 (downgrade) the send → 409
  `threads.runnerOutdated`.

### 3.2 Up: the `thread` log stream

- The runner appends each event (one JSON object per line) to `thread-events.jsonl` in the job directory and ships it
  as stream `thread` through `LogShipper` (`PUT /fleet/runner/jobs/:jobId/logs/thread`), with the existing offset,
  resume and drain-before-UPLOADING rules. `LogShipper.register` accepts `thread`; a `thread` stream wakes the shipper
  on append, at most once per 250 ms, within the existing per-runner byte-rate limits.
- Before writing, the runner passes `text_delta.text`, `thinking_delta.text` and `turn_end.output` through
  `redactSecrets` and caps a single line at 64 KiB (a longer delta is split).
- Runner-originated lines: `session_started { resumed, backend, skillShas }`, `session_closed { reason }`,
  `input_consumed { messageId }` (emitted just before `turn_start`), `write_doc { path }` (C), `published { sha, paths,
  specPresent }` / `publish_failed { reason }` (C), `session_failed { reason }`.
- Server: `LOG_STREAMS` gains `thread`. `FleetJobLogsController` refuses the `thread` stream (404) and lists only the
  other streams; `log-fallback.service` skips THREAD jobs (no bundle); retention may delete the raw stream because
  ingest has already folded it (§3.3).
- Per-stream cap: when the stream reaches 200 MiB the runner closes the session (`stateReason = stream_cap`); the next
  message starts a new job (and stream).
- `FLEET_PROTOCOL_VERSION` becomes 4: new job kind, five command types, `thread` stream, `freeThreadSlots`,
  `threadBackends`. Mirrored in `apps/api/src/fleet/common/protocol.ts` with parity tests; touch points include
  `FleetJobKindName`, `FleetCommandTypeName`, `LOG_STREAMS`, `sync-request.parser`, `parseCapabilities`,
  `parseAssign` and the runner journal schema. v3 runners keep serving non-thread jobs.

### 3.3 Ingest (API), durable

- After every accepted `thread` append, and once at startup for every non-terminal or recently terminal THREAD job,
  `ThreadIngestor.catchUp(jobId, leaseEpoch)` reads the stored stream from `ThreadIngestCursor.offset`, folds every
  complete line, and advances the cursor **in the same transaction** as the fold's row changes. The fold is
  idempotent per line (keyed by stream offset), so a crash between append and fold only delays ingestion. Catch-up
  runs under the per-key log lock; reads are bounded per call (`FLEET_LOG_SCAN_BYTES`) and loop until the end.
- Lines are untrusted: bounded fields, type-checked; a bad line is skipped and counted.

| Line | Effect |
|---|---|
| `input_consumed` | the user message → `complete` |
| `turn_start` | create the assistant message (`streaming`, next `seq`, `jobId`, `turnId`) |
| `text_delta` | append to the message's buffer; publish SSE `delta`; persist `content` at most once per second |
| `stream_reset` | drop the round's provisional text from the buffer; SSE `message` (refetch) |
| `thinking_delta`, `compaction` | ignored in v1 (kept in the raw stream) |
| `tool_call` / `tool_result` | upsert into `toolSummary` by `callId` (≤ 50; previews ≤ 512 B) |
| `approval_requested` / `approval_resolved` | record `decidedBy` on the matching tool entry; informational only |
| `question` | if answerable: set `pendingQuestion`, SSE `question`; if `answerable: false`: append a note to the message |
| `usage` | add to message, thread and job cost (§2.4) and tokens |
| `turn_end` | `content = output` when `completed`, else keep the streamed text; `status` = the end status (`cancelled`, `timed_out`, `interrupted`, `errored`); SSE `message`; signal the budget evaluator |
| `session_failed` | the thread shows the reason (§8) |
| `write_doc` / `published` | §5 (C) |

### 3.4 Browser: content-carrying SSE

- `GET /projects/:slug/threads/:id/events` via `createLiveStream` (membership re-checked on heartbeat, closed at JWT
  expiry, counted by `LiveStreamRegistry`). Delta fan-out uses a new `ThreadEventBus` keyed by thread id (same shape as
  `ProjectEventBus`); project and user streams stay content-free.
- Events: `delta { messageId, text }`, `message { id }`, `thread { state }`, `question { requestId, text }`.
- Reconnect = refetch messages, then subscribe; `message` at `turn_end` corrects any lost tail. When the per-user stream
  limit refuses the connection, the page polls `GET .../messages?afterSeq=` every 2 s while a turn is running.

## 4. Runner session host

### 4.1 Module (phase B)

`apps/runner/src/thread/`: `ThreadJobRun` (prepare → session → serial command loop → close), `SessionFactory`,
`ThreadWorktree`, `thread-tools/` (one file per tool), `ThreadEventWriter` (redaction, JSONL), `ThreadCommandQueue`.
`ThreadJobRun` emits only `ASSIGNED → RUNNING → UPLOADING → COMPLETED | FAILED | CANCELLED` and `ASSIGNED → FAILED |
CANCELLED` before the session starts.

- **Serial queue:** every command of a thread job (input, answer, stop, close, publish) goes through one FIFO queue.
  `THREAD_STOP_TURN` and `THREAD_CLOSE` act immediately on the running turn (cancel), then queue; `THREAD_PUBLISH`
  while a turn runs is acked `rejected` with `turn_running` (C).
- **Repo mutex:** the thread host takes `RepoMutex` only for `worktree add`, `fetch` of the base ref, and (C) publish's
  commit and `update-ref`; it never touches the main clone's working tree. PLAN/RUN `cleanWorkspace` (`reset`, `clean`
  in the main clone) does not affect a linked worktree's files.

### 4.2 Session

- **native (B):** `nativeBackend({ model, effort })`; credentials from the runner user's `~/.nax`
  (`configureCredentials`), which also makes the read tools refuse that directory.
- **acp (D):** `acpBackend({ agent, model, effort, allowUnsandboxed: true })`, default environment allowlist.
- Both: `profile: 'read'` (a unit test fails if the factory can build any other profile), `workdir` = the worktree,
  `transcriptStore = createFileTranscriptStore(<abs ~/.koda-runner/threads/<threadId>/transcript>)`,
  `turnTimeoutSeconds: 900`, `metadata: { threadId, jobId }`, `instructions` from the job, tools from §4.4,
  `hostPorts.protectedPaths` covering `~/.koda-runner`, `~/.nax` and `~/.ssh`.
- `resume: false` → `createAgentSession({ sessionId: <threadId> })`; `resume: true` → `resumeAgentSession`. When
  `lastTurn.status = interrupted` the interrupted turn is not replayed; the next input is a new turn. A missing
  transcript (runner home wiped) starts a fresh session and writes `session_started { resumed: false }`; the UI shows
  "context reset".
- **Version floor:** phase B pins nax-agent 0.85.0. A runtime constant `THREAD_NAX_AGENT_FLOOR` (set to the release
  that contains #2427 and #2346) gates thread support: below it the runner reports `threadBackends: []`, so no THREAD job
  is placed. Raising the floor and the pin, plus `FLEET_THREADS_ENABLED=true`, turns threads on.

### 4.3 Worktree (B; branch moves in C)

- `~/.koda-runner/threads/<threadId>/wt` is a `git worktree add --detach` of the runner's clone. A stale directory
  without a registered worktree is removed first; `git worktree prune` runs before `add`.
- **Always detached (D547).** Session start: under the mutex, `fetch` the base ref, then `git checkout --detach <tip>`
  where `<tip>` = `refs/heads/feat/<feature>` if it exists, else the resolved base ref (a remote branch is preferred,
  as for job refs). Uncommitted thread files are carried; if git refuses (a conflict with the new tip) the session
  starts on the old HEAD and emits `session_started { stale: true }`, and the UI offers **Discard unpublished
  changes** (C), which resets the worktree's unpublished files.
- Because the worktree never holds a branch, PLAN and RUN in the main clone can always check out `feat/<feature>`, and
  a crash never leaves the branch locked.

### 4.4 Tools

| Tool | Phase | Behaviour | Limits |
|---|---|---|---|
| `list_files(dir?, glob?)` | B | `git ls-files` plus untracked files under the `write_doc` allowlist (runner-side) | ≤ 2000 entries |
| `search_repo(pattern, glob?, max?, fixed?)` | B | `git grep -n -I [-F\|-E] -e <pattern> -- <glob>` with `--untracked` limited to the allowlist paths; `GIT_CONFIG_NOSYSTEM=1`; own process group, killed on timeout | 10 s; ≤ 200 hits, 64 KiB |
| `load_skill(name)` | B | §1.5 | snapshot skills only |
| `read_skill_file(name, relPath)` | B | §1.5 | ≤ 256 KiB, jailed |
| `write_doc(path, content)` | C | write a UTF-8 file into the worktree, no commit; emit `write_doc` | `docs/**/*.md` or `.nax/features/<thread feature>/**/*.md` (new `isAllowedThreadDocPath` in `@nathapp/fleet-protocol`); ≤ 512 KiB; safe segments; no existing symlink on the path; never `.git` |

All tools have `approval: "never"`. A refused call returns `isError: true` with a reason the agent can act on.

### 4.5 System prompt

Built by the API into `FleetThreadTurn.instructions`: the role (brainstorming partner for this repo and feature), the
spec target (`specPath`), the flow (brainstorm with the person; when they agree, `load_skill spec-writing` and write
the spec with `write_doc`; then `load_skill spec-review` and review it against the code), the tool rules, and one line
per snapshot skill. In phase B (no `write_doc`) the prompt asks the agent to put the spec draft in its reply.

### 4.6 Capabilities

`threadBackends` in the capability report: `{ native: [model ids from the runner's nax profiles with a credential],
acp: [agents for which isAgentLaunchable is true] }` (D548: no login probe), recomputed with the existing capability
probe (start, every `capabilityProbeMs`, SIGHUP). Parsed by `parseCapabilities` with bounds (≤ 32 models, ≤ 8 agents).
Phase B reports `acp: []`.

### 4.7 Questions and approvals

A `question` (answerable) waits for `THREAD_ANSWER`; the runner calls `answer(requestId, { text })`. Expiry follows
nax-agent's approval timeout (default 600 s) and clears `pendingQuestion` via the next `turn_end`. `approval_*` lines
in `read` are informational.

## 5. Publish, Plan, Run (phase C)

### 5.1 One active job per thread

A thread has at most one non-terminal job with its `threadId` (`THREAD`, `PLAN` or `RUN`), checked in the dispatching
transaction under a row lock on `ChatThread`. A send while the thread's PLAN or RUN is active → 409 `threads.busy`.
Note: the `(repoId, feature)` active index also blocks a manual dispatch of the same feature while the thread's PLAN or
RUN runs (the existing 409 with `activeJobId`).

### 5.2 Publish (creator)

- Enabled when the thread has unpublished changes (`writtenPaths` hint) and no turn is running.
- Live session → `THREAD_PUBLISH`; no session → a `THREAD` job with `action = PUBLISH` (no session starts).
- Runner, under the repo mutex, in the detached worktree:
  1. dirty set = `git status --porcelain -z` entries that pass `isAllowedThreadDocPath` and are not symlinks (the
     `write_doc` events are only a hint); others are ignored and listed in the result;
  2. `git add -- <dirty set>`; commit with the fleet git identity, message `docs(<feature>): spec from koda thread
     "<title>"`, trailer `Koda-Thread: <threadId>`;
  3. `git update-ref refs/heads/feat/<feature> <newSha> <expectedOld>` (`expectedOld` = the branch tip the session
     started on, or the zero SHA when the branch is new); a mismatch → `publish_failed { reason: branch_moved }` and
     the UI offers a fresh session;
  4. no push; emit `published { sha, paths, specPresent }`.
- Nothing to commit → `published` with the current tip and no paths.

### 5.3 Plan (creator)

- Requires `specPublished`, no live session (the creator uses **End session** first), no other active thread job.
- `FleetJobsService.dispatch` with `command: PLAN`, `ref: feat/<feature>`, `feature`, `planFrom: specPath`,
  `pinnedRunnerId: runnerId`, `threadId`, profiles and `maxCostUsd` from the dialog (dispatch defaults).
- The runner keeps the local branch (D51), runs `nax plan`, commits `prd.json` and pushes. For a job with `threadId`,
  the PLAN verdict fails with `branch_mismatch` when `prd.branchName != feat/<feature>` (nax defaults to it).

### 5.4 Run (creator)

Enabled when the thread's latest PLAN is COMPLETED. Dispatches `command: RUN` with the same ref, feature, pinned runner
and `threadId`; dialog fields as the dispatch form (profiles, `maxCostUsd`, `bashMode`). RUN's finish phase (repo nax
config) opens the PR.

### 5.5 Afterwards

A new session detaches at the branch's new tip (§4.3) and sees `prd.json` and code. Base-ref drift is not rebased.
Moving a thread to another runner is out of scope.

## 6. Web

### 6.1 Phase B

- Navigation: **Threads** in the project WORK sidebar section and the palette, with breadcrumbs.
- `/:project/threads`: list (title, creator, feature, backend, runner, status, last activity, cost or tokens); New
  thread for DEVELOPER+ (hidden when threads are disabled).
- `/:project/threads/new`: repo, base ref, feature (validated live), title, cost cap, backend picker from eligible
  runners' `threadBackends`, read-only list of the skills the thread will get.
- `/:project/threads/:id`: header (title, branch, backend, runner online state, skills, cost or tokens vs cap, session
  state); timeline (messages as sanitized Markdown through `renderMarkdownOrEscape`, streaming indicator, collapsible
  tool chips including "denied by profile", question cards, "context reset" and errored markers); composer (creator
  only; Enter sends, Shift+Enter newline; Stop while a turn runs; disabled with a reason otherwise; read-only note for
  others; retries `threads.closing`); End session; Raise cap; Archive.
- `useThread` (messages, SSE with polling fallback, optimistic user message keyed by `clientMessageId`), `useThreads`;
  pure logic in `lib/thread-*.ts`; components `ThreadTimeline`, `ThreadMessage`, `ThreadToolChip`, `ThreadComposer`,
  `ThreadQuestionCard`, `BackendPicker`.

### 6.2 Phase C

- Action bar: **Publish** (file list from the last status), **Plan** and **Run** dialogs (pre-filled like dispatch),
  **Discard unpublished changes** when a session started stale; timeline commit markers and PLAN/RUN job cards linking
  to job pages.

### 6.3 All phases

i18n in `en.json` and `zh.json`; tool names and reasons pinned in a locale-parity test. Not in v1: turn-finished
notifications (tab title gets a `•` prefix while streaming), thread search, transcript export, editing a past message,
CLI.

## 7. Security

| Risk | Control |
|---|---|
| Reading outside the checkout | `read` profile only (guard test). Native: realpath jail, `protectedPaths` (`~/.koda-runner`, `~/.nax`, `~/.ssh`). Claude: Read jailed (probe). |
| Shell or web from the agent | Native has no such tools; Claude's requests are auto-rejected (probe). Phase D's live check re-runs the canary probe, and so must every raise of the pinned nax-agent version. |
| Code writes | Only `write_doc` (allowlist helper, caps, segments, no symlink, no `.git`); Publish recomputes and re-checks the set; only a person publishes. |
| Prompt injection (skills, repo) | Admin-only catalog of public, SHA-pinned sources; every Publish, Plan and Run is a click; nothing chains. |
| Secrets in chat | Runner redacts deltas and output; nax-agent redacts tool previews; search covers tracked files and allowlisted docs only. |
| Transcript exposure | Members only; agents refused; raw `thread` stream not served by job-log routes; SSE re-checked on heartbeat; command text dropped after ack. |
| Skill fetch | public github.com https, no credentials, pinned SHA, shallow, no submodules / LFS / hooks, size cap, safe segments. |
| Actor confusion | Runner keys only on `@RunnerRoute()` routes; thread routes users-only; creator-only actions; fenced runner writes. |

## 8. Errors and limits

- 409: `threads.turnRunning`, `threads.busy`, `threads.closing`, `threads.runnerOffline`, `threads.runnerOutdated`,
  `threads.costCap`, `threads.budgetPaused`, `threads.archived`, `threads.notCreator`, `threads.notPublished`,
  `threads.featureTaken`, `threads.disabled`, `skills.nameConflict`. 400: `skills.unsupportedHost`. Resolve failures
  are stored on the source.
- `session_failed` / job reasons: `backend_unavailable`, `agent_not_logged_in`, `model_unknown`,
  `skill_fetch_failed`, `worktree_conflict`, `nax_agent_too_old`; publish: `branch_moved`, `turn_running`.
- Limits: message 32 KiB; event line 64 KiB; `write_doc` 512 KiB; tool summary 50; search 200 hits / 64 KiB; skill file
  256 KiB; turn 900 s; idle 900 s; stream 200 MiB; `threadCapacity` 2.

## 9. Testing

- API unit: thread rules and the 409 matrix; placement load classes and misfits; ingestor fold over fixtures of real
  nax-agent event lines (including `stream_reset`, non-answerable questions, every end status); cursor idempotency;
  skill resolver over a stubbed GitHub API; module DI specs.
- API integration (Postgres): message / command / job round-trips; seq allocation; `clientMessageId` dedupe; rejected
  input → errored; closing window; terminal hook; thread cost in `windowSpend`; budget stop cancels THREAD; `runnerId`
  written at assignment; THREAD does not block PLAN/RUN placement; agent and non-member refusal; SSE authorization;
  catch-up after a simulated crash between append and fold.
- Runner unit: tool jails on real temp git repos (symlink, `..`, `.git`, untracked files); detached worktree start,
  stale start, publish dirty set and `update-ref` mismatch; serial queue (publish during turn, stop, close); event
  redaction and line split; `ThreadJobRun` with a scripted fake session backend; READOPT rejects THREAD.
- Runner integration (built API): full thread job on the fake backend, including SIGKILL mid-turn → CRASHED → resume,
  and a PLAN on the same repo placed while a thread is live.
- Web unit: `lib/thread-*` and components. E2E (Playwright): thread page against the fake backend (send, stream, stop,
  closing retry, read-only viewer; C: publish, plan card).
- Live (never in CI, billed, approval required): `apps/runner/test/live/` per phase (§11).

## 10. Phases and slices

- **Phase A — Skill catalog** (one PR): §1.1-1.4, migration, resolver, routes, `/admin/skills`, project Skills tab,
  nav. Independent of the runner.
- **Phase B — Native chat, read-only** (three PRs, in order):
  1. API: protocol v4 mirror, models (`ChatThread`, `ChatMessage`, `FleetThreadTurn`, `ThreadIngestCursor`,
     `FleetJob.threadId`, `Runner.threadCapacity`), placement load class, thread routes, commands and acks, terminal
     hook, `thread` stream + durable ingest, content SSE, budgets, kill switch (default off). Tested with a scripted
     runner.
  2. Runner: `@nathapp/fleet-protocol` v4, nax-agent 0.85.0 dependency and floor constant, `threadBackends` (native),
     session host, detached worktree, read/search/skill tools, skill fetch, event writer, serial queue, idle close,
     READOPT branch. Tested with the fake backend.
  3. Web: threads list, new, chat page (§6.1), composables, E2E against the fake backend.
- **Phase C — Write path and handoff** (two PRs): runner `write_doc`, publish, stale start and discard; API Publish /
  Plan / Run, one-active-job rule, PLAN `branch_mismatch` verdict, web action bar and timeline cards.
- **Phase D — ACP backends** (one PR): acp `SessionFactory` branch, `threadBackends.acp`, picker entries, docs.
- **Enabling threads** is not a phase: after the nax release that contains #2427 and #2346, raise the pin and
  `THREAD_NAX_AGENT_FLOOR`, set `FLEET_THREADS_ENABLED=true` on koda-wk.

Each phase: deploy to koda-wk after merge (backup + migrations), design doc §9.x note, phase live check.

## 11. Live checks (koda-wk)

- **A:** add `nathapp-io/nax-spec-kit-skills` @ `main`, path `skills` → 2 skills with a SHA; a private or missing repo
  → `RESOLVE_FAILED`; enable both on `sandbox`; Update after an upstream commit → new SHA.
- **B** (after the nax release; native): create a thread; tool chips show `list_files`, `search_repo`, `load_skill`;
  reply streams live; test user B watches read-only; an agent key gets 403; a PLAN of another feature on the same repo
  is placed while the thread is live; idle timeout → COMPLETED (idle) and the next message resumes with context; kill
  the runner mid-turn → CRASHED, message errored, next message resumes; cap below spend → 409; thread spend appears in
  the fleet spend analytics.
- **C:** the agent writes `.nax/features/<f>/spec.md` via `write_doc`; Publish → commit on the runner's local branch,
  not on GitHub; End session → Plan: PLAN pinned to wk-mac commits `prd.json`, branch appears on GitHub; Run → PR with
  spec + PRD + code; a send during RUN → 409 `threads.busy`.
- **D:** Claude thread through Publish; asking it to read a `$HOME` canary or `cat` it is denied by the profile and the
  canary never appears; End session and resume → Claude remembers earlier context (verifies `session/resume` or
  `session/load` for claude-agent-acp).

## Out of scope

S5b assistant (koda tools, RAG/memory); interactive coding threads (D537); private skill sources (D546); multi-driver
threads; moving a thread between runners; non-GitHub skill hosts; editing skills in koda; per-thread skill selection;
thread delete, search and export; turn notifications; CLI.
