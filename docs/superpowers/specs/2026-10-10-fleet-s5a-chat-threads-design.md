# Fleet S5a — Brainstorm Threads (Runner-Hosted Chat, Skill Catalog, Thread → Plan → Run) — Design

First part of fleet phase S5 (fleet design doc §3 (e) + (i), §5). S4 is complete and deployed on koda-wk (§9.52).
This is also the koda side of nax-agent master plan S6 ("koda agent chat"); the nax side was a capability check
(master plan §5 S6 row).

- **S5a (this spec): repo-grounded brainstorm threads.** A person chats with an agent that runs on a fleet runner,
  reads the repo, writes a spec with the spec-writing and spec-review skills, and hands it to the existing PLAN and RUN
  jobs.
- S5b (later, own spec): the standalone assistant over koda data (koda tools, RAG/memory as retrieval).
- Later: interactive coding threads (writes beyond docs), deferred by ruling D537.

## Goal

From koda's web UI a project member opens a thread against a project repo, brainstorms with an agent (nax native or
Claude Code over ACP) that can read and search the code, and ends with `.nax/features/<feature>/spec.md` committed on a
runner-local branch. From the same thread they dispatch PLAN and then RUN on that branch. No provider credential leaves
the runner, transcripts live in koda, and every billed step is an explicit click.

## Success criteria

1. A global admin registers a skill source (GitHub URL, ref, path); koda pins it to a commit SHA and lists the skills
   found. A project admin enables skills for the project.
2. A DEVELOPER+ member creates a thread (repo, base ref, feature, backend) and chats with the agent; replies stream
   into the page as they are produced.
3. The agent can list and search tracked files, read files inside its checkout, load enabled skills, and write
   Markdown only under the allowlist (§5.4). It cannot read outside the checkout, run a shell, or reach the web.
4. Publish commits only the files the thread wrote, on the runner's local `feat/<feature>` branch, and pushes nothing.
5. Plan dispatches a PLAN job pinned to the thread's runner with `planFrom` = the spec; Run dispatches RUN on the same
   branch; RUN's finish phase opens a PR carrying spec + PRD + code.
6. Project members read every thread live; only the creator acts. Agent keys are refused on every thread route.
7. An idle session closes and the next message resumes it with the earlier context; a runner crash mid-turn marks the
   job CRASHED and the next message resumes.
8. A thread records the exact skill SHAs it ran with; updating a source does not change existing threads.

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
  commit SHA). Runners fetch the pinned content. Projects enable skills individually (Q4, revised; Q5 A).
- D541: visibility = project members read every thread; only the creator sends, stops, answers, publishes, plans, runs
  and raises the cap (Q6 B).
- D542: architecture = approach 1: a thread is a long-lived record whose live session is a finite `THREAD` fleet job;
  the session runs inside the runner daemon on `@nathapp/nax-agent`. Sessions stay on the runner (fleet design doc §3
  (e), credentials never leave the machine).
- D543: sessions always use nax-agent profile `read`. Bash and web tools are denied by the profile's auto-reject;
  `ask` and `full` are never used for threads.
- D544: koda injects `list_files` and `search_repo` because Claude Code in `read` mode has no Grep or Glob tool
  (canary probe, below).

## Ground truth (verified on main `3162822d`, 2026-10-10)

koda:
- The runner talks to the API only through `POST /fleet/runner/sync` (long-poll; `syncTimeoutMs` 35 s, `syncMinGapMs`
  250 ms, `apps/runner/src/daemon/tuning.ts:45-49`) plus the log and bundle PUTs
  (`apps/api/src/fleet/logs/log-upload.controller.ts:19`). `FLEET_PROTOCOL_VERSION = 3`
  (`packages/fleet-protocol/src/index.ts:7`).
- Server → runner messages are `FleetCommand` rows re-sent until acked (`apps/api/prisma/schema.prisma:1029`); types
  `ASSIGN | CANCEL | READOPT | ABANDON | APPROVAL_ANSWER`. `APPROVAL_ANSWER` already carries a person's decision to a
  running job (`apps/runner/src/supervisor/command-handler.ts:85`).
