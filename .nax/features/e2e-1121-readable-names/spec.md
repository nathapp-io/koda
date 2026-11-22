# SPEC: Readable names for activity, timeline, fleet jobs and approval notifications from the 2026-11-21 A-Z e2e run

## Summary

This feature fixes the readable-names findings from the 2026-11-21 A-Z end-to-end run on koda-wk (`2579ca3d`):
- Dashboard "Recent activity" rows say almost nothing: "Ticket · Ticket created · sandbox · 56m ago", with no actor, no ticket and no link (F13).
- The project timeline shows a raw id for an actor that is neither a project member nor a roster agent (F11).
- Fleet thread-turn jobs use `thread-<cuid>` as their feature name (F11).
- Fleet jobs requested by an agent, or by someone who left, show "Unknown member" (F11).
- Approval notifications read "Approval needed: fleet.flow.start" with the raw permission key (F11).

The fixes:
- The API resolves names where only it can: a shared reader turns actor ids into display names and ticket ids into a ref and title.
  - Home activity rows and project timeline events carry `actorName`, `ticketRef` and `ticketTitle`.
  - Fleet jobs carry `requesterName` and `threadTitle` on the list and get routes.
- The web shows those names, with "Former member" for an actor or requester the API no longer knows. A dashboard or timeline row about a ticket links to it.
- A permission key with no locale label reads as words (`fleet.flow.start` reads "Fleet flow start") everywhere `requestKeyLabel` is used, and approval notifications use `requestKeyLabel` too.

The findings report is `projects/koda/e2e-2026-11-21/koda-wk-a-z-e2e-findings-2026-11-21.md` in the workspace repo.

## Motivation

- F13: `buildHomeView` in `apps/api/src/home/home.types.ts` maps each activity row to `{ id, eventType, projectSlug, action, actorId, ticketId, createdAt }`. `components/home/HomeActivityList.vue` renders only the event type, the humanized action and the project slug. The dashboard spans projects, while the web's name lookups (`useProjectMemberNames`, `useProjectAgentNames`) are per project, so the API has to send the names.
- F11 timeline: `pages/[project]/timeline.vue` resolves `actorName(actorId)` as member name, then roster agent name, then the raw id. Live koda-wk has 4 ticket events by `cmwq26qni000008lcfmhvhbg0`, which is now neither a `User` nor an `Agent` row (a deleted e2e user). The table has no ticket column at all.
- F11 fleet jobs: thread turns dispatch with `feature: thread-${thread.id}` (`apps/api/src/fleet/threads/prisma-chat-thread.repository.ts`). 65 of the live jobs are THREAD jobs. `FleetJob.threadId` already names the thread, but `FleetJobDto` carries neither the thread title nor a requester name. The jobs list and job detail print `people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember')`, where `people` is the project member list, so every agent-requested job (10 live) reads "Unknown member".
- F11 notifications: `approvalRequestDrafts` stores `params: { key }` with kind `approval_request`. `notificationText` in `apps/web/lib/notifications.ts` renders `notifications.kinds.approval_request` ("Approval needed: {key}") with the raw key. Toasts and the approval inbox already pass the key through `requestKeyLabel`, but only 2 of the 130 approvable keys have an `approvals.keys.*` label, and `requestKeyLabel` falls back to the raw key.

## Design

### Integration

Symbols this feature only reads:

- `PrismaClient` from `apps/api/src/generated/prisma/client`. Client-taking helpers type their argument as a `Pick` of it, as `type RawQueryClient = Pick<PrismaClient, '$queryRaw'>` does in `apps/api/src/common/utils/advisory-lock.ts`.
- Prisma models: `User { id, email, name: String? }`, `Agent { id, name: String, deletedAt }` (a soft-deleted agent keeps its name), `Ticket { id, projectId, number, title, deletedAt, project: Project }`, `Project { key }`, `ChatThread { id, title: String }`, `FleetJob { requestedById, requestedByType ('USER' | 'AGENT'), threadId: String? }` (`onDelete: SetNull` on the thread).
- `TicketNotificationReadsRepository.actorName` in `apps/api/src/notifications/ticket-notification-reads.repository.ts` is the display-name precedent this feature mirrors: a user's trimmed `name`, else the local part of their email, and an agent's `name`. It never shows an email address.
- `PrismaHomeRepository.findRecentActivity(projectIds, takePerTable)` in `apps/api/src/home/prisma-home.repository.ts` reads at most `HOME_LIMITS.activityScan` (25) rows from each of `ticketEvent`, `agentEvent` and `decisionEvent`. `HomeService.snapshot` passes the result to `buildHomeView`.
- `FleetJobsService.list` and `FleetJobsService.get` in `apps/api/src/fleet/jobs/fleet-jobs.service.ts`. `list` builds rows with `FleetJobDto.summary(r, pending)`. `get` builds the row through `withDetail` -> `withPending` -> `FleetJobDto.from`.
- `humanizeCode(code)` in `apps/web/lib/humanize-code.ts`: `fleet.flow.start` -> `Fleet flow start`.
- `useProjectMemberNames(slug).nameOf` and `useProjectAgentNames(slug).nameOf` (web composables): `string | null`.
- `tests/helpers/mount-sfc.ts` (`mountSfc`, `webFile`) and `tests/helpers/fleet-harness.ts` (`uiStubs`, `enI18n`). `NuxtLink` is stubbed by `uiStubs`.

Symbols this feature changes. The baseline only locates the code and is never the interface to implement:

