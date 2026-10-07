# Fleet C9 Slice 2 — Ticket Work Products on the Web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ticket page shows the fleet jobs that worked on it (state, branch, PR with live state, failure reason, cost) and offers a Dispatch button; the dispatch form takes tickets; the PLAN -> RUN hand-off carries them; the job page lists its tickets; fleet PR links are marked "via fleet".

**Architecture:** Web only, plus one small API fix: the cancel and requeue responses now carry `tickets` (the slice 1a minor). Pure logic (feature slug, query parsing, reason and PR-state selection, live-event filter) lives in a new `apps/web/lib/fleet-ticket-links.ts`. Two new components: `components/TicketFleetRuns.vue` (the ticket card, which loads its own list and follows live events) and `components/fleet/TicketPicker.vue` (the dispatch form's tickets field). The ticket page, `TicketHeader`, `TicketProperties`, the dispatch page and the job page are wired to them.

**Tech Stack:** Nuxt 3 + Vue 3.5 (`<script setup>`), Tailwind 3, shadcn-vue (`Badge`, `Button`, `Input`, `Dialog`), vee-validate + zod, `@nuxtjs/i18n` (en + zh), Jest 29 with the repo's `mountSfc` fake renderer (no DOM), Playwright with the fleet `ScriptedRunner`; API: NestJS 11 + Prisma, Jest integration on PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md` (§4 Web, §6 E2E, §7 slice 2; D461). Slices 1a (#228 `63961a23`) and 1b (#229 `b0a4b294`) already serve every endpoint this slice reads: `POST .../fleet/jobs` accepts `ticketRefs`; `GET .../fleet/jobs/:id` returns `tickets`; `GET|DELETE /projects/:slug/tickets/:ref/fleet-jobs[/:jobId]`; `GET .../tickets/:ref/links` returns `source` and `jobId`.

## Global Constraints

- Branch: `feat/fleet-c9-slice-2-web` (cut from main `b0a4b294`; it holds this plan). Never switch branches during execution.
- No migration, no new endpoint, no DTO shape change. The only API change is Task 1 (cancel and requeue fill the already-declared `FleetJobDto.tickets`). `bun run generate` must leave no diff.
- C9-5: no UI/UX design pass. Build from the existing tokens and components (`lib/ticket-chips.ts`, `FleetJobStateBadge`, `FleetAge`, shadcn primitives). Colors come from tokens (`text-status-rejected`, `text-muted-foreground`, ...), never raw hex.
- D461: the Dispatch button links to `/<project>/fleet/dispatch?tickets=<REF>&feature=<slug>&command=PLAN`, where `<slug>` = lower-case `<key>-<number>-<title>` reduced to `[a-z0-9-]`, at most 48 chars.
- D450 mirrored on the web: at most 20 tickets, refs upper-cased, deduplicated; a ref is `^[A-Z]{2,6}-[1-9]\d{0,8}$` (project key rule in `apps/api/src/projects/dto/create-project.dto.ts`). The server stays the authority (its 400 names the bad ref and is shown as-is).
- D460: `FleetJobDto.tickets` is null on list pages; never read it from a list row.
- Agent-written and user-written text (ticket titles, failure reasons, branch names, PR URLs) renders through `{{ }}` only, never `v-html`. A PR URL becomes a link only through `safePrUrl` (https only), opened with `rel="noopener noreferrer"`.
- Live updates: no polling, no new stream. Everything follows the shared project event stream (`useProjectEvents`) with a 300 ms debounce, and never flips a page's `pending`.
- i18n: every new key in both `apps/web/i18n/locales/en.json` and `zh.json`. New fleet-owned keys live under `fleet.*` (the fleet subtree has an en/zh parity test); no `|` or `@` in any value under `fleet` (`tests/i18n/fleet-locale-parity.spec.ts`).
- Tailwind does not scan `apps/web/lib/` (except the existing `ticket-chips.ts` classes, already used by components): new lib helpers return values, never class names.
- No emojis; no `console.log` in `apps/web` sources; build new objects and arrays, never mutate inputs or props.
- Web lint runs with `--max-warnings=0`; `bun run type-check` (`nuxt typecheck`) must pass. `*.spec.ts` files are excluded from type-check but still linted.
- E2E resets the `koda_e2e` database (`prisma migrate reset`). Prisma refuses that from an AI agent without the user's consent: **ask the user first**, then run with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<their exact consent message>"`.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan defect: stop and report it.

### Plan decisions (not in the spec; flag in review if you disagree)

- **P1** The ticket picker's suggestions are one page of the project's 100 newest tickets (`GET /projects/:slug/tickets?size=100`, ordered by number descending), CLOSED and REJECTED dropped client-side. There is no ticket search endpoint; an older open ticket is typed by ref (Enter) and the server validates it.
- **P2** The Dispatch button is also hidden on CLOSED and REJECTED tickets: the dispatch would answer 400 for them (D450).
- **P3** The Fleet runs card refetches on a ticket event for its ticket, on a `fleet_job` event for a job it lists, on any `fleet_job` event with state `QUEUED` (a job just dispatched or requeued may be linked to this ticket, and a dispatch from elsewhere emits no ticket event for PLAN jobs), and on resync.
- **P4** The Fleet runs card is secondary content: a failed load keeps what is on screen (nothing on first load) and shows no toast; the next live event or resync retries. Same rule as the job page's log list.
- **P5** The ticket page also reloads its links on every ticket live event and on resync. Fleet PR links arrive as `TICKET_UPDATED` (1b) and today only the ticket and the comments reload.
- **P6** The "via fleet" mark links to the job page when the link has a `jobId`.
- **P7** The dispatch form shows a ticket-specific notice ("Pre-filled from the ticket ...") when the query brought tickets and no `ref`; the PLAN -> RUN hand-off keeps the existing notice.
- **P8** The web `FleetJobDto.tickets` is declared optional (`tickets?: FleetJobTicketDto[] | null`): the API always sends it, and optional keeps the many hand-built `FleetJobDto` fixtures in tests valid.

## Review Focus

- **Requeue or cancel from the job page** must keep the Tickets row: today the response carries `tickets: null` and the page replaces `job` with it. Pinned in Task 1 (integration) and Task 6 (the page renders from the response).
- **A ticket title with no ASCII letters or digits** (Chinese, emoji, punctuation only) still yields a valid nax feature name: `web-12`, never a trailing `-`, never more than 48 chars. Pinned in Task 2.
- **A hand-edited or stale `?tickets=` query** (lower case, spaces, duplicates, junk, other formats, repeated `tickets=` params, more than 20) prefills only valid refs, upper-cased, deduplicated, at most 20. Pinned in Task 2.
- **A job dispatched elsewhere for this ticket, or a linked job changing state, while the ticket page is open** shows up without a reload; events for unrelated jobs and other tickets do not refetch. Pinned in Task 4 (mount) and Task 7 (E2E, live FAILED).
- **Unlink races** (someone else already unlinked, so 404): the error is toasted and the list reloads; a successful unlink removes the row and tells the page to reload links (the fleet PR link is gone). Pinned in Task 4 and Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/fleet/jobs/fleet-jobs.service.ts` | `withDetail`: detail, cancel and requeue responses carry `tickets`. |
| `apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts` | Regression for the slice 1a minor. |
| `apps/web/lib/fleet-types.ts` | `FleetJobTicketDto`, `TicketFleetJobDto`, `FleetJobDto.tickets`, `DispatchBody.ticketRefs`. |
| `apps/web/lib/fleet-ticket-links.ts` (new) | Pure: ref rules, feature slug, query parsing, picker matching, reason, PR state, live filter. |
| `apps/web/lib/fleet-dispatch.ts` | `ticketRefs` in the schema, defaults, body, prefill; `prefillNotice`. |
| `apps/web/components/fleet/TicketPicker.vue` (new) | The dispatch form's tickets field (`FleetTicketPicker`). |
| `apps/web/pages/[project]/fleet/dispatch.vue` | Tickets field, prefill from `?tickets=`, ticket notice. |
| `apps/web/components/TicketFleetRuns.vue` (new) | The ticket page's Fleet runs card with Unlink. |
| `apps/web/components/TicketHeader.vue` | Dispatch link next to Edit. |
| `apps/web/components/TicketProperties.vue` | "via fleet" mark on fleet PR links. |
| `apps/web/pages/[project]/tickets/[ref].vue` | Fleet repo check, Dispatch href, the card, link reload on live events. |
| `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` | Tickets row; hand-off carries `tickets=`. |
| `apps/web/i18n/locales/{en,zh}.json` | `fleet.tickets.*`, `fleet.dispatch.tickets*`, `fleet.dispatch.prefilledTicket`, `fleet.dispatch.validation.tickets`, `fleet.jobs.detail.tickets`. |
| `apps/web/tests/e2e/fleet-ticket-runs.e2e.spec.ts` (new) | Dispatch from a ticket, Fleet runs, via fleet, live FAILED, Unlink. |
| `.nax/mono/apps/web/context.md`, generated `apps/web/{CLAUDE,AGENTS,GEMINI,codex}.md`, `docs/ux/redesign/MASTER-PLAN.md`, the spec | Docs. |

---

### Task 1: Cancel and requeue responses carry `tickets` (slice 1a minor)

**Files:**
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (`cancel` return ~line 159, `withPending` ~line 163, `requeue` return ~line 246, `get` ~line 252)
- Test: `apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts`

**Interfaces:**
- Consumes: `FleetTicketsService.forJob(jobId: string): Promise<FleetJobTicketDto[]>` (slice 1a).
- Produces: `POST /projects/:slug/fleet/jobs/:id/cancel` -> `FleetJobDto` with `tickets: FleetJobTicketDto[]`; `POST .../requeue` -> `DispatchResultDto` whose `job.tickets` is filled. Task 6 relies on it.

- [ ] **Step 1: Write the failing integration test**

In `apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts`, add inside the `describeIntegration` block, after the last `it(...)`:

```ts
  it('cancel and requeue answer with the linked tickets (slice 1a minor, C9 slice 2)', async () => {
    const t = await ticket();
    const res = data<{ job: { id: string } }>(await dispatch({ feature: 'cancel-requeue', ticketRefs: [`WEB-${t.number}`] }).expect(201));

    const cancelled = data<{ state: string; tickets: Array<{ ref: string }> | null }>(
      await request(server).post(`/api/projects/web/fleet/jobs/${res.job.id}/cancel`).set(auth('dev')).expect(200),
    );
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.tickets?.map((x) => x.ref)).toEqual([`WEB-${t.number}`]);

    const requeued = data<{ job: { tickets: Array<{ ref: string }> | null } }>(
      await request(server).post(`/api/projects/web/fleet/jobs/${res.job.id}/requeue`).set(auth('dev')).expect(200),
    );
    expect(requeued.job.tickets?.map((x) => x.ref)).toEqual([`WEB-${t.number}`]);
  });
```

(The job is QUEUED, or ASSIGNED with an unacked ASSIGN if the seeded world has a fitting runner; both cancel server-side to CANCELLED, which requeue accepts.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts`
Expected: the new test FAILS (`cancelled.tickets` is `null`); the other tests pass.

- [ ] **Step 3: Implement**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, add below `withPending`:

```ts
  /** C9 D460: single-job responses (detail, cancel, requeue) carry the linked tickets; lists keep null. */
  private async withDetail(r: FleetJobRecord): Promise<FleetJobDto> {
    return Object.assign(await this.withPending(r), { tickets: await this.fleetTickets.forJob(r.id) });
  }
```

Then use it in three places:

- `cancel`: replace the final `return this.withPending(job);` with `return this.withDetail(job);`
- `requeue`: replace `job: await this.withPending(fresh),` with `job: await this.withDetail(fresh),`
- `get`: replace its body's return with `return this.withDetail(job);` (same behaviour as today, one helper).