- `FleetJob.command` is `RUN | PLAN | CONFIG_EDIT | CONFIG_DRIFT` (`schema.prisma:904`); states and transitions are in
  `apps/api/src/fleet/jobs/job-state.ts`; dispatch is `FleetJobsService.dispatch`
  (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:62`), gated by `BudgetGate` (`fleet/budgets/budget-gate.ts:8`).
- Log streams are `['run', 'stdout', 'stderr']` (`apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts:1`); the
  runner ships byte windows with `LogShipper` (`apps/runner/src/logs/log-shipper.ts:72`), woken on its status tick
  (`statusPollMs` 2 s).
- Live streams share `LiveStreamRegistry` (`apps/api/src/live/live-stream-registry.ts:5`); all existing streams are
  content-free (refetch on event).
- The runner allows one job per repo checkout (`RepoMutex`, `apps/runner/src/supervisor/repo-mutex.ts:2`) and keeps a
  local-only branch (`planBranch` → `keep-local`, `apps/runner/src/executor/branch.ts:19-30`, D51). PLAN commits
  `prd.json` and pushes the branch.
- S3 config jobs re-check paths with `isAllowedNaxPath` from `@nathapp/fleet-protocol`
  (`apps/runner/src/executor/config-job/apply-edits.ts:3,21`) and refuse symlinks.
- Runner capacity is server-owned (`Runner.capacity`, `schema.prisma:706`; `apps/runner/src/daemon/capacity.ts:5`).
- Git tokens are minted by `GitTokenBroker` (`fleet/git-broker/git-token.broker.ts:20`); forge HTTP goes through
  `FleetHttpClient` (`fleet/git-broker/fleet-http-client.ts:10`). The `koda-fleet` GitHub App is installed on
  `nathapp-io` but narrowed to `koda-fleet-sandbox`.
- Web renders untrusted Markdown with `renderMarkdownOrEscape` (`apps/web/lib/markdown.ts:42`).

nax (`@nathapp/nax-agent` 0.85.0; static review + live probe):
- `createAgentSession({ backend, profile, workdir, instructions, tools, transcriptStore, turnTimeoutSeconds,
  metadata })`, `resumeAgentSession`, `session.send(text)` → `AsyncIterable<SessionEvent>`, `answer()`, `close()`
  (`packages/nax-agent/src/session/agent-session-types.ts`). `createFileTranscriptStore(dir: string)`.
- Native `read` tools: `Read`, `Glob`, `Grep`, read-only `Git`, scratchpad tools, plus embedder tools; no Bash, write
  or web tools. Paths are realpath-checked inside `workdir`; `.git` is refused; the configured credentials directory is
  refused. No OS sandbox for `read`.
- ACP Claude `read`: mode `default`, `Write/Edit/MultiEdit/NotebookEdit/EnterPlanMode` disallowed, `settingSources: []`
  (no user settings, hooks or settings MCP servers), every permission request auto-rejected (`decidedBy: profile`).
  Embedder tools are served over a loopback MCP host (127.0.0.1, per-session bearer token, Host check, no Origin) and
  pre-approved as `mcp__nax__<tool>`.
- **Canary probe (2026-10-10, runner host, Claude via ACP, profile `read`):** Read inside workdir allowed; Read of a
  `$HOME` file, a `/private/tmp` file, a committed symlink to `$HOME`, a symlinked directory and a `..` path all denied
  by the profile; Bash `cat`, WebFetch and WebSearch denied; no Grep or Glob tool exists; an embedder tool ran without
  approval. The canary never appeared in any event.
- Redaction: tool inputs and previews go through `redactSecrets` (public export of `@nathapp/nax-agent`); native text
  deltas and the transcript are not redacted; ACP deltas are scrubbed of known session secrets only.
- #2427 (facade compaction, default on) and #2346 (JSON/env secret redaction) are merged on nax main (`4544297ea`,
  `97e02b874`) but unreleased (latest 0.85.0).

## 1. Skill catalog

### 1.1 Data

```prisma
model SkillSource {
  id           String    @id @default(cuid())
  gitUrl       String    // https://github.com/<owner>/<repo>(.git)
  ref          String    // branch or tag as entered
  path         String    // repo-relative directory that holds skill directories; "" = repo root
  resolvedSha  String?
  resolvedAt   DateTime?
  status       String    // OK | RESOLVE_FAILED
  statusReason String?
  createdById  String
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  skills       Skill[]
  @@unique([gitUrl, ref, path])
}

model Skill {
  id          String   @id @default(cuid())
  sourceId    String
  name        String   @unique   // from SKILL.md frontmatter
  description String
  dir         String   // repo-relative directory of the skill at resolvedSha
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

- `SkillResolver` (interface; v1 implementation `GitHubSkillResolver`) runs on create and on "Update", never in the
  background. Through `FleetHttpClient`:
  1. ref → commit SHA (`GET /repos/{o}/{r}/commits/{ref}`);
  2. list `path` at the SHA (`GET /repos/{o}/{r}/contents/{path}?ref={sha}`); every subdirectory that contains
     `SKILL.md` is a skill;
  3. read each `SKILL.md`, parse the YAML frontmatter `name` and `description` (bounded: 64-char name matching
     `^[a-z0-9][a-z0-9-]{0,63}$`, 1 KiB description), at most 50 skills per source.
- Auth: an App installation token when the App is installed on the repo, else anonymous (public repos only). A private
  repo without the App installed → `RESOLVE_FAILED` with reason `app_not_installed`.
- Only `github.com` URLs are accepted in v1 (400 otherwise). The resolver interface leaves room for other hosts.
- A source whose skill name already exists under another source is refused (409 `skills.nameConflict`); nothing is
  written. Update replaces the source's skill rows in one transaction; `ProjectSkill` rows of a skill whose name
  survives the update are kept (matched by name), others are deleted.

### 1.3 Routes

- Global ADMIN: `GET/POST /admin/skills/sources`, `POST /admin/skills/sources/:id/update`,
  `DELETE /admin/skills/sources/:id`.
- Project: `GET /projects/:slug/skills` (any member: catalog skills with an `enabled` flag),
  `PUT /projects/:slug/skills/:skillId` / `DELETE ...` (project ADMIN or global ADMIN). Agents 403.

### 1.4 Runner fetch

- A `THREAD` job payload carries `skills: [{ sourceId, gitUrl, sha, path, names: [{ name, dir }] }]`, the snapshot
  taken at thread creation (§2.1).
- During prepare the runner ensures `~/.koda-runner/skills/<sourceId>/<sha>/` exists; if absent: `git init`, `fetch
  --depth 1 origin <sha>` with no submodules, no LFS (`GIT_LFS_SKIP_SMUDGE=1`), `core.hooksPath=/dev/null`,
  `checkout` of the SHA, a 50 MiB tree cap. Private repos use the job's credential helper (a token for the skill repo
  is requested like a repo token). Path segments go through `paths/safe-segment.ts`.
- Cached SHAs are shared across threads; the daily prune removes SHAs no live thread references.

### 1.5 Agent access

- The system prompt lists each snapshot skill as one line (`name — description`).
- `load_skill(name)` returns `SKILL.md`. `read_skill_file(name, relPath)` returns a text file inside the skill
  directory: at most 256 KiB, realpath inside the directory, symlinks refused, binary refused.

## 2. Threads

### 2.1 Data

```prisma
model ChatThread {
  id             String    @id @default(cuid())
  projectId      String
  repoId         String
  baseRef        String
  feature        String    // slug; branch feat/<feature>
  title          String
  createdById    String
  runnerId       String?   // pinned at first placement, never changed
  backend        Json      // { kind: "native" | "acp", agent?: "claude" | "codex", model?: string, effort?: string }
  status         String    @default("ACTIVE") // ACTIVE | ARCHIVED
  skills         Json      // snapshot [{ sourceId, gitUrl, sha, path, names: [{ name, dir }] }]
  maxCostUsd     Decimal   @default(5) @db.Decimal(12, 4)
  costUsd        Decimal   @default(0) @db.Decimal(12, 4)
  tokens         Json      // { input, output, cacheRead, cacheWrite }
  specPath       String    // .nax/features/<feature>/spec.md
  writtenPaths   String[]  // paths written by write_doc and not yet published
  publishedSha   String?
  specPublished  Boolean   @default(false) // specPath exists at publishedSha
  pendingQuestion Json?    // { requestId, text, expiresAt } while one is open
  lastActivityAt DateTime  @default(now())
  createdAt      DateTime  @default(now())
  messages       ChatMessage[]
  @@index([projectId, lastActivityAt])
}

model ChatMessage {
  id             String   @id @default(cuid())
  threadId       String
  seq            Int
  turnId         String?
  role           String   // user | assistant
  authorUserId   String?
  clientMessageId String?
  content        String   @db.Text
  toolSummary    Json?    // capped list of { name, input (redacted, 512 B), isError, preview (512 B), decidedBy? }
  status         String   // streaming | complete | cancelled | errored | timed_out
  usage          Json?
  costUsd        Decimal? @db.Decimal(12, 4)
  costSource     String?  // computed | reported | unpriced
  createdAt      DateTime @default(now())
  @@unique([threadId, seq])
  @@unique([threadId, clientMessageId])
}
```

- `FleetJob` gains `threadId String?` (indexed) and `command` gains `THREAD`. A `THREAD` job has no PRD, bundle, nax run
  ids or stories. PLAN and RUN jobs dispatched from a thread also carry `threadId`.
- `Runner` gains `threadCapacity Int @default(2)` (server-owned like `capacity`); `THREAD` jobs count against it, not
  against `capacity`.
- `feature` is validated with the runner's branch-name rules (`validateBranchName`) applied to `feat/<feature>`; it is
  unique among the project's ACTIVE threads for the same repo.

### 2.2 Lifecycle

1. **Create** (DEVELOPER+, who becomes the creator): the thread is stored with the skill snapshot of the project's
   enabled skills and no session.
2. **First message:** a `THREAD` job is queued with the message in its payload. Placement picks a runner that has the
   repo and reports the chosen backend (§4.6), and writes `ChatThread.runnerId` in the same transaction as the
   assignment.
3. **Later messages:** with a live session (a `THREAD` job of this thread in RUNNING), the message becomes a
   `THREAD_INPUT` command; without one, a new `THREAD` job is queued, pinned to `runnerId`, and the runner resumes the
   session from its transcript.
4. **One turn at a time:** a send while an assistant message of the thread is `streaming` → 409
   `threads.turnRunning`. Stop sends `THREAD_STOP_TURN`; the session stays open.
5. **Idle:** after `THREAD_IDLE_SEC` (default 900) without input the runner closes the session; the job goes
   `RUNNING → UPLOADING → COMPLETED` with `stateReason = idle`. The thread stays ACTIVE.
6. **Crash / daemon restart:** READOPT rejects a RUNNING `THREAD` job; the server marks it CRASHED (as for S3 config
   jobs). A `streaming` assistant message becomes `errored`. The next message starts a new job that resumes.
7. **Runner offline:** a send while the pinned runner is offline → 409 `threads.runnerOffline`. Nothing is queued.
8. **Cost cap:** a send when `costUsd >= maxCostUsd` → 409 `threads.costCap`. Usage with `costSource = unpriced`
   adds tokens only. `THREAD` jobs pass `BudgetGate` like other jobs.
9. **Archive** (creator or project ADMIN): status ARCHIVED, a live session is cancelled, the runner removes the
   worktree on its next thread prepare or the daily prune. Archived threads are read-only.

### 2.3 Access

- Read (list, get, messages, events): any project member and global ADMIN. Act (send, stop, answer, publish, end
  session, plan, run, cap, archive): the creator; archive also project ADMIN. Agents (API keys) get 403 on every thread route.

## 3. Transport

### 3.1 Down: commands

- `POST /projects/:slug/threads/:id/messages { text, clientMessageId }` (text ≤ 32 KiB). The API checks access,
  status, cost cap, runner online, no turn running and no other active job (§5.1); stores the user message; then queues
  `THREAD_INPUT { messageId, text }` or a new `THREAD` job; then wakes the runner's long-poll after commit.
- Further commands: `THREAD_ANSWER { requestId, text }`, `THREAD_STOP_TURN { turnId }`, `THREAD_CLOSE` (End session),
  `THREAD_PUBLISH`. All are fenced by `(runnerId, leaseEpoch)`, re-sent until acked, and deduplicated on the runner by
  command id.
- `FleetCommand.payload` of `THREAD_INPUT` and `THREAD_ANSWER` is replaced with `{ messageId }` / `{ requestId }` when
  the command is acked, so user text is not kept twice.

### 3.2 Up: the `thread` log stream

- The runner appends every session event (one JSON object per line) to `thread-events.jsonl` in the job directory and
  ships it through `LogShipper` as stream `thread` (`PUT /fleet/runner/jobs/:jobId/logs/thread`), with the existing
  offset, resume and drain-before-UPLOADING rules. `LOG_STREAMS` gains `thread`.
- A `thread` stream wakes the shipper on every append, at most once per 250 ms.
- Before writing, the runner passes `text_delta.text`, `thinking_delta.text` and `turn_end.output` through
  `redactSecrets`. Thinking deltas are written but not shown in v1.
- Runner-originated events (not from nax-agent) use the same file: `session_started { backend, skillShas }`,
  `session_closed { reason }`, `published { sha, paths, specPresent }`, `publish_failed { reason }`, `write_doc { path }`.
- `FLEET_PROTOCOL_VERSION` becomes 4 (new stream, `THREAD` command, five command types). The server keeps serving v3
  runners for non-thread jobs and never places a `THREAD` job on a v3 runner.

### 3.3 Ingest (API)

- After an accepted `thread` append (inside the existing per-key log lock), `ThreadEventIngestor` parses the new
  complete lines. Lines are untrusted: bounded fields, type-checked, a bad line is skipped and counted.

| Event | Effect |
|---|---|
| `turn_start` | create the assistant `ChatMessage` (`streaming`, next `seq`) |
| `text_delta` | append to an in-memory per-message buffer; publish SSE `delta`; persist `content` at most once per second |
| `tool_call` / `tool_result` | append to `toolSummary` (≤ 50 entries; previews ≤ 512 B) |
| `approval_requested` / `approval_resolved` | record `decidedBy` on the matching tool entry (informational) |
| `usage` | add to the message's usage and cost; add to the thread totals |
| `question` | set `pendingQuestion`; publish SSE `question` |
| `turn_end` | `content = output`; `status` from the end status; final cost; SSE `message`; signal the budget evaluator |
| `write_doc` | add the path to `writtenPaths` |
| `published` | `publishedSha = sha`; `specPublished = specPresent`; clear `writtenPaths`; SSE `thread` |

### 3.4 Browser: content-carrying SSE

- `GET /projects/:slug/threads/:id/events`: membership checked on connect (agents refused), registered in
  `LiveStreamRegistry`, closed by the server after 15 minutes (the client reconnects and is checked again).
- Events: `delta { messageId, text }`, `message { id }`, `thread { state }`, `question { requestId, text }`.
- Reconnect = refetch the messages, then subscribe; the `message` event at `turn_end` corrects any lost tail.
- Existing project and user streams stay content-free.

## 4. Runner session host

### 4.1 Module

`apps/runner/src/thread/`: `ThreadJobRun` (prepare → session → turn loop → close), `SessionFactory`, `ThreadWorktree`,
`thread-tools/` (one file per tool), `ThreadEventWriter` (redaction + JSONL), `ThreadCommandRouter`.
`ThreadJobRun` emits only `ASSIGNED → RUNNING → UPLOADING → COMPLETED | FAILED | CANCELLED` (and `ASSIGNED → FAILED |
CANCELLED` before the session starts).

### 4.2 Session

- native: `nativeBackend({ model, effort })` with credentials from the runner user's `~/.nax`
  (`configureCredentials`), which also makes the read tools refuse the credentials directory.
- acp: `acpBackend({ agent, model, effort, allowUnsandboxed: true })`, `inheritEnv: false` (default allowlist).
- Both: `profile: 'read'`, `workdir` = the thread worktree, `transcriptStore =
  createFileTranscriptStore('~/.koda-runner/threads/<threadId>/transcript')`, `turnTimeoutSeconds: 900`,
  `metadata: { threadId, jobId }`, `instructions` from the job payload (§4.5), `tools` from §4.4.
- First job of a thread: `createAgentSession({ sessionId: <threadId> })`; later jobs: `resumeAgentSession`. A missing
  transcript on resume (runner home wiped) starts a fresh session and writes `session_started { resumed: false }`.
- Dependencies: `@nathapp/nax-agent` and `@nathapp/nax-agent-acp` pinned to the first lockstep release that contains
  #2427 and #2346; the daemon refuses to run `THREAD` jobs (and reports no thread backends) below that version.

### 4.3 Worktree

- `~/.koda-runner/threads/<threadId>/wt` is a `git worktree` of the runner's clone of the repo. The repo mutex is held
  only for `worktree add`, branch creation and commits, never for the session.
- The worktree is attached to `feat/<feature>` while a session is live or a publish runs, and detached
  (`git checkout --detach`) when the session ends, so PLAN and RUN can check the branch out in the main clone.
  Uncommitted `write_doc` files stay in the worktree across sessions.
- A new branch is created from `baseRef` (resolved like a job ref); an existing local branch is kept (D51).

### 4.4 Tools

| Tool | Behaviour | Limits |
|---|---|---|
| `list_files(dir?, glob?)` | `git ls-files` (fixed argv, no shell) plus `writtenPaths` | tracked files only; ≤ 2000 entries |
| `search_repo(pattern, glob?, max?)` | `git grep -n -I -E -e <pattern> -- <glob>` | tracked files only; 10 s; ≤ 200 hits, 64 KiB |
| `write_doc(path, content)` | write a UTF-8 file into the worktree (no commit); emit `write_doc` | `docs/**/*.md` or `.nax/features/<thread feature>/**/*.md`; ≤ 512 KiB; safe segments; no existing symlink on the path; never `.git` |
| `load_skill(name)` | §1.5 | snapshot skills only |
| `read_skill_file(name, relPath)` | §1.5 | ≤ 256 KiB, jailed |

All tools have `approval: "never"`. A refused call returns `isError: true` with a reason the agent can act on.

### 4.5 System prompt

Built by the API and sent in the `THREAD` job payload: the agent's role (brainstorming partner for this repo and
feature), the spec target (`specPath`), the flow (brainstorm with the person; when they agree, `load_skill
spec-writing` and write the spec with `write_doc`; then `load_skill spec-review` and review the spec against the code),
the tool rules, and one line per snapshot skill.