- New `apps/api/src/common/utils/event-labels.ts`. It takes the Prisma client as an argument and imports only the `PrismaClient` type, as `common/utils/advisory-lock.ts` does; it is called only from `*.repository.ts` files (`prisma-home.repository.ts`, `prisma-timeline.repository.ts`, `prisma-fleet-job-labels.repository.ts`), so Prisma access stays in the repository layer:

  ```ts
  import type { PrismaClient } from '../../generated/prisma/client';

  export type EventLabelClient = Pick<PrismaClient, 'user' | 'agent' | 'ticket'>;

  export interface TicketLabel { ref: string; title: string }

  /** Display names by principal id: a user's trimmed name, else the email local part; an agent's name. Never an email. */
  export async function readPrincipalNames(client: EventLabelClient, ids: readonly string[]): Promise<Map<string, string>>;

  /** `KEY-N` ref and title by ticket id. Soft-deleted tickets are included: an event about a deleted ticket still names it. */
  export async function readTicketLabels(client: EventLabelClient, ids: readonly string[]): Promise<Map<string, TicketLabel>>;
  ```

  - Both functions drop duplicate and empty-string ids, and make no query when nothing is left.
  - `readPrincipalNames` issues one `user.findMany({ where: { id: { in: ids } }, select: { id, name, email } })` and one `agent.findMany({ where: { id: { in: ids } }, select: { id, name } })`. An id found in neither table is absent from the map.
  - `readTicketLabels` issues one `ticket.findMany({ where: { id: { in: ids } }, select: { id, number, title, project: { select: { key: true } } } })`. The ref is `${project.key}-${number}`.
- `HomeActivityRow` in `apps/api/src/home/home.types.ts`.
  - Baseline: `{ id, projectId, eventType, action, actorId, ticketId, createdAt }`.
  - Target: it also has `actorName: string | null`, `ticketRef: string | null` and `ticketTitle: string | null`.
- `PrismaHomeRepository.findRecentActivity`. Target: after the three reads, it calls `readPrincipalNames` once with every row's `actorId` and `readTicketLabels` once with every non-null `ticketId`, passing `this.prisma.client`, and sets the three fields on every row. A row whose actor or ticket is not in the map gets `null`.
- `HomeActivityView` (same file) and `HomeActivityDto` (`apps/api/src/home/dto/home-dashboard.dto.ts`).
  - Target: both also have `actorName: string | null`, `ticketRef: string | null` and `ticketTitle: string | null`, and `buildHomeView` copies them from the row. The DTO declares each with `@ApiProperty(NULLABLE_STRING)` and a description: `actorName` 'Display name of the actor; null when the user or agent no longer exists', `ticketRef` 'Project key + number of the ticket the event is about', `ticketTitle` 'Title of that ticket'.
- `TimelineEvent` in `apps/api/src/memory/timeline.service.ts`.
  - Baseline: `{ id, eventType, actorId, action, ticketId?, createdAt }`.
  - Target: it also has `actorName: string | null`, `ticketRef: string | null` and `ticketTitle: string | null`.
- `PrismaTimelineRepository` (`apps/api/src/memory/prisma-timeline.repository.ts`). Target: a new method `findEventLabels(actorIds: readonly string[], ticketIds: readonly string[]): Promise<{ names: Map<string, string>; tickets: Map<string, TicketLabel> }>` that calls `readPrincipalNames` and `readTicketLabels` with `this.prisma.client`.
- `TimelineService.getProjectTimeline`. Target: each table's rows are mapped with the three fields set to `null`, as today's mapping plus those keys. After the merged page is sliced to `limit`, it calls `findEventLabels` exactly once with the page's actor ids and ticket ids, and returns each event with the three fields filled from the maps (`null` when absent). It is called even for an empty page with two empty arrays (the helpers then make no query).
- `TimelineService.getTicketHistory`. Target: it sets the three new fields to `null` on every event, because `TimelineEvent` now requires them. It makes no label read; its other behaviour is unchanged.
- `FleetJobDto` in `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`.
  - Baseline: no requester name or thread title fields.
  - Target: it also has `requesterName: string | null` and `threadTitle: string | null` (both `@ApiPropertyOptional({ type: String, nullable: true })`, described 'Display name of the requester; null when the user or agent no longer exists' and 'Title of the thread the job was dispatched from; null when the job has no thread or the thread was deleted'). `FleetJobDto.from` sets both to `null`.
- New `apps/api/src/fleet/jobs/prisma-fleet-job-labels.repository.ts` (a repository file, since `.nax/rules/api-data.md` confines Prisma access to `*.repository.ts`):

  ```ts
  @Injectable()
  export class PrismaFleetJobLabelsRepository {
    constructor(private readonly prisma: PrismaService<PrismaClient>) {}

    /** Requester names by principal id and thread titles by thread id, for one page of jobs. */
    async read(jobs: ReadonlyArray<{ requestedById: string; threadId: string | null }>): Promise<{ names: Map<string, string>; threads: Map<string, string> }>;
  }
  ```

  It calls `readPrincipalNames` once with the jobs' requester ids, and issues one `chatThread.findMany({ where: { id: { in: threadIds } }, select: { id, title } })` with the non-null thread ids (no query when there are none). It is registered as a provider in `FleetJobsModule` and injected as its concrete class, with no token, as `PrismaTimelineRepository` is in `MemoryModule`: it is a read-only escape-hatch query, not an `AbstractPrismaRepository` aggregate.
- `FleetJobsService` constructor.
  - Baseline: 15 parameters, the last being `prRulings: FleetPrRulingsService`.
  - Target: a 16th, last parameter `@Optional() private readonly labels?: PrismaFleetJobLabelsRepository`, with `Optional` added to the `@nestjs/common` import. The six specs that call `new FleetJobsService(...)` with 15 arguments keep working, because the new parameter is last and optional.
- `FleetJobsService.list` and `FleetJobsService.get`. Target: each calls `this.labels.read` once with an array of `{ requestedById, threadId }` objects built from its row(s) (not the records themselves) and sets `requesterName` (from `names.get(requestedById)`) and `threadTitle` (from `threads.get(threadId)`, only when `threadId` is non-null) on the returned DTO(s), `null` when absent. With no reader injected, both fields stay `null`. Other routes that return a `FleetJobDto` (cancel, requeue, dispatch, config jobs) are unchanged and keep `null`.
- Web types:
  - `HomeActivity` in `apps/web/lib/home-types.ts` gains `actorName: string | null`, `ticketRef: string | null`, `ticketTitle: string | null`.
  - `TimelineEvent` in `apps/web/composables/useTimelineEvents.ts` gains the same three fields.
  - `FleetJobDto` in `apps/web/lib/fleet-types.ts` gains `requesterName: string | null` and `threadTitle: string | null`.
  - `FleetJobKind` in `apps/web/lib/fleet-types.ts` gains `'THREAD'`, which the API enum (`apps/api/src/common/enums.ts`) already has; without it `job.command === 'THREAD'` fails the web type-check.