`dispatch` keeps building `tickets` from the already-resolved list (no extra query).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts && bunx jest src/fleet/jobs src/fleet/approvals`
Expected: all PASS. (`approvals.service.ts` calls `requeue`; it reads only `job.id`/placement and is unaffected.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/jobs/fleet-jobs.service.ts apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts
git commit -m "fix(fleet): cancel and requeue responses carry the job's tickets (C9 slice 1a minor)"
```

---

### Task 2: Web types and pure helpers (`fleet-ticket-links.ts`, dispatch `ticketRefs`)

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (`FleetJobDto` ~line 163, `DispatchBody` ~line 237)
- Create: `apps/web/lib/fleet-ticket-links.ts`
- Modify: `apps/web/lib/fleet-dispatch.ts`
- Test: `apps/web/tests/lib/fleet-ticket-links.spec.ts` (new), `apps/web/tests/lib/fleet-dispatch.spec.ts` (extend)

**Interfaces:**
- Produces (used by Tasks 3-6):
  - `fleet-types.ts`: `interface FleetJobTicketDto { ref: string; title: string; status: string }`; `interface TicketFleetJobDto { id; command: 'RUN' | 'PLAN'; feature; state: FleetJobState; stateReason: string | null; escalationReason: string | null; resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null; costUsd: string; queuedAt: string; finishedAt: string | null }`; `FleetJobDto.tickets?: FleetJobTicketDto[] | null`; `DispatchBody.ticketRefs?: string[]`.
  - `fleet-ticket-links.ts`: `MAX_DISPATCH_TICKETS = 20`, `TICKET_REF_RE`, `MAX_TICKET_FEATURE_CHARS = 48`, `type TicketOption = FleetJobTicketDto`, `normalizeTicketRef(value: string): string | null`, `ticketRefsFromQuery(value: unknown): string[]`, `addTicketRef(list: readonly string[], value: string): string[]`, `isLinkableTicket(status: string): boolean`, `matchTicketOptions(options, chosen, query, limit = 8): TicketOption[]`, `ticketFeatureSlug(ref: string, title: string): string`, `ticketDispatchQuery(ticket: { ref: string; title: string }): Record<string, string>`, `ticketsQueryValue(tickets: readonly FleetJobTicketDto[] | null | undefined): string`, `runReason(job): string | null`, `runPrState(job, links): string | null`, `affectsRuns(event: { jobId: string; state: string }, jobIds: readonly string[]): boolean`, `shortSha(sha: string | null): string | null`.
  - `fleet-dispatch.ts`: `DispatchFormValues.ticketRefs: string[]`; `DispatchQuery.tickets?: unknown`; `prefillNotice(prefill: Partial<DispatchFormValues>): 'ticket' | 'plan' | null`.

- [ ] **Step 1: Write the failing helper tests**

`apps/web/tests/lib/fleet-ticket-links.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  addTicketRef, affectsRuns, isLinkableTicket, matchTicketOptions, MAX_DISPATCH_TICKETS, normalizeTicketRef, runPrState,
  runReason, shortSha, ticketDispatchQuery, ticketFeatureSlug, ticketRefsFromQuery, ticketsQueryValue,
} from '~/lib/fleet-ticket-links'
import { FEATURE_RE } from '~/lib/fleet-dispatch'

describe('ticketFeatureSlug (D461)', () => {
  test('lower-cases ref and title and joins words with one dash', () => {
    expect(ticketFeatureSlug('WEB-12', 'Fix login: 500 on  SSO!')).toBe('web-12-fix-login-500-on-sso')
  })

  test('a title with no ASCII letters or digits leaves the ref alone (Review Focus 2)', () => {
    expect(ticketFeatureSlug('WEB-12', '修复登录')).toBe('web-12')
    expect(ticketFeatureSlug('WEB-12', '!!! ...')).toBe('web-12')
  })

  test('at most 48 chars, never ending with a dash, always a valid nax feature name', () => {
    const slug = ticketFeatureSlug('WEB-12', `${'a'.repeat(39)} tail`)
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
    for (const title of ['x'.repeat(200), 'a b c d e f g h i j k l m n o p q r s t u v w x y z', '--', '..']) {
      const s = ticketFeatureSlug('ABCDEF-123456789', title)
      expect(s.length).toBeLessThanOrEqual(48)
      expect(FEATURE_RE.test(s) && !s.includes('..') && !s.endsWith('-')).toBe(true)
    }
  })
})

describe('ticket refs', () => {
  test('normalizeTicketRef upper-cases and trims; rejects other shapes', () => {
    expect(normalizeTicketRef(' web-7 ')).toBe('WEB-7')
    for (const bad of ['', 'W-1', 'TOOLONGK-1', 'WEB-0', 'WEB-01', 'WEB-', 'WEB 1', 'WEB-1a', 'cuid123']) {
      expect(normalizeTicketRef(bad)).toBeNull()
    }
  })

  test('ticketRefsFromQuery: valid refs only, upper-cased, deduplicated, at most 20 (Review Focus 3)', () => {
    expect(ticketRefsFromQuery('web-1, WEB-2,,junk,web-1')).toEqual(['WEB-1', 'WEB-2'])
    expect(ticketRefsFromQuery(['WEB-3', 'web-4,WEB-3'])).toEqual(['WEB-3', 'WEB-4'])
    expect(ticketRefsFromQuery(undefined)).toEqual([])
    expect(ticketRefsFromQuery(42)).toEqual([])
    const many = Array.from({ length: 25 }, (_, i) => `WEB-${i + 1}`).join(',')
    expect(ticketRefsFromQuery(many)).toHaveLength(MAX_DISPATCH_TICKETS)
  })

  test('addTicketRef adds a normalized ref once, refuses junk and a full list, never mutates', () => {
    const list = ['WEB-1']
    expect(addTicketRef(list, 'web-2')).toEqual(['WEB-1', 'WEB-2'])
    expect(addTicketRef(list, 'WEB-1')).toEqual(['WEB-1'])
    expect(addTicketRef(list, 'nope')).toEqual(['WEB-1'])
    expect(list).toEqual(['WEB-1'])
    const full = Array.from({ length: MAX_DISPATCH_TICKETS }, (_, i) => `WEB-${i + 1}`)
    expect(addTicketRef(full, 'WEB-99')).toHaveLength(MAX_DISPATCH_TICKETS)
  })
})

describe('picker matching (P1)', () => {
  const options = [
    { ref: 'WEB-12', title: 'Login fails', status: 'CREATED' },
    { ref: 'WEB-11', title: 'Old', status: 'CLOSED' },
    { ref: 'WEB-1', title: 'Export is slow', status: 'IN_PROGRESS' },
  ]

  test('open, unchosen tickets whose ref or title contains the query', () => {
    expect(matchTicketOptions(options, [], 'login').map(o => o.ref)).toEqual(['WEB-12'])
    expect(matchTicketOptions(options, [], 'web-1').map(o => o.ref)).toEqual(['WEB-12', 'WEB-1'])
    expect(matchTicketOptions(options, ['WEB-12'], '').map(o => o.ref)).toEqual(['WEB-1'])
    expect(matchTicketOptions(options, [], '', 1)).toHaveLength(1)
  })

  test('CLOSED and REJECTED are not linkable (D450)', () => {
    expect(isLinkableTicket('CLOSED')).toBe(false)
    expect(isLinkableTicket('REJECTED')).toBe(false)
    expect(isLinkableTicket('VERIFY_FIX')).toBe(true)
  })
})

describe('links between pages', () => {
  test('ticketDispatchQuery proposes a PLAN with this ticket and its slug', () => {
    expect(ticketDispatchQuery({ ref: 'WEB-3', title: 'Add CSV export' }))
      .toEqual({ command: 'PLAN', tickets: 'WEB-3', feature: 'web-3-add-csv-export' })
  })

  test('ticketsQueryValue joins the refs; empty for none', () => {
    expect(ticketsQueryValue([{ ref: 'WEB-1', title: 'a', status: 'CREATED' }, { ref: 'WEB-2', title: 'b', status: 'CREATED' }])).toBe('WEB-1,WEB-2')
    expect(ticketsQueryValue(null)).toBe('')
    expect(ticketsQueryValue(undefined)).toBe('')
  })
})

describe('Fleet runs rows', () => {
  const base = { stateReason: null as string | null, escalationReason: null as string | null }

  test('runReason picks the failure comment reason (failure-comment.ts)', () => {
    expect(runReason({ ...base, state: 'FAILED', stateReason: ' acceptance failed ' })).toBe('acceptance failed')
    expect(runReason({ ...base, state: 'CRASHED', stateReason: 'runner silent' })).toBe('runner silent')
    expect(runReason({ state: 'ESCALATED', stateReason: 'state', escalationReason: 'needs a human' })).toBe('needs a human')
    expect(runReason({ state: 'ESCALATED', stateReason: 'state', escalationReason: '  ' })).toBe('state')
    expect(runReason({ ...base, state: 'FAILED' })).toBeNull()
    expect(runReason({ ...base, state: 'COMPLETED', stateReason: 'ignored' })).toBeNull()
    expect(runReason({ ...base, state: 'CANCELLED', stateReason: 'ignored' })).toBeNull()
  })

  test('runPrState reads the matching ticket link; null without a PR or a link', () => {
    const links = [{ url: 'https://github.com/a/b/pull/7', linkType: 'pr', prState: 'merged' }]
    expect(runPrState({ resultPrUrl: 'https://github.com/a/b/pull/7' }, links)).toBe('merged')
    expect(runPrState({ resultPrUrl: 'https://github.com/a/b/pull/8' }, links)).toBeNull()
    expect(runPrState({ resultPrUrl: null }, links)).toBeNull()
  })

  test('affectsRuns: a listed job, or any newly queued job (P3)', () => {
    expect(affectsRuns({ jobId: 'j1', state: 'RUNNING' }, ['j1'])).toBe(true)
    expect(affectsRuns({ jobId: 'j9', state: 'RUNNING' }, ['j1'])).toBe(false)
    expect(affectsRuns({ jobId: 'j9', state: 'QUEUED' }, ['j1'])).toBe(true)
  })

  test('shortSha', () => {
    expect(shortSha('abcdef1234567')).toBe('abcdef1')
    expect(shortSha(null)).toBeNull()
  })
})
```

Append to `apps/web/tests/lib/fleet-dispatch.spec.ts` (and add `prefillNotice` to its existing import from `~/lib/fleet-dispatch`):

```ts
describe('dispatch tickets (C9 §4)', () => {
  test('defaults to none and sends none', () => {
    expect(DISPATCH_DEFAULTS.ticketRefs).toEqual([])
    expect(toDispatchBody(valid())).not.toHaveProperty('ticketRefs')
  })

  test('sends a copy of the chosen refs', () => {
    const values = valid({ ticketRefs: ['WEB-1', 'WEB-2'] })
    const body = toDispatchBody(values)
    expect(body.ticketRefs).toEqual(['WEB-1', 'WEB-2'])
    expect(body.ticketRefs).not.toBe(values.ticketRefs)
  })

  test('validates refs and the maximum', () => {
    expect(messages(valid({ ticketRefs: ['WEB-1'] }))).toEqual([])
    expect(messages(valid({ ticketRefs: ['web-1'] }))).toContain('fleet.dispatch.validation.tickets')
    expect(messages(valid({ ticketRefs: Array.from({ length: 21 }, (_, i) => `WEB-${i + 1}`) }))).toContain('fleet.dispatch.validation.tickets')
  })

  test('prefills tickets from ?tickets= and picks the notice (P7)', () => {
    const fromTicket = dispatchPrefillFromQuery({ command: 'PLAN', tickets: 'web-3', feature: 'web-3-add-csv-export' })
    expect(fromTicket).toEqual({ command: 'PLAN', ticketRefs: ['WEB-3'], feature: 'web-3-add-csv-export' })
    expect(prefillNotice(fromTicket)).toBe('ticket')
    const handoff = dispatchPrefillFromQuery({ command: 'RUN', repoId: 'r1', feature: 'f', ref: 'feat/f', tickets: 'WEB-3' })
    expect(prefillNotice(handoff)).toBe('plan')
    expect(prefillNotice(dispatchPrefillFromQuery({ tickets: 'junk' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/fleet-ticket-links.spec.ts tests/lib/fleet-dispatch.spec.ts`