### 4.6 Capabilities

The capability report gains `threadBackends`: native models available from the runner's nax profiles and credentials,
and ACP agents that `isAgentLaunchable` accepts and that pass a login probe. Reports are parsed by
`parseCapabilities` and bounded like the existing fields. Below the nax-agent floor the list is empty.

### 4.7 Questions and approvals

- A `question` event awaits `THREAD_ANSWER`; the runner calls `answer(requestId, text)`. An unanswered question
  expires per nax-agent's approval timeout.
- `approval_*` events in `read` are decided by the profile and are informational in the UI.

## 5. Publish, Plan, Run

### 5.1 One active job per thread

A thread has at most one non-terminal job (`THREAD`, `PLAN` or `RUN` with its `threadId`). A send while a thread's
PLAN or RUN is active → 409 `threads.busy`.

### 5.2 Publish (creator)

- Enabled when `writtenPaths` is non-empty and no turn is running.
- Live session → `THREAD_PUBLISH`; no session → a `THREAD` job with `action: publish` (no session is started).
- Runner, under the repo mutex: attach the worktree to `feat/<feature>` (create from `baseRef` if new); re-check every
  written path against the §4.4 allowlist and that it is not a symlink; `git add -- <paths>`; commit with the fleet git
  identity, message `docs(<feature>): spec from koda thread "<title>"` and trailer `Koda-Thread: <threadId>`; no push;
  emit `published { sha, paths, specPresent }` (`specPresent` = `specPath` exists at `sha`). Nothing to commit →
  `published` with the current SHA and no paths.

