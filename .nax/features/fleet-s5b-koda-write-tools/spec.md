# SPEC: Fleet S5b-2b-1 — Koda Write Tools (tickets, links, memory, decisions)

## Summary

S5b-2a built human-confirmed writes and shipped one pilot write tool, `koda_add_comment`. This feature adds five more
write tools on that machinery (umbrella row 6, S5b-2b, first half):

- `koda_create_tickets` creates 1 to 20 tickets in the thread's project.
- `koda_update_ticket` changes one ticket's title, description or priority, or starts it (`status: IN_PROGRESS`).
- `koda_link_tickets` attaches 1 to 20 URLs (PR, commit, branch or plain URL) to tickets.
- `koda_add_memory` stores one project memory item that is not a decision.
- `koda_record_decision` records a decision as the requester, superseding their earlier decision on the same topic.

Every call is previewed and proposed, never executed. The user approves or rejects it on the thread card or in the
inbox, exactly as for `koda_add_comment`. Two small additions to the executor let a tool refuse a proposal with a
precise reason, and report a partly applied batch as a failure that names what was done.

S5b-2b ships as two features (user ruling 2b-R1). The fleet writes `koda_dispatch_job`, `koda_requeue_job` and
`koda_cancel_job` are `fleet-s5b-koda-fleet-writes`, which follows this one.