Expected: FAIL (`Cannot find module '~/lib/fleet-ticket-links'`; `prefillNotice` is not a function).

- [ ] **Step 3: Add the wire types**

In `apps/web/lib/fleet-types.ts`, above `export interface FleetJobDto {`:

```ts
/** C9 §2.2: a ticket linked to a fleet job (detail, dispatch, cancel and requeue responses). */
export interface FleetJobTicketDto {
  ref: string
  title: string
  status: string
}

/** C9 §2.2: GET /projects/:slug/tickets/:ref/fleet-jobs, newest first, read live from the job (D460). */
export interface TicketFleetJobDto {
  id: string
  command: 'RUN' | 'PLAN'
  feature: string
  state: FleetJobState
  stateReason: string | null
  escalationReason: string | null
  resultBranch: string | null
  resultSha: string | null
  resultPrUrl: string | null
  /** USD across all attempts, a 4-place decimal string. */
  costUsd: string
  queuedAt: string
  finishedAt: string | null
}
```

In `FleetJobDto`, after `coalescedCount: number`:

```ts
  /** C9 D460: linked tickets on single-job responses; null on list pages. Optional for hand-built fixtures (plan P8). */
  tickets?: FleetJobTicketDto[] | null
```

In `DispatchBody`, after `approvalTimeoutSec?: number`:

```ts
  /** C9 §2.1: KEY-N refs, at most 20 (D450). */
  ticketRefs?: string[]
```

- [ ] **Step 4: Write `fleet-ticket-links.ts`**

`apps/web/lib/fleet-ticket-links.ts`:

```ts
import type { FleetJobTicketDto, TicketFleetJobDto } from '~/lib/fleet-types'

/** apps/api/src/fleet/tickets/ticket-refs.ts MAX_DISPATCH_TICKETS (D450). */
export const MAX_DISPATCH_TICKETS = 20
/** A project key is 2-6 capitals (create-project.dto.ts); ticket numbers start at 1. */
export const TICKET_REF_RE = /^[A-Z]{2,6}-[1-9]\d{0,8}$/
/** D461: the longest feature slug a ticket's Dispatch button proposes. */
export const MAX_TICKET_FEATURE_CHARS = 48

export type TicketOption = FleetJobTicketDto

const UNLINKABLE: ReadonlySet<string> = new Set(['CLOSED', 'REJECTED'])
const REASON_STATES: ReadonlySet<string> = new Set(['FAILED', 'ESCALATED', 'CRASHED'])

/** D450: dispatch refuses CLOSED and REJECTED tickets. */
export const isLinkableTicket = (status: string): boolean => !UNLINKABLE.has(status)

/** `' web-7 '` -> `'WEB-7'`; null for anything that is not a ticket ref. */
export function normalizeTicketRef(value: string): string | null {
  const ref = value.trim().toUpperCase()
  return TICKET_REF_RE.test(ref) ? ref : null
}

/** `?tickets=WEB-1,web-2` (or repeated params) -> valid refs only, upper-cased, deduplicated, at most 20. */
export function ticketRefsFromQuery(value: unknown): string[] {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(',') : ''
  const refs = raw.split(',').map(normalizeTicketRef).filter((r): r is string => r !== null)
  return [...new Set(refs)].slice(0, MAX_DISPATCH_TICKETS)
}

/** One more ref, normalized; the list comes back unchanged (as a copy) for junk, a repeat or a full list. */
export function addTicketRef(list: readonly string[], value: string): string[] {
  const ref = normalizeTicketRef(value)
  if (ref === null || list.includes(ref) || list.length >= MAX_DISPATCH_TICKETS) return [...list]
  return [...list, ref]
}

/** Picker suggestions (P1): open tickets not yet chosen whose ref or title contains the query. */
export function matchTicketOptions(options: readonly TicketOption[], chosen: readonly string[], query: string, limit = 8): TicketOption[] {
  const q = query.trim().toLowerCase()
  return options
    .filter(o => isLinkableTicket(o.status) && !chosen.includes(o.ref) && (!q || `${o.ref} ${o.title}`.toLowerCase().includes(q)))
    .slice(0, limit)
}

/** D461: `WEB-12` + `Fix login` -> `web-12-fix-login`; `[a-z0-9-]`, at most 48 chars, never ending with `-`. */
export function ticketFeatureSlug(ref: string, title: string): string {
  const slug = `${ref}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, MAX_TICKET_FEATURE_CHARS).replace(/-+$/, '')
}

/** The ticket page's Dispatch link query (D461). */
export function ticketDispatchQuery(ticket: { ref: string; title: string }): Record<string, string> {
  return { command: 'PLAN', tickets: ticket.ref, feature: ticketFeatureSlug(ticket.ref, ticket.title) }
}

/** PLAN -> RUN hand-off (spec §4): the PLAN job's refs, comma-separated; empty when it has none. */
export function ticketsQueryValue(tickets: readonly FleetJobTicketDto[] | null | undefined): string {
  return (tickets ?? []).map(t => t.ref).join(',')
}

/** The reason a Fleet runs row shows; same choice as apps/api/src/fleet/tickets/failure-comment.ts. */
export function runReason(job: Pick<TicketFleetJobDto, 'state' | 'stateReason' | 'escalationReason'>): string | null {
  if (!REASON_STATES.has(job.state)) return null
  const raw = job.state === 'ESCALATED' ? (job.escalationReason?.trim() || job.stateReason) : job.stateReason
  return raw?.trim() || null
}

/** The live state of a run's PR, from the ticket's own link (the refresher keeps it current, D456). */
export function runPrState(
  job: Pick<TicketFleetJobDto, 'resultPrUrl'>,
  links: ReadonlyArray<{ url: string; prState?: string | null }>,
): string | null {
  if (!job.resultPrUrl) return null
  return links.find(l => l.url === job.resultPrUrl)?.prState ?? null
}

/** P3: a listed job changed, or a job was just queued (it may be linked to this ticket). */
export function affectsRuns(event: { jobId: string; state: string }, jobIds: readonly string[]): boolean {
  return jobIds.includes(event.jobId) || event.state === 'QUEUED'
}

export const shortSha = (sha: string | null): string | null => (sha ? sha.slice(0, 7) : null)
```

- [ ] **Step 5: Add `ticketRefs` to the dispatch form logic**

In `apps/web/lib/fleet-dispatch.ts`:

1. Add the import below the existing ones:

```ts
import { MAX_DISPATCH_TICKETS, TICKET_REF_RE, ticketRefsFromQuery } from '~/lib/fleet-ticket-links'
```

2. In `buildDispatchSchema`, after the `pinnedRunnerId` line, add:

```ts
    ticketRefs: z.array(z.string()).max(MAX_DISPATCH_TICKETS, t('fleet.dispatch.validation.tickets'))
      .refine(list => list.every(r => TICKET_REF_RE.test(r)), t('fleet.dispatch.validation.tickets')),
```

3. In `DISPATCH_DEFAULTS`, after `pinnedRunnerId: '',` add `ticketRefs: [],`.

4. In `toDispatchBody`'s returned object, after the placement spread line, add:

```ts
    ...(v.ticketRefs.length > 0 ? { ticketRefs: [...v.ticketRefs] } : {}),
```

5. In `DispatchQuery`, add `readonly tickets?: unknown` after `readonly ref?: unknown`.

6. In `dispatchPrefillFromQuery`, before `return prefill`, add:

```ts
  const ticketRefs = ticketRefsFromQuery(query.tickets)
  if (ticketRefs.length > 0) prefill.ticketRefs = ticketRefs