- New `apps/web/lib/fleet-job-labels.ts`:

  ```ts
  import type { FleetJobDto } from '~/lib/fleet-types'

  type Translate = (key: string) => string

  /** The feature cell and page title of a job. */
  export function jobFeatureLabel(job: FleetJobDto, t: Translate): string

  /** The requester cell of a job: the API name, else the project member name, else "Former member". */
  export function jobRequesterLabel(job: FleetJobDto, memberName: (id: string) => string | null, t: Translate): string
  ```

  - `jobFeatureLabel`, in order: a config job (`isConfigJob`) -> `t('fleet.jobs.configFeature')`; a `THREAD` job -> `job.threadTitle` when it is a non-blank string, else `t('fleet.jobs.threadFeature')`; a `REVIEW` or `FIX` job whose `reviewPrNumber(job.feature)` is a number -> `PR #<n>`; every other job -> `job.feature`. This moves the logic that `featureLabel` (`pages/[project]/fleet/index.vue`) and `jobTitle` (`pages/[project]/fleet/jobs/[id]/index.vue`) duplicate today, and adds the THREAD branch.
  - `jobRequesterLabel`: `job.requesterName ?? memberName(job.requestedById) ?? t('common.formerMember')`.
- `pages/[project]/fleet/index.vue` and `pages/[project]/fleet/jobs/[id]/index.vue`. Target: the feature cell and the page title use `jobFeatureLabel(job, t)`; the requester cells use `jobRequesterLabel(job, people.nameOf, t)`. The `fleet.jobs.unknownMember` key is no longer read.
- `components/home/HomeActivityList.vue`. Target, per row in this order:
  - the event-type label (unchanged);
  - the actor: `event.actorName ?? t('common.formerMember')`, in an element with `data-testid="home-activity-actor"`;
  - the humanized action, with the raw code as its `title` (unchanged);
  - when `event.ticketRef` and `event.projectSlug` are both non-empty strings (a truthiness check, so a fixture without the field, or the `''` slug `buildHomeView` falls back to, renders no link), a `NuxtLink` to `/${event.projectSlug}/tickets/${event.ticketRef}` with `data-testid="home-activity-ticket"`, reading `${ticketRef} ${ticketTitle}` (just the ref when the title is null);
  - the project slug and the age (unchanged).
- `pages/[project]/timeline.vue`.
  - Baseline: `actorName(actorId)` is member name, then agent name, then the raw id. The table has the columns event, actor, action and when.
  - Target: `actorName(event)` is `event.actorName ?? memberNames.nameOf(event.actorId) ?? agentNames.nameOf(event.actorId) ?? t('common.formerMember')`. A new Ticket column (header `t('timeline.columns.ticket')`) sits between action and when. When `event.ticketRef` is a non-empty string (truthiness), its cell holds a `NuxtLink` to `/${slug}/tickets/${event.ticketRef}` with `data-testid="timeline-ticket"`, reading `${ticketRef} ${ticketTitle}` (just the ref when the title is null). Otherwise the cell is empty.
- `requestKeyLabel(t, te, key)` in `apps/web/lib/approval-requests.ts`.
  - Baseline: the `approvals.keys.<key with dots replaced by underscores>` label when the locale has it, else the raw key.
  - Target: the same label when the locale has it, else `humanizeCode(key)`.
- `components/approvals/ApprovalRequestInbox.vue`. Target: the key label span also carries `:title="row.permissionKey"`, so the raw key stays readable as a tooltip, as with every other `humanizeCode` use.
- `notificationText(n, i18n)` in `apps/web/lib/notifications.ts`. Target: for `n.kind === 'approval_request'` with a string `n.params.key`, the `key` param passed to `t` is `requestKeyLabel(i18n.t, i18n.te, n.params.key)`. Every other kind and param is unchanged.
- i18n, in both `en.json` and `zh.json`:
  - New `common.formerMember`: en `Former member`, zh `已离开的成员`.
  - New `fleet.jobs.threadFeature`: en `Thread`, zh `线程` (the zh word `nav.threads` already uses).
  - New `timeline.columns.ticket`: en `Ticket`, zh `工单`.
  - `fleet.jobs.unknownMember` is left in place, unused.

After the API contract changes, `bun run generate` from the repo root regenerates `openapi.json` and the CLI client.

### Failure Handling

- An actor id that is in neither `User` nor `Agent` (a hard-deleted user): `actorName` / `requesterName` is `null`, and the web shows "Former member".
- A ticket id that no longer exists at all: `ticketRef` and `ticketTitle` are `null`, and the row shows no ticket link. A soft-deleted ticket keeps its ref and title, and its link opens the ticket page's existing not-found state.
- A thread job whose thread was deleted (`threadId` set to null by the relation): `threadTitle` is `null`, and the feature reads "Thread".
- A label read fails (database error): the route fails as any other read on it does today. No partial or fallback response is built.

## Out of Scope