### 5.3 Plan (creator)

- Requires `specPublished`, no live session and no other active job. A live session is ended with the **End session**
  action (creator; sends `THREAD_CLOSE`), not implicitly by Plan.
- `FleetJobsService.dispatch` with `command: PLAN`, `ref: feat/<feature>`, `feature`, `planFrom: specPath`,
  `pinnedRunnerId: runnerId`, `threadId`, profiles and `maxCostUsd` from the dialog (dispatch defaults).
- The runner's existing PLAN path keeps the local branch, commits `prd.json` and pushes the branch.

### 5.4 Run (creator)

- Enabled when the thread's latest PLAN is COMPLETED. Dispatches `command: RUN` with the same ref, feature, pinned
  runner and `threadId`; dialog fields as the dispatch form (profiles, `maxCostUsd`, `bashMode`).
- RUN's finish phase (repo nax config) opens the PR.

### 5.5 Afterwards

The thread is usable again; a new session checks out the branch at its new tip. Base-ref drift is not rebased.
Moving a thread to another runner is out of scope (archive and start a new thread).

## 6. Web

- Navigation: **Threads** in the project WORK sidebar section and the command palette, with breadcrumbs; **Skills**
  under ADMIN.
- `/:project/threads`: list (title, creator, feature, backend, runner, status, last activity, cost or tokens); New
  thread for DEVELOPER+.
