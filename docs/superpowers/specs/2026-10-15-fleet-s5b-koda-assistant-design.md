# Fleet S5b: koda assistant in threads (design)

Status: design approved in brainstorming 2026-10-15; revised after one read-only codebase review (2 BLOCKER, 9 MAJOR,
6 MINOR, all addressed below; revision 1); revision 2 adds WORKSPACE threads and the anchor repo (S5b-R12, R13).
Umbrella design: delivery is seven nax features, each with its own spec, PRD
and run (section 10). File:line references are against koda main `22c825c5`.

## 1. Goal

A thread can answer questions about koda's own data, propose actions the user confirms, help operate the fleet, and
brainstorm. The assistant lives in the existing S5a threads, not on a separate page. The same tool layer is later
exposed to external agents (Claude Code, nax, Zed) over MCP.

Example asks:

- "What failed in the fleet this week, and why?" (jobs, escalation reasons, log excerpts)
- "Which tickets are blocked?" / "Summarise PR status for KODA-12."
- "Turn this brainstorm into tickets." (proposes a batch, the user confirms)
- "Re-run the lc198 feature with native-ds, cap $1." (proposes a dispatch, the user confirms)
- "Record this decision as an ADR."

## 2. Rulings

User, 2026-10-15:

- **S5b-R1 Threads are the surface.** The assistant is a thread capability; no separate assistant page.
- **S5b-R2 Scope = all of:** read Q&A over koda data, confirmed write actions, fleet-ops help, brainstorming, and an
  MCP front door for external agents.
- **S5b-R3 Repo optional.** A new PROJECT thread kind has no repo, worktree or feature. REPO threads keep today's
  behaviour and also get the koda tools.
- **S5b-R4 Write families in scope:** tickets, comments, fleet dispatch, KB / memory. Every write is confirmed by a human.
- **S5b-R5 Approach B.** Tools are defined and executed on the koda API; the runner session only proxies tool calls;
  confirmed writes are executed by the server. No user token and no write capability leave the server. LLM
  credentials stay on runners (fleet design §3 (e), unchanged).

Design decisions taken in the review revision (revision 1):

- **S5b-R6 Permissions are CASL, per tool.** Each tool names the exact CASL tuple or `@ProjectRoles` its REST route
  enforces (section 7 table); the executor evaluates it with `KodaCaslAbilityFactory` for the acting user's principal.
  No role-string comparison.
- **S5b-R7 The executor owns the project scope.** REPO and PROJECT threads: the executor sets `projectId` from the
  thread and any `project` argument is refused. WORKSPACE threads (S5b-R12): every project-scoped tool requires a
  `project` slug argument, which the executor resolves and checks against the creator's project memberships on every
  call. In both cases every referenced id (repo, job, ticket, approval, KB doc, memory item) must belong to the
  resolved project before the permission check. The registry and executor are built project-aware from S5b-1b on.
- **S5b-R8 Approvals get an `assistant_action` branch, not the budget branch.** Own decisions (`approve` | `reject`),
  own permission function, own expiry sweep, notification to the thread creator only (section 8).
