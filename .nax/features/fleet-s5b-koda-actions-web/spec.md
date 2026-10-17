<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S5b-2a-web — Koda Actions Delivery and Web (Outcome Delivery, Inbox Panel, Thread Cards, #294)

Closes: #294

## Summary

`fleet-s5b-koda-actions` (koda PR #295, merged `e7361264`) shipped the API half of human-confirmed writes: a write tool
stores a `PendingAction`, opens an `assistant_action` approval, and every terminal outcome leaves a `system` note in the
thread. This feature finishes S5b-2a (user ruling 2a-R4):

- **Delivery (apps/api).** The next message the thread creator sends carries the thread's undelivered outcome notes to
  the agent, before the user's text. This covers both a live session (the `THREAD_INPUT` command) and a new turn (the
  job's `initialMessage`). Each delivered action records `deliveredAt` and the message it rode on.
- **Approvals (apps/web).** The web knows the `assistant_action` type and the `approve` / `reject` decisions. Only the
  requester may decide. The inbox shows the action's own label and summary, and its panel loads the exact preview
  from the thread before offering Approve.
- **Thread (apps/web).** Both thread pages show a card per pending action, with the preview, the expiry and, for the
  creator, Approve and Reject. `system` notes render as their own muted row.
- **#294 (apps/web).** The project thread list stops a stale Active/Archived read from overwriting a newer one.

Umbrella design `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R5, S5b-R10; §8).
The API spec is `.nax/features/fleet-s5b-koda-actions/spec.md`.

## Motivation

After #295 an approved, rejected or expired action leaves a `system` note, but nothing hands that note to the agent.
`deliveredAt` exists on `PendingAction` (`apps/api/src/fleet/assistant/actions/pending-action.domain.ts:39`) and
nothing writes it. S5b-R10 says outcomes reach the agent through the next user message.

The web cannot act on the new approvals either:

- `APPROVAL_TYPES` and `APPROVAL_DECISIONS` in `apps/web/lib/fleet-types.ts:456-460` do not know `assistant_action`,
  `approve` or `reject`.
- `approvalSummary` (`apps/web/lib/fleet-approvals.ts:330`) labels every unknown type as a budget override.
- `canDecide` (`fleet-approvals.ts:132-135`) would let any DEVELOPER decide, while the API lets only the requester
  decide (2a-R2), so the buttons would answer 403.
- `keyboardDecision` (`fleet-approvals.ts:171-183`) would send `keep_paused` for the D key.
- The web `ThreadDetailDto` (`apps/web/lib/thread-types.ts:122-125`) has no `pendingActions`, so the thread page cannot
  show what waits for a decision.
- `ThreadMessage.vue:25` renders a `system` note exactly like a user message.

The two features deploy together (2a-1 spec, Out of Scope): until this ships, the inbox shows `assistant_action` rows
under the budget label.

koda#294: `useThreads(slug).load()` (`apps/web/composables/useThreads.ts:26-34`) has no guard against overlapping
reads, so on a fast Active/Archived switch the read that answers last wins. #293 fixed the same race on the personal
list (`useWorkspaceThreads.ts`, `pages/threads/index.vue`).

## Design

### Rulings that bind every story

From the umbrella design and the API feature:

- **S5b-R5.** No write runs without a human approving the exact preview.
- **S5b-R10.** Outcomes reach the agent through the next user message; no server-to-session command.
- **2a-R2.** Only the action's requester (the thread creator) may approve or reject, on either inbox prefix.
- **2a-R3.** koda#294 rides in S5b-2a.
- **2a-R4.** This is the second of the two S5b-2a features.

User rulings for this feature, 2026-10-17:

- **2aw-R1 decide UI.** The requester can decide on the thread card and in the inbox panel. The inbox panel loads the
  preview from the thread detail before Approve is enabled (S5b-R5).
- **2aw-R2 delivery at hand-off.** An action is delivered in the `sendMessage` transaction that hands its note to the
  runner path. `deliveredAt` and `deliveredMessageId` are set there. A requeued new-turn job rebuilds the same text from
  `deliveredMessageId`. A live session that dies before reading its `THREAD_INPUT` does not get the note again; the
  note stays in the transcript and `koda_get_action` still answers.

Drafting calls (spec author, 2026-10-17):

- **2aw-D1 delivery column.** `PendingAction` gains `deliveredMessageId String?`, `@@index([threadId, deliveredAt])` and
  `@@index([deliveredMessageId])` (`api-data.md`: every filtered field is indexed). Migration `apps/api/prisma/migrations/20261024090000_pending_action_delivery/migration.sql`. No relation to
  `ChatMessage`: the column is an id only, like `approvalId`.
- **2aw-D2 delivery text.** A pure module `apps/api/src/fleet/assistant/actions/outcome-delivery.ts` exports:

  ```ts
  export const DELIVERY_HEADER = 'Updates on actions you proposed:';
  export const MAX_DELIVERED_NOTES = 20;
  export const DELIVERABLE_STATUSES = ['EXECUTED', 'FAILED', 'REJECTED', 'EXPIRED'] as const;

  /**
   * The text the agent receives: the header, one note per line block, a blank line, then the user's text.
   * Notes are taken in the given order while the whole text stays within `maxBytes` UTF-8 bytes; the first note
   * that does not fit stops the list. No note fits, or none given: the user's text unchanged, delivered 0.
   */
  export function deliveryText(notes: readonly string[], userText: string, maxBytes: number): { text: string; delivered: number } {
    const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= maxBytes;
    let delivered = 0;
    let text = userText;
    for (const [i] of notes.entries()) {
      const candidate = `${DELIVERY_HEADER}\n${notes.slice(0, i + 1).join('\n')}\n\n${userText}`;
      if (!fits(candidate)) break;
      delivered = i + 1;
      text = candidate;
    }
    return { text, delivered };
  }
  ```

  The notes are `outcomeNote(action)` (`outcome-note.ts`), rebuilt from the action, never read back from the `system`
  messages. `maxBytes` is `THREAD_LIMITS.messageMaxBytes` (32,768, `apps/api/src/fleet/common/thread-jobs.ts:24`), the
  bound the runner enforces on both `THREAD_INPUT` text and `initialMessage.text`.
- **2aw-D3 hand-off in `sendMessage`.** In `PrismaChatThreadRepository.sendMessage`, after the user `chatMessage` is
  created and before the live / new-turn branch, still inside the same transaction and after the thread
  `FOR UPDATE` lock:
  1. Read the thread's actions with `status` in `DELIVERABLE_STATUSES` and `deliveredAt` null, ordered by `createdAt`
     then `id`, at most `MAX_DELIVERED_NOTES`.
  2. Call `deliveryText(notes, input.text, THREAD_LIMITS.messageMaxBytes)`.
  3. Set `deliveredAt = now` and `deliveredMessageId = message.id` on the first `delivered` of them, in one update.
  4. Live branch: the `THREAD_INPUT` payload is `{ messageId, text }` with the delivery text. New-turn branch:
     `createThreadJob` is unchanged.

  The stored user message keeps `content: input.text`. A duplicate `clientMessageId` and a refused send return or
  throw before step 1, so they deliver nothing.
- **2aw-D4 new-turn assign.** `PrismaFleetJobRepository.findThreadAssign` builds `initialMessage.text` as
  `deliveryText(notes, message.content, THREAD_LIMITS.messageMaxBytes).text`, where `notes` are the `outcomeNote`s of
  the actions whose `deliveredMessageId` is the initial message's id, ordered by `createdAt` then `id`. It writes
  nothing, so every assign of the same job answers the same text. When the turn has no `initialMessageId`, it reads
  no actions at all and `initialMessage` stays null.
- **2aw-D5 web types.** `APPROVAL_TYPES` gains `assistant_action`, and `APPROVAL_DECISIONS` gains `approve` and `reject`.
  `ThreadDetailDto` gains `pendingActions: PendingActionDto[]`, where
  `PendingActionDto = { id, approvalId, tool, preview, projectSlug, expiresAt, createdAt }`, all strings except
  `approvalId: string | null` (null while propose links it, `thread.dto.ts:44`). That mirrors the
  API (`apps/api/src/fleet/threads/dto/thread.dto.ts:42-55`).
- **2aw-D6 web permission.** `ApprovalViewer` gains `userId: string | null` on both kinds.
  - The project and admin approvals pages fill it from `useAuth().user.value?.id ?? null`.
  - `useApprovalNotifications` fills it, on both the admin viewer (line 134) and the project viewer (line 143), from
    the `userId` it already reads.
  - `canDecide` takes `Pick<FleetApprovalDto, 'type' | 'status' | 'payload'>` (every caller already passes a full row)
    and answers, for `assistant_action`: `status === 'pending'` and `viewer.userId !== null` and the payload's
    `requestedById === viewer.userId`, on both viewer kinds. Every other type keeps today's rule.
  - `keyboardDecision` for an `assistant_action` the viewer can decide answers `approve: null`, `deny: { decision:
    'reject' }`. The A key never approves an action, because the preview may not be on screen.
- **2aw-D7 action payload.** `assistantPayload(a)` in `fleet-approvals.ts` answers
  `{ actionId, tool, threadId, threadPath, requestedById }` when the approval is `assistant_action` and every field is a
  string, else null. `toActionBody(decision: 'approve' | 'reject', comment: string)` answers `{ decision }` plus the
  trimmed comment when it is not empty (`commentField`).
- **2aw-D8 web labels.** Every key below is added by US-003, in `apps/web/i18n/locales/en.json` and `zh.json`; later stories only use them.
  - `approvalSummary` for `assistant_action` answers `t('fleet.approvals.summary.assistant', { tool })`, or
    `t('fleet.approvals.type.assistant_action')` when the payload does not parse.
  - New keys in both locales:
    - `fleet.approvals.type.assistant_action`
    - `fleet.approvals.decision.approve`, `.reject`
    - `fleet.approvals.toast.approve`, `.reject`
    - `fleet.approvals.summary.assistant` (`{tool}`)
    - `fleet.approvals.assistant.*`: panel strings `openThread`, `requesterOnly`, `previewLoading`, `previewGone`,
      `previewFailed`, `approve`, `reject`, `expiresIn` (`{time}`)
    - `notifications.kinds.action_requested` (`{tool}`)
    - `fleet.threads.action.*`: card strings `title` (`{tool}`), `expiresIn` (`{time}`), `approve`, `reject`,
      `awaiting`, `decideFailed`
    - `fleet.threads.message.system`
  - No new `fleet.*` string contains `|` or `@`; `fleet-locale-parity.spec.ts` refuses both.
  - US-003 owns both locale files for this feature, because `nax plan` keeps one Modifies entry per path.
- **2aw-D9 inbox panel.** `components/fleet/ApprovalActionPanel.vue`, with props `{ approval, canDecide, busy, now }`
  and the emit `decide(DecideApprovalBody)`.
  - It always shows the tool, the countdown (`secondsLeft` / `countdownText`) and an "open thread" link to
    `threadPath`.
  - When `canDecide` is false it shows `requesterOnly` and fetches nothing.
  - When `canDecide` is true it calls `useActionPreview().load(threadPath, actionId)`. Approve is disabled until that
    answers a preview. Reject is enabled whenever `canDecide` holds and `busy` is false.
  - The answer `null` (the action is no longer pending) shows `previewGone`, with Approve disabled. A failed load shows
    `previewFailed`, with Approve disabled.
  - The preview renders through `{{ }}` interpolation in a `whitespace-pre-wrap` block, never `v-html`.

  `ApprovalInbox.vue` renders it for a pending `assistant_action`, before the outcome fallback, with
  `:can-decide="canDecide(detail, viewer)"`.
- **2aw-D10 preview source.** `composables/useActionPreview.ts` exports `useActionPreview()` with
  `load(threadPath: string, actionId: string): Promise<string | null>`.
  - `threadApiPath(threadPath)` in `lib/fleet-approvals.ts` maps `/threads/<id>` to `/threads/<id>`, and
    `/<slug>/threads/<id>` to `/projects/<slug>/threads/<id>`. It answers null for any other shape.
  - `load` GETs that path through `useApi()` and answers the `preview` of the `pendingActions` entry whose `id` is
    `actionId`, or null when there is none. It throws when `threadApiPath` answers null or the request fails.
- **2aw-D11 thread card.** `components/fleet/threads/ThreadActionCard.vue`, with props
  `{ action: PendingActionDto, canDecide: boolean, now: Date }`.
  - It shows `title`, the preview (interpolation only, `whitespace-pre-wrap`) and `expiresIn`.
  - When `canDecide` holds and `approvalId` is not null it shows Approve and Reject. Otherwise it shows `awaiting`.
  - A click calls `useFleetApprovals({ kind: 'project', slug: action.projectSlug }).decide(action.approvalId,
    toActionBody(decision, ''))`. Both buttons are disabled while that runs.
  - On success the card hides itself (the thread's live `thread` frame then reloads `pendingActions`). On failure it
    toasts `extractApiError(err)` and re-enables the buttons.

  `ThreadTimeline.vue` renders one card per `thread.pendingActions` entry, below the question card and above the
  entries, with `:can-decide="isCreator"` and `:now` from `useApprovalCountdown().now`
  (`composables/useApprovalCountdown.ts:33`). Both thread pages already pass `is-creator`. A `pendingActions` that is
  absent renders no card.
- **2aw-D12 system notes.** `ThreadMessage.vue` renders `role === 'system'` as a separate row:
  - `data-testid="thread-system-note"`;
  - muted styling (`text-muted-foreground`, `bg-muted`);
  - a label `t('fleet.threads.message.system')`, then the content through `{{ }}`.

  The note text stays English, as stored (2a-D9).
- **2aw-D13 #294.** Mirror `useWorkspaceThreads.ts` (`generation`, lines 58 and 74-78) and `pages/threads/index.vue`
  (`pageLoad` token):
  - `useThreads(slug).load(status)` keeps a generation counter and resolves `Promise<boolean>`: true when it applied,
    false when a newer `load` overtook it (it then writes nothing). `ThreadList.load` says so too.
  - `pages/[project]/threads/index.vue` `loadPage` keeps a page token. Only the newest call writes `pending` and
    `loadFailed`. It returns the `load` result from its `Promise.all` with `members.load()`.
  - `selectStatus` replaces the URL only when that result is true.
  - An overtaken read that rejects still rejects, as in `useWorkspaceThreads`; the page token keeps it from writing.

### Integration

Read-only symbols (verified):

- `outcomeNote(action)` and `NOTE_RESULT_MAX` (`apps/api/src/fleet/assistant/actions/outcome-note.ts`).
- `THREAD_LIMITS.messageMaxBytes` (`apps/api/src/fleet/common/thread-jobs.ts:24`).
- `PrismaChatThreadRepository.pendingActions(scope, threadId)` (`prisma-chat-thread.repository.ts:113`).
- `useFleetApprovals(base).decide(id, body)` (`apps/web/composables/useFleetApprovals.ts:43`).
- `secondsLeft`, `countdownText`, `commentField` (`apps/web/lib/fleet-approvals.ts`).
- `ApprovalBashPanel.vue`, the pattern for the new panel.
- `ThreadQuestionCard.vue`, the pattern for the new card.
- `useWorkspaceThreads.ts` and `pages/threads/index.vue`, the #294 pattern.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- **`PrismaChatThreadRepository.sendMessage`** (`prisma-chat-thread.repository.ts:312`).
  - Baseline: the `THREAD_INPUT` payload text is `input.text`.
  - Target: 2aw-D3.
- **`PrismaFleetJobRepository.findThreadAssign`** (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:226`).
  - Baseline: `initialMessage.text` is `message.content`.
  - Target: 2aw-D4.
- **`PendingAction`** (`apps/api/prisma/schema.prisma`). Target: 2aw-D1.
- **`PendingActionRecord`** (`pending-action.domain.ts`). Target: gains the optional `deliveredMessageId?: string | null`
  (optional, so the existing spec literals without it still type-check), mapped by `prisma-pending-action.repository.ts`.
- **`APPROVAL_TYPES`, `APPROVAL_DECISIONS`** (`apps/web/lib/fleet-types.ts:456-460`). Target: 2aw-D5.
- **`ApprovalViewer`, `canDecide`, `keyboardDecision`, `approvalSummary`** (`apps/web/lib/fleet-approvals.ts`). Target:
  2aw-D6, 2aw-D8.
- **`ThreadDetailDto`** (`apps/web/lib/thread-types.ts:122`). Target: 2aw-D5.
- **`ThreadMessage.vue`, `ThreadTimeline.vue`, `ApprovalInbox.vue`.** Target: 2aw-D12, 2aw-D11, 2aw-D9.
- Additive source edits with no Modifies entry (Modifies is kept to tests and shared contracts, under the 25-path
  cap): `pages/[project]/fleet/approvals.vue`, `pages/admin/fleet/approvals.vue` and `useApprovalNotifications.ts`
  (US-003, 2aw-D6); `thread-types.ts` and `ThreadTimeline.vue` (US-005); `ThreadMessage.vue` (US-006).
- **`useThreads.load`** (`apps/web/composables/useThreads.ts:26`).
  - Baseline: `Promise<void>`.
  - Target: 2aw-D13.

### Failure Handling

| Case | Behaviour |
|---|---|
| The notes plus the user's text exceed 32,768 bytes | The notes that fit go; the rest stay undelivered for the next message (2aw-D2) |
| More than 20 undelivered actions | The 20 oldest are considered; the rest wait (2aw-D3) |
| Duplicate `clientMessageId`, or a refused send | Nothing is delivered (2aw-D3) |
| A new-turn job is assigned again after a requeue | The same text, rebuilt from `deliveredMessageId` (2aw-D4) |
| Inbox preview: the action is no longer pending | `previewGone`; Approve disabled (2aw-D9) |
| Inbox preview: the thread read fails, or `threadPath` does not parse | `previewFailed`; Approve disabled (2aw-D9, 2aw-D10) |
| Thread card decide fails (403, 409) | Toast `extractApiError`; buttons re-enabled; the card stays (2aw-D11) |
| An overtaken thread-list read answers or fails | It writes nothing: no list, no status, no URL, no error state (2aw-D13) |

## Out of Scope

- Changes to the runner, the fleet protocol or `FLEET_PROTOCOL_VERSION`; the delivery text rides the existing `THREAD_INPUT` text and `initialMessage.text` fields.
- Re-sending an outcome note when a live session ends before it reads the `THREAD_INPUT` that carried it (2aw-R2); the note stays in the transcript and `koda_get_action` answers.
- Delivering outcome notes on `THREAD_ANSWER` (an answer to a pending question); only a user message delivers them.
- Showing whether an outcome note was delivered, anywhere in the web.
- Translating outcome note texts or the delivery header; they stay English (2a-D9).
- Editing a proposed action's input before deciding, and deciding several actions in one request.
- Approving from the keyboard: the inbox A key never approves an `assistant_action` (2aw-D6).
- Desktop approval notifications for a requester whose project role is VIEWER: `useApprovalNotifications` keeps scanning only projects where the viewer can manage or work; the notification bell still shows `action_requested`.
- A decide control for `assistant_action` on the home dashboard (`HomeNeedsYou.vue`); it keeps the label and its link.
- Filtering `assistant_action` rows out of the approval badge counts or the home dashboard's pending list.
- Translating the API `actionRequestedDraft` title; the web shows `notifications.kinds.action_requested` and falls back to that English title only for an unknown kind.
- Playwright journeys for the action card and the inbox panel; the live check on koda-wk covers the end-to-end path.
- Any API change beyond outcome delivery: approvals, decide, the sweeper, the notification subscriber and the thread detail DTO are unchanged.
- The job page's approvals list (`components/fleet/JobApprovals.vue`) keeps its bash summary fallback for an `assistant_action` row; the inbox and the thread card are where an action is read and decided.
- Hiding the Approve and Reject buttons once an action's countdown reaches 0; the API answers 409 for an expired action and the card or panel shows that error.
- US-002 only: marking the notes and creating the new-turn job share one transaction, so a failure rolls back both; no AC forces a mid-transaction failure.
- US-002 only: two `sendMessage` calls on the same thread are serialised by the thread row lock; no AC drives them concurrently.
- US-004 only: a decide racing the action's expiry answers the API's 409, shown as the existing decide error; no AC drives the race.

## Stories

- **US-001 Delivery text, column and new-turn assign** (`Workdir: apps/api`). No dependencies. 2aw-D1, 2aw-D2,
  2aw-D4: the migration, the record field, `deliveryText`, and `findThreadAssign` rebuilding the text from
  `deliveredMessageId`.
- **US-002 Hand-off in `sendMessage`** (`Workdir: apps/api`). Depends on US-001. 2aw-D3: select, mark and send.
- **US-003 `assistant_action` in the web approvals model** (`Workdir: apps/web`). No dependencies. 2aw-D5 (approval
  types and decisions), 2aw-D6, 2aw-D7, `threadApiPath` from 2aw-D10, and the approvals keys of 2aw-D8.
- **US-004 Inbox action panel** (`Workdir: apps/web`). Depends on US-003. 2aw-D9, `useActionPreview` from 2aw-D10.
- **US-005 Thread action cards** (`Workdir: apps/web`). Depends on US-003. 2aw-D5 (`ThreadDetailDto`), 2aw-D11.
- **US-006 System notes and the action notification text** (`Workdir: apps/web`). Depends on US-003. 2aw-D12 and the
  `notifications.kinds.action_requested` key.
- **US-007 Project thread list race (#294)** (`Workdir: apps/web`). No dependencies. 2aw-D13.

### Context Files

**US-001**
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign` at 226
- `apps/api/src/fleet/assistant/actions/outcome-note.ts` — `outcomeNote`, the note text
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.find-thread-assign.spec.ts` — stubs with no `pendingAction` delegate and `initialMessageId: null`
- `apps/api/test/integration/fleet/assistant-actions-decide.integration.spec.ts` — how terminal actions are seeded

**US-002**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `sendMessage` at 312, `sendRefusalFor` (a `pending` message refuses the next send)
- `apps/api/src/fleet/assistant/actions/outcome-delivery.ts` — created by US-001, called here
- `apps/api/test/integration/fleet/assistant-action-delivery.integration.spec.ts` — created by US-001; its seeding helpers are the pattern for this story's own spec

**US-003**
- `apps/web/composables/useApprovalNotifications.ts` — the viewers it builds at 140 and 144
- `apps/web/pages/[project]/fleet/approvals.vue` — the project viewer
- `apps/web/pages/admin/fleet/approvals.vue` — the admin viewer
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the closed key lists at 49, 53 and 60

**US-004**
- `apps/web/components/fleet/ApprovalBashPanel.vue` — the panel pattern
- `apps/web/composables/useFleetApprovals.ts` — `decide` at 43
- `apps/web/lib/fleet-approvals.ts` — `assistantPayload`, `canDecide`, `threadApiPath`, extended by US-003

**US-005**
- `apps/web/components/fleet/threads/ThreadQuestionCard.vue` — the card pattern
- `apps/web/composables/useFleetApprovals.ts` — `decide` at 43
- `apps/web/lib/fleet-approvals.ts` — `toActionBody`, `secondsLeft`, `countdownText`; `toActionBody` is added by US-003

**US-006**
- `apps/web/lib/notifications.ts` — `notificationText`
- `apps/web/tests/i18n/notifications-fleet-kinds-locale-parity.spec.ts` — the `FLEET_KINDS` map

**US-007**
- `apps/web/composables/useWorkspaceThreads.ts` — the generation counter to mirror
- `apps/web/pages/threads/index.vue` — the page token to mirror
- `apps/web/tests/composables/useWorkspaceThreads.spec.ts` — the overtaken-read test at 170
- `apps/web/tests/pages/workspace-threads-page.spec.ts` — the overtaken page tests at 170 and 188

### Creates

**US-001**
- `apps/api/src/fleet/assistant/actions/outcome-delivery.ts`
- `apps/api/src/fleet/assistant/actions/outcome-delivery.spec.ts`
- `apps/api/prisma/migrations/20261024090000_pending_action_delivery/migration.sql`
- `apps/api/test/integration/fleet/assistant-action-delivery.integration.spec.ts`

**US-002**
- `apps/api/test/integration/fleet/assistant-action-send-delivery.integration.spec.ts`

**US-004**
- `apps/web/components/fleet/ApprovalActionPanel.vue`
- `apps/web/composables/useActionPreview.ts`
- `apps/web/tests/components/fleet-approval-action-panel.spec.ts`
- `apps/web/tests/composables/useActionPreview.spec.ts`

**US-005**
- `apps/web/components/fleet/threads/ThreadActionCard.vue`
- `apps/web/tests/components/thread-action-card.spec.ts`

**US-006**
- `apps/web/tests/components/thread-system-note.spec.ts`

### Modifies

**US-001**
- `apps/api/prisma/schema.prisma` — `PendingAction` gains `deliveredMessageId String?`, `@@index([threadId, deliveredAt])` and `@@index([deliveredMessageId])` (2aw-D1); no other model changes.
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — `PendingActionRecord` gains the optional `deliveredMessageId?: string | null`; the existing `deliveredAt` stays.
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — the record mapper reads and writes `deliveredMessageId` (2aw-D1).
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadAssign` builds `initialMessage.text` from the actions delivered on the initial message, and reads none when there is no initial message (2aw-D4).
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.find-thread-assign.spec.ts` — gains AC-10's case (a turn with `initialMessageId` null on a stub with no `pendingAction` delegate); the existing cases keep their stubs and expectations.

**US-002**
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — `sendMessage` selects, marks and sends the undelivered notes under the thread lock (2aw-D3).
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.spec.ts` — the `sendRepo` fake's `client` gains `pendingAction: { findMany: async () => [], updateMany: async () => ({ count: 0 }) }` so the five existing `sendMessage` tests keep passing with their current expectations.

**US-003**
- `apps/web/lib/fleet-types.ts` — `APPROVAL_TYPES` gains `assistant_action`; `APPROVAL_DECISIONS` gains `approve` and `reject` (2aw-D5).
- `apps/web/lib/fleet-approvals.ts` — `ApprovalViewer.userId`, the `canDecide` signature and `assistant_action` rule, `keyboardDecision`, `assistantPayload`, `toActionBody`, `threadApiPath` and the `approvalSummary` branch (2aw-D6..D8, D10).
- `apps/web/tests/lib/fleet-approvals.spec.ts` — existing viewer literals gain `userId: null` so they type-check; the expectations for the two existing types are unchanged.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the closed lists at 49 (`fleet.approvals.type`), 53 (`decision`) and 60 (`toast`) gain `assistant_action`, `approve` / `reject`, and `approve` / `reject`; the invariant stays "every listed key exists in both locales".
- `apps/web/i18n/locales/en.json` — every 2aw-D8 key for this feature: the approvals type, decision, toast, summary and `fleet.approvals.assistant.*` keys, `fleet.threads.action.*`, `fleet.threads.message.system` and `notifications.kinds.action_requested`.
- `apps/web/i18n/locales/zh.json` — the same 2aw-D8 keys as the English locale file, in Chinese, with the same parameters.

**US-004**
- `apps/web/components/fleet/ApprovalInbox.vue` — renders `ApprovalActionPanel` for a pending `assistant_action` (2aw-D9).
- `apps/web/tests/components/fleet-approval-inbox.spec.ts` — `fleetComponents` (line 61) registers `FleetApprovalActionPanel`, and viewer literals gain `userId`; the existing bash and budget cases keep their expectations.
- `apps/web/tests/helpers/mount-sfc.ts` — `FleetComponentName` and `FLEET_COMPONENT_FILES` (lines 273-295) gain `FleetApprovalActionPanel: 'ApprovalActionPanel.vue'`, so the inbox spec can mount the real panel.

**US-005**
- `apps/web/tests/components/thread-timeline.spec.ts` — `mountTimeline` registers `ThreadActionCard` and stubs `useApprovalCountdown`; existing expectations unchanged.

**US-006**
- `apps/web/tests/i18n/notifications-fleet-kinds-locale-parity.spec.ts` — `FLEET_KINDS` gains `action_requested: ['tool']`.
- `apps/web/tests/lib/notifications.spec.ts` — gains the `action_requested` cases (AC-6, AC-7); existing cases unchanged.

**US-007**
- `apps/web/composables/useThreads.ts` — `load` resolves `boolean` behind a generation counter (2aw-D13).
- `apps/web/pages/[project]/threads/index.vue` — `loadPage` page token; `selectStatus` replaces the URL only on an applied read (2aw-D13).
- `apps/web/tests/composables/useThreads.spec.ts` — gains the overtaken-read cases; the two existing tests keep their expectations.
- `apps/web/tests/pages/threads-page.spec.ts` — its `useThreads` stub's `load` resolves `true`; gains the out-of-order page cases.

### Seams

- US-001 -> US-002: `deliveryText` is called by `sendMessage`; pinned by US-002 AC-1 through `sendMessage`. `findThreadAssign` reads what `sendMessage` marks; pinned by US-002 AC-13.
- US-003 -> US-004: `canDecide` and `toActionBody` for `assistant_action` are consumed by the inbox; pinned by US-004 AC-1, AC-2 and AC-11 through `ApprovalInbox`.
- US-003 -> US-005: `toActionBody` is consumed by the thread card; pinned by US-005 AC-7.

## Acceptance Criteria

### US-001: Delivery text, column and new-turn assign (`Workdir: apps/api`)

1. [unit] `deliveryText([], 'hello', 32768)` returns `{ text: 'hello', delivered: 0 }`.
2. [unit] `deliveryText(['note A', 'note B'], 'hello', 32768).text` equals `Updates on actions you proposed:\nnote A\nnote B\n\nhello`.
3. [unit] `deliveryText(['note A', 'note B'], 'hello', 32768).delivered` equals 2.
4. [unit] `deliveryText` with three notes and a `maxBytes` equal to the byte length of `Updates on actions you proposed:\n<first note>\n\nhello` returns `delivered` 1.
5. [unit] In that case its `text` equals `Updates on actions you proposed:\n<first note>\n\nhello`.
6. [unit] `deliveryText` counts UTF-8 bytes, not characters: for a note of 4-byte characters whose character count fits `maxBytes` but whose byte count does not, it returns `delivered` 0.
7. [integration] For a SESSION job whose turn's initial message `m1` has content `go`, with two actions whose `deliveredMessageId` is `m1` and whose `createdAt` are `t1 < t2`, `PrismaFleetJobRepository.findThreadAssign(jobId).initialMessage.text` equals `Updates on actions you proposed:\n<note of the t1 action>\n<note of the t2 action>\n\ngo`.
8. [integration] For a job whose initial message has no action delivered on it, `findThreadAssign` returns `initialMessage.text` equal to the message content, even when the thread has an action delivered on another message.
9. [integration] Two calls of `findThreadAssign` for the same job return the same `initialMessage.text`.
10. [unit] `findThreadAssign` for a turn with `initialMessageId` null, on a client stub with no `pendingAction` delegate, returns `initialMessage` null without throwing.
11. [integration] `PrismaPendingActionRepository.findById` returns `deliveredMessageId` equal to the value stored on the row.

### US-002: Hand-off in `sendMessage` (`Workdir: apps/api`)

1. [integration] For a thread with a live RUNNING session and one EXECUTED action with `deliveredAt` null, `PrismaChatThreadRepository.sendMessage` with text `hello` creates a `THREAD_INPUT` command whose payload text equals `Updates on actions you proposed:\n<outcomeNote of that action>\n\nhello`.
2. [integration] After that send, the action's `deliveredAt` is not null.
3. [integration] After that send, the action's `deliveredMessageId` equals the new user message's id.
4. [integration] After that send, the stored user `ChatMessage` content equals `hello`.
5. [integration] After the first message's status is set to `complete`, a second `sendMessage` with text `again` creates a `THREAD_INPUT` command whose payload text equals `again`.
6. [integration] A PENDING action on the thread keeps `deliveredAt` null after `sendMessage`.
7. [integration] An APPROVED action on the thread keeps `deliveredAt` null after `sendMessage`.
8. [integration] A terminal undelivered action on a different thread keeps `deliveredAt` null after `sendMessage` on this thread.
9. [integration] With 21 terminal undelivered actions seeded with distinct, increasing `createdAt` values on a live thread, `sendMessage` leaves exactly 20 of them with `deliveredAt` set.
10. [integration] In that case the action with the latest `createdAt` keeps `deliveredAt` null.
11. [integration] With two terminal undelivered actions and a user text whose length the test computes with `deliveryText` so that only the first note fits within 32,768 bytes, `sendMessage` sets `deliveredAt` on the first action and leaves the second null.
12. [integration] A `sendMessage` repeated with the `clientMessageId` of an earlier send leaves a terminal action created between the two sends with `deliveredAt` null.
13. [integration] For a thread with no live session and one REJECTED undelivered action, after `sendMessage` with text `hi` creates the new-turn job, `findThreadAssign(jobId).initialMessage.text` equals `Updates on actions you proposed:\n<outcomeNote of that action>\n\nhi`.
14. [integration] In that new-turn case, the action's `deliveredMessageId` equals the new user message's id.

### US-003: `assistant_action` in the web approvals model (`Workdir: apps/web`)

1. [unit] `canDecide` for a pending `assistant_action` whose payload `requestedById` is `u1` returns true for a project viewer with `userId` `u1` and `canWork` false.
2. [unit] `canDecide` for that approval returns false for a project viewer with `userId` `u2`, `canManage` true and `canWork` true.
3. [unit] `canDecide` for that approval returns false for an admin viewer with `userId` `u2`.
4. [unit] `canDecide` for that approval returns true for an admin viewer with `userId` `u1`.
5. [unit] `canDecide` for that approval returns false for a viewer with `userId` null.
6. [unit] `canDecide` for an `assistant_action` with status `approved` returns false for its requester.
7. [unit] `keyboardDecision` for a pending `assistant_action` and its requester returns `{ approve: null, deny: { decision: 'reject' } }`.
8. [unit] `assistantPayload` returns `{ actionId, tool, threadId, threadPath, requestedById }` for an `assistant_action` whose payload has those five strings.
9. [unit] `assistantPayload` returns null for an `assistant_action` whose payload lacks `threadPath`.
10. [unit] `toActionBody('approve', '  ')` returns `{ decision: 'approve' }`.
11. [unit] `toActionBody('reject', ' no ')` returns `{ decision: 'reject', comment: 'no' }`.
12. [unit] `approvalSummary` for an `assistant_action` with tool `koda_add_comment` returns the `fleet.approvals.summary.assistant` text with `{ tool: 'koda_add_comment' }`, not the budget label.
13. [unit] `threadApiPath('/threads/t1')` returns `/threads/t1`.
14. [unit] `threadApiPath('/acme/threads/t1')` returns `/projects/acme/threads/t1`.
15. [unit] `threadApiPath('/acme/tickets/t1')` returns null.

### US-004: Inbox action panel (`Workdir: apps/web`)

1. [unit] Mounting `ApprovalInbox` on a project base with a pending `assistant_action` row whose `requestedById` is the viewer's `userId`, and expanding it, renders `ApprovalActionPanel` with an Approve button.
2. [unit] Mounting `ApprovalInbox` with the same row for a viewer whose `userId` is another user renders the panel with no Approve button.
3. [unit] `ApprovalActionPanel` with `canDecide` false never calls `useActionPreview().load`.
4. [unit] `ApprovalActionPanel` with `canDecide` true calls `load` with the payload's `threadPath` and `actionId`.
5. [unit] The panel renders the preview text that `load` answers.
6. [unit] While `load` has not answered, the panel's Approve button is disabled.
7. [unit] When `load` answers null, the panel shows the `fleet.approvals.assistant.previewGone` text.
8. [unit] When `load` rejects, the panel shows the `fleet.approvals.assistant.previewFailed` text.
9. [unit] When `load` rejects, the panel's Approve button stays disabled.
10. [unit] A preview containing `<b>x</b>` renders as that literal text, with no `b` element in the panel.
11. [unit] Clicking Approve after the preview loaded makes `ApprovalInbox` call `useFleetApprovals(base).decide` with the approval id and `{ decision: 'approve' }`.
12. [unit] Clicking Reject in the panel emits `decide` with `{ decision: 'reject' }`.
13. [unit] `useActionPreview().load('/acme/threads/t1', 'a2')` GETs `/projects/acme/threads/t1` through `useApi()`.
14. [unit] That call returns the `preview` of the `pendingActions` entry with id `a2`, and null when no entry has that id.
15. [unit] `useActionPreview().load('/acme/tickets/t1', 'a2')` rejects without making a request.

### US-005: Thread action cards (`Workdir: apps/web`)

1. [unit] Mounting `ThreadTimeline` with a thread whose `pendingActions` has two entries renders two `ThreadActionCard`s.
2. [unit] With `isCreator` true, each card renders an Approve button.
3. [unit] With `isCreator` true, each card renders a Reject button.
4. [unit] With `isCreator` false, each card shows the `fleet.threads.action.awaiting` text and no Approve button.
5. [unit] Mounting `ThreadTimeline` with a thread whose `pendingActions` is empty renders no `ThreadActionCard`.
6. [unit] A card for an action with `approvalId` null shows the `awaiting` text and no Approve button, even with `canDecide` true.
7. [unit] Clicking Approve on a card for an action with `approvalId` `ap1` and `projectSlug` `acme` calls `useFleetApprovals({ kind: 'project', slug: 'acme' }).decide` with `ap1` and `{ decision: 'approve' }`.
8. [unit] Clicking Reject on that card calls `decide` with `ap1` and `{ decision: 'reject' }`.
9. [unit] While `decide` has not answered, the card's Approve button is disabled.
10. [unit] After `decide` resolves, the card is no longer rendered.
11. [unit] When `decide` rejects, the card toasts the `extractApiError` text.
12. [unit] When `decide` rejects, the card stays rendered with its Approve button enabled.
13. [unit] A card's preview containing `<img src=x>` renders as literal text, with no `img` element in the card.
14. [unit] A card shows the `fleet.threads.action.expiresIn` text with `time` equal to `countdownText(secondsLeft(action.expiresAt, now))`.

### US-006: System notes and the action notification text (`Workdir: apps/web`)

1. [unit] `ThreadMessage` with `role` `system` renders a `thread-system-note` element.
2. [unit] That element contains the `fleet.threads.message.system` label.
3. [unit] That element contains the message content.
4. [unit] `ThreadMessage` with `role` `system` and content `<b>x</b>` renders the literal text, with no `b` element.
5. [unit] `ThreadMessage` with `role` `user` renders no `thread-system-note` element.
6. [unit] `notificationText` (`lib/notifications.ts`) for kind `action_requested` with params `{ tool: 'koda_add_comment' }` and title `API title` returns the `notifications.kinds.action_requested` text, not `API title`.
7. [unit] That returned text contains `koda_add_comment`.
8. [unit] The `zh` locale has a `notifications.kinds.action_requested` message that uses the `{tool}` parameter.

### US-007: Project thread list race (#294) (`Workdir: apps/web`)

1. [unit] `useThreads(slug).load('ARCHIVED')` then `load('ACTIVE')`, with the ACTIVE read answering first, leaves `status` `ACTIVE`.
2. [unit] In that order, `threads` holds the ACTIVE rows.
3. [unit] In that order, the overtaken ARCHIVED `load` resolves `false`.
4. [unit] In that order, the ACTIVE `load` resolves `true`.
5. [unit] An overtaken `load` that rejects after a newer one applied leaves the newer rows in `threads`.
6. [unit] On the project threads page, clicking Archived then Active, with the Active read answering first, leaves the Active toggle pressed.
7. [unit] In that page case, the URL query ends on Active.
8. [unit] On that page, a stale Archived read that rejects after the Active read applied shows no error state.
9. [unit] On that page, a stale read that answers first does not clear the loading state of the newer read.