```

7. Below `dispatchPrefillFromQuery`, add:

```ts
/** P7: the notice a prefilled form shows: from a ticket (tickets, no ref), else from a PLAN job or an admin link. */
export function prefillNotice(prefill: Partial<DispatchFormValues>): 'ticket' | 'plan' | null {
  if (Object.keys(prefill).length === 0) return null
  return prefill.ticketRefs !== undefined && prefill.ref === undefined ? 'ticket' : 'plan'
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/fleet-ticket-links.spec.ts tests/lib/fleet-dispatch.spec.ts`
Expected: PASS, including every pre-existing `fleet-dispatch` test (a minimal RUN still sends no `ticketRefs`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-ticket-links.ts apps/web/lib/fleet-dispatch.ts apps/web/tests/lib/fleet-ticket-links.spec.ts apps/web/tests/lib/fleet-dispatch.spec.ts
git commit -m "feat(web): fleet ticket link helpers and dispatch ticketRefs (C9 slice 2)"
```

---

### Task 3: Ticket picker on the dispatch form

**Files:**
- Create: `apps/web/components/fleet/TicketPicker.vue`
- Modify: `apps/web/pages/[project]/fleet/dispatch.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`fleet.dispatch`)
- Test: `apps/web/tests/components/fleet-ticket-picker.spec.ts` (new); modify `apps/web/tests/pages/fleet-dispatch-page.spec.ts`, `apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts`

**Interfaces:**
- Consumes: Task 2's `addTicketRef`, `isLinkableTicket`, `matchTicketOptions`, `normalizeTicketRef`, `MAX_DISPATCH_TICKETS`, `TicketOption`, `removeToken` (existing in `fleet-dispatch.ts`), `prefillNotice`.
- Produces: `FleetTicketPicker` props `{ slug: string; modelValue: string[]; testId: string }`, emits `update:modelValue: string[]`; test ids `${testId}-item` (with `data-ref`), `${testId}-input`, `${testId}-suggestion` (with `data-ref`), `${testId}-full`. The dispatch page uses `test-id="dispatch-tickets"` (Task 7 relies on these ids).

- [ ] **Step 1: Add the i18n keys**

In `apps/web/i18n/locales/en.json`, inside `fleet.dispatch`, after `"prefilled": ...,` insert:

```json
      "prefilledTicket": "Pre-filled from the ticket. Pick the repo, and for a PLAN the spec path, before dispatching.",
      "tickets": "Tickets",
      "ticketsHint": "The job is linked to these tickets. A RUN moves CREATED and VERIFIED tickets to In progress.",
      "ticketsPlaceholder": "Search by ref or title, or type a ref and press Enter",
      "ticketsMax": "At most 20 tickets per job",
```

and inside `fleet.dispatch.validation`, after `"labelsOrPin": ...` (add a comma to that line):

```json
        "tickets": "Use ticket refs like WEB-12, at most 20"
```

In `apps/web/i18n/locales/zh.json`, the same keys at the same places:

```json
      "prefilledTicket": "已根据工单预填。派发前请选择仓库；PLAN 还需填写规格文件路径。",
      "tickets": "工单",
      "ticketsHint": "任务将关联这些工单。RUN 会将 CREATED 和 VERIFIED 状态的工单移至进行中。",
      "ticketsPlaceholder": "按编号或标题搜索，或输入编号后按 Enter",
      "ticketsMax": "每个任务最多 20 个工单",
```

```json
        "tickets": "请使用 WEB-12 这样的工单编号，最多 20 个"
```

Check: `cd apps/web && node -e "JSON.parse(require('fs').readFileSync('i18n/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('i18n/locales/zh.json','utf8'))"` prints nothing.

- [ ] **Step 2: Write the failing picker test**

`apps/web/tests/components/fleet-ticket-picker.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const picker = webFile('components', 'fleet', 'TicketPicker.vue')
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const page = {
  records: [
    { ref: 'WEB-12', title: 'Login fails', status: 'CREATED', id: 'x', priority: 'HIGH' },
    { ref: 'WEB-11', title: 'Old one', status: 'CLOSED' },
    { ref: 'WEB-1', title: 'Export is slow', status: 'IN_PROGRESS' },
  ],
}

function mountPicker(modelValue: string[], opts: { fail?: boolean } = {}) {
  const gets: Array<{ path: string; query: unknown }> = []
  const api = {
    get: async (path: string, init?: { query?: unknown }) => {
      gets.push({ path, query: init?.query })
      if (opts.fail) throw new Error('down')
      return page
    },
  }
  const app = mountSfc(picker, {
    components: uiStubs,
    props: { slug: 'web', modelValue, testId: 'dispatch-tickets' },
    globals: { useI18n: () => enI18n(), useApi: () => ({ $api: api }) },
  })
  return { app, gets }
}

const byTestid = (app: ReturnType<typeof mountSfc>, testid: string) =>
  app.find('[data-testid="' + testid + '"]')

describe('FleetTicketPicker (C9 §4, P1)', () => {
  test('loads 100 newest tickets once and suggests open ones only', async () => {
    const { app, gets } = mountPicker([])
    await flush()
    expect(gets).toEqual([{ path: '/projects/web/tickets', query: { size: '100' } }])
    expect(byTestid(app, 'dispatch-tickets-suggestion').map(s => s.props['data-ref'])).toEqual(['WEB-12', 'WEB-1'])
    app.unmount()
  })

  test('chosen refs show as chips with their title; a suggestion click emits the longer list', async () => {
    const { app } = mountPicker(['WEB-12'])
    await flush()
    const chips = byTestid(app, 'dispatch-tickets-item')
    expect(chips.map(c => c.props['data-ref'])).toEqual(['WEB-12'])
    expect(app.textOf(chips[0])).toContain('Login fails')
    const suggestion = byTestid(app, 'dispatch-tickets-suggestion')[0]
    ;(suggestion.props.onClick as () => void)()
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-12', 'WEB-1']]])
    app.unmount()
  })

  test('Enter adds a typed ref exactly, not the first match (WEB-1 while WEB-12 is listed first)', async () => {
    const { app } = mountPicker([])
    await flush()
    const input = byTestid(app, 'dispatch-tickets-input')[0]
    ;(input.props['onUpdate:modelValue'] as (v: string) => void)('web-1')
    await flush()
    ;(input.props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-1']]])
    app.unmount()
  })

  test('Enter on free text adds the first match; on no match adds nothing', async () => {
    const { app } = mountPicker([])
    await flush()
    const input = byTestid(app, 'dispatch-tickets-input')[0]
    ;(input.props['onUpdate:modelValue'] as (v: string) => void)('export')
    await flush()
    ;(input.props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    ;(byTestid(app, 'dispatch-tickets-input')[0].props['onUpdate:modelValue'] as (v: string) => void)('zzz')
    await flush()
    ;(byTestid(app, 'dispatch-tickets-input')[0].props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-1']]])
    app.unmount()
  })

  test('a chip remove emits the shorter list', async () => {
    const { app } = mountPicker(['WEB-12', 'WEB-1'])
    await flush()
    const remove = app.find('[data-stub="button"]').find(b => b.props['aria-label'] === 'Remove WEB-12')
    ;(remove?.props.onClick as () => void)()
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-1']]])
    app.unmount()
  })

  test('a full list disables the input and says so', async () => {
    const full = Array.from({ length: 20 }, (_, i) => `WEB-${i + 100}`)
    const { app } = mountPicker(full)
    await flush()
    expect(byTestid(app, 'dispatch-tickets-input')[0].props.disabled).toBe(true)
    expect(byTestid(app, 'dispatch-tickets-full')).toHaveLength(1)
    expect(byTestid(app, 'dispatch-tickets-suggestion')).toHaveLength(0)
    app.unmount()
  })

  test('a failed load leaves typing working (no suggestions, no throw)', async () => {
    const { app } = mountPicker([], { fail: true })
    await flush()
    expect(byTestid(app, 'dispatch-tickets-suggestion')).toHaveLength(0)
    const input = byTestid(app, 'dispatch-tickets-input')[0]
    ;(input.props['onUpdate:modelValue'] as (v: string) => void)('WEB-5')
    await flush()
    ;(byTestid(app, 'dispatch-tickets-input')[0].props.onKeydown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined })
    expect(app.emitted('update:modelValue')).toEqual([[['WEB-5']]])
    app.unmount()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/components/fleet-ticket-picker.spec.ts`
Expected: FAIL (the component file does not exist).

- [ ] **Step 4: Write the picker**

`apps/web/components/fleet/TicketPicker.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { apiPath } from '~/lib/api-path'
import { removeToken } from '~/lib/fleet-dispatch'
import { addTicketRef, isLinkableTicket, matchTicketOptions, MAX_DISPATCH_TICKETS, normalizeTicketRef, type TicketOption } from '~/lib/fleet-ticket-links'
import type { FleetPage } from '~/lib/fleet-types'

/** Dispatch tickets (C9 §4): picked from the newest open tickets or typed as KEY-N; the server validates (D450). */
const props = defineProps<{ slug: string; modelValue: string[]; testId: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useI18n()
const { $api } = useApi()

/** P1: one page of the newest tickets; older open tickets are typed by ref. */
const OPTION_PAGE_SIZE = '100'
const options = ref<TicketOption[]>([])
const query = ref('')

onMounted(async () => {
  try {
    const page = await $api.get<FleetPage<TicketOption>>(apiPath`/projects/${props.slug}/tickets`, { query: { size: OPTION_PAGE_SIZE } })
    options.value = (page.records ?? [])
      .filter(o => isLinkableTicket(o.status))
      .map(o => ({ ref: o.ref, title: o.title, status: o.status }))
  }
  catch {
    // Suggestions are a convenience: refs can still be typed.
  }
})

const full = computed(() => props.modelValue.length >= MAX_DISPATCH_TICKETS)
const matches = computed(() => matchTicketOptions(options.value, props.modelValue, query.value))
const titleOf = (ticketRef: string): string | null => options.value.find(o => o.ref === ticketRef)?.title ?? null

function add(value: string): void {
  emit('update:modelValue', addTicketRef(props.modelValue, value))
  query.value = ''
}

/** Enter: the typed ref exactly when it is one (so WEB-1 never becomes WEB-12), else the first match. */
function addFromQuery(): void {
  const choice = normalizeTicketRef(query.value) ?? matches.value[0]?.ref
  if (choice) add(choice)
}

function remove(ticketRef: string): void {
  emit('update:modelValue', removeToken(props.modelValue, ticketRef))
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-2">
      <Badge v-for="item in modelValue" :key="item" variant="secondary" class="max-w-full gap-1" :data-testid="`${testId}-item`" :data-ref="item">
        <span class="font-mono">{{ item }}</span>
        <span v-if="titleOf(item)" class="max-w-[16rem] truncate text-muted-foreground">{{ titleOf(item) }}</span>
        <Button type="button" variant="ghost" size="icon" class="h-4 w-4" :aria-label="t('fleet.dispatch.remove', { item })" @click="remove(item)">
          <X class="h-3 w-3" />
        </Button>
      </Badge>
    </div>
    <Input
      v-model="query"
      :disabled="full"
      :placeholder="t('fleet.dispatch.ticketsPlaceholder')"
      :aria-label="t('fleet.dispatch.tickets')"
      :data-testid="`${testId}-input`"
      @keydown.enter.prevent="addFromQuery()"
    />
    <p v-if="full" class="text-xs text-muted-foreground" :data-testid="`${testId}-full`">{{ t('fleet.dispatch.ticketsMax') }}</p>
    <div v-else-if="matches.length > 0" class="flex flex-wrap gap-2">
      <Button
        v-for="option in matches"
        :key="option.ref"
        type="button"
        variant="ghost"
        size="sm"
        class="max-w-full truncate"
        :data-testid="`${testId}-suggestion`"
        :data-ref="option.ref"
        @click="add(option.ref)"
      >
        + {{ option.ref }} {{ option.title }}
      </Button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: Run the picker test to verify it passes**

Run: `cd apps/web && bunx jest tests/components/fleet-ticket-picker.spec.ts`
Expected: PASS.

- [ ] **Step 6: Wire the dispatch page (failing source test first)**

In `apps/web/tests/pages/fleet-dispatch-page.spec.ts`, add inside `describe('dispatch page', ...)`:

```ts
  test('C9: a Tickets field bound to ticketRefs, prefilled from ?tickets= with its own notice (P7)', () => {
    expect(dispatch).toContain("import FleetTicketPicker from '~/components/fleet/TicketPicker.vue'")
    expect(dispatch).toMatch(/<FormField name="ticketRefs">[\s\S]*?<FleetTicketPicker[\s\S]*?:model-value="values\.ticketRefs \?\? \[\]"[\s\S]*?test-id="dispatch-tickets"[\s\S]*?@update:model-value="setFieldValue\('ticketRefs', \$event\)"/)
    expect(dispatch).toContain("setFieldValue('ticketRefs', prefill.ticketRefs)")
    expect(dispatch).toContain('prefilled.value = applied ? prefillNotice(prefill) : null')
    expect(dispatch).toContain("prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled')")
  })
```

Run: `cd apps/web && bunx jest tests/pages/fleet-dispatch-page.spec.ts`
Expected: the new test FAILS.

Then edit `apps/web/pages/[project]/fleet/dispatch.vue`:

1. Imports: change the `fleet-dispatch` import to

```ts
import { buildDispatchSchema, DISPATCH_DEFAULTS, dispatchPrefillFromQuery, prefillNotice, toDispatchBody } from '~/lib/fleet-dispatch'
```

and add below `import FleetTokenListInput ...`:

```ts
import FleetTicketPicker from '~/components/fleet/TicketPicker.vue'
```

2. Replace `const prefilled = ref(false)` with:

```ts
/** P7: which prefill notice to show, if any. */
const prefilled = ref<'ticket' | 'plan' | null>(null)
```

3. In `onMounted`, after the `prefill.ref` line, add:

```ts
  if (prefill.ticketRefs !== undefined) { setFieldValue('ticketRefs', prefill.ticketRefs); applied = true }
```

and replace `prefilled.value = applied` with:

```ts
  prefilled.value = applied ? prefillNotice(prefill) : null
```

4. In the template, replace the prefilled paragraph's text `{{ t('fleet.dispatch.prefilled') }}` with:

```vue
{{ prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled') }}
```

5. In the template, between the `planFrom` `FormField` and the `profiles` `FormField`, add:

```vue
      <FormField name="ticketRefs">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.tickets') }}</FormLabel>
          <FleetTicketPicker
            :slug="slug"
            :model-value="values.ticketRefs ?? []"
            test-id="dispatch-tickets"
            @update:model-value="setFieldValue('ticketRefs', $event)"
          />
          <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.ticketsHint') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>
```

6. The placement runtime test mounts the real page; the real picker would call `useApi`, which that test does not supply. In `apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts`, extend its `alias` option:

```ts
      alias: {
        '~/components/fleet/FleetTokenListInput.vue': TokenInput,
        '~/components/fleet/TicketPicker.vue': { render: () => null },
      },
```

- [ ] **Step 7: Run the dispatch tests to verify they pass**

Run: `cd apps/web && bunx jest tests/pages/fleet-dispatch-page.spec.ts tests/pages/fleet-dispatch-placement-runtime.spec.ts tests/components/fleet-ticket-picker.spec.ts tests/i18n`
Expected: PASS (the runtime test still dispatches once; `used-keys-exist` finds the new literal keys in both locales; fleet parity holds).

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/fleet/TicketPicker.vue apps/web/pages/[project]/fleet/dispatch.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/components/fleet-ticket-picker.spec.ts apps/web/tests/pages/fleet-dispatch-page.spec.ts apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts
git commit -m "feat(web): tickets field on the fleet dispatch form (C9 slice 2)"
```

---

### Task 4: The Fleet runs card (`TicketFleetRuns`)

**Files:**
- Create: `apps/web/components/TicketFleetRuns.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (new `fleet.tickets` subtree)
- Test: `apps/web/tests/components/ticket-fleet-runs.spec.ts` (new)

**Interfaces:**
- Consumes: Task 2's `affectsRuns`, `runPrState`, `runReason`, `shortSha`, `TicketFleetJobDto`; existing `formatUsd`, `safePrUrl` (`lib/fleet-jobs.ts`), `createDebouncer` (`lib/debounce.ts`), `extractApiError` (`composables/useApi.ts`), `FleetJobStateBadge`, the `FleetAge` auto-import.
- Produces: `TicketFleetRuns` props `{ projectSlug: string; ticketRef: string; ticketId: string; ticketLinks: Array<{ url: string; prState?: string | null }>; canWork: boolean }`, emits `changed` after a successful unlink. Test ids: `ticket-fleet-runs` (section), `ticket-fleet-run` (row, `data-job`), `ticket-fleet-run-link`, `-command`, `-branch`, `-pr`, `-pr-state` (`data-state`), `-cost`, `-reason`, `-unlink`, `-unlink-confirm` (Task 5 and Task 7 rely on these).

- [ ] **Step 1: Add the i18n keys**

In `apps/web/i18n/locales/en.json`, inside `fleet`, after the `"dispatch": { ... },` block, add:

```json
    "tickets": {
      "title": "Fleet runs",
      "dispatch": "Dispatch",
      "viaFleet": "via fleet",
      "pr": "PR",
      "unlink": "Unlink",
      "unlinkTitle": "Unlink this fleet job?",
      "unlinkBody": "The job, its PR and the ticket history stay. The job leaves this ticket, and its fleet PR link is removed from the ticket.",
      "unlinked": "Fleet job unlinked"
    },
```

In `apps/web/i18n/locales/zh.json`, at the same place:

```json
    "tickets": {
      "title": "Fleet 运行",
      "dispatch": "派发",
      "viaFleet": "来自 fleet",
      "pr": "PR",
      "unlink": "取消关联",
      "unlinkTitle": "取消关联此 fleet 任务？",
      "unlinkBody": "任务、其 PR 和工单历史都会保留。该任务将不再显示在此工单上，其 fleet PR 链接也会从工单中移除。",
      "unlinked": "已取消关联 fleet 任务"
    },
```

(`dispatch` and `viaFleet` are used by Task 5.)

- [ ] **Step 2: Write the failing component test**

`apps/web/tests/components/ticket-fleet-runs.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, toastRecorder, uiStubs } from '../helpers/fleet-harness'
import type { TicketFleetJobDto } from '../../lib/fleet-types'
import type { ProjectEventHandlers } from '../../lib/project-event-stream'

const card = webFile('components', 'TicketFleetRuns.vue')
const LIST = '/projects/web/tickets/WEB-1/fleet-jobs'
const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Past the card's 300 ms live debounce. */
const settle = (): Promise<void> => wait(350)

const run = (id: string, over: Partial<TicketFleetJobDto> = {}): TicketFleetJobDto => ({
  id, command: 'RUN', feature: `feat-${id}`, state: 'COMPLETED', stateReason: null, escalationReason: null,
  resultBranch: null, resultSha: null, resultPrUrl: null, costUsd: '0.4200',
  queuedAt: '2026-10-07T00:00:00.000Z', finishedAt: '2026-10-07T00:10:00.000Z', ...over,
})

/** Each GET answers the next entry (the last one repeats); `'fail'` makes that GET throw. */
function mountCard(opts: { lists: Array<TicketFleetJobDto[] | 'fail'>; links?: unknown[]; canWork?: boolean; deleteFails?: boolean }) {
  const gets: string[] = []
  const deletes: string[] = []
  let handlers: ProjectEventHandlers | null = null
  const toast = toastRecorder()
  const api = {
    get: async (path: string) => {
      gets.push(path)
      const next = opts.lists[Math.min(gets.length - 1, opts.lists.length - 1)]
      if (next === 'fail') throw new Error('down')
      return next
    },
    delete: async (path: string) => {
      deletes.push(path)
      if (opts.deleteFails) throw Object.assign(new Error('gone'), { data: { message: 'Not linked' } })
    },
  }
  const app = mountSfc(card, {
    components: uiStubs,
    props: { projectSlug: 'web', ticketRef: 'WEB-1', ticketId: 't1', ticketLinks: opts.links ?? [], canWork: opts.canWork ?? true },
    globals: {
      useI18n: () => enI18n(),
      useAppToast: () => toast,
      useApi: () => ({ $api: api }),
      useProjectEvents: (_slug: string, h: ProjectEventHandlers) => { handlers = h },
    },
  })
  const events = (): ProjectEventHandlers => {
    if (!handlers) throw new Error('useProjectEvents was not called')
    return handlers
  }
  return { app, gets, deletes, toast, events }
}

const rowOf = (app: ReturnType<typeof mountSfc>, jobId: string) =>
  app.find('[data-testid="ticket-fleet-run"]').find((r) => r.props['data-job'] === jobId)
const inRow = (app: ReturnType<typeof mountSfc>, jobId: string, testid: string) => {
  const row = rowOf(app, jobId)
  return row ? app.find(`[data-testid="${testid}"]`, row) : []
}

describe('TicketFleetRuns (C9 §4, D461)', () => {
  test('renders nothing when the ticket has no fleet jobs', async () => {
    const { app, gets } = mountCard({ lists: [[]] })
    await wait()
    expect(gets).toEqual([LIST])
    expect(app.one('[data-testid="ticket-fleet-runs"]')).toBeUndefined()
    app.unmount()
  })

  test('a row: command, state, link to the job, branch with short sha, PR with its live state, cost', async () => {
    const pr = 'https://github.com/acme/app/pull/7'
    const { app } = mountCard({
      lists: [[run('j1', { resultBranch: 'feat/x', resultSha: 'abcdef1234567', resultPrUrl: pr })]],
      links: [{ url: pr, linkType: 'pr', prState: 'merged' }],
    })
    await wait()
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-command')[0])).toBe('RUN')
    expect(inRow(app, 'j1', 'fleet-job-state')[0].props['data-state']).toBe('COMPLETED')
    expect(inRow(app, 'j1', 'ticket-fleet-run-link')[0].props.to).toBe('/web/fleet/jobs/j1')
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-branch')[0])).toBe('feat/x (abcdef1)')
    expect(inRow(app, 'j1', 'ticket-fleet-run-pr-state')[0].props['data-state']).toBe('merged')
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-cost')[0])).toBe('$0.42')
    expect(inRow(app, 'j1', 'ticket-fleet-run-reason')).toHaveLength(0)
    const prLink = app.find('a').find((a) => a.props.href === pr)
    expect(prLink?.props.rel).toBe('noopener noreferrer')
    app.unmount()
  })

  test('failure reasons follow the comment rule; an http PR URL is text, not a link', async () => {
    const { app } = mountCard({
      lists: [[
        run('j1', { state: 'FAILED', stateReason: 'acceptance failed' }),
        run('j2', { state: 'ESCALATED', stateReason: 's', escalationReason: 'needs a human' }),
        run('j3', { resultPrUrl: 'http://example.com/pull/1' }),
      ]],
    })
    await wait()
    expect(app.textOf(inRow(app, 'j1', 'ticket-fleet-run-reason')[0])).toBe('acceptance failed')
    expect(app.textOf(inRow(app, 'j2', 'ticket-fleet-run-reason')[0])).toBe('needs a human')
    expect(app.find('a').some((a) => a.props.href === 'http://example.com/pull/1')).toBe(false)
    expect(app.textOf(inRow(app, 'j3', 'ticket-fleet-run-pr')[0])).toContain('http://example.com/pull/1')
    app.unmount()
  })

  test('live: refetches for this ticket, a listed job, a newly queued job and a resync; not for others (P3)', async () => {
    const { app, gets, events } = mountCard({ lists: [[run('j1', { state: 'RUNNING' })]] })
    await wait()
    const fleetJob = (jobId: string, state: string) => ({ id: 'e', type: 'fleet_job' as const, projectId: 'p', jobId, state, at: '' })
    const ticketEvent = (ticketId: string) => ({ id: 'e', type: 'ticket' as const, action: 'updated' as const, projectId: 'p', ticketId, actorId: 'u', at: '' })

    events().onFleetJob?.(fleetJob('j9', 'RUNNING'))
    events().onEvent?.(ticketEvent('t2'))
    await settle()
    expect(gets).toHaveLength(1)

    events().onFleetJob?.(fleetJob('j1', 'FAILED'))
    await settle()
    expect(gets).toHaveLength(2)
    events().onFleetJob?.(fleetJob('j9', 'QUEUED'))
    await settle()
    expect(gets).toHaveLength(3)
    events().onEvent?.(ticketEvent('t1'))
    await settle()
    expect(gets).toHaveLength(4)
    events().onResync()
    await settle()
    expect(gets).toHaveLength(5)
    app.unmount()
  })

  test('a failed load keeps the rows on screen and shows no toast (P4)', async () => {
    const { app, gets, toast, events } = mountCard({ lists: [[run('j1')], 'fail'] })
    await wait()
    events().onResync()
    await settle()
    expect(gets).toHaveLength(2)
    expect(rowOf(app, 'j1')).toBeDefined()
    expect(toast.errors).toEqual([])
    app.unmount()
  })

  test('Unlink needs canWork, asks first, deletes, reloads and tells the page', async () => {
    const viewer = mountCard({ lists: [[run('j1')]], canWork: false })
    await wait()
    expect(viewer.app.find('[data-testid="ticket-fleet-run-unlink"]')).toHaveLength(0)
    viewer.app.unmount()

    const { app, gets, deletes, toast } = mountCard({ lists: [[run('j1')], []] })
    await wait()
    expect(deletes).toEqual([])
    ;(inRow(app, 'j1', 'ticket-fleet-run-unlink')[0].props.onClick as () => void)()
    await wait()
    expect(deletes).toEqual([])
    await (app.one('[data-testid="ticket-fleet-run-unlink-confirm"]')?.props.onClick as () => Promise<void>)()
    await wait()
    expect(deletes).toEqual(['/projects/web/tickets/WEB-1/fleet-jobs/j1'])
    expect(toast.successes).toEqual(['Fleet job unlinked'])
    expect(app.emitted('changed')).toHaveLength(1)
    expect(gets).toHaveLength(2)
    expect(app.one('[data-testid="ticket-fleet-runs"]')).toBeUndefined()
    app.unmount()
  })

  test('an Unlink that fails (already unlinked) toasts the API message and reloads, without "changed"', async () => {
    const { app, gets, toast } = mountCard({ lists: [[run('j1')], []], deleteFails: true })
    await wait()
    ;(inRow(app, 'j1', 'ticket-fleet-run-unlink')[0].props.onClick as () => void)()
    await wait()
    await (app.one('[data-testid="ticket-fleet-run-unlink-confirm"]')?.props.onClick as () => Promise<void>)()
    await wait()
    expect(toast.errors).toEqual(['Not linked'])
    expect(app.emitted('changed')).toHaveLength(0)
    expect(gets).toHaveLength(2)
    app.unmount()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/components/ticket-fleet-runs.spec.ts`
Expected: FAIL (the component file does not exist).

- [ ] **Step 4: Write the component**

`apps/web/components/TicketFleetRuns.vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'
import { createDebouncer } from '~/lib/debounce'
import { formatUsd, safePrUrl } from '~/lib/fleet-jobs'
import { affectsRuns, runPrState, runReason, shortSha } from '~/lib/fleet-ticket-links'
import type { TicketFleetJobDto } from '~/lib/fleet-types'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'

/** C9 §4 (D461): the ticket's fleet jobs, read live from FleetJob; hidden when there are none. */
const props = defineProps<{
  projectSlug: string
  ticketRef: string
  ticketId: string
  ticketLinks: ReadonlyArray<{ url: string; prState?: string | null }>
  canWork: boolean
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const { t } = useI18n()
const { $api } = useApi()
const toast = useAppToast()

const LIVE_RELOAD_DEBOUNCE_MS = 300
const runs = ref<TicketFleetJobDto[]>([])
const now = ref(new Date())
const unlinkTarget = ref<TicketFleetJobDto | null>(null)
const unlinking = ref(false)

/** P4: secondary content. A failed load keeps what is on screen; the next live event or resync retries. */
async function load(): Promise<void> {
  try {
    runs.value = await $api.get<TicketFleetJobDto[]>(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/fleet-jobs`)
    now.value = new Date()
  }
  catch {
    // Keep the last list.
  }
}

const liveReload = createDebouncer(() => { void load() }, LIVE_RELOAD_DEBOUNCE_MS)
onMounted(load)
onBeforeUnmount(() => liveReload.cancel())

useProjectEvents(props.projectSlug, {
  onEvent: (event) => {
    if (event.ticketId === props.ticketId) liveReload.trigger()
  },
  onFleetJob: (event) => {
    if (affectsRuns(event, runs.value.map(r => r.id))) liveReload.trigger()
  },
  onResync: () => liveReload.trigger(),
})

const rows = computed(() => runs.value.map(run => ({
  run,
  reason: runReason(run),
  prUrl: safePrUrl(run.resultPrUrl),
  prState: runPrState(run, props.ticketLinks),
  sha: shortSha(run.resultSha),
  at: run.finishedAt ?? run.queuedAt,
})))

function closeUnlink(open: boolean): void {
  if (!open) unlinkTarget.value = null
}

async function confirmUnlink(): Promise<void> {
  const target = unlinkTarget.value
  if (!target) return
  unlinking.value = true
  try {
    await $api.delete(apiPath`/projects/${props.projectSlug}/tickets/${props.ticketRef}/fleet-jobs/${target.id}`)
    toast.success(t('fleet.tickets.unlinked'))
    emit('changed')
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    unlinking.value = false
    unlinkTarget.value = null
    await load()
  }
}
</script>

<template>
  <section v-if="runs.length > 0" class="overflow-hidden rounded-lg border bg-card" :aria-label="t('fleet.tickets.title')" data-testid="ticket-fleet-runs">
    <h2 class="border-b px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('fleet.tickets.title') }}</h2>
    <ul class="divide-y">
      <li v-for="row in rows" :key="row.run.id" class="flex flex-col gap-1.5 px-3.5 py-3 text-sm" data-testid="ticket-fleet-run" :data-job="row.run.id">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline" data-testid="ticket-fleet-run-command">{{ row.run.command }}</Badge>
          <FleetJobStateBadge :state="row.run.state" />
          <NuxtLink :to="`/${projectSlug}/fleet/jobs/${row.run.id}`" class="min-w-0 truncate font-medium text-primary underline-offset-4 hover:underline" data-testid="ticket-fleet-run-link">{{ row.run.feature }}</NuxtLink>
          <span class="ml-auto text-xs text-muted-foreground"><FleetAge :iso="row.at" :now="now" mode="ago" /></span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span v-if="row.run.resultBranch" class="break-all font-mono" data-testid="ticket-fleet-run-branch">{{ row.run.resultBranch }}<template v-if="row.sha"> ({{ row.sha }})</template></span>
          <span v-if="row.run.resultPrUrl" class="flex items-center gap-1.5" data-testid="ticket-fleet-run-pr">
            <a v-if="row.prUrl" :href="row.prUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline-offset-4 hover:underline">{{ t('fleet.tickets.pr') }}</a>
            <span v-else class="break-all">{{ row.run.resultPrUrl }}</span>
            <Badge v-if="row.prState" variant="outline" data-testid="ticket-fleet-run-pr-state" :data-state="row.prState">{{ t(`tickets.pr.status.${row.prState}`) }}</Badge>
          </span>
          <span data-testid="ticket-fleet-run-cost">{{ formatUsd(row.run.costUsd) }}</span>
        </div>
        <p v-if="row.reason" class="whitespace-pre-wrap break-words text-xs text-status-rejected" data-testid="ticket-fleet-run-reason">{{ row.reason }}</p>
        <div v-if="canWork" class="flex justify-end">
          <Button size="sm" variant="ghost" data-testid="ticket-fleet-run-unlink" @click="unlinkTarget = row.run">{{ t('fleet.tickets.unlink') }}</Button>
        </div>
      </li>
    </ul>

    <Dialog :open="unlinkTarget !== null" @update:open="closeUnlink">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ t('fleet.tickets.unlinkTitle') }}</DialogTitle>
          <DialogDescription>{{ t('fleet.tickets.unlinkBody') }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="unlinkTarget = null">{{ t('common.cancel') }}</Button>
          <Button variant="destructive" :disabled="unlinking" data-testid="ticket-fleet-run-unlink-confirm" @click="confirmUnlink()">{{ t('fleet.tickets.unlink') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/components/ticket-fleet-runs.spec.ts tests/i18n`
Expected: PASS. If the `FleetAge` stub or `FleetJobStateBadge` does not resolve in the harness, check `tests/helpers/fleet-harness.ts` `uiStubs` (it stubs `FleetAge` as `fleet-age`); do not weaken an assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/TicketFleetRuns.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/components/ticket-fleet-runs.spec.ts
git commit -m "feat(web): Fleet runs card for tickets with unlink (C9 slice 2, D461)"
```

---

### Task 5: Ticket page — Dispatch button, the card, "via fleet", live links

**Files:**
- Modify: `apps/web/components/TicketHeader.vue` (props ~line 22, actions ~line 100)
- Modify: `apps/web/components/TicketProperties.vue` (`TicketLink` interface ~line 19, PR row ~line 357)
- Modify: `apps/web/pages/[project]/tickets/[ref].vue`
- Test: `apps/web/tests/components/ticket-header-dispatch.spec.ts` (new), `apps/web/tests/pages/ticket-fleet-wiring.spec.ts` (new)

**Interfaces:**
- Consumes: Task 2's `ticketDispatchQuery`, `isLinkableTicket`; Task 4's `TicketFleetRuns`; i18n `fleet.tickets.dispatch`, `fleet.tickets.viaFleet` (Task 4).
- Produces: `TicketHeader` prop `dispatchHref?: { path: string; query: Record<string, string> } | null`; test ids `ticket-fleet-dispatch`, `ticket-link-via-fleet` (Task 7 relies on both).

- [ ] **Step 1: Write the failing `TicketHeader` test**

`apps/web/tests/components/ticket-header-dispatch.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import * as Vue from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const header = webFile('components', 'TicketHeader.vue')
const ticket = { id: 't1', ref: 'WEB-3', title: 'Add CSV export', type: 'ENHANCEMENT', priority: 'HIGH', status: 'CREATED', createdAt: '2026-10-07T00:00:00.000Z' }
const href = { path: '/web/fleet/dispatch', query: { command: 'PLAN', tickets: 'WEB-3', feature: 'web-3-add-csv-export' } }

function mountHeader(props: Record<string, unknown>) {
  return mountSfc(header, {
    components: uiStubs,
    props: { ticket, editing: false, editTitle: '', editPriority: 'HIGH', ...props },
    globals: { useI18n: () => ({ ...enI18n(), locale: Vue.ref('en') }) },
  })
}

describe('TicketHeader Dispatch link (C9 §4, D461)', () => {
  test('renders the link with the given target', () => {
    const app = mountHeader({ dispatchHref: href })
    const link = app.one('[data-testid="ticket-fleet-dispatch"]')
    expect(link?.props.to).toEqual(href)
    expect(link && app.textOf(link).trim()).toBe('Dispatch')
    app.unmount()
  })

  test('hidden without a target and while editing', () => {
    for (const props of [{}, { dispatchHref: null }, { dispatchHref: href, editing: true }]) {
      const app = mountHeader(props)
      expect(app.one('[data-testid="ticket-fleet-dispatch"]')).toBeUndefined()
      app.unmount()
    }
  })
})
```

Run: `cd apps/web && bunx jest tests/components/ticket-header-dispatch.spec.ts`
Expected: FAIL (no `ticket-fleet-dispatch`).

- [ ] **Step 2: Add the Dispatch link to `TicketHeader`**

In `apps/web/components/TicketHeader.vue`:

1. Extend the props:

```ts
const props = defineProps<{
  ticket: Ticket
  editing: boolean
  editTitle: string
  editPriority: TicketPriority
  /** C9 D461: where Dispatch leads; null hides it (no permission, no fleet repo, or a closed ticket). */
  dispatchHref?: { path: string; query: Record<string, string> } | null
}>()
```

2. In the template's `<div class="flex shrink-0 gap-2">`, before the Edit `<Button v-if="!editing" ...>`, add:

```vue
        <NuxtLink
          v-if="!editing && dispatchHref"
          :to="dispatchHref"
          class="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm hover:bg-muted"
          data-testid="ticket-fleet-dispatch"
        >
          {{ t('fleet.tickets.dispatch') }}
        </NuxtLink>
```

Run: `cd apps/web && bunx jest tests/components/ticket-header-dispatch.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing wiring test for the page and `TicketProperties`**

The ticket page and `TicketProperties` are covered by source assertions (the repo's pattern for these files, see `tests/pages/ticket-detail.spec.ts`); their rendered behaviour is covered by Task 7's E2E.

`apps/web/tests/pages/ticket-fleet-wiring.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const page = read('pages', '[project]', 'tickets', '[ref].vue')
const properties = read('components', 'TicketProperties.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('ticket page fleet wiring (C9 §4)', () => {
  test('Dispatch shows for DEVELOPER+ on an open ticket of a project with a fleet repo (D461, P2)', () => {
    expect(page).toContain("import { isLinkableTicket, ticketDispatchQuery } from '~/lib/fleet-ticket-links'")
    expect(page).toContain('apiPath`/projects/${slug}/fleet/repos`')
    expect(page).toContain("{ query: { size: '1' } }")
    expect(page).toMatch(/onMounted\(\(\) => \{\s*watch\(canWork, loadFleetRepoFlag, \{ immediate: true \}\)/)
    expect(page).toContain('if (!current || !canWork.value || !hasFleetRepo.value || !isLinkableTicket(current.status)) return null')
    expect(page).toContain('return { path: `/${slug}/fleet/dispatch`, query: ticketDispatchQuery(current) }')
    expect(page).toContain(':dispatch-href="dispatchHref"')
  })

  test('the Fleet runs card sits under the header and refreshes links after an unlink', () => {
    expect(page).toContain("import TicketFleetRuns from '~/components/TicketFleetRuns.vue'")
    expect(page).toMatch(/<TicketHeader[\s\S]*?\/>\s*<TicketFleetRuns[\s\S]*?:ticket-id="ticket\.id"[\s\S]*?:ticket-links="ticketLinks"[\s\S]*?:can-work="canWork"[\s\S]*?@changed="refetchAll\(\)"/)
  })

  test('live ticket events and resync also reload the links (P5: fleet PR links arrive as TICKET_UPDATED)', () => {
    const handlers = liveHandlers(page)
    expect(handlers.match(/void reloadLinksSilently\(\)/g)).toHaveLength(2)
  })

  test('fleet PR links carry a "via fleet" mark that links to the job (P6)', () => {
    expect(properties).toContain('source?: string')
    expect(properties).toContain('jobId?: string | null')
    expect(properties).toContain("v-if=\"link.source === 'fleet' && link.jobId\"")
    expect(properties).toContain(':to="`/${projectSlug}/fleet/jobs/${link.jobId}`"')
    expect(properties).toContain("v-else-if=\"link.source === 'fleet'\"")
    expect(properties.match(/data-testid="ticket-link-via-fleet"/g)).toHaveLength(2)
    expect(properties).toContain("t('fleet.tickets.viaFleet')")
  })
})
```

Run: `cd apps/web && bunx jest tests/pages/ticket-fleet-wiring.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Add the "via fleet" mark to `TicketProperties`**

In `apps/web/components/TicketProperties.vue`:

1. In `interface TicketLink`, after `title?: string`, add:

```ts
  /** C9 1b: `vcs` (default) or `fleet`; fleet links name the job that opened the PR. */
  source?: string
  jobId?: string | null
```

2. In the PR row (`<div v-for="link in vcsPullRequestLinks" ...>`), after the `<span v-if="link.prState" ...>` chip, add:

```vue
            <NuxtLink
              v-if="link.source === 'fleet' && link.jobId"
              :to="`/${projectSlug}/fleet/jobs/${link.jobId}`"
              :class="[chipClass, 'text-muted-foreground hover:bg-muted']"
              data-testid="ticket-link-via-fleet"
            >{{ t('fleet.tickets.viaFleet') }}</NuxtLink>
            <span v-else-if="link.source === 'fleet'" :class="[chipClass, 'text-muted-foreground']" data-testid="ticket-link-via-fleet">{{ t('fleet.tickets.viaFleet') }}</span>
```

- [ ] **Step 5: Wire the ticket page**

In `apps/web/pages/[project]/tickets/[ref].vue`:

1. Imports: change the `vue` import to include `watch`:

```ts
import { computed, reactive, ref as vueRef, onMounted, onBeforeUnmount, watch } from 'vue'
```

and add below `import TicketProperties ...`:

```ts
import TicketFleetRuns from '~/components/TicketFleetRuns.vue'
import { isLinkableTicket, ticketDispatchQuery } from '~/lib/fleet-ticket-links'
```

2. In the page's `interface TicketLink`, after `title?: string`, add:

```ts
  source?: string
  jobId?: string | null
```

3. In `useProjectEvents(slug, { ... })`, add `void reloadLinksSilently()` in both handlers:

```ts
useProjectEvents(slug, {
  onEvent: (event) => {
    if (!ticket.value || event.ticketId !== ticket.value.id) return
    if (event.action === 'deleted') {
      ticketDeleted.value = true
      return
    }
    liveTicketReload.trigger()
    // Any ticket event may have changed the comment thread (transitions create
    // a VERIFICATION/FIX_REPORT/REVIEW comment), so reload it unconditionally.
    void reloadCommentsSilently()
    // C9 P5: fleet PR links arrive as TICKET_UPDATED.
    void reloadLinksSilently()
  },
  onResync: () => {
    if (ticketDeleted.value) return
    liveTicketReload.trigger()
    void reloadCommentsSilently()
    void reloadLinksSilently()
  },
})
```

4. After `const canWork = computed(...)`, add:

```ts
// C9 §4 (D461, P2): Dispatch needs DEVELOPER+, a fleet repo in the project, and an open ticket.
const hasFleetRepo = vueRef(false)

async function loadFleetRepoFlag(allowed: boolean): Promise<void> {
  if (!allowed || hasFleetRepo.value) return
  try {
    const page = await $api.get<{ records?: unknown[] }>(apiPath`/projects/${slug}/fleet/repos`, { query: { size: '1' } })
    hasFleetRepo.value = (page.records ?? []).length > 0
  }
  catch {
    // No button: dispatching still works from the fleet pages.
  }
}

// Client-only: the role may resolve after mount, and the button is not worth a server round trip.
onMounted(() => {
  watch(canWork, loadFleetRepoFlag, { immediate: true })
})

const dispatchHref = computed(() => {
  const current = ticket.value
  if (!current || !canWork.value || !hasFleetRepo.value || !isLinkableTicket(current.status)) return null
  return { path: `/${slug}/fleet/dispatch`, query: ticketDispatchQuery(current) }
})
```

5. In the template, add `:dispatch-href="dispatchHref"` to `<TicketHeader ...>` (after `:edit-priority`), and directly after the `<TicketHeader ... />` element, inside the same left-column `div`, add:

```vue
        <TicketFleetRuns
          :project-slug="slug"
          :ticket-ref="ref"
          :ticket-id="ticket.id"
          :ticket-links="ticketLinks"
          :can-work="canWork"
          @changed="refetchAll()"
        />
```

- [ ] **Step 6: Run the ticket tests to verify they pass**

Run: `cd apps/web && bunx jest tests/pages/ticket-fleet-wiring.spec.ts tests/components/ticket-header-dispatch.spec.ts tests/pages/ticket-detail.spec.ts tests/pages/ticket-role-visibility.spec.ts tests/pages/ticket-detail-priority.spec.ts tests/components/ticket-detail-redesign.spec.ts tests/openapi tests/i18n`
Expected: PASS (existing ticket page tests unchanged in outcome).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/TicketHeader.vue apps/web/components/TicketProperties.vue "apps/web/pages/[project]/tickets/[ref].vue" apps/web/tests/components/ticket-header-dispatch.spec.ts apps/web/tests/pages/ticket-fleet-wiring.spec.ts
git commit -m "feat(web): ticket page Dispatch button, Fleet runs card and via-fleet PR mark (C9 slice 2)"
```

---

### Task 6: Job page — Tickets row and the hand-off carries `tickets=`

**Files:**
- Modify: `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` (imports, `dispatchRunHref` ~line 70, the `<dl>` ~line 300)
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`fleet.jobs.detail.tickets`)
- Test: `apps/web/tests/pages/fleet-job-detail.spec.ts`

**Interfaces:**
- Consumes: Task 1 (cancel/requeue responses carry `tickets`), Task 2's `ticketsQueryValue`, `lib/ticket-chips.ts` (`TICKET_CHIP_CLASS`, `TICKET_DOT_CLASS`, `STATUS_DOT`).
- Produces: test ids `fleet-job-tickets` (row) and `fleet-job-ticket` (each link, `data-ref`); the RUN hand-off query gains `tickets` (Task 7 relies on both).

- [ ] **Step 1: Add the i18n key**

`apps/web/i18n/locales/en.json`, inside `fleet.jobs.detail`, after `"pr": ...,`: `"tickets": "Tickets",`
`apps/web/i18n/locales/zh.json`, same place: `"tickets": "工单",`

- [ ] **Step 2: Write the failing source tests**

In `apps/web/tests/pages/fleet-job-detail.spec.ts`:

1. In the existing test `'a COMPLETED PLAN offers Dispatch run pre-filled with repo, feature and resultBranch (#205)'`, replace the last assertion line with:

```ts
    expect(detail).toContain("query: { command: 'RUN', repoId: current.repoId, feature: current.feature, ref: current.resultBranch, ...(tickets ? { tickets } : {}) }")
```

2. Add inside the `describe('job detail', ...)` block:

```ts
  test('C9: the hand-off carries the PLAN job tickets', () => {
    expect(detail).toContain("import { ticketsQueryValue } from '~/lib/fleet-ticket-links'")
    expect(detail).toContain('const tickets = ticketsQueryValue(current.tickets)')
  })

  test('C9: a Tickets row lists the linked tickets with status, linking to each ticket', () => {
    expect(detail).toContain("import { STATUS_DOT, TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'")
    expect(detail).toMatch(/<div v-if="job\.tickets && job\.tickets\.length > 0"[^>]*data-testid="fleet-job-tickets"/)
    expect(detail).toContain(':to="`/${slug}/tickets/${linked.ref}`"')
    expect(detail).toContain('data-testid="fleet-job-ticket"')
    expect(detail).toContain("t(`tickets.status.${linked.status}`)")
    expect(detail).toContain("t('fleet.jobs.detail.tickets')")
  })

  test('C9: cancel and requeue render the job from the response, which now carries tickets (Task 1)', () => {
    expect(detail).toContain('job.value = await jobsApi.cancel(jobId)')
    expect(detail).toContain('job.value = result.job')
  })
```

Run: `cd apps/web && bunx jest tests/pages/fleet-job-detail.spec.ts`
Expected: the hand-off and Tickets tests FAIL.

- [ ] **Step 3: Implement**

In `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`:

1. Add imports below `import type { FleetJobLogListDto } ...`:

```ts
import { ticketsQueryValue } from '~/lib/fleet-ticket-links'
import { STATUS_DOT, TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'
```

2. Replace `dispatchRunHref` with:

```ts
const dispatchRunHref = computed(() => {
  const current = job.value
  if (!current || !current.resultBranch) return `/${slug}/fleet/dispatch`
  // C9 §4: the RUN keeps the PLAN's tickets.
  const tickets = ticketsQueryValue(current.tickets)
  return { path: `/${slug}/fleet/dispatch`, query: { command: 'RUN', repoId: current.repoId, feature: current.feature, ref: current.resultBranch, ...(tickets ? { tickets } : {}) } }
})
```

3. In the `<dl ...>` block, after the PR `<div>` (the one with `data-testid="fleet-job-pr"`), add:

```vue
        <div v-if="job.tickets && job.tickets.length > 0" class="sm:col-span-3" data-testid="fleet-job-tickets">
          <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.tickets') }}</dt>
          <dd class="mt-1 flex flex-wrap gap-2">
            <NuxtLink
              v-for="linked in job.tickets"
              :key="linked.ref"
              :to="`/${slug}/tickets/${linked.ref}`"
              :class="[TICKET_CHIP_CLASS, 'max-w-full hover:bg-muted']"
              data-testid="fleet-job-ticket"
              :data-ref="linked.ref"
            >
              <span :class="[TICKET_DOT_CLASS, STATUS_DOT[linked.status] ?? 'bg-muted-foreground']" aria-hidden="true" />
              <span class="font-mono">{{ linked.ref }}</span>
              <span class="truncate">{{ linked.title }}</span>
              <span class="text-muted-foreground">{{ t(`tickets.status.${linked.status}`) }}</span>
            </NuxtLink>
          </dd>
        </div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/pages/fleet-job-detail.spec.ts tests/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/pages/[project]/fleet/jobs/[id]/index.vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): job page Tickets row; PLAN -> RUN hand-off carries tickets (C9 slice 2)"
```

---

### Task 7: E2E — dispatch from a ticket, Fleet runs, via fleet, live FAILED, Unlink

**Files:**
- Create: `apps/web/tests/e2e/fleet-ticket-runs.e2e.spec.ts`

**Interfaces:**
- Consumes: `createTicket`, `login`, `E2E_ADMIN` (`fixtures/api-client.ts`); `call`, `repoIdOf` (`fixtures/fleet-budgets-api.ts`); `waitForHydration`, `webLogin` (`fixtures/page-helpers.ts`); `ScriptedRunner` (`fixtures/scripted-runner.ts`); the seeded project `fleet-e2e` (key `FLTE`) and repo `acme/e2e-app` (`apps/api/prisma/seed-e2e.ts`); test ids from Tasks 3-6.

- [ ] **Step 1: Write the spec**

`apps/web/tests/e2e/fleet-ticket-runs.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createTicket, login, E2E_ADMIN } from './fixtures/api-client';
import { call, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner } from './fixtures/scripted-runner';

/**
 * Fleet C9 slice 2 (spec §6 E2E, D461): Dispatch from a ticket prefills the ticket and the feature; a second ticket
 * is added in the picker; the RUN moves both tickets to IN_PROGRESS; the finished job shows in the ticket's Fleet
 * runs card with its PR, which is also a "via fleet" PR link. A second job fails live on an open ticket page with
 * its reason and a failure comment, and Unlink removes it. Every locator is scoped to this spec's own tickets/jobs.
 */
const SLUG = 'fleet-e2e';

test.describe('Fleet runs on tickets (scripted runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    token = (await login(E2E_ADMIN.email, E2E_ADMIN.password)).token;
    runner = await ScriptedRunner.enroll(token, `e2e-tickets-runner-${suffix}`);
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  test('Dispatch from a ticket, two tickets start, the finished job and its PR show on the ticket', async ({ page }) => {
    test.setTimeout(120_000);
    const a = await createTicket(token, SLUG, { title: `Login fails ${suffix}`, type: 'BUG' });
    const b = await createTicket(token, SLUG, { title: `Session expiry ${suffix}`, type: 'BUG' });

    await webLogin(page);
    await page.goto(`/${SLUG}/tickets/${a.ref}`);
    await waitForHydration(page);
    await page.getByTestId('ticket-fleet-dispatch').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/dispatch\\?`));
    await waitForHydration(page);

    await expect(page.getByTestId('dispatch-prefilled')).toBeVisible();
    await expect(page.getByTestId('dispatch-command')).toHaveValue('PLAN');
    await expect(page.getByTestId('dispatch-feature')).toHaveValue(`${a.ref.toLowerCase()}-login-fails-${suffix}`);
    await expect(page.getByTestId('dispatch-tickets-item')).toHaveCount(1);
    await expect(page.getByTestId('dispatch-tickets-item').first()).toHaveAttribute('data-ref', a.ref);

    // Typed in lower case: the picker normalizes it (D450).
    await page.getByTestId('dispatch-tickets-input').fill(b.ref.toLowerCase());
    await page.getByTestId('dispatch-tickets-input').press('Enter');
    await expect(page.getByTestId('dispatch-tickets-item')).toHaveCount(2);

    // A RUN pinned to the scripted runner, so the dispatch moves both tickets (D452).
    await page.getByTestId('dispatch-command').selectOption('RUN');
    await page.getByTestId('dispatch-repo').selectOption({ label: 'acme/e2e-app' });
    await page.getByTestId('dispatch-max-cost').fill('3');
    await page.getByTestId('placement-pin').click();
    await page.getByTestId('dispatch-pin').selectOption(runner.id);
    await runner.heartbeat();
    await page.getByTestId('dispatch-submit').click();
    await expect(page.getByTestId('placement-assigned')).toContainText(runner.name);

    await page.getByTestId('placement-open-job').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
    await waitForHydration(page);
    const jobId = page.url().split('/').pop() ?? '';
    await expect(page.getByTestId('fleet-job-ticket')).toHaveCount(2);
    for (const t of [a, b]) {
      const ticket = await call<{ status: string }>('GET', `/projects/${SLUG}/tickets/${t.ref}`, token);
      expect(ticket.status).toBe('IN_PROGRESS');
    }

    const prUrl = 'https://github.com/acme/e2e-app/pull/41';
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'state', payload: { to: 'UPLOADING' } },
      {
        type: 'snapshot',
        payload: { finishResult: 'opened', resultBranch: `feat/tickets-${suffix}`, resultSha: 'abcdef1234567', resultPrUrl: prUrl, costSpentUsd: '0.5000' },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);

    await page.goto(`/${SLUG}/tickets/${a.ref}`);
    await waitForHydration(page);
    const run = page.locator(`[data-testid="ticket-fleet-run"][data-job="${jobId}"]`);
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'COMPLETED', { timeout: 15_000 });
    await expect(run.getByTestId('ticket-fleet-run-branch')).toHaveText(`feat/tickets-${suffix} (abcdef1)`);
    await expect(run.getByTestId('ticket-fleet-run-pr-state')).toHaveAttribute('data-state', 'open');
    await expect(run.getByTestId('ticket-fleet-run-cost')).toHaveText('$0.50');
    await expect(page.getByTestId('ticket-link-via-fleet')).toHaveCount(1);
  });

  test('a job fails live on an open ticket page with its reason and comment; Unlink removes it', async ({ page }) => {
    test.setTimeout(90_000);
    const t = await createTicket(token, SLUG, { title: `Flaky export ${suffix}`, type: 'BUG' });
    await runner.heartbeat();
    const result = await call<{ job: { id: string } }>('POST', `/projects/${SLUG}/fleet/jobs`, token, {
      command: 'RUN', repoId, feature: `fail-${suffix}`, maxCostUsd: 3, pinnedRunnerId: runner.id, ticketRefs: [t.ref],
    });
    const jobId = result.job.id;

    await webLogin(page);
    await page.goto(`/${SLUG}/tickets/${t.ref}`);
    await waitForHydration(page);
    const run = page.locator(`[data-testid="ticket-fleet-run"][data-job="${jobId}"]`);
    await expect(run).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      { type: 'state', payload: { to: 'FAILED', reason: `acceptance failed ${suffix}`, exitCode: 1 } },
    ]);

    // Live (P3): the card follows the job's fleet_job events without a navigation.
    await expect(run.getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'FAILED', { timeout: 15_000 });
    await expect(run.getByTestId('ticket-fleet-run-reason')).toHaveText(`acceptance failed ${suffix}`);
    await expect(page.getByText(`ended FAILED: acceptance failed ${suffix}`).first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    await run.getByTestId('ticket-fleet-run-unlink').click();
    await page.getByTestId('ticket-fleet-run-unlink-confirm').click();
    await expect(page.getByTestId('ticket-fleet-runs')).toHaveCount(0, { timeout: 10_000 });
    expect(await call<unknown[]>('GET', `/projects/${SLUG}/tickets/${t.ref}/fleet-jobs`, token)).toEqual([]);
  });
});
```

- [ ] **Step 2: Lint and list**

Run: `cd apps/web && bunx eslint tests/e2e/fleet-ticket-runs.e2e.spec.ts --max-warnings=0 && bunx playwright test tests/e2e/fleet-ticket-runs.e2e.spec.ts --list`
Expected: lint clean; two tests listed.

- [ ] **Step 3: Run it (ask the user first)**

The run resets `koda_e2e`. **Ask the user for consent**, then (test Postgres up: `cd apps/api && bun run test:db:up`):

```bash
cd apps/web && PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-ticket-runs.e2e.spec.ts --reporter=line
```

Expected: 2 passed. Then the fleet group and the ticket journeys, to prove no neighbour broke (the dispatch form gained a field; the ticket page gained a card and a header link):

```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact consent message>" bunx playwright test tests/e2e/fleet-*.e2e.spec.ts tests/e2e/ticket-*.spec.ts tests/e2e/ticket-detail-operations.e2e.spec.ts --reporter=line
```

Expected: all passed. If the PR link never appears, check the API log for the `upsertPrLinks` warning (the URL must name the job's repo, `acme/e2e-app`); do not loosen the assertion.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/fleet-ticket-runs.e2e.spec.ts
git commit -m "test(web): fleet runs on tickets E2E with a scripted runner (C9 slice 2)"
```

---

### Task 8: Docs, full verification, review and hand-off

**Files:**
- Modify: `.nax/mono/apps/web/context.md` (new section after "Fleet story graph (S2b (j))")
- Modify (generated): `apps/web/CLAUDE.md`, `apps/web/AGENTS.md`, `apps/web/GEMINI.md`, `apps/web/codex.md`
- Modify: `docs/ux/redesign/MASTER-PLAN.md` (§10 Decisions log)
- Modify: `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md` (Decisions table)

- [ ] **Step 1: Record the plan decisions in the spec**

In the spec's `## Decisions` table, append after the D461 row:

```markdown
| D462 | (slice 2) The dispatch picker suggests the project's 100 newest open tickets (no ticket search endpoint); older open tickets are typed by ref and validated by the server. |
| D463 | (slice 2) The Dispatch button is hidden on CLOSED and REJECTED tickets; the Fleet runs card refetches on its ticket's events, its jobs' `fleet_job` events, any `QUEUED` `fleet_job` event, and resync; a failed load shows nothing new and no toast. |
| D464 | (slice 2, fixes the 1a minor) Cancel and requeue responses carry `FleetJobDto.tickets`, like the job detail. |
```

- [ ] **Step 2: Add the web agent guidance**

In `.nax/mono/apps/web/context.md`, after the "Fleet story graph (S2b (j))" section (it ends with the `fleet-locale-parity.spec.ts` bullet), add:

```markdown
## Fleet on tickets (C9)

- The ticket page renders `components/TicketFleetRuns.vue` under `TicketHeader`: it loads
  `GET /projects/:slug/tickets/:ref/fleet-jobs` itself and follows its own live events (this ticket, its jobs,
  any `QUEUED` job, resync). It is hidden when empty and never toasts a failed load. Unlink emits `changed`, and the
  page reloads its links (the fleet PR link goes with the job).
- Fleet PR links are ordinary `pr` ticket links with `source = 'fleet'` and a `jobId`; `TicketProperties` marks them
  "via fleet". The ticket page reloads links on every ticket live event, because the server announces new fleet
  PR links as `TICKET_UPDATED`.
- Pure logic lives in `lib/fleet-ticket-links.ts` (ref rules, the D461 feature slug, `?tickets=` parsing, picker
  matching, row reason and PR state). The dispatch form's tickets field is `components/fleet/TicketPicker.vue`.
- `FleetJobDto.tickets` is filled on single-job responses (detail, dispatch, cancel, requeue) and null on lists.
```

- [ ] **Step 3: Log the UX decision**

In `docs/ux/redesign/MASTER-PLAN.md` §10 Decisions log, append a row at the end of the table:

```markdown
| 2026-10-07 | Ticket page: a Dispatch link next to Edit (DEVELOPER+, project has a fleet repo, ticket open) and a "Fleet runs" card under the header; fleet PR links get a "via fleet" chip | Fleet C9 slice 2 (spec `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md` §4, D461); built from existing tokens and components (C9-5, no design pass) |
```

- [ ] **Step 4: Regenerate every agent file**

Run from the repo root: `nax generate && nax generate --all-packages`
Expected: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`codex.md` under `apps/web` change; root files unchanged or metadata-only. Never hand-edit them and never regenerate a single `--package` only. If `nax generate` also writes `.cursorrules`, `.windsurfrules` or `.aider.conf.yml`, commit those too.

- [ ] **Step 5: Full verification**

Run from the repo root:

```bash
bun run lint
bun run type-check
bun run test
cd apps/web && bun run build && cd ../..
cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet && cd ../..
git diff --check main...HEAD
bun run generate && git diff --exit-code
```

Expected: everything PASS; no whitespace errors; `bun run generate` leaves no diff (Task 1 changed no DTO). Record the web and API test counts and the Task 7 E2E result for the PR body. Do not mark this done on a red run; fix in the task that owns the file and re-run.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md docs/ux/redesign/MASTER-PLAN.md .nax/mono/apps/web/context.md apps/web/CLAUDE.md apps/web/AGENTS.md apps/web/GEMINI.md apps/web/codex.md
git commit -m "docs(fleet): C9 slice 2 decisions, UX log and web agent guidance"
```

Adjust the `git add` list to the files `git status` shows as changed by `nax generate`.

- [ ] **Step 7: Whole-branch review, then hand off (no push without approval)**

Request a whole-branch code review of `main..feat/fleet-c9-slice-2-web` against the spec (superpowers:requesting-code-review), including the Review Focus list at the top of this plan. Fix Critical and Important findings, at most 2 fix rounds. Then report to the user: test counts, the E2E result, deferred minors, and the proposed PR title `feat(fleet): C9 slice 2 — fleet runs, dispatch and PR links on tickets (D461-D464)`. **Do not push or open the PR until the user approves.**

After merge, with the user's approval, in this order: deploy koda-wk (it is still on `ab672d48`, so this deploy also ships slice 1a's migration and slice 1b: take a DB backup first with `~/koda-wk/backup-db.sh`, then `~/koda-wk/scripts/build-images.sh <sha>` and `~/koda-wk/deploy.sh`); then the billed live check of spec §6 on `koda-fleet-sandbox` (approval at launch); then file the out-of-scope follow-up issue the spec names (classic VERIFIED -> `createPrForTicket` and a fleet RUN on the same ticket can each open a PR).

---

## Self-review notes

- **Spec coverage (§4):** Dispatch button + D461 slug and query -> Tasks 2 and 5; `TicketFleetRuns` (row content, hidden when empty, Unlink with confirm, live reload) -> Task 4, placed in Task 5; "via fleet" mark -> Task 5; Tickets multi-select, `?tickets=` prefill, `ticketRefs` -> Tasks 2 and 3; PLAN -> RUN hand-off `tickets=` -> Task 6; job page Tickets row -> Task 6; i18n en + zh -> Tasks 3, 4, 6. §6 E2E (Dispatch prefill, seeded linked jobs FAILED with reason and COMPLETED with PR, Unlink, via fleet) -> Task 7. §7 slice 2 also carries the slice 1a minor -> Task 1. The §6 live check on koda-wk runs after merge and deploy (Task 8 Step 7), not in this branch.
- **Not in this slice:** CLI (§5) shipped in 1a; no API endpoint or DTO change beyond Task 1's fill.
- **Type consistency:** `FleetJobTicketDto`/`TicketFleetJobDto` (Task 2) are the names used in Tasks 3, 4, 6; test ids produced in Tasks 3-6 match the Task 7 locators (`ticket-fleet-dispatch`, `dispatch-tickets-*`, `fleet-job-ticket`, `ticket-fleet-run*`, `ticket-link-via-fleet`).