Umbrella design `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R4, S5b-R6, S5b-R7; §7;
§8; §10 row 6). Machinery: `.nax/features/fleet-s5b-koda-actions/spec.md` (2a-1) and
`.nax/features/fleet-s5b-koda-actions-web/spec.md` (2a-web).

## Motivation

S5b-R4 puts tickets, comments, fleet dispatch and KB / memory writes in scope. The umbrella's example asks include
"Turn this brainstorm into tickets" and "Record this decision as an ADR". Today a thread can only propose a comment:
the registry holds one write tool (`apps/api/src/fleet/assistant/tools/action-tools.ts:116-130`).

The 2a write contract is generic — `kind: 'write'`, `preview`, `execute`
(`apps/api/src/fleet/assistant/assistant-tool.types.ts:18-33`) — so each new tool is a descriptor, a parser, a
preview and an execute. Two gaps in the executor block tools richer than a comment:

- A preview can only refuse with `not_found`. Any other exception becomes `error: <tool> failed`
  (`apps/api/src/fleet/assistant/assistant-tool.executor.ts`, `proposeWrite`). `koda_update_ticket` needs to refuse a
  status the requester may not set, or a move the ticket's state does not allow, before an action exists.
- An approved action's outcome is `not_found` or `error: <tool> failed` for every exception (`executeAction`). A batch
  that created 3 of 5 tickets before failing would report a bare failure and hide the 3 tickets that exist.

## Design

### Rulings that bind every story

User, 2026-10-17:

- **2b-R1** S5b-2b is split in two. This feature holds the ticket and knowledge writes. `fleet-s5b-koda-fleet-writes`
  holds dispatch, requeue and cancel.
- **2b-R2** `koda_add_kb_doc` is dropped. The KB route writes the legacy RAG table (`RagService.indexDocument`), which
  `koda_kb_search` never reads (it searches only repo docs and run outcomes, `tools/kb-tools.ts:46`), and S5b-R14 keeps
  ADRs as docs-as-code. Durable knowledge goes through `koda_add_memory` and `koda_record_decision`, which
  `koda_memory_search` already reads.
- **2b-R3** `koda_update_ticket` may set `status` only to `IN_PROGRESS` (the "start" move). The PATCH path carries no
  comment, and every other move needs a typed comment (`tickets/state-machine/ticket-transitions.ts:13-31`).
- **2b-R4** `koda_create_tickets` and `koda_link_tickets` apply their items one at a time, in input order. A failure
  stops the batch, the action is `FAILED`, and its result names what was already applied.
- **2b-R5** Memory items and decisions are always attributed to the requester. The admin override of `ownerId` and
  `actorId` (`memory/memory.controller.ts:103,145-146`) is not exposed.

Drafting decisions (2b1-D*):

- **2b1-D1 Preview refusals.** The executor maps two more exceptions thrown by a write tool's `preview`:
  - `ToolInputError(reason)` answers `invalid_input: <reason>`, audit outcome `invalid_input`.
  - `ToolForbiddenError(need)` answers `forbidden: <tool> needs <need> on <projectSlug>`, audit outcome `forbidden`.
    This is the text format `execParsed` already uses for an ability refusal.
  - Both stop before `propose`, so no action exists. `NotFoundAppException` keeps answering `not_found`.
- **2b1-D2 Partial outcomes.** A tool's `execute` may throw `ToolActionError(text)`. `executeAction` answers
  `{ ok: false, text }` with `text` capped at `RESULT_CAP_BYTES`, so the action is `FAILED` and its outcome note quotes
  the text. Every other exception keeps today's mapping. The outcome note keeps its 500-character cap
  (`NOTE_RESULT_MAX`, `actions/outcome-note.ts:4`), so a long batch result is cut in the note; the action's stored
  `result` keeps all of it and `koda_get_action` returns it.
- **2b1-D3 Descriptors.** The five descriptors form a new group `WRITE_TOOL_DESCRIPTORS`, in the order
  `koda_create_tickets`, `koda_update_ticket`, `koda_link_tickets`, `koda_add_memory`, `koda_record_decision`.
  `KODA_TOOL_DESCRIPTORS` spreads it last, after `ACTION_TOOL_DESCRIPTORS`. REPO and PROJECT threads then carry 19
  descriptors and WORKSPACE threads 20, under `KODA_TOOL_LIMITS.maxTools` (32). Every description says the change
  happens only after the user approves it and that the call must not be repeated, as `KODA_ADD_COMMENT` does. The
  runner refuses the whole tool list when any description exceeds `KODA_TOOL_DESCRIPTION_MAX_CHARS` (2000,
  `apps/runner/src/supervisor/assign-parser.ts`), and a WORKSPACE thread appends its `project` sentence, so every
  description stays at most 2000 characters after that sentence is appended.
- **2b1-D4 Permissions** mirror each REST route (S5b-R6):
  - `koda_create_tickets`: ability `create` `Ticket` (`tickets.controller.ts:168`).
  - `koda_update_ticket`: ability `update` `Ticket` (`tickets.controller.ts:214`). When `status` is set, the preview
    also requires `transition` `Ticket`, as `TicketsService.update` does through `assertTransitionPermission`.
  - `koda_link_tickets`: project membership. The link route checks only membership (`ticket-links.controller.ts:57`).
    This corrects the umbrella §7 row, which named the ticket abilities.
  - `koda_add_memory` and `koda_record_decision`: project membership (`memory.controller.ts:31-46`).
- **2b1-D5 Input bounds** (the parser refuses with the named reason):

  | Tool | Field | Rule | Reason |
  |---|---|---|---|
  | `koda_create_tickets` | `tickets` | array of 1 to 20 objects | `tickets` |
  | | `tickets[i].type` | one of `BUG`, `ENHANCEMENT`, `TASK`, `QUESTION` | `tickets[i].type` |
  | | `tickets[i].title` | string, 1 to 200 characters after trim | `tickets[i].title` |
  | | `tickets[i].description` | optional string, at most 4000 characters | `tickets[i].description` |
  | | `tickets[i].priority` | optional, one of `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` | `tickets[i].priority` |
  | `koda_update_ticket` | `ref` | `TICKET_REF` | `ref` |
  | | `title` | optional string, 1 to 200 characters after trim | `title` |
  | | `description` | optional string, at most 4000 characters | `description` |
  | | `priority` | optional, one of the four priorities | `priority` |
  | | `status` | optional, exactly `IN_PROGRESS` | `status` |
  | | (all four absent) | at least one change | `changes` |
  | `koda_link_tickets` | `links` | array of 1 to 20 objects | `links` |
  | | `links[i].ref` | `TICKET_REF` | `links[i].ref` |
  | | `links[i].url` | an absolute `http:` or `https:` URL, at most 2048 characters | `links[i].url` |
  | | `links[i].linkType` | optional, one of `url`, `pr`, `commit`, `branch` | `links[i].linkType` |
  | `koda_add_memory` | `kind` | one of `FACT`, `PREFERENCE`, `CONSTRAINT`, `INCIDENT_PATTERN` (never `DECISION`) | `kind` |
  | | `subject`, `predicate` | string, 1 to 200 characters after trim | `subject`, `predicate` |
  | | `object` | optional string, at most 4000 characters | `object` |
  | `koda_record_decision` | `topic` | string, 1 to 200 characters after trim | `topic` |
  | | `decision` | string, 1 to 4000 characters after trim | `decision` |
  | | `rationale` | optional string, at most 4000 characters | `rationale` |

  `i` is the zero-based index. The descriptors' JSON schemas carry the same bounds. A parsed value is stored as written:
  only the trimmed length is judged, as `koda_add_comment` does.
- **2b1-D6 Previews.** Every preview is passed through `maskSecrets`, as `koda_add_comment`'s is. Each one names the
  project slug, and every existing ticket it names is read through the project-scoped `TicketsService.findByRef`, so a
  foreign or missing ref raises `NotFoundAppException` and answers `not_found` before any action exists. The first
  lines are fixed:
  - `koda_create_tickets`: `Create <n> ticket(s) in <slug>:`, then per ticket `<i+1>. [<type>, <priority>] <title>`
    (priority defaults to `MEDIUM`). When the ticket has a description, each of its lines follows, indented by
    four spaces.
  - `koda_update_ticket`: `Update <ref> "<title>" in <slug>:`, then one line per changed field in the order `title`,
    `description`, `priority`, `status`. Title, priority and status read `<field>: <current> -> <new>`. A description
    change reads `description:` followed by the new text, each line indented by four spaces; the old text is not shown.
  - `koda_link_tickets`: `Link <n> URL(s) in <slug>:`, then per link `- <ref> "<title>" <- <linkType> <url>`.
    `linkType` is the one given, or the one `TicketLinksService.inferLinkType` would infer, copied into the tool
    because that method is private: `pr` when the URL matches `/\/pull\/\d+/`, `/\/merge_requests\/\d+/` or
    `/\/pull-requests\/\d+/`, else `url`.
  - `koda_add_memory`: `Remember in <slug>: <kind> <subject> / <predicate>`, then the object when present. When an
    active item with the same `kind`, `subject` and `predicate` exists, the last line is
    `Replaces memory:<id>: <its object>`, or `Replaces memory:<id>` when that item has no object.
  - `koda_record_decision`: `Record a decision in <slug> on "<topic>": <decision>`, then `Rationale: <rationale>`
    when present. When the requester already has an active decision on that topic, the last line is
    `Supersedes memory:<id>: <its decision>`.
  - `koda_update_ticket` with `status` checks the requester's `transition` permission before the ticket's current
    status, so a requester without it gets `forbidden` whatever the status.
  - Preview size is accepted as bounded by the input bounds (at most about 85 KB for 20 tickets with full
    descriptions); previews are not truncated, because the user approves the exact text.
- **2b1-D7 Execution** runs as the requester with the action project's role (`ctx.actor`, 2a-D8), through the domain
  services, so the usual ticket events, timeline rows and outbox events fire.
  - `koda_create_tickets` calls `TicketsService.create(slug, { type, title, description, priority }, ctx.actor)` once
    per ticket, in order. The result is one line per ticket, `created <ref> /<slug>/tickets/<ref>`. When ticket `k`
    fails, it throws `ToolActionError` whose text is the lines already written, then
    `failed at ticket <k+1>: <reason>`, where the reason is `not_found` for `NotFoundAppException` and `error` for
    anything else.
  - `koda_update_ticket` first reads the ticket. When `status` is set and the ticket's current status cannot move to
    `IN_PROGRESS` (`validateTransition` throws), it throws `ToolActionError('<ref> cannot move from <status> to
    IN_PROGRESS')` before any write. Otherwise it calls `TicketsService.update(slug, ref, changes, ctx.actor)`, and
    the result is `updated <ref> /<slug>/tickets/<ref>`. A `ForbiddenAppException` from the service becomes
    `ToolActionError('forbidden: <ref> needs transition Ticket')`.
  - `koda_link_tickets` calls `TicketLinksService.create(slug, ref, { url, linkType })` once per link, in order. The
    result is one line per link, `linked <ref> <url>` with ` (already linked)` appended when the service answered
    status 200. A failure at link `k` throws `ToolActionError` with the lines so far, then
    `failed at link <k+1>: <reason>`.
  - `koda_add_memory` calls `PrismaMemoryItemRepository.upsert` with the thread's project, the parsed fields,
    `sourceType: 'thread'`, `sourceId: <threadId>`, `confidence: 0.8` and `ownerId: ctx.actor.id`. The result is
    `memory:<id> saved`.
  - `koda_record_decision` calls `ExtractionService.recordDecision` with the thread's project,
    `actorId: ctx.actor.id`, the topic, `sourceId: 'thread:<threadId>'` and the same repository. `recordDecision`
    stores only `decision` as the item's object and drops `rationale` (`memory/extraction.service.ts:223-232`), so the
    tool passes `decision` as `<decision>\n\nRationale: <rationale>` when a rationale is given, and as the decision
    alone otherwise, and passes no `rationale` field. The decision and rationale the user approved are both stored; the stored text
    separates them with a blank line where the preview uses a line break. The result is
    `decision memory:<memoryId> recorded`.
- **2b1-D8 Tool groups and files.** Each tool is a factory in its own file under `tools/`:
  `create-tickets-tool.ts`, `update-ticket-tool.ts`, `link-tickets-tool.ts`, `add-memory-tool.ts` and
  `record-decision-tool.ts`. `TicketWriteTools` (`tools/ticket-write-tools.ts`) registers the three ticket tools and
  `MemoryWriteTools` (`tools/memory-write-tools.ts`) the two memory tools, each in `onModuleInit` like `ActionTools`.
  Both are `AssistantModule` providers. The two input helpers private to `action-tools.ts`, `asRecord` and
  `ticketPath` (`tools/action-tools.ts:41-48`), move to a new `tools/tool-input.ts` and are exported from there;
  `action-tools.ts` imports them, unchanged in behaviour. `AssistantModule` already imports `TicketsModule` (which exports
  `TicketsService` and `TicketTransitionsService`), `TicketLinksModule` and `MemoryModule` (which exports
  `PrismaMemoryItemRepository` and `ExtractionService`), so no module import changes.

### Integration

Read-only — the feature calls these as they are:

- `TicketsService.create(projectSlug, dto: CreateTicketDto, principal)`, `findByRef(projectSlug, ref)` and
  `update(projectSlug, ref, dto: UpdateTicketDto, principal)` — `apps/api/src/tickets/tickets.service.ts:93,178,227`.
- `TicketTransitionsService.assertTransitionPermission(principal)` — throws `ForbiddenAppException` without
  `transition` `Ticket` (`tickets/state-machine/ticket-transitions.service.ts:518`).
- `validateTransition(from, to, commentType?)` — throws `ValidationAppException` for a move with no rule
  (`tickets/state-machine/ticket-transitions.ts:39`).
- `TicketLinksService.create(slug, ref, dto: CreateTicketLinkDto): Promise<{ status: 200 | 201; link }>` — answers 200
  for a URL already linked to the ticket (`ticket-links/ticket-links.service.ts`).
- `PrismaMemoryItemRepository.upsert(item: MemoryItemInput): Promise<MemoryItem>` and
  `findActive(projectId, kind, subject, predicate): Promise<MemoryItem | null>` —
  `memory/prisma-memory-item.repository.ts:155,215`.
- `ExtractionService.recordDecision(input, repository): Promise<WriteResult>` — stores a `DECISION` whose subject is
  `agent:<actorId>` and supersedes the active one on the same topic (`memory/extraction.service.ts:204`).
- `TICKET_REF` — `fleet/assistant/tools/ticket-tools.ts:23`. `maskSecrets` — `fleet/assistant/assistant-tool-safety.ts`.
- The pattern to mirror: `addCommentTool` and `ActionTools` (`fleet/assistant/tools/action-tools.ts`).

Changed — the baseline exists only to locate the code; the target is the interface to implement:

- `apps/api/src/fleet/assistant/assistant-tool.types.ts`
  - Baseline: exports `ToolInputError` only.
  - Target: also exports `ToolForbiddenError` (constructor `(need: string)`, readonly `need`) and `ToolActionError`
    (constructor `(text: string)`, readonly `text`), both subclasses of `Error`.
- `AssistantToolExecutor.proposeWrite` (`assistant-tool.executor.ts`)
  - Baseline: a `preview` exception other than `NotFoundAppException` answers `error: <tool> failed`.
  - Target: `ToolInputError` answers `invalid_input: <reason>` and `ToolForbiddenError` answers
    `forbidden: <tool> needs <need> on <slug>` (2b1-D1). Both are recorded with that outcome, and `propose` is not called.
- `AssistantToolExecutor.executeAction`
  - Baseline: `NotFoundAppException` answers `not_found`; anything else answers `error: <tool> failed`.
  - Target: `ToolActionError` answers `{ ok: false, text: capText(error.text, RESULT_CAP_BYTES) }`, with no error
    log. The other two mappings are unchanged.
- `KODA_TOOL_DESCRIPTORS` (`koda-tool-descriptors.ts`)
  - Baseline: `[...TICKET, ...FLEET, ...KNOWLEDGE, ...ACTION]` (14 entries).
  - Target: `[...TICKET, ...FLEET, ...KNOWLEDGE, ...ACTION, ...WRITE_TOOL_DESCRIPTORS]` (19 entries), plus the exported
    constants `KODA_CREATE_TICKETS`, `KODA_UPDATE_TICKET`, `KODA_LINK_TICKETS`, `KODA_ADD_MEMORY`,
    `KODA_RECORD_DECISION` and `WRITE_TOOL_DESCRIPTORS`.
- `apps/api/src/fleet/assistant/tools/action-tools.ts`
  - Baseline: declares `asRecord` and `ticketPath` as private module helpers (`:41-48`).
  - Target: imports both from the new `tools/tool-input.ts`, which exports them with the same behaviour.

### Failure Handling

| Case | Behaviour |
|---|---|
| Requester lacks the tool's ability (VIEWER on a ticket write) | `forbidden: <tool> needs <action> Ticket on <slug>`; no action (existing executor path) |
| `status` set and the requester lacks `transition` `Ticket` | Preview throws `ToolForbiddenError('transition Ticket')`; `forbidden: koda_update_ticket needs transition Ticket on <slug>`; no action |
| `status` set and the ticket cannot start from its current status | Preview throws `ToolInputError('status')`; `invalid_input: status`; no action |
| A ref that is not a ticket of the project | `not_found`; no action |
| Input outside 2b1-D5 | `invalid_input: <reason>`; no action |
| Ticket changed between proposal and approval so it can no longer start | `FAILED`, result `<ref> cannot move from <status> to IN_PROGRESS`; nothing written |
| Ticket deleted before approval | `koda_update_ticket`: `FAILED`, result `not_found` (existing `executeAction` mapping). A batch tool: `FAILED`, result `failed at <ticket|link> <k+1>: not_found` after the lines applied |
| Batch item `k` fails at approval | `FAILED`, result lists the items applied, then `failed at <ticket|link> <k+1>: <reason>` |
| URL already linked to the ticket | That line reads `linked <ref> <url> (already linked)`; the batch continues |

## Out of Scope

- `koda_dispatch_job`, `koda_requeue_job` and `koda_cancel_job`: `fleet-s5b-koda-fleet-writes` (2b-R1).
- `koda_add_kb_doc` and any write to the RAG knowledge base: dropped by ruling 2b-R2.
- Status moves other than the start move to `IN_PROGRESS` (verify, fix, verify-fix, close, reject): they need typed comments the tool does not take (2b-R3).
- Assigning, unassigning, labelling or deleting tickets through a tool.
- Ticket-to-ticket relations (blocks, depends on, duplicates): koda has no such model; `koda_link_tickets` attaches URLs only.
- Creating a batch of tickets or links atomically; items apply one at a time and a failure leaves the earlier ones in place (2b-R4).
- Attributing a memory item or decision to anyone other than the requester, including for global admins (2b-R5).
- Writing a `DECISION` memory item through `koda_add_memory`; decisions go through `koda_record_decision` only.
- Any web change: the thread card, the inbox panel and the system notes already render every write tool from its preview text.
- Changes to the runner, the fleet protocol or `FLEET_PROTOCOL_VERSION`.
- Editing a proposed action's input before deciding it (umbrella §12).
- Storing a decision's rationale in a field of its own; it is appended to the stored decision text (2b1-D7).
- Annotating the ticket, link or memory events with `via: thread <id>`; the approval activity row carries the thread id, and memory rows carry it as `sourceId`.
- US-003 and US-004 only: a requester without `create` or `update` `Ticket` (a VIEWER) is refused by the existing executor ability path (2a US-002 AC-8); this feature adds no AC for it.
- US-004 only: a `koda_update_ticket` ref that matches no ticket of the project answers `not_found` through `TicketsService.findByRef` and the existing executor preview mapping, as US-005 AC-6 pins for links; this feature adds no `koda_update_ticket` AC for it.
- A ticket deleted between proposal and approval answers `not_found` through the existing `executeAction` mapping; this feature adds no AC for it.
- US-004 only: a ticket whose status changes between the start check and `TicketsService.update` can leave the field changes written and the transition refused; the window is one request and is not locked.

## Stories

1. **US-001: Executor refusal and partial-outcome errors** — `Workdir: apps/api` — No dependencies.
2. **US-002: Write descriptors and shared tool-input helpers** — `Workdir: apps/api` — No dependencies.
3. **US-003: `koda_create_tickets`** — `Workdir: apps/api` — Depends on US-001, US-002.
4. **US-004: `koda_update_ticket`** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: `koda_link_tickets`** — `Workdir: apps/api` — Depends on US-004.
6. **US-006: `koda_add_memory`** — `Workdir: apps/api` — Depends on US-005.
7. **US-007: `koda_record_decision`** — `Workdir: apps/api` — Depends on US-006.

- US-001 adds the two error classes and the two executor mappings. US-002 adds all five descriptors and moves the two
  input helpers. Tool stories add only their tools.
- The tool stories run one after another, because each adds a registration test to `assistant.module.spec.ts` and
  US-003 and US-006 both add a provider to `assistant.module.ts`.
- US-003 creates `TicketWriteTools`; US-004 and US-005 register their tools in it (an additive edit to a file this
  feature creates, so it has no Modifies entry). US-006 creates `MemoryWriteTools`; US-007 registers its tool in it.
- Integration tests are one file per story. They enter at the runner tool route
  `POST /api/fleet/runner/jobs/:jobId/tools/<name>?leaseEpoch=<n>` and decide at
  `POST /api/projects/web/fleet/approvals/:approvalId/decide` (the app's `/api` prefix, as in the fixture), where `approvalId` is the stored `PendingAction`'s
  `approvalId` (not the action id).
- The fixtures follow `test/integration/fleet/assistant-action-tools.integration.spec.ts`:
  - `seedFleetHttpWorld`, with the web project's key set to `KODA` so the first ticket is `KODA-1`;
  - DEVELOPER `dev`, VIEWER `viewer`;
  - a RUNNING REPO THREAD job from `seedThreadJobFor`, created by `dev` unless an AC names `viewer`;
  - `FLEET_THREADS_ENABLED=true` before boot.
- A test that needs a ticket in a given status (`VERIFY_FIX`, `CREATED`) sets that status on its own ticket. The tests
  need the compose test DB (`bun run test:db:up`).
- No story changes the Prisma schema or the API contract, so none regenerates `openapi.json`.

### Context Files

**US-001**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `proposeWrite`, `executeAction`
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `ToolInputError`, `AssistantTool`
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — the executor test harness with stub write tools

**US-002**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_ADD_COMMENT`, `ACTION_TOOL_DESCRIPTORS`, `kodaToolDescriptorsFor`
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the descriptor tests this story updates
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `asRecord`, `ticketPath`

**US-003**

- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `addCommentTool` and `ActionTools`, the pattern to mirror
- `apps/api/src/tickets/tickets.service.ts` — `create`, `findByRef`
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — the registration tests to extend
- `apps/api/test/integration/fleet/assistant-action-tools.integration.spec.ts` — route and decide fixtures

**US-004**

- `apps/api/src/tickets/tickets.service.ts` — `update`, `findByRef`
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — `assertTransitionPermission`
- `apps/api/src/tickets/state-machine/ticket-transitions.ts` — `validateTransition`, `TRANSITION_RULES`
- `apps/api/src/fleet/assistant/tools/ticket-write-tools.ts` — created by US-003; this story registers `updateTicketTool` in its `onModuleInit`
- `apps/api/test/integration/fleet/assistant-create-tickets-tool.integration.spec.ts` — created by US-003; route and decide fixtures

**US-005**

- `apps/api/src/ticket-links/ticket-links.service.ts` — `create`, `inferLinkType`, the 200/201 status
- `apps/api/src/ticket-links/dto/create-ticket-link.dto.ts` — `CreateTicketLinkDto`
- `apps/api/src/fleet/assistant/tools/ticket-write-tools.ts` — created by US-003; this story registers `linkTicketsTool` in its `onModuleInit`
- `apps/api/test/integration/fleet/assistant-create-tickets-tool.integration.spec.ts` — created by US-003; route and decide fixtures

**US-006**

- `apps/api/src/memory/prisma-memory-item.repository.ts` — `upsert`, `findActive`
- `apps/api/src/memory/memory.controller.ts` — the attribution rules to mirror
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts` — `koda_memory_search`, which reads what this story writes
- `apps/api/test/integration/fleet/assistant-memory-tools.integration.spec.ts` — memory tool fixtures

**US-007**

- `apps/api/src/memory/extraction.service.ts` — `recordDecision`
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findActive`
- `apps/api/src/fleet/assistant/tools/memory-write-tools.ts` — created by US-006; this story registers `recordDecisionTool` in its `onModuleInit`
- `apps/api/test/integration/fleet/assistant-add-memory-tool.integration.spec.ts` — created by US-006; route and decide fixtures

### Creates

**US-001**

- `apps/api/src/fleet/assistant/write-tool-errors.spec.ts` — the executor mappings for `ToolInputError`, `ToolForbiddenError` and `ToolActionError`

**US-002**

- `apps/api/src/fleet/assistant/tools/tool-input.ts` — exported `asRecord` and `ticketPath`
- `apps/api/src/fleet/assistant/tools/tool-input.spec.ts` — unit tests for the two helpers

**US-003**

- `apps/api/src/fleet/assistant/tools/create-tickets-tool.ts` — `createTicketsTool`
- `apps/api/src/fleet/assistant/tools/create-tickets-tool.spec.ts` — its unit tests
- `apps/api/src/fleet/assistant/tools/ticket-write-tools.ts` — the `TicketWriteTools` provider, registering `createTicketsTool`
- `apps/api/test/integration/fleet/assistant-create-tickets-tool.integration.spec.ts` — route and approve tests

**US-004**

- `apps/api/src/fleet/assistant/tools/update-ticket-tool.ts` — `updateTicketTool`
- `apps/api/src/fleet/assistant/tools/update-ticket-tool.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/assistant-update-ticket-tool.integration.spec.ts` — route and approve tests

**US-005**

- `apps/api/src/fleet/assistant/tools/link-tickets-tool.ts` — `linkTicketsTool`
- `apps/api/src/fleet/assistant/tools/link-tickets-tool.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/assistant-link-tickets-tool.integration.spec.ts` — route and approve tests

**US-006**

- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts` — `addMemoryTool`
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — its unit tests
- `apps/api/src/fleet/assistant/tools/memory-write-tools.ts` — the `MemoryWriteTools` provider, registering `addMemoryTool`
- `apps/api/test/integration/fleet/assistant-add-memory-tool.integration.spec.ts` — route and approve tests

**US-007**

- `apps/api/src/fleet/assistant/tools/record-decision-tool.ts` — `recordDecisionTool`
- `apps/api/src/fleet/assistant/tools/record-decision-tool.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/assistant-record-decision-tool.integration.spec.ts` — route and approve tests

### Modifies

**US-001**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `proposeWrite` maps `ToolInputError` and `ToolForbiddenError` from `preview` (2b1-D1) and `executeAction` maps `ToolActionError` (2b1-D2); every other path is unchanged.

**US-002**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the test `gives REPO and PROJECT 14 descriptors and WORKSPACE 15` becomes 19 and 20, and its `at(-1)` name check becomes `koda_record_decision`; the AC-15 test that `kodaToolDescriptorsFor('REPO')` ends with `koda_get_action` then `koda_add_comment` asserts instead that those two directly precede the five `WRITE_TOOL_DESCRIPTORS` entries; the AC-22 tests slice off `ACTION_TOOL_DESCRIPTORS.length + WRITE_TOOL_DESCRIPTORS.length` and their full-list equality gains `...WRITE_TOOL_DESCRIPTORS` last. No other assertion changes.
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — imports `asRecord` and `ticketPath` from the new tool-input helper module (US-002 Creates) instead of declaring them (2b1-D8); behaviour unchanged.

**US-003**

- `apps/api/src/fleet/assistant/assistant.module.ts` — the providers list gains `TicketWriteTools`; no import changes.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_create_tickets` is registered as a write tool with its permission; existing tests unchanged.

**US-004**

- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_update_ticket` is registered as a write tool with its permission; existing tests unchanged.

**US-005**

- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_link_tickets` is registered as a write tool with its permission; existing tests unchanged.

**US-006**

- `apps/api/src/fleet/assistant/assistant.module.ts` — the providers list gains `MemoryWriteTools`; no import changes.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_add_memory` is registered as a write tool with its permission; existing tests unchanged.

**US-007**

- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `koda_record_decision` is registered as a write tool with its permission; existing tests unchanged.

### Seams

- **US-001 → US-003 .. US-007.** `ToolInputError`, `ToolForbiddenError` and `ToolActionError` reach the agent or the
  action only through the executor. US-001 pins the three mappings with stub tools; US-004 AC-14 enters at the runner
  tool route and asserts `invalid_input: status` from a real preview.
- **US-002 → US-003 .. US-007.** A tool reaches the agent only once its group registers it under its US-002
  descriptor's name with `kind: 'write'`. Each tool story pins the registration in `assistant.module.spec.ts`, and its
  route AC proves the real path, because only a registered write tool answers `pending ` at the runner tool route.
- **US-006 → `koda_memory_search`.** US-006 AC-12 reads the approved memory item back through the existing read tool at
  the runner tool route.

## Acceptance Criteria

### US-001: Executor refusal and partial-outcome errors (`Workdir: apps/api`)

1. [unit] `AssistantToolExecutor.execute` calling a stub write tool named `w`, whose `preview` throws `ToolInputError('status')`, returns `{ isError: true, content: 'invalid_input: status' }`.
2. [unit] For a stub write tool whose `preview` throws `ToolInputError('status')`, the attached proposer's `propose` is never called.
3. [unit] For a stub write tool whose `preview` throws `ToolInputError('status')`, the `AssistantToolCall` row the executor records has `outcome` `invalid_input`.
4. [unit] `AssistantToolExecutor.execute` calling a stub write tool named `w` in project `web`, whose `preview` throws `new ToolForbiddenError('transition Ticket')`, returns `{ isError: true, content: 'forbidden: w needs transition Ticket on web' }`.
5. [unit] For a stub write tool whose `preview` throws `ToolForbiddenError`, the attached proposer's `propose` is never called.
6. [unit] For a stub write tool whose `preview` throws `ToolForbiddenError`, the `AssistantToolCall` row the executor records has `outcome` `forbidden`.
7. [unit] `AssistantToolExecutor.executeAction` for an action whose tool's `execute` throws `new ToolActionError('created KODA-1\nfailed at ticket 2: error')` returns `{ ok: false, text: 'created KODA-1\nfailed at ticket 2: error' }`.
8. [unit] `AssistantToolExecutor.executeAction` for an action whose tool's `execute` throws a `ToolActionError` whose text is `RESULT_CAP_BYTES + 100` bytes returns a `text` of at most `RESULT_CAP_BYTES` bytes.
9. [unit] `AssistantToolExecutor.executeAction` for an action of tool `w` whose `execute` throws a plain `Error` returns `{ ok: false, text: 'error: w failed' }`.

### US-002: Write descriptors and shared tool-input helpers (`Workdir: apps/api`)

1. [unit] `WRITE_TOOL_DESCRIPTORS.map((d) => d.name)` equals `['koda_create_tickets', 'koda_update_ticket', 'koda_link_tickets', 'koda_add_memory', 'koda_record_decision']`.
2. [unit] The last five entries of `kodaToolDescriptorsFor('REPO')` are the `WRITE_TOOL_DESCRIPTORS` entries, in order.
3. [unit] The two entries of `kodaToolDescriptorsFor('REPO')` before those five are named `koda_get_action` and `koda_add_comment`.
4. [unit] `kodaToolDescriptorsFor('REPO')` has 19 entries.
5. [unit] `kodaToolDescriptorsFor('WORKSPACE')` has 20 entries.
6. [unit] Every `WRITE_TOOL_DESCRIPTORS` entry's `description` contains `only after the user approves`.
7. [unit] Every entry of `kodaToolDescriptorsFor('WORKSPACE')` has a `description` of at most 2000 characters.
8. [unit] `KODA_CREATE_TICKETS.inputSchema.properties.tickets` has `minItems` 1 and `maxItems` 20.
9. [unit] `KODA_LINK_TICKETS.inputSchema.properties.links` has `minItems` 1 and `maxItems` 20.
10. [unit] `KODA_UPDATE_TICKET.inputSchema.properties.status.enum` equals `['IN_PROGRESS']`.
11. [unit] `KODA_ADD_MEMORY.inputSchema.properties.kind.enum` equals `['FACT', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN']`.
12. [unit] `asRecord([1])`, imported from `tools/tool-input.ts`, returns `{}`.
13. [unit] `ticketPath('web', 'KODA-1')`, imported from `tools/tool-input.ts`, returns `/web/tickets/KODA-1`.

### US-003: `koda_create_tickets` (`Workdir: apps/api`)

1. [unit] `createTicketsTool(...).parse({ tickets: [] })` throws `ToolInputError` with reason `tickets`.
2. [unit] `createTicketsTool(...).parse` with 21 valid tickets throws `ToolInputError` with reason `tickets`.
3. [unit] `createTicketsTool(...).parse({ tickets: [{ type: 'TASK', title: 'a' }, { type: 'EPIC', title: 'b' }] })` throws `ToolInputError` with reason `tickets[1].type`.
4. [unit] `createTicketsTool(...).parse({ tickets: [{ type: 'TASK', title: '   ' }] })` throws `ToolInputError` with reason `tickets[0].title`.
5. [unit] `createTicketsTool(...).preview` for two tickets in project `web` returns text whose first line is `Create 2 ticket(s) in web:`.
6. [unit] `createTicketsTool(...).preview` for a first ticket `{ type: 'TASK', title: 'Add login' }` with no priority returns text whose second line is `1. [TASK, MEDIUM] Add login`.
7. [unit] `createTicketsTool(...).preview` for a ticket whose description holds `token=ghp_abcdefghijklmnopqrstuvwxyz0123456789` returns text in which `ghp_abcdefghijklmnopqrstuvwxyz0123456789` does not appear.
8. [unit] For `createTicketsTool(...).execute` in project `web` with tickets titled `a` then `b`, the list of argument tuples `TicketsService.create` received equals, in order, `('web', { type, title: 'a', description, priority }, ctx.actor)` and `('web', { type, title: 'b', description, priority }, ctx.actor)`.
9. [unit] `createTicketsTool(...).execute` in project `web`, when `TicketsService.create` answers refs `KODA-5` and `KODA-6`, returns `created KODA-5 /web/tickets/KODA-5\ncreated KODA-6 /web/tickets/KODA-6`.
10. [unit] When the second of three `TicketsService.create` calls throws a plain `Error` after the first answered `KODA-5` in project `web`, `createTicketsTool(...).execute` throws a `ToolActionError` whose `text` is `created KODA-5 /web/tickets/KODA-5\nfailed at ticket 2: error`.
11. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_create_tickets')?.permission` equals `{ kind: 'ability', action: 'create', subject: 'Ticket' }`.
12. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_create_tickets?leaseEpoch=<n>` from the runner holding `dev`'s RUNNING REPO THREAD job, with two tickets, answers 200 with content starting `pending `.
13. [integration] After `dev` approves that action at `POST /projects/web/fleet/approvals/:approvalId/decide` with `{ decision: 'approve' }`, the titles of the project's two newest tickets, oldest first, equal the two proposed titles.
14. [integration] Each ticket created by that approval has `createdByUserId` equal to `dev`'s id.

### US-004: `koda_update_ticket` (`Workdir: apps/api`)

1. [unit] `updateTicketTool(...).parse({ ref: 'KODA-1' })` throws `ToolInputError` with reason `changes`.
2. [unit] `updateTicketTool(...).parse({ ref: 'KODA-1', status: 'CLOSED' })` throws `ToolInputError` with reason `status`.
3. [unit] `updateTicketTool(...).preview` for `{ ref: 'KODA-1', priority: 'HIGH' }` on a ticket titled `Fix login` with priority `MEDIUM` in project `web` returns text whose first line is `Update KODA-1 "Fix login" in web:`.
4. [unit] `updateTicketTool(...).preview` for `{ ref: 'KODA-1', priority: 'HIGH' }` on a ticket whose priority is `MEDIUM` returns text whose second line is `priority: MEDIUM -> HIGH`.
5. [unit] `updateTicketTool(...).preview` for `{ ref: 'KODA-1', title: 'New' }` never calls `TicketTransitionsService.assertTransitionPermission`.
6. [unit] `updateTicketTool(...).preview` for `{ ref: 'KODA-1', status: 'IN_PROGRESS' }`, when `assertTransitionPermission` throws `ForbiddenAppException`, throws a `ToolForbiddenError` whose `need` is `transition Ticket`.
7. [unit] `updateTicketTool(...).preview` for `{ ref: 'KODA-1', status: 'IN_PROGRESS' }` on a ticket whose status is `VERIFY_FIX` throws `ToolInputError` with reason `status`.
8. [unit] `updateTicketTool(...).execute` in project `web` with `{ ref: 'KODA-1', priority: 'HIGH' }` calls `TicketsService.update` once with `('web', 'KODA-1', { priority: 'HIGH' }, ctx.actor)`.
9. [unit] `updateTicketTool(...).execute` in project `web` with `{ ref: 'KODA-1', priority: 'HIGH' }` returns `updated KODA-1 /web/tickets/KODA-1`.
10. [unit] `updateTicketTool(...).execute` with `{ ref: 'KODA-1', status: 'IN_PROGRESS' }` on a ticket whose status is now `CLOSED` throws `new ToolActionError('KODA-1 cannot move from CLOSED to IN_PROGRESS')`.
11. [unit] When `updateTicketTool(...).execute` with `status: 'IN_PROGRESS'` finds the ticket `CLOSED`, `TicketsService.update` is never called.
12. [unit] `updateTicketTool(...).execute` with `{ ref: 'KODA-1', status: 'IN_PROGRESS' }` on a `CREATED` ticket, when `TicketsService.update` throws `ForbiddenAppException`, throws `new ToolActionError('forbidden: KODA-1 needs transition Ticket')`.
13. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_update_ticket')?.permission` equals `{ kind: 'ability', action: 'update', subject: 'Ticket' }`.
14. [integration] At the runner tool route, `koda_update_ticket` with `{ ref: 'KODA-1', status: 'IN_PROGRESS' }` for a ticket in `VERIFY_FIX` answers `{ isError: true, content: 'invalid_input: status' }`.
15. [integration] `koda_update_ticket` with `{ ref: 'KODA-1', status: 'IN_PROGRESS', priority: 'HIGH' }` at the runner tool route for a `CREATED` ticket, approved by `dev` at the decide route, leaves the ticket with `{ status: 'IN_PROGRESS', priority: 'HIGH' }`.

### US-005: `koda_link_tickets` (`Workdir: apps/api`)

1. [unit] `linkTicketsTool(...).parse({ links: [] })` throws `ToolInputError` with reason `links`.
2. [unit] `linkTicketsTool(...).parse` with 21 valid links throws `ToolInputError` with reason `links`.
3. [unit] `linkTicketsTool(...).parse({ links: [{ ref: 'KODA-1', url: 'ftp://host/x' }] })` throws `ToolInputError` with reason `links[0].url`.
4. [unit] `linkTicketsTool(...).parse({ links: [{ ref: 'KODA-1', url: 'https://x.dev/a', linkType: 'issue' }] })` throws `ToolInputError` with reason `links[0].linkType`.
5. [unit] `linkTicketsTool(...).preview` for `{ links: [{ ref: 'KODA-1', url: 'https://github.com/o/r/pull/7' }] }` on a ticket titled `Fix login` in project `web` returns exactly `Link 1 URL(s) in web:\n- KODA-1 "Fix login" <- pr https://github.com/o/r/pull/7`.
6. [unit] `linkTicketsTool(...).preview` for a link whose ref matches no ticket of the project rethrows the `NotFoundAppException` that `TicketsService.findByRef` threw.
7. [unit] For `linkTicketsTool(...).execute` in project `web` with links to `KODA-1` then `KODA-2`, the list of argument tuples `TicketLinksService.create` received equals, in order, `('web', 'KODA-1', { url, linkType })` and `('web', 'KODA-2', { url, linkType })`.
8. [unit] For a link to `KODA-1` that `TicketLinksService.create` answers with status 200, the result line is `linked KODA-1 <url> (already linked)`.
9. [unit] For a link to `KODA-2` that `TicketLinksService.create` answers with status 201, the result line is `linked KODA-2 <url>`.
10. [unit] When the second of two `TicketLinksService.create` calls throws `NotFoundAppException` after the first answered 201 for `KODA-1` and `https://x.dev/a`, `linkTicketsTool(...).execute` throws a `ToolActionError` whose `text` is `linked KODA-1 https://x.dev/a\nfailed at link 2: not_found`.
11. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_link_tickets')?.permission` equals `{ kind: 'member' }`.
12. [integration] At the runner tool route, `koda_link_tickets` with `{ links: [{ ref: 'KODA-1', url: 'https://github.com/o/r/pull/7' }] }` answers content starting `pending `.
13. [integration] After that `koda_link_tickets` route call, `KODA-1` has no `TicketLink`.
14. [integration] After `dev` approves that action at the decide route, `KODA-1` has one `TicketLink` with `{ url: 'https://github.com/o/r/pull/7', linkType: 'pr' }`.
15. [integration] At the runner tool route, `koda_link_tickets` for a RUNNING REPO THREAD job whose thread was created by the project's VIEWER `viewer` answers content starting `pending ` (membership is enough, 2b1-D4).

### US-006: `koda_add_memory` (`Workdir: apps/api`)

1. [unit] `addMemoryTool(...).parse({ kind: 'DECISION', subject: 's', predicate: 'p' })` throws `ToolInputError` with reason `kind`.
2. [unit] `addMemoryTool(...).parse({ kind: 'FACT', subject: ' ', predicate: 'p' })` throws `ToolInputError` with reason `subject`.
3. [unit] `addMemoryTool(...).parse({ kind: 'FACT', subject: 's', predicate: 'p', ownerId: 'someone' })` returns a value with no `ownerId` key (2b-R5).
4. [unit] `addMemoryTool(...).preview` for `{ kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun' }` in project `web`, with no active item of that key, returns exactly `Remember in web: FACT api / runs on\nbun`.
5. [unit] `addMemoryTool(...).preview`, when `PrismaMemoryItemRepository.findActive` answers an item with id `m1` and object `node`, returns text whose last line is `Replaces memory:m1: node`.
6. [unit] `addMemoryTool(...).preview`, when `PrismaMemoryItemRepository.findActive` answers an item with id `m1` and no object, returns text whose last line is `Replaces memory:m1`.
7. [unit] `addMemoryTool(...).execute` for `{ kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun' }` calls `PrismaMemoryItemRepository.upsert` once with `{ projectId: ctx.projectId, kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun', sourceType: 'thread', sourceId: ctx.threadId, confidence: 0.8, ownerId: ctx.actor.id }`.
8. [unit] When that `upsert` answers an item with id `m3`, `addMemoryTool(...).execute` returns `memory:m3 saved`.
9. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_add_memory')?.permission` equals `{ kind: 'member' }`.
10. [integration] At the runner tool route, `koda_add_memory` with `{ kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun' }` from the runner holding `dev`'s RUNNING REPO THREAD job answers content starting `pending `.
11. [integration] After that `koda_add_memory` route call, the project has no active memory item with subject `api` and predicate `runs on`.
12. [integration] After `dev` approves that action at the decide route, `koda_memory_search` with `{ text: 'bun' }` at the runner tool route answers content containing the `memory:<id>` of the stored item.

### US-007: `koda_record_decision` (`Workdir: apps/api`)

1. [unit] `recordDecisionTool(...).parse({ topic: 'db', decision: '   ' })` throws `ToolInputError` with reason `decision`.
2. [unit] `recordDecisionTool(...).parse({ topic: 'db', decision: 'use postgres', actorId: 'someone' })` returns a value with no `actorId` key (2b-R5).
3. [unit] `recordDecisionTool(...).preview` for `{ topic: 'db', decision: 'use postgres', rationale: 'one engine' }` in project `web`, with no active decision, returns exactly `Record a decision in web on "db": use postgres\nRationale: one engine`.
4. [unit] `recordDecisionTool(...).preview` for topic `db` calls `PrismaMemoryItemRepository.findActive` with `(ctx.projectId, 'DECISION', 'agent:<ctx.actor.id>', 'db')`.
5. [unit] `recordDecisionTool(...).preview`, when that lookup answers an item with id `m2` and object `use sqlite`, returns text whose last line is `Supersedes memory:m2: use sqlite`.
6. [unit] `recordDecisionTool(...).execute` for `{ topic: 'db', decision: 'use postgres', rationale: 'one engine' }` calls `ExtractionService.recordDecision` once with first argument `{ projectId: ctx.projectId, actorId: ctx.actor.id, topic: 'db', decision: 'use postgres\n\nRationale: one engine', sourceId: 'thread:<ctx.threadId>' }`.
7. [unit] `recordDecisionTool(...).execute` for `{ topic: 'db', decision: 'use postgres' }` calls `ExtractionService.recordDecision` with a first argument whose `decision` is `use postgres`.
8. [unit] When `recordDecision` answers `{ memoryId: 'm4' }`, `recordDecisionTool(...).execute` returns `decision memory:m4 recorded`.
9. [unit] In `assistant.module.spec.ts`, after the compiled `AssistantModule` testing module runs `init()`, `AssistantToolRegistry.get('koda_record_decision')?.permission` equals `{ kind: 'member' }`.
10. [integration] At the runner tool route, `koda_record_decision` with `{ topic: 'db', decision: 'use postgres', rationale: 'one engine' }` from the runner holding `dev`'s RUNNING REPO THREAD job answers content starting `pending `.
11. [integration] After `dev` approves that action at the decide route, the project holds one active `DECISION` memory item, and it has `{ subject: 'agent:<dev id>', predicate: 'db', object: 'use postgres\n\nRationale: one engine', ownerId: <dev id> }`.