- `/:project/threads/new`: repo, base ref, feature (validated live), title, cost cap, backend picker from eligible
  runners' `threadBackends`, read-only list of the skills the thread will get.
- `/:project/threads/:id`: header (title, branch, backend, runner online state, skills, cost or tokens vs cap, session
  state); timeline (messages as sanitized Markdown, streaming indicator, collapsible tool chips including "denied by
  profile", question cards, commit markers, PLAN/RUN job cards linking to job pages); composer (creator only; Enter
  sends, Shift+Enter newline; Stop while a turn runs; disabled with a reason otherwise; read-only note for others);
  action bar (Publish with the file list, End session, Plan and Run dialogs, Raise cap, Archive).
- `/admin/skills` and the project settings **Skills** tab (§1.3).
- `useThread`, `useThreads`, `useSkillCatalog`; pure logic in `lib/thread-*.ts`; components `ThreadTimeline`,
  `ThreadMessage`, `ThreadToolChip`, `ThreadComposer`, `ThreadActionBar`, `ThreadQuestionCard`, `BackendPicker`.
- i18n in `en.json` and `zh.json`; tool names and reasons pinned in a locale-parity test.
- Not in v1: turn-finished notifications (the tab title gets a `•` prefix while streaming), thread search, transcript
  export, editing a past message, CLI.