- The thread system note "Action <uuid> (koda_add_memory) was approved and done: memory:<id> saved" (F11). It is English text the agent reads, persisted in `ChatMessage.content`. Showing it readably needs structured message metadata, not parsing the English in the web.
- The flow detail page's ID row (F11): it is shown deliberately, and `tests/pages/flow-detail-readable.spec.ts` pins it.
- The memory page's user-id fallback (F11): the memory spec allows it.
- Locale labels for the 128 approvable permission keys that have none: the humanized key is the fallback. Adding `approvals.keys.*` labels is a separate copy task.
- Names on fleet job DTOs returned by cancel, requeue, dispatch and config-job routes: they keep `requesterName` and `threadTitle` `null`. The web reads names from the list and get routes only.
- Labels on `TimelineService.getTicketHistory` (it sets the new fields to `null` and makes no label read) and the koda timeline tool output (unchanged).
- Links for agent and decision events on the dashboard and timeline: those tables carry no ticket, and there is no page for one event.
- Removing the now-unused `fleet.jobs.unknownMember` key.
- Other surfaces that print a thread job's `thread-<id>` feature: `components/home/HomeNeedsYou.vue`, the fleet overview's `ActiveRunsTable.vue` and `RecentRunsList.vue`, and the job logs page. Only the jobs list and job detail page change here.
- A test for a failing label read: it propagates like any other repository error on those routes (no catch is added), so it needs no new handling.
- Checking the dashboard, timeline, jobs list and notifications in a real browser: a post-deploy manual check on koda-wk, not a story.

## Stories

### US-001: Event label readers

No dependencies. Workdir: `apps/api`.

Add `apps/api/src/common/utils/event-labels.ts` with `readPrincipalNames` and `readTicketLabels`, as in Design. Their tests use a fake client whose `findMany` methods are spies.

### US-002: Home activity names and tickets

Depends on US-001. Workdir: `apps/api`.

Add `actorName`, `ticketRef` and `ticketTitle` to `HomeActivityRow`, `HomeActivityView` and `HomeActivityDto`. Set them in `findRecentActivity` through the US-001 readers and copy them in `buildHomeView`, as in Design. Then run `bun run generate` from the repo root, so that `openapi.json` and the CLI client document the new fields. Check that the regenerated diff carries only these fields.

### US-003: Timeline event names and tickets

Depends on US-001. Workdir: `apps/api`.

Add the three fields to `TimelineEvent`, add `PrismaTimelineRepository.findEventLabels`, and call it once per page in `getProjectTimeline`, as in Design. The timeline route has no response DTO, so `openapi.json` does not change.

### US-004: Fleet job requester and thread names

Depends on US-001. Workdir: `apps/api`.

Add `requesterName` and `threadTitle` to `FleetJobDto`, add `PrismaFleetJobLabelsRepository` and register it as a provider in `FleetJobsModule`, and set the names in `FleetJobsService.list` and `get`, as in Design. Then run `bun run generate` from the repo root, and check that the regenerated diff carries only these fields.

### US-005: Web fleet job feature and requester label helpers

Depends on US-004. Workdir: `apps/web`.

Add `apps/web/lib/fleet-job-labels.ts`, the two `FleetJobDto` fields and the `THREAD` kind, as in Design. Add `common.formerMember` and `fleet.jobs.threadFeature` in en and zh.

### US-006: Web fleet jobs pages use the labels

Depends on US-005. Workdir: `apps/web`.

Use `jobFeatureLabel` and `jobRequesterLabel` on the jobs list page and the job detail page in place of `featureLabel`, `jobTitle` and the `people.nameOf(...) ?? t('fleet.jobs.unknownMember')` cells, as in Design.

### US-007: Web dashboard activity and timeline rows

Depends on US-002, US-003, US-005. Workdir: `apps/web`.

Add the three fields to `HomeActivity` and the web `TimelineEvent`. Show the actor and the linked ticket on `HomeActivityList.vue`, and the API actor name and a Ticket column on the timeline page, as in Design. Add `timeline.columns.ticket` in en and zh. It depends on US-005 because both use the `common.formerMember` key, which US-005 adds.

### US-008: Readable permission keys in approval notifications

No dependencies. Workdir: `apps/web`.

Change the `requestKeyLabel` fallback to `humanizeCode`, add the raw-key tooltip in `ApprovalRequestInbox.vue`, and pass approval notification keys through `requestKeyLabel` in `notificationText`, as in Design.

### Context Files

**US-001**
- `apps/api/src/notifications/ticket-notification-reads.repository.ts` — the `actorName` display-name precedent
- `apps/api/src/common/utils/advisory-lock.ts` — the `Pick<PrismaClient, ...>` client type precedent

**US-002**
- `apps/api/src/home/prisma-home.repository.ts` — `findRecentActivity`
- `apps/api/src/home/home.types.spec.ts` — `buildHomeView` row factories
- `apps/api/test/integration/home/home-api.integration.spec.ts` — the DB-backed `GET /api/home` fixtures

**US-003**
- `apps/api/src/memory/timeline.service.spec.ts` — the mocked-repository precedent
- `apps/api/test/integration/memory/timeline-pagination.integration.spec.ts` — the real-repository timeline precedent
- `apps/api/src/memory/timeline.controller.ts` — the route that returns `getProjectTimeline`

