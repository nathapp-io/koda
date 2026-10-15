# Fleet S5b: koda assistant in threads (design)

Status: design approved in brainstorming 2026-10-15; awaiting written-spec review.
Umbrella design. Delivery is three nax features, each with its own spec, PRD and run (section 9).

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

## 2. Rulings (user, 2026-10-15)

- **S5b-R1 Threads are the surface.** The assistant is a thread capability; no separate assistant page.
- **S5b-R2 Scope = all of:** read Q&A over koda data, confirmed write actions, fleet-ops help, brainstorming, and an
  MCP front door for external agents.
- **S5b-R3 Repo optional.** A new PROJECT thread kind has no repo, worktree or feature. REPO threads keep today's
  behaviour and also get the koda tools.
- **S5b-R4 Write families in scope:** tickets, comments, fleet dispatch, KB / memory. Every write is confirmed by a human.
- **S5b-R5 Approach B.** Tools are defined and executed on the koda API; the runner session only proxies tool calls;
  confirmed writes are executed by the server. No user token and no write capability leave the server. LLM
  credentials stay on runners (fleet design §3 (e), unchanged).

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
                 |           permission, execute}      |
                 |  AssistantToolExecutor (as creator) |
                 |  PendingAction -> confirmation      |
                 +------^------------------------------+
   POST /fleet/runner/threads/:threadId/tools/:name  (runner key + active THREAD job lease)
                 +------+-----------+
                 | runner            | nax-agent session, profile `read`
                 |  koda tool proxies (from the job's tool descriptors)
                 |  + repo tools only for REPO threads
                 +-------------------+
```

Units and their single purpose:

- **AssistantToolRegistry** (api): the list of koda tools. Each tool declares its name (`koda_*`), description, JSON
  input schema, kind (`read` | `write`), required project permission, and an `execute(ctx, input)` that calls existing
  domain services. Pure data plus functions; no transport.
- **AssistantToolExecutor** (api): resolves the caller (thread creator for runner calls; key owner for MCP), re-checks
  project membership and the tool's permission on every call, validates input against the schema, applies output caps
  and masking, writes the audit row, and for `write` tools creates a PendingAction instead of executing.
- **Runner tool route** (api): `POST /fleet/runner/threads/:threadId/tools/:name`. Authenticated by the runner API key;
  authorised only when the runner holds the thread's active THREAD job lease. Thin: delegates to the executor.
- **PendingAction service** (api): state machine for proposed writes; integrates with the approvals inbox as approval
  type `assistant_action`; on approval re-checks the approver's permission and executes via the registry.
- **Runner koda tool proxies** (runner): one `EmbedderTool` per descriptor received in the THREAD job payload; posts the
  input to the tool route and returns the result text. No business logic.
- **Project-thread session path** (runner): starts a nax-agent session with no worktree.
- **Web**: scope picker on the new-thread form, citation links, inline PendingAction cards, inbox rows.

## 5. Thread kinds and data model

`ChatThread` gains `kind` (`REPO` | `PROJECT`, default `REPO`; existing rows backfill to `REPO`). `repoId`, `baseRef`,
`feature` and `specPath` become nullable. A database check constraint enforces: `REPO` has all four set, `PROJECT`
has none set.

PROJECT threads:

- run on a runner like any thread (placement needs a protocol v5 runner with a thread backend), in a per-thread
  scratch directory under the runner home, with no git checkout;
- get the koda tools and `load_skill` / `read_skill_file`; no `list_files`, `search_repo` or `write_doc`;
- have no Publish, Discard, Plan or Run (those stay REPO-only; the web hides them and the API answers 409
  `fleet.threadNotRepo`).

REPO threads keep all S5a behaviour and additionally get the koda tools.

New models:

- **AssistantToolCall** (audit): `id`, `threadId?`, `jobId?`, `apiKeyId?` (MCP), `actorUserId`, `tool`, `inputHash`,
  `outcome` (`ok` | `error` | `forbidden` | `pending`), `errorCode?`, `durationMs`, `resultBytes`, `createdAt`.
  Input itself is not stored (it can carry user text); the hash supports dedupe and debugging.
- **PendingAction**: `id`, `projectId`, `threadId?`, `tool`, `input` (JSON), `preview` (rendered text shown to the
  approver), `status` (`PENDING` | `APPROVED` | `REJECTED` | `EXPIRED` | `EXECUTED` | `FAILED`), `requestedById`,
  `decidedById?`, `decidedAt?`, `result` (JSON: created ids / links, or the failure reason), `expiresAt`, `createdAt`.
  Each PendingAction has one approvals-inbox row of type `assistant_action`, so inbox counts, toasts and
  notifications work unchanged.

## 6. Tool catalog

All tools are scoped to the thread's project. Every read result carries citations (section 7).

| Group | Read (S5b-1) | Write (S5b-2, always confirmed) |
|---|---|---|
| Tickets | `koda_search_tickets` (status, label, assignee, text; paginated), `koda_get_ticket` (fields, links, last 10 comments, linked PRs) | `koda_create_tickets` (batch, max 20), `koda_update_ticket` (status, labels, assignee, title/body), `koda_link_tickets` |
| Comments | (in `koda_get_ticket`) | `koda_add_comment` |
| Fleet | `koda_list_jobs` (state, window, feature, command), `koda_get_job` (stories, phase, escalation reason, PR, cost), `koda_job_log_excerpt` (error-level lines and their surroundings, capped), `koda_fleet_spend` (period, feature, model), `koda_list_approvals`, `koda_runner_status` | `koda_dispatch_job` (PLAN / RUN; `maxCostUsd` required), `koda_requeue_job`, `koda_cancel_job` |
| Knowledge | `koda_kb_search` (existing hybrid retriever), `koda_context_query`, `koda_memory_search`, `koda_timeline` | `koda_add_kb_doc`, `koda_add_memory`, `koda_record_decision` (ADR) |

Fleet ops is a subset of these tools, plus an optional "diagnose a run" skill in the skill catalog; no extra
mechanism.

## 7. Permissions and safety

Permissions:

- Each tool declares the permission its REST counterpart enforces: reads need project membership (VIEWER and up);
  writes and dispatch need DEVELOPER and up, as the matching routes do.
- The executor re-resolves the actor's project role on every call (roles can change mid-thread) and the
  PendingAction service re-resolves the approver's role at approval time.
- The approver must hold the write permission. Default approver is the thread creator; any project member who could
  perform the action may approve from the inbox.
- No admin-only operation (users, runners, budgets, skill sources) is a tool.

Safety:

- **Prompt injection.** User-written content in results (ticket bodies, comments, KB text, log lines) is wrapped in
  fenced data blocks; the thread system prompt states that fenced content is data, not instructions. The structural
  guard is that no write happens without a human approving the exact preview.
- **Output caps.** Every result is capped (default 20 items or 16 KB, whichever first) and returns a cursor for more.
- **Secret masking.** The koda API has no server-side secret masking today; log text is stored as nax wrote it. S5b-1
  adds a small masker in the tool layer (token-shaped values and `KEY=value` pairs with secret-like key names) applied
  to log excerpts and any free-text field returned from fleet data.
- **Cost.** Thread spend stays bounded by `ChatThread.maxCostUsd` and the existing THREAD budget stops. A dispatch
  carries its own `maxCostUsd`, shown on the confirmation card, and the project budget applies to it as to any job.
- **Write throttle.** At most 10 PENDING actions per thread; an 11th returns a tool error asking the agent to wait.
  PendingActions expire after 24 h.
- **Citations.** Read results carry stable references: ticket key + web path, job id + web path, KB document id,
  memory id. The system prompt asks the agent to cite them; the web renders them as links.
- **Audit.** Executed writes go through the same domain services as REST, so they emit the usual timeline / outbox
  events, with the actor = the approving user and a `via: thread <id>` (or `via: mcp key <id>`) annotation.

## 8. Flows

Read call:

1. The agent calls `koda_search_tickets`. The runner proxy posts `{ input }` to the tool route.
2. The API checks the lease, resolves the thread creator, checks membership and permission, validates input,
   executes, masks and caps, writes the audit row.
3. The result (text with citations) returns to the session and is ingested into the thread like any tool summary.

Write call:

1. The agent calls `koda_create_tickets`. The executor validates and stores a PendingAction with a preview, and returns
   immediately: `pending <actionId>: awaiting user approval; do not retry`.
2. The thread page shows a confirmation card (preview, Approve, Reject, expiry); the inbox shows an `assistant_action`
   row linking to the thread.
3. On Approve the API re-checks the approver, executes through the registry, stores `result`, and sets `EXECUTED` or
   `FAILED`. Reject sets `REJECTED`; the expiry sweeper sets `EXPIRED`.
4. The outcome becomes a thread system note (`Action <id> executed: created KODA-41, KODA-42` or the failure reason).
   If a session is live it is delivered at the start of the next turn; otherwise it is stored and seen on resume.
   The agent never blocks on a human.

Failure handling:

| Case | Behaviour |
|---|---|
| Actor lacks permission | Tool error `forbidden: needs <ROLE> on <project>`; audit `forbidden` |
| Target changed before approval (ticket deleted, job already terminal) | `FAILED` with the reason; card shows it |
| Approver lacks permission | 403; action stays PENDING |
| API unreachable from the runner | Proxy returns a tool error; one retry for read tools only |
| Approval after the thread is archived | Executes (it is the user's decision); outcome note stored |
| Runner below protocol v5 | REPO threads run without koda tools; PROJECT threads are not placed on it |

## 9. Delivery (nax features, in order)

1. **S5b-1 `fleet-s5b-koda-read`** (api, runner, web): PROJECT thread kind (migration, placement, no-worktree session,
   form scope picker); registry + executor + runner tool route + audit; all read tools; secret masker; protocol v5
   (THREAD payload gains `kodaTools: ToolDescriptor[]`); citation links in the web.
2. **S5b-2 `fleet-s5b-koda-write`** (api, web): PendingAction + `assistant_action` approval type; all write tools;
   confirmation cards; outcome notes into the thread; expiry sweeper.
3. **S5b-3 `fleet-s5b-koda-mcp`** (api): streamable-HTTP MCP endpoint over the same registry, authenticated by user or
   agent API key; reads execute directly, writes return `pending` and are approved in the koda inbox.

Each feature gets spec-writing, spec-review, `nax plan` and `nax run` (both with approval), then deploy and a live check
on koda-wk. S5b-1 may be split further at spec time if it exceeds the story-size cap.

## 10. Testing

- api: per-tool unit tests (permission matrix VIEWER / DEVELOPER / ADMIN / non-member, caps, masking, citations);
  executor and PendingAction state-machine tests; DB-backed route tests for the runner tool route (lease auth) and
  approve -> execute -> outcome note.
- runner: proxy tool tests against a scripted fake API; PROJECT-thread session start without a worktree.
- web: unit tests for the scope picker, citation rendering and the confirmation card; one Playwright journey (PROJECT
  thread asks "which tickets are blocked", gets a cited answer, proposes two tickets, approve, tickets exist).
- Live check on koda-wk after each feature.

## 11. Out of scope

- MCP before S5b-3; ACP-backed threads (S5a phase D, still deferred).
- Questions across projects (a thread sees only its project).
- Text-to-SQL or any direct database access by the agent.
- Editing a proposed action's input on the card (reject and ask again).
- Write tools for admin-only objects.
- Server-side LLM calls (the koda API never holds model credentials).