- **S5b-R9 Two placement capabilities, no protocol version bump.** `projectThreads: true` (S5b-1a): the runner can
  host a thread with no checkout; PROJECT and WORKSPACE thread jobs are placed only on such runners. `kodaTools: true`
  (S5b-1b): the runner builds koda tool proxies; REPO threads may run on a runner without it and then show a thread
  notice "koda tools unavailable on runner <name>". The ASSIGN changes are additive optional fields, gated by these
  capabilities, so `FLEET_PROTOCOL_VERSION` stays 4. PROJECT and WORKSPACE threads with an ACP backend are refused at
  creation (ACP sessions get no tools, nax#2444).
- **S5b-R10 Action outcomes reach the agent through the next user message.** No new server-to-session command.
  Undelivered outcome notes are attached to the next THREAD_INPUT the user sends (rendered before the user's text),
  and `koda_get_action` lets the agent check an action on demand. Notes are stored as thread messages of a new
  `system` role so the transcript and resume carry them.
- **S5b-R11 Split into seven nax features** (section 10), because the story-size gate is 15 ACs per story
  (`.nax/config.json:63-67`) and S5b-1 as first drafted could not fit one feature.

User, 2026-10-15 (during S5b-1a spec-writing):

- **S5b-R12 WORKSPACE threads (app-wide), personal.** A third thread kind for questions across projects ("which
  projects have pending tickets?"). Only its creator can list, read or act on it (a project thread is readable by
  project members, so it must never carry another project's data). It lives at a top-level `/threads` page, tools take
  a validated `project` argument (S5b-R7), and a `koda_my_projects` read tool lists the creator's projects with open
  ticket, failed job and pending approval counts. Delivered as its own feature after the read tools, before writes.
- **S5b-R13 Anchor repo and home project for bookkeeping.** `FleetJob.repoId` and `FleetJob.projectId` stay required.
  A PROJECT thread's jobs use the project's oldest fleet repo (by `createdAt`, then id) as an anchor; a WORKSPACE
  thread's jobs use a home project chosen at creation (default: the creator's first project that has a fleet repo)
  and that project's anchor repo. The anchor is used only for placement, budget keys and dashboards; the runner never
  clones, fetches or touches it, and no git token is requested. `ChatThread.repoId` stays null for PROJECT and
  WORKSPACE threads, so deleting a repo never deletes those threads.

User, 2026-10-15 (after S5b-1b; research note `koda-agent-knowledge-research-2026-10-15.md` in the workspace):

- **S5b-R14 1c is the layered project-knowledge model.** The gap is content and reach, not retrieval: memory holds only
  automatic ticket facts, `DecisionEvent` is empty, and the project's architecture, specs, ADRs and run reports live
  as repo Markdown and nax artifacts that no thread can reach. 1c delivers L0 an always-loaded brief, L1/L2 indexed
  repo docs and run outcomes (heading chunks with an extractive abstract and a citation), and the tools over them.
  `koda_context_query` is dropped. ADRs stay docs-as-code. Deferred behind a brainstorm eval set: reranker, code
  embeddings, temporal graph, automatic memory extraction. Abstracts and chunk context lines are extractive, because
  the API holds no model credentials (section 12). 1c ships as three features (section 10, rows 3a-3c).
- **S5b-R15 PROJECT threads read code (revises S5b-R13).** A PROJECT thread's runner keeps a read-only shallow checkout
  of every fleet repo of the project at its default branch, with a read-only brokered token, and offers the REPO
  thread's read tools over it (no `write_doc`). Gated by a `projectCode` capability. The anchor repo still decides
  placement and budget keys; S5b-R13's "never clones" now applies only to WORKSPACE threads.

User, 2026-10-16 (S5b-1c-c brainstorm, after 1c-b):

- **1c-c-R1** hybrid lexical + vector on the existing LanceDB engine; embeddings from Ollama `nomic-embed-text` (a compose
  service on koda-wk); Jina deferred, provider stays configuration. **1c-c-R2** fixed default allowlist; per-project
  patterns in 3c-2. **1c-c-R3** 30-minute head poll + merged-RUN hook + admin re-index, incremental by blob sha.
  **1c-c-R4** eval = 40 questions over `nathapp-io/koda` (registered in a koda-wk dogfood project), recall@5/@20 + MRR;
  recall@20 < 0.85 -> try the reranker or Jina next. **1c-c-R5** 1c-c splits into 3c-1 (index + tools + eval) and 3c-2
  (fleet outcomes, patterns, web). **1c-c-R6** separate search path; ticket search unchanged. **1c-c-R7** citations
  `owner/name:path@sha7#anchor`.

## 3. Research summary (2026-10-15)

Surveyed: Plane MCP server (MIT), LibreChat (MIT), CopilotKit (MIT), assistant-ui (MIT), Onyx CE (MIT),
Vercel ai-chatbot (Apache-2.0), Mastra (Apache-2.0 core), Twenty (AGPL), Metabase Metabot (commercial AI), Chatwoot
Captain (MIT core, AI in enterprise). Recurring patterns, all adopted here:

1. Typed tools over the app's own service layer, not raw SQL; prose knowledge via RAG, records via tools.
2. The assistant acts as the user and inherits the user's permissions (Metabot: "only sees what the person can see").
3. Writes pause for human approval (CopilotKit `respond`, Mastra suspend/resume, LibreChat Ask/Allow/Deny).
4. The app exposes an MCP server (Plane) so one tool set serves in-app and external clients.

Pitfalls taken into the design: permission checks in the tool layer, not the prompt; prompt injection from
user-written records; cost runaway (step / message / token caps); stale answers (cite records). Only patterns are
reused; no code is copied from AGPL or enterprise-licensed sources.

Rejected approaches: (A) runner-side tools holding a delegated user token: a token that can act as the user would sit
on a runner, and confirmation would be enforced on the runner. (C) a koda MCP server consumed by the session: blocked
on nax (no facade `mcpServers` option, nax#2416; ACP sessions get no MCP, nax#2444). The registry in this design
makes (C) a later swap of the transport, not a rewrite.

## 4. Architecture

```
 web thread page --SSE--+                      +-- MCP clients (S5b-3; user or agent API key)
                        |                      |
                 +------v----------------------v------+
                 | koda API                            |
                 |  AssistantToolRegistry              |
                 |   tool = {name, description, schema,|
                 |           kind: read|write,         |
                 |           ability, execute}         |
                 |  AssistantToolExecutor (as creator) |
                 |  PendingAction -> assistant_action  |
                 +------^------------------------------+
   POST /fleet/runner/threads/:threadId/tools/:name  (@RunnerRoute + RUNNING THREAD job lease)
                 +------+-----------+
                 | runner            | nax-agent session, profile `read`
                 |  koda tool proxies (from the ASSIGN's tool descriptors)
                 |  + repo tools only for REPO threads
                 +-------------------+
```

Units and their single purpose:

- **AssistantToolRegistry** (api): the list of koda tools. Each tool declares its name (`koda_*`), description, JSON
  input schema, kind (`read` | `write`), the CASL ability or project roles it needs (section 7), the ids in its input
  that must belong to the project, and `execute(ctx, input)` that calls existing domain services. No transport.
- **AssistantToolExecutor** (api): resolves the actor, sets the project from the thread, validates input, checks
  referenced ids and the ability, applies output caps, masking and fencing, writes the audit row, and for `write`
  tools creates a PendingAction instead of executing.
- **Runner tool route** (api): `POST /fleet/runner/threads/:threadId/tools/:name` under `@RunnerRoute()` (as
  `runner-sync.controller.ts:12`). Delegates to the executor after the lease check (section 6).
- **PendingAction service** (api): state machine for proposed writes, mirrored as an `assistant_action` approval
  (section 8).
- **Runner koda tool proxies** (runner): one `EmbedderTool` per descriptor received in the ASSIGN; posts the input to
  the tool route and returns the result text. No business logic.
- **PROJECT-thread job path** (api, protocol, runner): a THREAD job with no repo (section 5).
- **Web**: scope picker on the new-thread form, citation links, PendingAction cards, inbox rows.

## 5. Thread kinds and job shape

`ChatThread` gains `kind` (`REPO` | `PROJECT` | `WORKSPACE`, default `REPO`; existing rows backfill to `REPO`).
`repoId`, `baseRef`, `feature` and `specPath` become nullable (`schema.prisma:1058-1095`). The create path, the only
writer of these columns, enforces: `REPO` has all four set; `PROJECT` and `WORKSPACE` have none set. No database check
constraint (integration schemas come from `prisma db push`, which cannot create one; S5b-1a ruling 1a-R4). `projectId` stays required: the thread's project for REPO / PROJECT, the home project for
WORKSPACE (S5b-R13). The existing partial unique index on active `(repoId, feature)` admits many rows with a null
`repoId`, so it needs no change.

Visibility: REPO and PROJECT threads keep S5a's rule (project members read, the creator acts). WORKSPACE threads are
creator-only: the project thread list and detail routes never return them; they are served by top-level `/threads`
routes (WORKSPACE feature).

Every thread runs as a THREAD fleet job. `FleetJob` is unchanged: `repoId`, `ref`, `feature` stay required (S5b-R13).

| Place | Today | Change |
|---|---|---|
| Thread job creation (`prisma-chat-thread.repository.ts:356-367`, `createThreadJob`) | `repoId: thread.repoId, ref: thread.baseRef`, `feature: thread-<id>` | PROJECT / WORKSPACE: `repoId` = the anchor repo, `ref` = the anchor's default branch, `feature` = `thread-<id>` (unchanged); no fleet repo -> 409 `threads.noFleetRepo` |
| Budget keys (`budgets/budget-rules.ts:40-47`) | `repo:<id>` from the job | unchanged; the anchor repo's scope applies (documented, accepted) |
| Thread instructions (`thread-instructions.ts`, built in `createThreadJob`) | repo + feature + spec path | PROJECT / WORKSPACE variant: names the project, no repo, no spec path, no `write_doc` |
| ASSIGN `thread` block (`fleet-protocol/src/threads.ts`, `ThreadAssign`) | `feature` required | adds optional `kind`; `feature` optional and absent for PROJECT / WORKSPACE |
| Runner ASSIGN parser (`supervisor/assign-parser.ts:148-188`) | requires `thread.feature` | accepts a missing `feature` only with `kind` PROJECT or WORKSPACE |
| Runner thread run (`thread/thread-job-run.ts:217-330`) | acquires git credentials, prepares a worktree, opens live publish | PROJECT / WORKSPACE: no credentials, no worktree, no live publish; session cwd = `<runner home>/threads/<threadId>/scratch` (created empty; pruned with the thread dir) |
| Runner tools (`thread/tools/index.ts:9-11`) | always the five repo tools | PROJECT / WORKSPACE: `load_skill`, `read_skill_file`; koda proxies added in S5b-1b |
| Placement (`placement-rules.ts:108-123`) | thread backends only | PROJECT / WORKSPACE jobs need `projectThreads`; ACP backend refused at thread creation |
| Capabilities (`capabilities-core.ts:121-158`, runner `nax-probe.ts:156-170`) | `threadWrite`, `configJobs` | adds `projectThreads: true` (S5b-1a) and `kodaTools: true` (S5b-1b), strict like `threadWrite` |

PROJECT and WORKSPACE threads have no Publish, Discard, Plan or Run: the web hides them and the API answers 409 with a
new i18n key `threads.notRepoThread` (en + zh). REPO threads keep all S5a behaviour.

## 6. Tool route and executor contract

- **Lease check.** The call is accepted only when a FleetJob exists with `command = THREAD`, `threadId = :threadId`,
  `runnerId = <calling runner>`, `state = RUNNING`, and `leaseEpoch` equal to the `leaseEpoch` header the runner sends
  (`FleetJob.threadId` is indexed, `schema.prisma:1040`). Jobs in UPLOADING or with a close requested are refused, as
  sends are (`thread-send-rules.ts:36-37`). Refusals are typed errors the proxy returns to the agent as tool errors.
- **Kill switch.** `FLEET_THREADS_ENABLED` off (`threads.service.ts:88`) refuses the tool route and approval execution.
- **Idempotency.** The runner sends the nax-agent tool-call id. `AssistantToolCall` is unique on `(jobId, toolCallId)`;
  a repeat returns the stored result for reads and the existing PendingAction for writes.
- **Write cap under lock.** Creating a PendingAction locks the ChatThread row (`FOR UPDATE`, as `lockIdleThread`,
  `prisma-fleet-job.repository.ts:64-69`), counts PENDING actions, refuses an 11th, then inserts.
- **Job end.** In-flight calls when a job is reaped fail with a typed error; writes are never retried by the proxy.
  PendingActions outlive the job (they belong to the thread).
- **Cost.** Thread spend is enforced live by the runner against `maxCostUsd` (`thread-job-run.ts:497`); the API's
  `ChatThread.costUsd` is folded from cost events at ingest and can lag
  (`threads/ingest/prisma-thread-ingest.repository.ts:281`). Dispatch cost is governed separately (section 7).

## 7. Tool catalog and permissions

All tools act in the thread's project. Every read result carries citations (section 9).

| Tool | Kind | Ability / roles (source) | Feature |
|---|---|---|---|
| `koda_search_tickets`, `koda_get_ticket` (fields, links incl. PR state from `TicketLink`, last 10 comments) | read | project member (read Ticket) | S5b-1b |
| `koda_list_jobs`, `koda_get_job`, `koda_fleet_spend`, `koda_list_approvals`, `koda_runner_status` | read | project member (read FleetJob) | S5b-1b |
| `koda_job_log_excerpt` | read | project member (read FleetJob) | S5b-1b |
| `koda_get_action` | read | project member | S5b-2a |
| `koda_kb_search` (`HybridRetrieverService.search`, `rag/hybrid-retriever.service.ts:129`), `koda_context_query` (`ContextBuilderService`), `koda_memory_search`, `koda_timeline` (`TimelineService`) | read | project member | S5b-1c |
| `koda_create_tickets` (batch, max 20), `koda_update_ticket`, `koda_link_tickets` | write | CASL create/update Ticket (DEVELOPER+; `koda-casl-ability.factory.ts:82-95`) | S5b-2b |
| `koda_add_comment` | write | CASL create Comment (every member; `factory.ts:96-99`) | S5b-2b |
| `koda_add_kb_doc` | write | `@ProjectRoles('ADMIN','DEVELOPER','AGENT')` (`rag.controller.ts:47`) | S5b-2b |
| `koda_add_memory`, `koda_record_decision` | write | project member (`memory.controller.ts:31-46`) | S5b-2b |
| `koda_dispatch_job` (PLAN / RUN, `maxCostUsd` required), `koda_requeue_job`, `koda_cancel_job` | write | CASL create/update FleetJob (DEVELOPER+) | S5b-2b |

Rules:

- The executor evaluates the ability with `KodaCaslAbilityFactory` for the acting user's principal on every call, and
  again for the approver at approval time. Domain services do not check permissions themselves
  (`project-membership.guard.ts:29-60`), so the executor is the guard.
- `projectId` is set from the thread, never read from input (S5b-R7). `recordDecision` today takes `projectId` from
  the request body; the tool supplies it. Every id in input is checked against the project before the ability check;
  a foreign id answers `not_found` (no existence leak).
- `koda_dispatch_job` reuses the REPO handoff dispatch path (`threads.service.ts:85-101`) rather than a second
  dispatch implementation.
- No admin-only operation (users, runners, budgets, skill sources) is a tool. Ticket delete is not a tool.

Fleet ops is a subset of these tools, plus an optional "diagnose a run" skill in the skill catalog.

## 8. PendingAction and the approvals inbox

`PendingAction`: `id`, `projectId`, `threadId?`, `jobId?`, `toolCallId?`, `tool`, `input` (JSON), `preview` (text shown
to the approver), `status` (`PENDING` | `APPROVED` | `REJECTED` | `EXPIRED` | `EXECUTED` | `FAILED`), `requestedById`,
`decidedById?`, `decidedAt?`, `result` (JSON), `deliveredAt?` (outcome note handed to the agent), `expiresAt` (24 h),
`createdAt`. Each has one `FleetApproval` row of type `assistant_action` (`type` is a String,
`schema.prisma:884-890`; the TS union in `approval.domain.ts:4` gains it).

Approvals changes (S5b-2a):

- `ApprovalsService.decide` today routes every non-bash type into the budget branch
  (`approvals.service.ts:92-96`, ADMIN-only, `policyId` required). A new `decideAssistant` branch: decisions
  `approve` | `reject` (added to `APPROVAL_DECISIONS` for this type only), permission = the tool's ability evaluated for
  the approver (S5b-R6), then executes through the registry and records `result`.
- Expiry: the sweeper filter selects only `nax_bash_escalate` (`prisma-approval.repository.ts:75`); it is widened to
  `assistant_action` with its own expiry rule (PENDING -> EXPIRED, approval closed).
- Exposure: the project inbox list returns the full payload to any member (`project-fleet-approvals.controller.ts:31-37`,
  `fleet-approval.dto.ts:26,42`). For `assistant_action` the list returns a summary (tool, thread, requester, status);
  the detail returns the preview and input only when the caller holds the read ability for that tool's data.
- Notifications: `ApprovalCloser.enqueueRequested` fans out to all global admins
  (`approval-closer.ts:158-165`, `fleet-approval-requested.subscriber.ts:40-47`). For `assistant_action` it notifies
  the thread creator only (in-app and email under the approval category), never all admins.
- Web: `assistant_action` gets its own label and summary (today unknown types fall back to "budget override",
  `apps/web/lib/fleet-approvals.ts:330`), and the inline thread card.

Write flow:

1. The agent calls `koda_create_tickets`. The executor validates, checks ids and the requester's ability, stores the
   PendingAction (under the thread lock), and returns at once:
   `pending <actionId>: awaiting user approval; do not retry`.
2. The thread shows a confirmation card (preview, Approve, Reject, expiry); the inbox shows the row.
3. Approve: re-check the approver, execute, store `result`, set `EXECUTED` or `FAILED`. Reject: `REJECTED`. Expiry:
   `EXPIRED`. Each outcome writes a `system`-role thread message (`ChatMessage.role` gains `system`,
   `schema.prisma:1104`) and pushes it on the thread SSE.
4. Delivery to the agent (S5b-R10): the next THREAD_INPUT the user sends carries the undelivered outcome notes before
   the user's text, and marks them `deliveredAt`. `koda_get_action` returns an action's status and result at any time.
   The agent never blocks on a human.

Failure handling:

| Case | Behaviour |
|---|---|
| Requester lacks the ability | Tool error `forbidden: <action> needs <role/ability> on <project>`; audit `forbidden` |
| Id from another project | Tool error `not_found`; audit `forbidden` |
| Target changed before approval (ticket deleted, job terminal) | `FAILED` with the reason; card and note show it |
| Approver lacks the ability | 403; action stays PENDING |
| Repeat tool call (same `toolCallId`) | Stored result / existing PendingAction returned |
| 11th pending action | Tool error asking the agent to wait for decisions |
| Job reaped mid-call | Typed tool error; writes not retried; PendingActions kept |
| Approval after the thread is archived | Executes (the user's decision); system note stored |
| `FLEET_THREADS_ENABLED` off | Tool route and approval execution refused |

## 9. Safety

- **Fencing.** User-written content in results is wrapped in a fence with a per-result random token
  (`<<koda-data-7f3a…>> … <<end-koda-data-7f3a…>>`), so content cannot close the fence. The thread system prompt says
  fenced content is data, never instructions. The structural guard is that no write happens without a human approving
  the exact preview.
- **Masked and fenced fields:** ticket title and body, comments, KB chunk text, memory item content, ADR rationale,
  story titles, job escalation reasons, and log lines.
- **Secret masking.** The API has no server-side secret masking today (only auth-secret handling). S5b-1b adds a masker
  in the tool layer (token-shaped values; `KEY=value` with secret-like key names; URL credentials) applied to every
  masked field above.
- **Log excerpts.** Level filtering exists only on the `run` stream (nax LogEntry JSON, `fleet/logs/log-entry.ts:4,60-62`);
  stdout / stderr are raw text and are returned as tail excerpts. Reads scan a bounded window (`FLEET_LOG_SCAN_BYTES`,
  default 2 MiB, `config/fleet.config.ts:128`) and logs expire (`logRetentionDays`). Results carry `truncated`,
  `scannedBytes` and `expired`. `LogReadService` is added to `LogsModule` exports (`logs/logs.module.ts:33`).
- **Output caps.** Default 20 items or 16 KB per result, whichever first, with a cursor for more.
- **Citations.** Results carry stable references: ticket key + web path, job id + web path, KB document id, memory id.
  The system prompt asks the agent to cite them; the web renders them as links.
- **Audit.** `AssistantToolCall` stores tool, input hash (not input), outcome, duration, result bytes. Executed writes
  go through the domain services, so the usual timeline / outbox events fire, actor = the approving user, annotated
  `via: thread <id>` (or `via: mcp key <id>`).
- **Cost.** Thread spend: section 6. A dispatch carries its own `maxCostUsd` on the card, and project budgets apply
  (no `repo:` key for PROJECT threads' own spend; a dispatched RUN has a repo and keeps it).

## 10. Delivery (nax features, in order)

| # | Feature | Packages | Content |
|---|---|---|---|
| 1 | `fleet-s5b-project-threads` (S5b-1a) | api, protocol, runner, web | PROJECT kind end to end with no koda tools: migration (`kind`, nullable repo fields), anchor repo for the job, `projectThreads` capability + placement, ASSIGN `thread.kind` + optional `feature`, no-checkout runner path, `threads.notRepoThread` / `threads.noFleetRepo`, PROJECT instructions, web scope picker and hidden handoff actions |
| 2 | `fleet-s5b-koda-read-core` (S5b-1b) | api, runner | registry, project-aware executor (ability, project resolution per S5b-R7, ids, caps, masking, fencing, idempotency), runner tool route + lease check, audit, ASSIGN `kodaTools` + `kodaTools` capability, runner proxies, ticket + fleet read tools |
| 3a | `fleet-s5b-koda-knowledge-core` (S5b-1c-a) | api, web | L0 brief: `Project.brief` + the anchor repo's `.nax/context.md` / `AGENTS.md` (GitHub App read, cached per sha) in every thread's instructions, capped 8 KB; `koda_memory_search` (text filter), `koda_timeline`; web brief editor and koda path links in replies |
| 3b | `fleet-s5b-project-thread-code` (S5b-1c-b) | api, protocol, runner | S5b-R15: read-only shallow checkout of all the project's fleet repos for PROJECT threads, read tools over it, `projectCode` capability |
| 3c-1 | `fleet-s5b-koda-knowledge-index` (S5b-1c-c-1) | api | 1c-c-R1..R7: repo Markdown (README, `.nax/context.md`, `docs/**/*.md`, `.nax/features/*/spec.md`) indexed via the GitHub App read-only mint into the project's LanceDB table as heading chunks with extractive abstracts and context lines; hybrid FTS + Ollama vectors fused by RRF on a separate search path; 30-min head poll + merged-RUN hook + admin re-index; `koda_kb_search` + `koda_get_doc`; `owner/name:path@sha7#anchor` citations; 40-question eval over `nathapp-io/koda` (`kb:eval`) |
| 3c-2 | `fleet-s5b-koda-knowledge-outcomes` (S5b-1c-c-2) | api, web | fleet run outcomes (`feature-report.md`, `decisions.jsonl`) kept as rows at bundle ingest for every RUN and indexed tagged with job and PR state; per-project path patterns (default = 3c-1 allowlist); web: patterns editor, re-index button + status, citation links |
| 4 | `fleet-s5b-workspace-threads` (S5b-1d) | api, runner, web | WORKSPACE kind: creator-only visibility, top-level `/threads` routes and page, home project, `project` argument on tools, `koda_my_projects` |
| 5 | `fleet-s5b-koda-actions` (S5b-2a) | api, web | PendingAction, `assistant_action` approvals branch + sweeper + notifications + list exposure, `system` messages, outcome delivery via THREAD_INPUT, `koda_get_action`, confirmation card |
| 6 | `fleet-s5b-koda-write-tools` (S5b-2b) | api | all write tools from section 7 |
| 7 | `fleet-s5b-koda-mcp` (S5b-3) | api | streamable-HTTP MCP over the registry, user or agent API key (agent keys need the project roster; no delete), writes return `pending` and take the `project` argument as WORKSPACE threads do |

Each feature: spec-writing, spec-review, `nax plan` and `nax run` (both need approval), then deploy and a live check on
koda-wk.

## 11. Testing

- api: per-tool unit tests (ability matrix VIEWER / DEVELOPER / ADMIN / non-member; foreign ids; caps; masking; fence
  token); executor idempotency; PendingAction state machine; DB-backed tests for the tool route (lease, epoch,
  UPLOADING refusal) and approve -> execute -> system note; migration test for the `kind` column.
- runner: PROJECT-thread start without a worktree; proxy tools against a scripted fake API; ASSIGN parsing of `thread.kind` and the optional `feature`.
- web: scope picker, citation rendering, confirmation card; one Playwright journey per user-facing feature (PROJECT
  thread asks "which tickets are blocked", gets a cited answer; later proposes two tickets, approve, tickets exist).
- Live check on koda-wk after each feature.

## 12. Out of scope

- MCP before S5b-3; ACP-backed threads (S5a phase D, still deferred; PROJECT + ACP refused).
- Questions across projects in REPO or PROJECT threads (those see only their project; cross-project questions belong to WORKSPACE threads, S5b-R12).
- Text-to-SQL or any direct database access by the agent.
- Editing a proposed action's input on the card (reject and ask again).
- Write tools for admin-only objects; ticket delete.
- A server-to-session command for notes (outcomes ride the next THREAD_INPUT, S5b-R10).
- Server-side LLM calls (the koda API never holds model credentials).