## 7. Security

| Risk | Control |
|---|---|
| Reading outside the checkout | `read` profile only (a guard test refuses any other profile). Native: realpath jail, credentials dir refused. Claude: Read jailed (probe). |
| Shell or web from the agent | Native has no such tools; Claude's requests are auto-rejected (probe). The live check re-runs the canary probe for every new pinned nax-agent version. |
| Code writes | Only `write_doc` (allowlist, caps, segments, no symlink, no `.git`); Publish re-checks; only a person publishes. |
| Prompt injection (skills, repo) | Admin-only catalog, SHA-pinned; every Publish, Plan and Run is a click; nothing chains. |
| Secrets in chat | Runner redacts deltas and output; tool previews redacted by nax-agent; search covers tracked files only. |
| Transcript exposure | Members only; agents refused; SSE re-checked every 15 min; command text dropped after ack. |
| Skill fetch | github.com https only, pinned SHA, shallow, no submodules / LFS / hooks, size cap, safe segments. |
| Actor confusion | Runner keys only on `@RunnerRoute()` routes; thread routes users-only; creator-only actions; fenced runner writes. |

The worktree holds only git content and thread-written files; Claude can read any of them, so no extra deny rules in
v1.

## 8. Errors and limits

- 409 keys: `threads.turnRunning`, `threads.busy`, `threads.runnerOffline`, `threads.costCap`, `threads.archived`,
  `threads.notCreator`, `threads.notPublished`, `threads.featureTaken`, `skills.nameConflict`; 400
  `skills.unsupportedHost`; resolve failures are stored on the source (`RESOLVE_FAILED`, reason).