**US-004**
- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — the positional `new FleetJobsService(...)` precedent
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` — provider registration
- `apps/api/src/fleet/jobs/fleet-jobs.module.spec.ts` — module compilation test

**US-005**
- `apps/web/pages/[project]/fleet/index.vue` — the `featureLabel` logic that moves into the lib
- `apps/web/lib/fleet-types.ts` — `FleetJobDto` and `FleetJobKind`
- `apps/web/lib/fleet-jobs.ts` — `isConfigJob` and `reviewPrNumber`

**US-006**
- `apps/web/pages/[project]/fleet/index.vue` — `featureLabel` and the requester cell
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — `jobTitle` and the requester row
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — the jobs list mount
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — the job detail mount
- `apps/web/lib/fleet-job-labels.ts` — created by US-005, integrated here

**US-007**
- `apps/web/components/home/HomeActivityList.vue`
- `apps/web/tests/components/home-activity-list.spec.ts`
- `apps/web/pages/[project]/timeline.vue`
- `apps/web/tests/pages/timeline-readable.spec.ts`

**US-008**
- `apps/web/lib/approval-requests.ts` — `requestKeyLabel`
- `apps/web/lib/notifications.ts` — `notificationText`
- `apps/web/tests/lib/notifications.spec.ts`

### Creates

**US-001**
- `apps/api/src/common/utils/event-labels.ts`
- `apps/api/src/common/utils/event-labels.spec.ts`

**US-002**
- `apps/api/src/home/prisma-home.repository.activity.spec.ts` — AC-1 to AC-6

**US-003**
- `apps/api/test/integration/memory/timeline-labels.integration.spec.ts`

**US-004**
- `apps/api/src/fleet/jobs/prisma-fleet-job-labels.repository.ts`
- `apps/api/src/fleet/jobs/fleet-jobs.labels.spec.ts` — AC-1 to AC-9

**US-005**
- `apps/web/lib/fleet-job-labels.ts`
- `apps/web/tests/lib/fleet-job-labels.spec.ts`

### Modifies

**US-001**
None. These are new modules, and no existing test reads them.

**US-002**
- `apps/api/src/home/home.types.spec.ts` — the inline activity row literals gain `actorName`, `ticketRef` and `ticketTitle` (null), because `HomeActivityRow` now requires them. Add this story's AC-7 and AC-8 here. Every existing assertion stays unchanged.
- `apps/api/test/integration/home/home-api.integration.spec.ts` — append the AC-9 to AC-11 cases after the last existing case. Existing cases assert exact counts over the seeded world (`[['web', 2, 2]]` open tickets, exactly three event types), so each new case creates its ticket with `status: 'CLOSED'` (not open) and deletes the ticket event and the ticket in a `finally`, as the file's AC-1 case cleans up `seedAgentCreate`. Existing cases stay unchanged.
- `openapi.json` — regenerated by `bun run generate` for the three new `HomeActivityDto` fields.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` for the three new `HomeActivityDto` fields; never hand-edited.

**US-003**
- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — its typed `TimelineEvent` fixture gains `actorName`, `ticketRef` and `ticketTitle` (null), because `TimelineEvent` now requires them; the tool output expectations stay unchanged.
- `apps/api/src/memory/prisma-timeline.repository.spec.ts` — its fake Prisma client gains `user`, `agent` and `ticket` delegates with `findMany` spies, for the AC-6 case. Existing cases stay unchanged.
- `apps/api/src/memory/timeline.service.spec.ts` — `mockTimelineRepo` gains `findEventLabels: vi.fn().mockResolvedValue({ names: new Map(), tickets: new Map() })`, because `getProjectTimeline` now calls it on every page. Existing assertions on ids, order and cursors stay unchanged. Add this story's AC-1 to AC-5 here.

**US-004**
- `apps/api/src/fleet/jobs/fleet-jobs.module.spec.ts` — add the AC-10 case. The existing compile case stays unchanged.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — add the AC-11 case next to the existing `FleetJobDto` property checks, which stay unchanged.
- `openapi.json` — regenerated by `bun run generate` for the two new `FleetJobDto` fields.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` for the two new `FleetJobDto` fields; never hand-edited.

**US-005**
- `apps/web/i18n/locales/en.json` — add `common.formerMember` and `fleet.jobs.threadFeature`.
- `apps/web/i18n/locales/zh.json` — add `common.formerMember` and `fleet.jobs.threadFeature`.

**US-006**
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — the test "the table scrolls sideways on narrow screens and names a requester who left" pins the source text `people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember')`. That line is replaced by `jobRequesterLabel`, so the pin changes to the invariant that the requester cell reads `jobRequesterLabel(job, people.nameOf, t)`. The `overflow-x-auto` assertion stays unchanged. The test "S3 §6: config jobs show a readable feature without changing RUN/REVIEW/FIX rendering" pins the source text `if (isConfigJob(job)) return t('fleet.jobs.configFeature')`, which moves into the US-005 label helper; that pin changes to the invariant that the feature cell reads `jobFeatureLabel(job, t)`, and its `codeLabel(t, te, 'fleet.command', job.command)` assertion stays unchanged. Its job fixtures gain `requesterName: null` and `threadTitle: null`. Add this story's AC-1 and AC-2 here.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — add the AC-3 case, using the file's existing `PageHeader` stub (which exposes `title`) and its `useProjectMemberNames` stub. Its job fixtures gain `requesterName: null` and `threadTitle: null`. Existing title and requester assertions stay unchanged: a non-THREAD job's title is still its feature, and a `null` `requesterName` falls back to the member name as before.