- A session that cannot start fails the `THREAD` job with a reason shown in the thread: `backend_unavailable`,
  `agent_not_logged_in`, `model_unknown`, `skill_fetch_failed`, `worktree_conflict`, `nax_agent_too_old`.
- Turn end statuses `timed_out`, `errored`, `interrupted`, `cancelled` mark the message; the thread stays usable.
- Limits: message 32 KiB; `write_doc` 512 KiB; tool summary 50 entries; search 200 hits / 64 KiB; skill file 256 KiB;
  turn 900 s; idle 900 s; `threadCapacity` 2 per runner.

## 9. Testing

- API unit: thread rules and the 409 matrix; ingestor fold over fixtures of real nax-agent event lines; skill resolver
  over a stubbed GitHub API; module DI specs.
- API integration (Postgres): message / command / job round-trips; one active job; Plan dispatch pins runner and
  branch; cost cap; agent and non-member refusal; SSE authorization; skill update keeps enablement by name.
- Runner unit: tool jails on real temp git repos (symlink, `..`, `.git`, untracked files); worktree attach / detach;
  publish commits only written paths; event redaction; `ThreadJobRun` with a scripted fake session backend.
- Runner integration (built API): a full thread job on the fake backend, including SIGKILL mid-turn → CRASHED →
  resume.
- Web unit: `lib/thread-*` and components. E2E (Playwright): thread page against the fake backend (send, stream, stop,
  publish, plan card, read-only viewer).
- Live (never in CI, billed, approval required): `apps/runner/test/live/` native and Claude threads through publish,
  plus the canary probe.

## 10. Slices

1. Skill catalog (API + web): models, resolver, routes, `/admin/skills`, project Skills tab, nav.
2. Thread core (protocol v4 + API): models, `THREAD` command, command types, thread routes, `thread` stream + ingestor,
   content SSE.
3. Runner thread host: nax-agent dependencies and floor, `threadBackends` capability, session factory, worktree, tools,
   skill fetch, event writer, command router, idle close.
4. Publish, Plan, Run (runner publish + API actions and the one-active-job rule).
5. Web threads: list, new, chat page, action bar, composables, E2E.

**Prerequisite:** slice 3's merge and the live check need a nax lockstep release that contains #2427 and #2346 (the
user decides when to release).

## 11. Live check (koda-wk, after slice 5)

1. Add source `nathapp-io/nax-spec-kit-skills` @ `main`, path `skills`: 2 skills, SHA shown; enable on `sandbox`.
2. Native thread on sandbox: brainstorm a small feature; tool chips show `list_files`, `search_repo`,
   `load_skill spec-writing`, `write_doc .nax/features/<f>/spec.md`, `load_skill spec-review`.
3. Publish: the commit is on the runner's local branch and not on GitHub.
4. Plan: PLAN pinned to wk-mac commits `prd.json`; the branch appears on GitHub. Run: the PR contains spec + PRD + code.
5. Claude thread through Publish; asking it to read a `$HOME` canary or `cat` it is denied by the profile; the canary
   never appears in the thread.
6. Test user B (member) watches a reply stream read-only; composer disabled; an agent key gets 403 on thread routes.
7. Idle timeout → job COMPLETED (idle); the next message resumes and the agent remembers earlier context.
8. Kill the runner mid-turn → job CRASHED, message errored; the next message resumes.
9. Cap below spend (native) → 409; a send during RUN → 409 `threads.busy`.
10. Update the skill source after a new upstream commit → new SHA; a new thread records it, the old thread keeps its SHA.

## Out of scope

S5b assistant (koda tools, RAG/memory); interactive coding threads (D537); multi-driver threads; moving a thread
between runners; non-GitHub skill hosts; editing skills in koda; per-thread skill selection; thread delete, search and
export; turn notifications; CLI.