**US-007**
- `apps/web/tests/components/home-activity-list.spec.ts` — the `event()` factory gains `actorName: 'Alice'`, `ticketRef: 'ACME-12'`, `ticketTitle: 'Fix login'`. The two existing tests stay unchanged. Add this story's AC-1 to AC-5 here.
- `apps/web/tests/pages/timeline-readable.spec.ts` — its `t` stub maps only a few keys, so it gains `common.formerMember` -> `Former member` and `timeline.columns.ticket` -> `Ticket`. The test "falls back to raw actor and readable unknown event/action codes; member failure is silent" expects `former-user` (the raw id) for an actor no lookup knows. The fallback is now `common.formerMember`, so that expectation changes to `Former member`. The invariant: an actor no source knows never shows its raw id, the event type and action are still humanized, and the member failure is still silent. Its row fixture gains `actorName: null`, `ticketRef: null`, `ticketTitle: null`. Add this story's AC-6 to AC-10 here.
- `apps/web/tests/pages/timeline-agent-actor.spec.ts` — its `t` stub returns the key, so the fallback cell reads `common.formerMember`. The test "falls back to raw actor id and does not toast when the roster request rejects" finds the row by `textOf(row).includes('agent-1')` and expects the actor cell to read `agent-1`. The row no longer shows the raw id, so it is located by its position (the agent event's row index) instead, and the actor cell is expected to read `common.formerMember`. The invariant: an unknown actor never shows its raw id, and no toast fires when the roster request rejects. Its fixture rows gain `actorName: null`, `ticketRef: null`, `ticketTitle: null`.
- `apps/web/tests/pages/timeline.spec.ts` — the source pins "the v-for body interpolates {{ event.actorId }} (binds the data field)" and "eventType, actorId, action bindings are inside the v-for loop body" require an `{{ ... event.actorId ... }}` interpolation, which `actorName(event)` replaces. Both pins change to require an interpolation of `actorName(event)` inside the `v-for` body; the eventType and action pins stay unchanged. The SSR render test builds its context with `actorName: (id: string) => id`; that stub becomes `actorName: (event: TimelineEvent) => event.actorId`, so the rendered HTML still contains `user-1`, `agent-7` and `admin`. Its event fixtures gain `actorName: null`, `ticketRef: null`, `ticketTitle: null`.
- `apps/web/i18n/locales/en.json` — add `timeline.columns.ticket`.
- `apps/web/i18n/locales/zh.json` — add `timeline.columns.ticket`.

**US-008**
- `apps/web/tests/lib/approval-requests.spec.ts` — the test "AC-9: an unknown key stays raw" expects `requestKeyLabel(t, knows([]), 'label.create')` to be `label.create`. The fallback is now `humanizeCode`, so it expects `Label create`. The known-key test stays unchanged. Add this story's AC-1 and AC-2 here.
- `apps/web/tests/lib/notifications.spec.ts` — the table row `['approval_request', { key: 'label.create' }, 'Approval needed: label.create']` changes its expected text to `Approval needed: Label create`, because the key now goes through `requestKeyLabel`. Every other row stays unchanged. Add this story's AC-4 to AC-6.
- `apps/web/tests/components/home-needs-you.spec.ts` — the assertion that an approval row with an unlabelled key (`te: () => false`) contains `label.create` changes to `Label create`. The invariant: an unlabelled key reads as words.
- `apps/web/tests/components/approval-request-inbox.spec.ts` — the test "a key the locale does not know reads as itself" expects `brand.new.key`. It now expects the label `Brand new key`, and the raw `brand.new.key` as that label's `title` attribute (the tooltip is where the raw key is now asserted). Add this story's AC-3 here.
- `apps/web/tests/components/notification-bell.spec.ts` — the expectation `Approval needed: label.create` changes to `Approval needed: Label create`.

### Seams

- US-001 -> US-002: `findRecentActivity` resolves names through the real `readPrincipalNames` and `readTicketLabels` (US-002 AC-1 to AC-6, AC-9).
- US-001 -> US-003: `findEventLabels` resolves through the real readers (US-003 AC-6 with fakes; AC-7 to AC-9 DB-backed).
- US-001 -> US-004: `PrismaFleetJobLabelsRepository.read` resolves requester names through the real `readPrincipalNames` (US-004 AC-9).
- US-004 -> US-006: the web reads `requesterName` and `threadTitle` from the API's `FleetJobDto` (US-006 AC-1 to AC-3).
- US-005 -> US-006: both pages call the real `jobFeatureLabel` and `jobRequesterLabel` (US-006 AC-1 to AC-3).
- US-002 / US-003 -> US-007: the web reads `actorName`, `ticketRef` and `ticketTitle` from the home activity and timeline responses (US-007 AC-1 to AC-10).
- US-008 internal: `notificationText` labels the key through the real `requestKeyLabel` (US-008 AC-4).

## Acceptance Criteria

### US-001

1. [unit] `readPrincipalNames(client, ['u1'])` returns a map with `u1` -> `Alice` when `client.user.findMany` resolves `[{ id: 'u1', name: '  Alice ', email: 'alice@example.com' }]` and `client.agent.findMany` resolves `[]`.
2. [unit] `readPrincipalNames(client, ['u2'])` returns `u2` -> `bob` when the user row is `{ id: 'u2', name: null, email: 'bob@example.com' }`.
3. [unit] `readPrincipalNames(client, ['u3'])` returns `u3` -> `carol` when the user row is `{ id: 'u3', name: '   ', email: 'carol@example.com' }`.
4. [unit] `readPrincipalNames(client, ['a1'])` returns `a1` -> `codex-bot` when `client.user.findMany` resolves `[]` and `client.agent.findMany` resolves `[{ id: 'a1', name: 'codex-bot' }]`.
5. [unit] `readPrincipalNames(client, ['gone'])` returns a map with no `gone` key when both reads resolve `[]`.
6. [unit] `readPrincipalNames(client, ['u1', 'u1', ''])` calls `client.user.findMany` once, with `where: { id: { in: ['u1'] } }`.
7. [unit] `readPrincipalNames(client, [])` resolves an empty map, and calls neither `client.user.findMany` nor `client.agent.findMany`.
8. [unit] `readTicketLabels(client, ['t1'])` returns `t1` -> `{ ref: 'SB-34', title: 'Fix login' }` when `client.ticket.findMany` resolves `[{ id: 't1', number: 34, title: 'Fix login', project: { key: 'SB' } }]`.
9. [unit] `readTicketLabels(client, ['t1'])` calls `client.ticket.findMany` with a `where` of exactly `{ id: { in: ['t1'] } }`, so soft-deleted tickets are not filtered out.
10. [unit] `readTicketLabels(client, [])` resolves an empty map and does not call `client.ticket.findMany`.

### US-002

AC-1 to AC-6 run in the new `prisma-home.repository.activity.spec.ts` and call `PrismaHomeRepository.findRecentActivity(['p1'], 25)` on a repository whose Prisma client is a fake: `ticketEvent.findMany` resolves two rows, `{ id: 'te1', projectId: 'p1', action: 'TICKET_CREATED', actorId: 'u1', ticketId: 't1', createdAt }` and the same with `id: 'te2'` and `ticketId: 'gone-t'`, `agentEvent.findMany` resolves one row with `actorId: 'a1'`, `decisionEvent.findMany` resolves one row with `agentId: 'gone'`, `user.findMany` resolves `[{ id: 'u1', name: 'Alice', email: 'alice@example.com' }]`, `agent.findMany` resolves `[{ id: 'a1', name: 'codex-bot' }]`, and `ticket.findMany` resolves `[{ id: 't1', number: 12, title: 'Fix login', project: { key: 'WEB' } }]`.

1. [unit] The ticket event row has `actorName: 'Alice'`, `ticketRef: 'WEB-12'` and `ticketTitle: 'Fix login'`.
2. [unit] The agent event row has `actorName: 'codex-bot'`, `ticketRef: null` and `ticketTitle: null`.
3. [unit] The decision event row has `actorName: null`.
4. [unit] A second ticket event row with `ticketId: 'gone-t'`, which `ticket.findMany` does not return, has `ticketRef: null` and `ticketTitle: null`.
5. [unit] `user.findMany` is called once, with `where.id.in` holding exactly `u1`, `a1` and `gone` (in any order).
6. [unit] `ticket.findMany` is called once, with `where.id.in` holding exactly `t1` and `gone-t` (in any order).
7. [unit] `buildHomeView` with one activity row carrying `actorName: 'Alice'`, `ticketRef: 'WEB-12'`, `ticketTitle: 'Fix login'` returns an activity entry with those three values.
8. [unit] `buildHomeView` with one activity row carrying `actorName: null`, `ticketRef: null`, `ticketTitle: null` returns an activity entry with those three values `null`.

AC-9 to AC-11 run in `home-api.integration.spec.ts`. Each creates a ticket with `status: 'CLOSED'` in a project the seeded `dev` user (named `dev` by `fleet-fixtures.ts`) can see, with the file's `ticket()` helper, and inserts a `ticketEvent` row directly with Prisma (`ticketId` = that ticket, `action: 'TICKET_CREATED'`, `actorType: 'user'`, `source: 'api'`), because the helper writes no event.

9. [integration] With the event's `actorId` set to the `dev` user's id, `GET /api/home` as `dev` returns 200 with an activity entry whose `ticketRef` is that ticket's `KEY-N`, whose `ticketTitle` is its title, and whose `actorName` is `dev`.
10. [integration] After `prisma.ticket.update` sets that ticket's `deletedAt`, `GET /api/home` still returns the entry with the same `ticketRef` and `ticketTitle`.
11. [integration] With the event's `actorId` set to an id that matches no `User` or `Agent` row, `GET /api/home` returns the entry with `actorName: null`.

### US-003

AC-1 to AC-5 run in `timeline.service.spec.ts` with the mocked repository. AC-6 runs in `prisma-timeline.repository.spec.ts`.

1. [unit] `getProjectTimeline({ projectId: 'p1', limit: 2 })`, with the repository returning three ticket events, calls `findEventLabels` exactly once, with the actor ids and ticket ids of the two returned events only.
2. [unit] When `findEventLabels` resolves `names` with `u1` -> `Alice` and `tickets` with `t1` -> `{ ref: 'SB-3', title: 'Fix login' }`, the returned event with `actorId: 'u1'` and `ticketId: 't1'` has `actorName: 'Alice'`, `ticketRef: 'SB-3'` and `ticketTitle: 'Fix login'`.
3. [unit] A returned agent event, with an actor the `names` map lacks, has `actorName: null`, `ticketRef: null` and `ticketTitle: null`.
4. [unit] A returned ticket event whose `ticketId` the `tickets` map lacks has `ticketRef: null` and `ticketTitle: null`.
5. [unit] `getProjectTimeline` with every repository read resolving `[]` returns `events: []` and calls `findEventLabels` once with two empty arrays.
6. [unit] `findEventLabels(['u1'], ['t1'])` over a fake Prisma client whose `user`, `agent` and `ticket` delegates resolve `[{ id: 'u1', name: 'Alice', email: 'a@x.io' }]`, `[]` and `[{ id: 't1', number: 3, title: 'Fix login', project: { key: 'SB' } }]` returns `names` with `u1` -> `Alice` and `tickets` with `t1` -> `{ ref: 'SB-3', title: 'Fix login' }`, through the real US-001 readers.
7. [integration] In the new `timeline-labels.integration.spec.ts`, with a real `PrismaTimelineRepository` and a project holding one ticket created by a user named `Alice`, `getProjectTimeline` returns that ticket's event with `actorName: 'Alice'`, the ticket's `KEY-N` as `ticketRef`, and its title as `ticketTitle`.
8. [integration] In the same spec, a ticket event whose `actorId` matches no `User` or `Agent` row has `actorName: null`.
9. [integration] In the same spec, an agent event by a soft-deleted agent named `retired-bot` has `actorName: 'retired-bot'`.

### US-004

AC-1 to AC-9 run in the new `fleet-jobs.labels.spec.ts`. AC-2 to AC-8 construct `FleetJobsService` positionally with the same 15 arguments `fleet-jobs.service.spec.ts` passes, plus a stub `PrismaFleetJobLabelsRepository` as the 16th.

1. [unit] `FleetJobDto.from` on any record returns `requesterName: null` and `threadTitle: null`.
2. [unit] `list` on a page of one THREAD job with `requestedById: 'u1'` and `threadId: 'th1'` calls the stub's `read` exactly once, with exactly `[{ requestedById: 'u1', threadId: 'th1' }]`.
3. [unit] When `read` resolves `names` with `u1` -> `Alice` and `threads` with `th1` -> `Fix login flow`, that `list` row has `requesterName: 'Alice'` and `threadTitle: 'Fix login flow'`.
4. [unit] A listed job whose `threadId` is null has `threadTitle: null`, even when the `threads` map is not empty.
5. [unit] A listed job whose requester the `names` map lacks has `requesterName: null`.
6. [unit] `get` for a job with `requestedById: 'a1'` and `threadId: null` returns `requesterName` from the stub's `names` map (`a1` -> `codex-bot`) and calls `read` once.
7. [unit] `list` on a page of one `PLAN` job with `threadId: 'th1'`, when `threads` maps `th1` -> `Fix login flow`, returns `threadTitle: 'Fix login flow'` (any job with a thread gets its title; the web shows it only for THREAD jobs).
8. [unit] With only the 15 existing arguments passed (no labels repository), `list` returns rows with `requesterName: null` and `threadTitle: null`.
9. [unit] `new PrismaFleetJobLabelsRepository(prisma).read([{ requestedById: 'u1', threadId: 'th1' }, { requestedById: 'u1', threadId: null }])`, over a fake Prisma client, calls `chatThread.findMany` once with `where: { id: { in: ['th1'] } }`, and returns `u1` -> the user's display name from the real `readPrincipalNames` (a user row `{ id: 'u1', name: 'Alice', email: 'a@x.io' }` gives `Alice`).
10. [unit] In `fleet-jobs.module.spec.ts`, the compiled `FleetJobsModule` resolves `PrismaFleetJobLabelsRepository`, and the resolved `FleetJobsService` instance's `labels` field is that same instance (so the `@Optional()` parameter is really injected).
11. [unit] In `fleet-openapi.contract.spec.ts`, the regenerated `openapi.json` `FleetJobDto` schema lists the properties `requesterName` and `threadTitle`.

### US-005

1. [unit] `jobFeatureLabel` on a `THREAD` job with `threadTitle: 'Fix login flow'` and `feature: 'thread-cm1'` returns `Fix login flow`.
2. [unit] `jobFeatureLabel` on a `THREAD` job with `threadTitle: null` returns the `fleet.jobs.threadFeature` translation.
3. [unit] `jobFeatureLabel` on a `THREAD` job with `threadTitle: '   '` returns the `fleet.jobs.threadFeature` translation.
4. [unit] `jobFeatureLabel` on a `REVIEW` job with `feature: 'review-pr-18'` returns `PR #18`.
5. [unit] `jobFeatureLabel` on a `RUN` job with `feature: 'c3-clamp'` and `threadTitle: 'ignored'` returns `c3-clamp`.
6. [unit] `jobFeatureLabel` on a `CONFIG_EDIT` job returns the `fleet.jobs.configFeature` translation.
7. [unit] `jobRequesterLabel` on a job with `requesterName: 'codex-bot'` returns `codex-bot`, and does not call `memberName`.
8. [unit] `jobRequesterLabel` on a job with `requesterName: null`, where `memberName('u1')` returns `Alice`, returns `Alice`.
9. [unit] `jobRequesterLabel` on a job with `requesterName: null`, where `memberName` returns `null`, returns the `common.formerMember` translation.
### US-006

1. [unit] The jobs list page (`pages/[project]/fleet/index.vue`), mounted with one THREAD job row `{ command: 'THREAD', feature: 'thread-cm1', threadTitle: 'Fix login flow', requesterName: 'codex-bot' }`, renders `Fix login flow` and `codex-bot` in that row, and neither `thread-cm1` nor `Unknown member`.
2. [unit] The jobs list page, mounted with one RUN job `{ requesterName: null, requestedById: 'gone' }` and a member list without `gone`, renders `Former member` in its requester cell.
3. [unit] The job detail page (`pages/[project]/fleet/jobs/[id]/index.vue`), mounted with a THREAD job with `threadTitle: 'Fix login flow'` and `requesterName: 'codex-bot'`, passes `Fix login flow` as the `PageHeader` title and renders `codex-bot` as the requester.

### US-007

AC-1 to AC-5 mount `HomeActivityList.vue`.

1. [unit] A ticket event with `actorName: 'Alice'`, `ticketRef: 'ACME-12'`, `ticketTitle: 'Fix login'` and `projectSlug: 'acme'` renders `Alice` in its `home-activity-actor` element.
2. [unit] The same event renders a `home-activity-ticket` link whose `to` is `/acme/tickets/ACME-12` and whose text is `ACME-12 Fix login`.
3. [unit] An event with `ticketRef: 'ACME-12'` and `ticketTitle: null` renders a `home-activity-ticket` link whose text is `ACME-12`.
4. [unit] An agent event with `ticketRef: null` renders no `home-activity-ticket` element.
5. [unit] An event with `actorName: null` renders `Former member` in its `home-activity-actor` element.

AC-6 to AC-10 mount the timeline page as `timeline-readable.spec.ts` does, with the member and agent roster requests resolved and its `t` stub extended as in Modifies.

6. [unit] An event with `actorName: 'Alice'` and `actorId: 'u1'`, where the member list names `u1` as `Someone Else`, shows `Alice` in its actor cell.
7. [unit] An event with `actorName: null` and `actorId: 'u1'`, where the member list names `u1` as `Bob`, shows `Bob` in its actor cell.
8. [unit] An event with `actorName: null` and an `actorId` neither roster knows shows `Former member` in its actor cell, and the raw id appears nowhere in the row.
9. [unit] The table header contains `Ticket`, and an event with `ticketRef: 'SB-3'` and `ticketTitle: 'Fix login'` renders a `timeline-ticket` link whose `to` is `/<slug>/tickets/SB-3` and whose text is `SB-3 Fix login`.
10. [unit] An event with `ticketRef: null` renders no `timeline-ticket` element in its row.

### US-008

1. [unit] `requestKeyLabel(t, te, 'fleet.flow.start')`, where `te` knows no key, returns `Fleet flow start`.
2. [unit] `requestKeyLabel(t, te, 'memory.create')`, where `te` knows no key, returns `Memory create`.
3. [unit] `ApprovalRequestInbox.vue`, mounted as `approval-request-inbox.spec.ts` does with one pending request whose `permissionKey` is `fleet.flow.start`, renders `Fleet flow start`, and that label element's `title` attribute is `fleet.flow.start`.
4. [unit] `notificationText` on `{ kind: 'approval_request', params: { key: 'fleet.flow.start' }, title: 'Approval needed: fleet.flow.start' }`, with the real en locale, returns `Approval needed: Fleet flow start`.
5. [unit] `notificationText` on `{ kind: 'approval_request', params: { key: 'fleet.budget.override' } }`, with the real en locale, returns `Approval needed: Fleet budget override` (the existing `approvals.keys.fleet_budget_override` label).
6. [unit] `notificationText` on a `ticket_assigned` notification with params `{ actorName: 'Alice', ref: 'SB-1', ticketTitle: 'Fix' }` returns the same text it returned before this change: the locale's `ticket_assigned` message with those params.
