# Fleet S1 Slice 4c — Web Job Pages, Live Updates, E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** This is plan 4c, the third of the three slice 4 plans (`2026-10-01-fleet-s1-slice-4-overview.md`, D114). Read the overview first: it fixes the API contract (D116-D121) and the shared decisions D114-D129 this plan relies on. This plan adds **D138-D140** only.

**Prerequisite:** 4a and 4b are merged. Cut branch `feat/fleet-s1-slice4c-web-jobs` from that `main`. From 4a this plan uses `GET /api/projects/:slug/fleet/runners` (`RunnerSummaryDto`, D118) and nothing else new. From 4b (`2026-10-01-fleet-s1-slice-4b-web-admin.md`) it uses, by these exact names:
- `apps/web/lib/fleet-types.ts` exports `FleetPage<T>` (`{ records, total, current, size, hasNext, hasPrev }`), `FleetRepo`, `FleetRunnerSummary` and `FLEET_LIST_SIZE` (100, overview D125);
- `apps/web/lib/fleet-validation.ts` exports `LABEL_PATTERN` (the API's label rule);
- `apps/web/components/fleet/NativeSelect.vue`, auto-imported as `<FleetNativeSelect v-bind="componentField" :options="[{ value, label }]" :placeholder? :testid? />` (4b D137: fleet forms use native selects; the `testid` lands on the `<select>` itself);
- the i18n root `fleet` in both locales with `fleet.state.<STATE>`, `fleet.misfit.<reason>`, `fleet.repoReason.<reason>` and `fleet.common.*`, and `nav.fleetRunners`, `nav.fleetRepos` right after `nav.users`;
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, which already checks en/zh parity, non-empty values and the `|`/`@` ban for the whole `fleet` and `nav` subtrees (this plan extends it, it does not add another parity spec);
- `fleet` in the `API_ROOT` alternation of `apps/web/tests/lib/api-path-guard.spec.ts`;
- the lucide import of `layouts/default.vue` ending `..., Users, Server, FolderGit2 } from 'lucide-vue-next'` and the admin Runners/Repos links.

Check before Task 1: `grep -n "FleetPage\|FleetRunnerSummary\|FleetRepo\b\|FLEET_LIST_SIZE" apps/web/lib/fleet-types.ts`, `grep -n "LABEL_PATTERN" apps/web/lib/fleet-validation.ts`, `ls apps/web/components/fleet/NativeSelect.vue apps/web/tests/i18n/fleet-locale-parity.spec.ts`. Each must match; if 4b changed a name in review, use 4b's name everywhere below and do not rename 4b's exports.

**Goal:** A project member follows fleet jobs in the web app: a filterable jobs list, a dispatch form that explains placement, and a job page that updates live (state, story, phase, cost, timeline) and offers cancel, requeue and the bundle download; proven end to end by a Playwright run against a scripted runner.

**Architecture:** The existing per-project SSE client learns the `fleet_job` named event through an optional `onFleetJob` handler; ticket pages are untouched. Pure helpers in `lib/` hold every rule the pages need (state groups, permissions, cost and progress formatting, timeline summaries, dispatch validation and request body), so the pages stay thin and the logic is unit-tested. Composables (`useFleetJobs`, `useFleetDispatchOptions`, `useProjectMemberNames`) own all API calls; `useApi()` gains `download()` for the bundle (D127). Pages follow the existing source-wiring test style; the E2E drives the real sync protocol from the test (D128).

**Tech Stack:** Nuxt 3 SSR, Vue 3.5, shadcn-vue on radix-vue, vee-validate 4 + zod 3, `@nuxtjs/i18n`, lucide-vue-next, jest 29 + ts-jest (node env, source-wiring tests for pages), Playwright 1.51.

**Spec:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec": §11 Dispatch and Jobs pages, §1 live events, §2.2 permissions, §3.4 routes, §12 E2E line), with `docs/superpowers/plans/2026-10-01-fleet-s1-slice-4-overview.md` ("overview": D115, D118, D121, D125-D128).

## Global Constraints

From the spec, the overview and the repo rules (`.nax/rules/web.md`, `common.md`); every task includes them.

- **Routes (D115):** jobs list `/:project/fleet`, dispatch `/:project/fleet/dispatch`, job `/:project/fleet/jobs/:id`.
- **Permissions (S1 spec §2.2):** dispatch and requeue: project ADMIN or DEVELOPER (`canWorkOnFleet(viewer)` = `canManage || viewerRole === 'DEVELOPER'`, one helper for all three pages); cancel: `canWork` or the requester; read: any member. The server enforces all of them; the web only hides controls.
- **API access:** only through `useApi()` inside composables; every interpolated API path through `apiPath` (the guard spec fails otherwise). No raw `$fetch`/`useFetch` in pages or components.
- **i18n:** no hardcoded UI strings; every key in `en.json` and `zh.json`; server codes (state, misfit reason) through key maps with a raw-code fallback (D126). vue-i18n treats `|` and `@` in messages as syntax: never use them in a message.
- **Forms:** vee-validate + zod, validation messages are i18n keys; form selects are `<FleetNativeSelect v-bind="componentField">` (4b D137, issue #58: Radix `Select` options live in a portal that Playwright drives unreliably, `tests/e2e/vcs-integration-settings.e2e.spec.ts:207`). Filter selects that no E2E drives (the jobs list) may stay shadcn `Select`.
- **Errors:** `toast.error(extractApiError(err))`; a status is told apart by `ApiError.code` (the envelope `ret`: 409 for the duplicate dispatch, 422 for a pinned misfit), never by message text.
- **Links:** a PR URL is rendered as a link only when it is `https:` (the API also accepts `http:`), with `rel="noopener noreferrer"`.
- **Code style:** no emojis, immutable updates (new arrays and objects, never `push` into reactive state), files under 400 lines, functions under 50 lines, no `eslint-disable`, no non-null assertions.
- **Git:** conventional commits, no attribution trailer, never push; never run `git checkout`, `git switch`, `git stash`, `git reset` or `git rebase` in the shared checkout.
- **Commands (from `apps/web`):** one spec `npx jest <path>`; all unit specs `bun run test`; lint `bun run lint`; types `bun run type-check` (Nuxt typecheck, about 2 minutes). E2E: `cd apps/api && bun run test:db:up` once, then `cd apps/web && bunx playwright test tests/e2e/fleet-dispatch.e2e.spec.ts`. E2E is not a new required check (D129).

## Review Focus

Inputs the spec implies that a user will meet and that no page-level test would otherwise exercise, most likely first. Each has its pinning test in the named task.

1. **A job whose `progress` or event payloads are missing, partial or odd JSON** (an older nax, a snapshot without counters): the page shows `-` and never throws. Pinned by `extractProgress` and `summarizeEvent` tests (Task 3).
2. **The bundle is not there** (CRASHED before upload, or still RUNNING): the download shows the API's message as a toast and creates no file. Pinned by the `download` 404 test (Task 2) and the `downloadBundle` propagation test (Task 5).
3. **A duplicate dispatch whose active job finished between the 409 and the lookup:** the user sees the toast and no dead link. Pinned by the `findActiveJob ... already finished` test (Task 5).
4. **A VIEWER who requested the job** (role changed after dispatch) can still cancel it; a VIEWER who did not, cannot; nobody cancels a finished job. Pinned by the `canCancelJob` tests (Task 3).
5. **A live event for another job, or a redelivered event id:** the detail page does not refetch for another job's notice, and a duplicate id is dropped once. Pinned by the stream dedupe test (Task 1) and the detail wiring test (Task 9).

## Plan decisions

| # | Decision | Why |
|:--|:--|:--|
| D138 | The E2E fixture is seeded by `apps/api/prisma/seed-e2e.ts`: project `fleet-e2e` (key `FLTE`, the seeded admin is its project ADMIN) and GitHub repo `acme/e2e-app` (installation id 1), with the fleet tables wiped first. The runner enrolls over HTTP from the test. | Registering a repo runs a live forge check (GitHub App or GitLab token) that e2e cannot pass; `apps/web` has no Prisma client, and spawning one per test is slower and couples the test to the API's toolchain. The seed already runs once per e2e database reset, before the API starts. |
| D139 | Live updates: `ProjectEventHandlers.onEvent` becomes optional and `onFleetJob` is added; the `fleet_job` listener is registered only when `onFleetJob` is given, so ticket pages do not change. The jobs list reloads the visible page on any fleet notice (300 ms debounce); the job page reloads only for its own `jobId`, refetching the job and the events from the last loaded page, then following `hasNext` for at most 10 more pages (events only append, ordered by `seq`; a busy job's runner logs can push new rows past the loaded page). Live reloads never touch `pending`. A live notice carries any non-empty `state` string, not only today's nine, so a state added later still triggers the refetch. | Same pattern as the ticket board and detail (Track 1 Slice 5): content-free events, refetch, debounce, and no LoadingState flash. |
| D140 | The web mirrors a few server rules with a source pointer instead of importing them: `FEATURE_RE`, `PROFILE_NAME_RE`, the `koda-job-` prefix, max-cost bounds (`lib/fleet-dispatch.ts`; labels reuse 4b's `LABEL_PATTERN`), the state groups and the requeue/cancel rules (`lib/fleet-jobs.ts`). The server stays the authority: its 400/409/422 message is shown as-is. The bundle downloads as `koda-job-<id>.tar.gz`. | `apps/web` cannot import `apps/api` source and there is no shared package for these rules; catching mistakes before the request is a usability gain only. The blob download cannot read `Content-Disposition`, so the file name is built from the job id. |

## File structure

| File | Responsibility |
|:--|:--|
| `apps/web/lib/project-event-stream.ts` (modify) | `LiveFleetJobEvent`, `parseFleetJobEvent`, optional `onFleetJob` |
| `apps/web/composables/useApi.ts` (modify) | `blobErrorToApiError`, `$api.download()` |
| `apps/web/lib/fleet-types.ts` (modify, from 4b) | job, event, placement and dispatch-body types |
| `apps/web/lib/fleet-jobs.ts` | state groups, permissions (`canWorkOnFleet`, cancel, requeue), cost/progress formatting, timeline summaries and filter, `mergeEvents`, `pickActiveJob` |
| `apps/web/lib/save-blob.ts` | hands a Blob to the browser as a file, revoking the object URL after a delay |
| `apps/web/lib/fleet-i18n.ts` | `codeLabel` (D126) |
| `apps/web/lib/fleet-dispatch.ts` | dispatch zod schema, defaults, `toDispatchBody`, token-list helpers |
| `apps/web/composables/useFleetJobs.ts` | list/get/events/dispatch/cancel/requeue/findActiveJob/downloadBundle |
| `apps/web/composables/useFleetDispatchOptions.ts` | project repos + runner summaries, profile and label options, name lookups |
| `apps/web/composables/useProjectMemberNames.ts` | requester names |
| `apps/web/components/fleet/*.vue` | `FleetJobStateBadge`, `FleetJobProgress`, `FleetJobTimeline`, `FleetPlacementResult`, `FleetTokenListInput` |
| `apps/web/pages/[project]/fleet/index.vue`, `dispatch.vue`, `jobs/[id].vue` | the three pages |
| `apps/web/layouts/default.vue` (modify) | project nav link + breadcrumbs |
| `apps/web/i18n/locales/{en,zh}.json` (modify) | `fleet.jobs.*`, `fleet.dispatch.*`, `nav.fleetJobs` |
| `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (modify, from 4b) | `nav.fleetJobs` assertion |
| `apps/api/prisma/seed-e2e.ts` (modify), `apps/web/playwright.config.ts` (modify), `apps/web/tests/e2e/fixtures/scripted-runner.ts`, `apps/web/tests/e2e/fleet-dispatch.e2e.spec.ts` | E2E |

Verified after the review fixes: 4b's web code, then every code block of this plan, applied in order to a scratch worktree of `main` `0ba9ba94` (no stand-ins: 4b's real `fleet-types.ts`, `fleet-validation.ts`, `NativeSelect.vue`, parity spec and layout). The full web jest suite passed (142 suites, 2260 tests: 13 suites and 108 tests over 4b's 129/2152), `bun run lint` exited 0, and `bun run type-check` exited 0; Nuxt's type-check covers `tests/e2e` (its tsconfig includes `../**/*`), so the scripted runner and the E2E spec type-check too. The Playwright spec was not run (it needs 4a's runner summaries route); the review ran its sync sequence against a booted API and it reached COMPLETED.

---

### Task 1: `fleet_job` events in the project event stream

**Files:**
- Modify: `apps/web/lib/project-event-stream.ts` (handler interface, new parser, listener)
- Test: `apps/web/tests/lib/project-event-stream-fleet.spec.ts`

`composables/useProjectEvents.ts` needs no change: it passes `handlers` through. The existing ticket specs stay green because `onEvent` keeps working when given.

**Interfaces:**
- Consumes: the API's named SSE event `fleet_job` with data `{ id, type: 'fleet_job', projectId, jobId, state, at }` (overview, "Unchanged and relied on").
- Produces: `FLEET_JOB_STATES` (the nine states, `as const`), `type FleetJobState`, `interface LiveFleetJobEvent { id: string; type: 'fleet_job'; projectId: string; jobId: string; state: string; at: string }` (`state` is any non-empty string: the notice only triggers a refetch, so a state added to the API later must not silence live updates, D139), `parseFleetJobEvent(raw: string): LiveFleetJobEvent | null`, and `ProjectEventHandlers { onEvent?: (e: LiveTicketEvent) => void; onFleetJob?: (e: LiveFleetJobEvent) => void; onResync: () => void }`. Tasks 3, 7 and 9 use `FleetJobState`, `FLEET_JOB_STATES` and `onFleetJob`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/project-event-stream-fleet.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import {
  createProjectEventStream,
  parseFleetJobEvent,
  type EventSourceLike,
  type LiveFleetJobEvent,
  type ProjectEventHandlers,
} from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }

  close(): void {
    this.readyState = 2
  }

  listenerTypes(): string[] {
    return Object.keys(this.listeners).sort()
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }
}

const fleetEvent = (id: string, over: Partial<LiveFleetJobEvent> = {}): LiveFleetJobEvent => ({
  id, type: 'fleet_job', projectId: 'p1', jobId: 'j1', state: 'RUNNING', at: '2026-10-01T00:00:00.000Z', ...over,
})

function open(handlers: ProjectEventHandlers): FakeEventSource {
  let source: FakeEventSource | null = null
  createProjectEventStream('/api/projects/p1/events', handlers, {
    createEventSource: () => {
      source = new FakeEventSource()
      return source
    },
    refreshAuth: async () => true,
    setTimer: () => null,
    clearTimer: () => undefined,
  })
  if (!source) throw new Error('no event source opened')
  return source
}

describe('parseFleetJobEvent', () => {
  test('accepts a well-formed fleet_job event', () => {
    expect(parseFleetJobEvent(JSON.stringify(fleetEvent('e1')))).toEqual(fleetEvent('e1'))
  })

  test.each([
    ['a ticket event', { id: 'e1', type: 'ticket', jobId: 'j1', state: 'RUNNING' }],
    ['no jobId', { id: 'e1', type: 'fleet_job', state: 'RUNNING' }],
    ['no id', { type: 'fleet_job', jobId: 'j1', state: 'RUNNING' }],
    ['a non-string state', { id: 'e1', type: 'fleet_job', jobId: 'j1', state: 42 }],
    ['an empty state', { id: 'e1', type: 'fleet_job', jobId: 'j1', state: '' }],
    ['a non-object', 'nope'],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(parseFleetJobEvent(JSON.stringify(value))).toBeNull()
  })

  test('rejects text that is not JSON', () => {
    expect(parseFleetJobEvent('{oops')).toBeNull()
  })

  test('accepts a state this web build does not know yet (it only triggers a refetch)', () => {
    expect(parseFleetJobEvent(JSON.stringify(fleetEvent('e1', { state: 'PAUSED' })))?.state).toBe('PAUSED')
  })
})

describe('createProjectEventStream with onFleetJob', () => {
  test('delivers fleet_job events to onFleetJob, not to onEvent', () => {
    const onEvent = jest.fn()
    const onFleetJob = jest.fn()
    const es = open({ onEvent, onFleetJob, onResync: jest.fn() })
    es.emit('fleet_job', fleetEvent('e1'))
    expect(onFleetJob).toHaveBeenCalledWith(fleetEvent('e1'))
    expect(onEvent).not.toHaveBeenCalled()
  })

  test('drops a redelivered fleet_job id', () => {
    const onFleetJob = jest.fn()
    const es = open({ onFleetJob, onResync: jest.fn() })
    es.emit('fleet_job', fleetEvent('e1'))
    es.emit('fleet_job', fleetEvent('e1', { state: 'COMPLETED' }))
    expect(onFleetJob).toHaveBeenCalledTimes(1)
  })

  test('ignores malformed fleet_job payloads', () => {
    const onFleetJob = jest.fn()
    const es = open({ onFleetJob, onResync: jest.fn() })
    es.emit('fleet_job', { id: 'e1', type: 'fleet_job', jobId: 'j1', state: 42 })
    expect(onFleetJob).not.toHaveBeenCalled()
  })

  test('a ticket-only page does not listen for fleet_job at all', () => {
    const es = open({ onEvent: jest.fn(), onResync: jest.fn() })
    expect(es.listenerTypes()).toEqual(['ticket'])
  })

  test('a fleet-only page still tolerates ticket events', () => {
    const onFleetJob = jest.fn()
    const es = open({ onFleetJob, onResync: jest.fn() })
    expect(() => es.emit('ticket', { id: 't1', type: 'ticket', action: 'created', projectId: 'p1', ticketId: 't1', actorId: 'u1', at: 'x' })).not.toThrow()
    expect(onFleetJob).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx jest tests/lib/project-event-stream-fleet.spec.ts`
Expected: FAIL: ts-jest reports `TS2305: Module '"~/lib/project-event-stream"' has no exported member 'parseFleetJobEvent'` (and `LiveFleetJobEvent`).

- [ ] **Step 3: Implement**

In `apps/web/lib/project-event-stream.ts`, replace the `ProjectEventHandlers` interface:

```ts
export interface ProjectEventHandlers {
  onEvent: (event: LiveTicketEvent) => void
  onResync: () => void
}
```

with:

```ts
/** Fleet S1 slice 4c: content-free job notice; the page refetches the job (S1 spec §1). */
export const FLEET_JOB_STATES = [
  'QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED',
] as const
export type FleetJobState = typeof FLEET_JOB_STATES[number]

export interface LiveFleetJobEvent {
  id: string
  type: 'fleet_job'
  projectId: string
  jobId: string
  /** Any non-empty string: the notice only triggers a refetch, so a new API state must not be dropped (D139). */
  state: string
  at: string
}

/** Both event handlers are optional; a page subscribes to what it shows. */
export interface ProjectEventHandlers {
  onEvent?: (event: LiveTicketEvent) => void
  onFleetJob?: (event: LiveFleetJobEvent) => void
  onResync: () => void
}
```

Directly above `export function createProjectEventStream(`, add:

```ts
export function parseFleetJobEvent(raw: string): LiveFleetJobEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveFleetJobEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'fleet_job' || typeof value.id !== 'string' || typeof value.jobId !== 'string') return null
    if (typeof value.state !== 'string' || value.state.length === 0) return null
    return value as LiveFleetJobEvent
  }
  catch {
    return null
  }
}
```

Inside `open()`, replace the ticket listener:

```ts
    es.addEventListener('ticket', (ev) => {
      const event = parseLiveEvent(ev.data)
      if (event && isNew(event.id)) handlers.onEvent(event)
    })
```

with:

```ts
    es.addEventListener('ticket', (ev) => {
      const event = parseLiveEvent(ev.data)
      if (event && isNew(event.id)) handlers.onEvent?.(event)
    })
    const onFleetJob = handlers.onFleetJob
    if (onFleetJob) {
      es.addEventListener('fleet_job', (ev) => {
        const event = parseFleetJobEvent(ev.data)
        if (event && isNew(event.id)) onFleetJob(event)
      })
    }
```

- [ ] **Step 4: Run the new and the existing stream specs**

Run: `cd apps/web && npx jest tests/lib/project-event-stream tests/composables/useProjectEvents.spec.ts tests/pages/live-wiring.spec.ts`
Expected: PASS (the 14 existing stream tests, the new fleet tests, the composable and live-wiring specs).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/project-event-stream.ts apps/web/tests/lib/project-event-stream-fleet.spec.ts
git commit -m "feat(web): deliver fleet_job live events to an optional onFleetJob handler"
```

### Task 2: `useApi().$api.download()` (D127)

**Files:**
- Modify: `apps/web/composables/useApi.ts`
- Test: `apps/web/tests/composables/useApi-download.spec.ts`

**Interfaces:**
- Consumes: `request()`, `ApiError`, `JsonResponse` inside `useApi.ts`.
- Produces: `export async function blobErrorToApiError(err: unknown): Promise<unknown>` and `$api.download(path: string): Promise<Blob>` (path relative to the API base, like `get`). Task 5 calls it with the `apiPath`-built bundle path `/projects/:slug/fleet/jobs/:id/bundle`.

Why the conversion: with `responseType: 'blob'` ofetch hands the error body over as a `Blob`, so `request()` cannot read `ret` from it and would rethrow a bare fetch error; the 404 message ("no bundle") would be lost.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/composables/useApi-download.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'
import { ref } from 'vue'

const composablePath = join(__dirname, '../..', 'composables', 'useApi.ts')
const g = globalThis as Record<string, unknown>

const jsonBlob = (body: unknown): Blob => new Blob([JSON.stringify(body)], { type: 'application/json' })
const fetchError = (status: number, data: unknown): Error => Object.assign(new Error(`HTTP ${status}`), { status, data })

describe('blobErrorToApiError', () => {
  test('turns a JSON error Blob into an ApiError with ret and message', async () => {
    const mod = await import(composablePath)
    const out = await mod.blobErrorToApiError(fetchError(404, jsonBlob({ ret: 404, message: 'No bundle yet' })))
    expect(out).toBeInstanceOf(mod.ApiError)
    expect(out).toMatchObject({ code: 404, message: 'No bundle yet' })
  })

  test('returns the original error for a non-JSON Blob, a non-Blob body or a non-object', async () => {
    const mod = await import(composablePath)
    const binary = fetchError(500, new Blob(['<html>']))
    expect(await mod.blobErrorToApiError(binary)).toBe(binary)
    const plain = fetchError(500, { message: 'x' })
    expect(await mod.blobErrorToApiError(plain)).toBe(plain)
    expect(await mod.blobErrorToApiError('boom')).toBe('boom')
  })

  test('passes an ApiError through untouched', async () => {
    const mod = await import(composablePath)
    const err = new mod.ApiError(409, 'busy')
    expect(await mod.blobErrorToApiError(err)).toBe(err)
  })
})

describe('useApi().$api.download', () => {
  beforeEach(() => {
    g.__JEST_IS_SERVER__ = false
    g.useRuntimeConfig = () => ({ public: { apiBaseUrl: '/api' }, apiInternalUrl: 'http://localhost:3100' })
    g.useI18n = () => ({ locale: ref('en') })
  })

  afterEach(() => {
    g.$fetch = undefined
    g.useAuth = undefined
  })

  test('asks for a Blob at the API base and returns it', async () => {
    const file = new Blob(['gz'], { type: 'application/gzip' })
    const fetchMock = jest.fn(async () => file)
    g.$fetch = fetchMock
    const mod = await import(composablePath)

    const out = await mod.useApi().$api.download('/projects/web/fleet/jobs/j1/bundle')

    expect(out).toBe(file)
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(url).toBe('/api/projects/web/fleet/jobs/j1/bundle')
    expect(opts.responseType).toBe('blob')
  })

  test('throws the API message as an ApiError on a 404', async () => {
    g.$fetch = jest.fn(async () => { throw fetchError(404, jsonBlob({ ret: 404, message: 'No bundle yet' })) })
    const mod = await import(composablePath)

    await expect(mod.useApi().$api.download('/x')).rejects.toMatchObject({ name: 'ApiError', code: 404, message: 'No bundle yet' })
  })

  test('refreshes once on a 401 and retries the download', async () => {
    const file = new Blob(['gz'])
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(fetchError(401, jsonBlob({ ret: 401, message: 'expired' })))
      .mockResolvedValueOnce(file)
    const refresh = jest.fn(async () => true)
    g.$fetch = fetchMock
    g.useAuth = () => ({ refresh })
    const mod = await import(composablePath)

    expect(await mod.useApi().$api.download('/x')).toBe(file)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('rejects a body that is not a file', async () => {
    g.$fetch = jest.fn(async () => ({ hello: 'json' }))
    const mod = await import(composablePath)

    await expect(mod.useApi().$api.download('/x')).rejects.toMatchObject({ name: 'ApiError', code: -1 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx jest tests/composables/useApi-download.spec.ts`
Expected: FAIL: `TypeError: mod.blobErrorToApiError is not a function` and `TypeError: mod.useApi(...).$api.download is not a function`.

- [ ] **Step 3: Implement**

In `apps/web/composables/useApi.ts`, directly above `export const useApi = () => {`, add:

```ts
/**
 * Fleet S1 slice 4c (D127): a download asks for a Blob, so ofetch hands the
 * error body over as a Blob too and request() cannot read `ret` from it.
 * Turn a JSON error Blob back into the ApiError every other call throws;
 * anything else is returned unchanged. Pure and exported for unit testing.
 */
export async function blobErrorToApiError(err: unknown): Promise<unknown> {
  if (err instanceof ApiError || err === null || typeof err !== 'object') return err
  const data = (err as { data?: unknown }).data
  if (!(data instanceof Blob)) return err
  try {
    const body = JSON.parse(await data.text()) as JsonResponse | null
    if (body && typeof body.ret === 'number') return new ApiError(body.ret, body.message || 'Request failed', body.errors)
  }
  catch {
    // Not a JSON body: surface the original fetch error.
  }
  return err
}
```

Replace the `return { $api: { get, post, patch, delete: delete_ } }` block at the end of `useApi` with:

```ts
  // D127: binary GET (job bundle). Same auth, locale and 401 retry as get().
  const download = async (path: string): Promise<Blob> => {
    let body: unknown
    try {
      body = await request<unknown>(`${baseURL}${path}`, { responseType: 'blob' })
    }
    catch (err: unknown) {
      throw await blobErrorToApiError(err)
    }
    if (!(body instanceof Blob)) throw new ApiError(-1, 'Expected a file download')
    return body
  }

  return {
    $api: {
      get,
      post,
      patch,
      delete: delete_,
      download,
    },
  }
```

- [ ] **Step 4: Run the useApi specs**

Run: `cd apps/web && npx jest tests/composables/useApi`
Expected: PASS (the existing `useApi.spec.ts` and the new download spec).

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useApi.ts apps/web/tests/composables/useApi-download.spec.ts
git commit -m "feat(web): add useApi download() returning a Blob with API errors preserved"
```

### Task 3: Job types and pure job helpers

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (4b's file: add one import at the top, append the job types)
- Create: `apps/web/lib/fleet-jobs.ts`, `apps/web/lib/fleet-i18n.ts`
- Test: `apps/web/tests/lib/fleet-jobs.spec.ts`, `apps/web/tests/lib/fleet-i18n.spec.ts`

**Interfaces:**
- Consumes: `FleetJobState` (Task 1).
- Produces (used by Tasks 5, 7, 8, 9): types `MisfitReason`, `FleetJobDto`, `FleetJobEventDto`, `PlacementMisfit`, `DispatchResultDto`, `DispatchBody`; from `lib/fleet-jobs.ts`: `ACTIVE_JOB_STATES`, `TERMINAL_JOB_STATES`, `REQUEUEABLE_JOB_STATES`, `isActiveJobState(s)`, `isTerminalJobState(s)`, `mayHaveBundle(s)`, `canWorkOnFleet(role: { canManage: boolean; viewerRole: string | null }): boolean`, `interface JobViewer { userId: string | null; canWork: boolean }`, `canCancelJob(job, viewer)`, `canRequeueJob(job, viewer)`, `formatUsd(decimal)`, `interface JobProgress`, `extractProgress(unknown)`, `safePrUrl(url)`, `type TimelineEntry`, `summarizeEvent(event)`, `visibleTimelineEvents(events)`, `pickActiveJob(records)`, `bundleFileName(id)`, `mergeEvents(existing, incoming)`; from `lib/fleet-i18n.ts`: `codeLabel(t, te, prefix, code)`.

`FleetJobDto` mirrors `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` field for field. `progress` is nax's `status.json` counters `{ total, passed, failed, paused, blocked, pending }` (runner `src/verdict/status-view.ts`), but it is untrusted JSON, so it stays `unknown` and only `extractProgress` reads it. Server-written `state` events carry `{ from, to, by, reason }` with `runnerSeq: null` (the first one, at dispatch, is `{ from: null, to: 'QUEUED', by: 'server' }`); runner-written ones carry `{ to, reason?, exitCode? }` and are stored too, next to the server's own row for the transition they caused (`apps/api/src/fleet/jobs/job-transitions.service.ts:62`, `sync/event-payloads.ts`; observed against the real API in review: seq 3 and 5, 6 and 7, 9 and 10). The timeline therefore shows only the server's `state` rows (`visibleTimelineEvents`), so every transition appears once.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/lib/fleet-jobs.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  bundleFileName,
  canCancelJob,
  canRequeueJob,
  canWorkOnFleet,
  extractProgress,
  formatUsd,
  isActiveJobState,
  isTerminalJobState,
  mayHaveBundle,
  mergeEvents,
  pickActiveJob,
  safePrUrl,
  summarizeEvent,
  visibleTimelineEvents,
} from '~/lib/fleet-jobs'
import type { FleetJobDto, FleetJobEventDto } from '~/lib/fleet-types'

const job = (over: Partial<FleetJobDto> = {}): FleetJobDto => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, leaseEpoch: 0,
  state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T00:00:00.000Z', assignedAt: null,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', lastHeartbeatAt: null,
  finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  ...over,
})

describe('state groups', () => {
  test('active and terminal partition every state', () => {
    for (const s of ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']) expect([isActiveJobState(s), isTerminalJobState(s)]).toEqual([true, false])
    for (const s of ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']) expect([isActiveJobState(s), isTerminalJobState(s)]).toEqual([false, true])
  })

  test('a bundle may exist from UPLOADING on, never while QUEUED/ASSIGNED/RUNNING', () => {
    expect(['QUEUED', 'ASSIGNED', 'RUNNING'].map(mayHaveBundle)).toEqual([false, false, false])
    expect(['UPLOADING', 'COMPLETED', 'CANCELLED', 'CRASHED'].map(mayHaveBundle)).toEqual([true, true, true, true])
  })
})

describe('permissions', () => {
  test('canWorkOnFleet: project ADMIN (canManage) or DEVELOPER', () => {
    expect(canWorkOnFleet({ canManage: true, viewerRole: 'ADMIN' })).toBe(true)
    expect(canWorkOnFleet({ canManage: false, viewerRole: 'DEVELOPER' })).toBe(true)
    expect(canWorkOnFleet({ canManage: false, viewerRole: 'VIEWER' })).toBe(false)
    expect(canWorkOnFleet({ canManage: false, viewerRole: null })).toBe(false)
  })

  const dev = { userId: 'u2', canWork: true }
  const viewer = { userId: 'u3', canWork: false }
  const requester = { userId: 'u1', canWork: false }

  test('cancel: workers and the requester, only while unfinished', () => {
    expect(canCancelJob(job({ state: 'RUNNING' }), dev)).toBe(true)
    expect(canCancelJob(job({ state: 'RUNNING' }), requester)).toBe(true)
    expect(canCancelJob(job({ state: 'RUNNING' }), viewer)).toBe(false)
    expect(canCancelJob(job({ state: 'COMPLETED' }), dev)).toBe(false)
    expect(canCancelJob(job({ state: 'RUNNING' }), { userId: null, canWork: false })).toBe(false)
  })

  test('requeue: workers only, from CRASHED, FAILED or CANCELLED', () => {
    expect(['CRASHED', 'FAILED', 'CANCELLED'].map(state => canRequeueJob(job({ state: state as FleetJobDto['state'] }), dev))).toEqual([true, true, true])
    expect(canRequeueJob(job({ state: 'ESCALATED' }), dev)).toBe(false)
    expect(canRequeueJob(job({ state: 'COMPLETED' }), dev)).toBe(false)
    expect(canRequeueJob(job({ state: 'FAILED' }), requester)).toBe(false)
  })
})

describe('formatUsd', () => {
  test.each([
    ['0.4200', '$0.42'],
    ['12', '$12.00'],
    ['0', '$0.00'],
    ['0.0042', '$0.0042'],
    ['10000.0000', '$10000.00'],
  ])('%s -> %s', (input, out) => {
    expect(formatUsd(input)).toBe(out)
  })

  test('null, empty and garbage', () => {
    expect(formatUsd(null)).toBe('-')
    expect(formatUsd('  ')).toBe('-')
    expect(formatUsd('abc')).toBe('abc')
  })
})

describe('extractProgress', () => {
  test('reads nax counters', () => {
    expect(extractProgress({ total: 4, passed: 1, failed: 1, paused: 0, blocked: 0, pending: 2 })).toEqual({ total: 4, passed: 1, failed: 1, pending: 2 })
  })

  test('missing counters default to 0', () => {
    expect(extractProgress({ total: 3 })).toEqual({ total: 3, passed: 0, failed: 0, pending: 0 })
  })

  test.each([[null], [[]], ['x'], [{}], [{ total: 0 }], [{ total: -1 }], [{ total: 1.5 }], [{ total: '3' }]])('unusable %p -> null', (value) => {
    expect(extractProgress(value)).toBeNull()
  })
})

describe('safePrUrl', () => {
  test('keeps https only', () => {
    expect(safePrUrl('https://github.com/acme/app/pull/7')).toBe('https://github.com/acme/app/pull/7')
    expect(safePrUrl('http://github.com/acme/app/pull/7')).toBeNull()
    expect(safePrUrl('javascript:alert(1)')).toBeNull()
    expect(safePrUrl('not a url')).toBeNull()
    expect(safePrUrl(null)).toBeNull()
  })
})

describe('summarizeEvent', () => {
  test('server transition', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: null, payload: { from: 'QUEUED', to: 'ASSIGNED', by: 'server', reason: null } }))
      .toEqual({ kind: 'transition', from: 'QUEUED', to: 'ASSIGNED', reason: null, source: 'server' })
  })

  test('the server row written at dispatch has no from', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: null, payload: { from: null, to: 'QUEUED', by: 'server', reason: null } }))
      .toEqual({ kind: 'transition', from: null, to: 'QUEUED', reason: null, source: 'server' })
  })

  test('runner-reported state has no from', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: 3, payload: { to: 'FAILED', reason: 'capability mismatch: sandbox' } }))
      .toEqual({ kind: 'transition', from: null, to: 'FAILED', reason: 'capability mismatch: sandbox', source: 'runner' })
  })

  test('a state event without to is unknown', () => {
    expect(summarizeEvent({ type: 'state', runnerSeq: 1, payload: {} })).toEqual({ kind: 'unknown', type: 'state' })
  })

  test('snapshot lists story, phase, progress, cost and finish result in that order', () => {
    expect(summarizeEvent({
      type: 'snapshot', runnerSeq: 2,
      payload: { currentStoryId: 'US-001', currentPhase: 'implement', progress: { total: 2, passed: 1 }, costSpentUsd: '0.4200', finishResult: 'opened' },
    })).toEqual({ kind: 'snapshot', parts: ['US-001', 'implement', '1/2', '$0.42', 'opened'] })
  })

  test('an empty snapshot has no parts', () => {
    expect(summarizeEvent({ type: 'snapshot', runnerSeq: 2, payload: { currentStoryId: null } })).toEqual({ kind: 'snapshot', parts: [] })
  })

  test('lifecycle and log', () => {
    expect(summarizeEvent({ type: 'lifecycle', runnerSeq: 4, payload: { level: 'warn', message: 'watcher error' } }))
      .toEqual({ kind: 'lifecycle', level: 'warn', message: 'watcher error' })
    const long = 'x'.repeat(400)
    expect(summarizeEvent({ type: 'log', runnerSeq: 5, payload: { text: long } })).toEqual({ kind: 'log', text: `${'x'.repeat(300)}...` })
  })

  test('a non-object payload never throws', () => {
    expect(summarizeEvent({ type: 'lifecycle', runnerSeq: 1, payload: null })).toEqual({ kind: 'lifecycle', level: 'info', message: '' })
    expect(summarizeEvent({ type: 'bogus' as 'log', runnerSeq: 1, payload: 'x' })).toEqual({ kind: 'unknown', type: 'bogus' })
  })
})

describe('visibleTimelineEvents', () => {
  const ev = (id: string, type: FleetJobEventDto['type'], runnerSeq: number | null): FleetJobEventDto =>
    ({ id, seq: 0, leaseEpoch: 1, runnerSeq, type, payload: {}, createdAt: '2026-10-01T00:00:00.000Z' })

  test("drops the runner's own state rows (the server writes the applied transition too) and keeps everything else", () => {
    const events = [ev('q', 'state', null), ev('r', 'state', 3), ev('s', 'state', null), ev('n', 'snapshot', 4), ev('l', 'log', 5)]
    expect(visibleTimelineEvents(events).map(e => e.id)).toEqual(['q', 's', 'n', 'l'])
    expect(events).toHaveLength(5)
  })
})

describe('pickActiveJob', () => {
  test('first active record wins; none -> null', () => {
    const records = [job({ id: 'old', state: 'COMPLETED' }), job({ id: 'live', state: 'RUNNING' })]
    expect(pickActiveJob(records)?.id).toBe('live')
    expect(pickActiveJob([job({ state: 'FAILED' })])).toBeNull()
    expect(pickActiveJob([])).toBeNull()
  })
})

test('bundleFileName', () => {
  expect(bundleFileName('j1')).toBe('koda-job-j1.tar.gz')
})

describe('mergeEvents', () => {
  const ev = (id: string, seq: number, type: FleetJobEventDto['type'] = 'log'): FleetJobEventDto =>
    ({ id, seq, leaseEpoch: 1, runnerSeq: seq, type, payload: {}, createdAt: '2026-10-01T00:00:00.000Z' })

  test('appends new rows, replaces refetched ones, orders by seq, never mutates', () => {
    const loaded = [ev('a', 1), ev('b', 2)]
    const merged = mergeEvents(loaded, [ev('b', 2, 'state'), ev('c', 3)])
    expect(merged.map(e => [e.id, e.type])).toEqual([['a', 'log'], ['b', 'state'], ['c', 'log']])
    expect(loaded.map(e => e.type)).toEqual(['log', 'log'])
  })
})
```

Create `apps/web/tests/lib/fleet-i18n.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { codeLabel } from '~/lib/fleet-i18n'

const keys: Record<string, string> = { 'fleet.state.RUNNING': 'Running' }
const t = (key: string): string => keys[key] ?? `!${key}`
const te = (key: string): boolean => key in keys

describe('codeLabel', () => {
  test('translates a known code', () => {
    expect(codeLabel(t, te, 'fleet.state', 'RUNNING')).toBe('Running')
  })

  test('falls back to the raw code for an unknown one', () => {
    expect(codeLabel(t, te, 'fleet.state', 'PAUSED')).toBe('PAUSED')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx jest tests/lib/fleet-jobs.spec.ts tests/lib/fleet-i18n.spec.ts`
Expected: FAIL: `Cannot find module '~/lib/fleet-jobs'` and `Cannot find module '~/lib/fleet-i18n'`.

- [ ] **Step 3: Implement**

At the top of `apps/web/lib/fleet-types.ts` (above 4b's declarations) add:

```ts
import type { FleetJobState } from '~/lib/project-event-stream'
```

and append to the end of the file:

```ts
export type { FleetJobState }

export type MisfitReason =
  | 'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity'

export interface FleetJobDto {
  id: string
  projectId: string
  repoId: string
  ref: string
  command: 'RUN' | 'PLAN'
  feature: string
  planFrom: string | null
  profiles: string[]
  maxCostUsd: string
  bashMode: string
  selectorLabels: string[]
  pinnedRunnerId: string | null
  runnerId: string | null
  leaseEpoch: number
  state: FleetJobState
  stateReason: string | null
  requestedById: string
  queuedAt: string
  assignedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  naxRunId: string | null
  naxLogRunId: string | null
  naxCostRunId: string | null
  progress: unknown
  currentStoryId: string | null
  currentPhase: string | null
  costSpentUsd: string
  lastHeartbeatAt: string | null
  finishResult: string | null
  escalationReason: string | null
  exitCode: number | null
  resultBranch: string | null
  resultSha: string | null
  resultPrUrl: string | null
}

export interface FleetJobEventDto {
  id: string
  seq: number
  leaseEpoch: number
  runnerSeq: number | null
  type: 'state' | 'snapshot' | 'lifecycle' | 'log'
  payload: unknown
  createdAt: string
}

export interface PlacementMisfit {
  runnerId: string
  name: string
  reason: MisfitReason
}

export interface DispatchResultDto {
  job: FleetJobDto
  placement: { assigned: boolean; runnerId: string | null; misfits: PlacementMisfit[] }
}

/** POST /projects/:slug/fleet/jobs body; bashMode is left to the server default (raw). */
export interface DispatchBody {
  repoId: string
  command: 'RUN' | 'PLAN'
  feature: string
  maxCostUsd: number
  ref?: string
  planFrom?: string
  profiles?: string[]
  selectorLabels?: string[]
  pinnedRunnerId?: string
}
```

Create `apps/web/lib/fleet-jobs.ts`:

```ts
import type { FleetJobDto, FleetJobEventDto, FleetJobState } from '~/lib/fleet-types'

/** Mirrors apps/api/src/fleet/jobs/job-state.ts (S1 spec §5.4). */
export const ACTIVE_JOB_STATES: readonly FleetJobState[] = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']
export const TERMINAL_JOB_STATES: readonly FleetJobState[] = ['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']
/** The server's requeue rows: CRASHED|FAILED|CANCELLED -> QUEUED. */
export const REQUEUEABLE_JOB_STATES: readonly FleetJobState[] = ['CRASHED', 'FAILED', 'CANCELLED']

export const isActiveJobState = (state: string): boolean => (ACTIVE_JOB_STATES as readonly string[]).includes(state)
export const isTerminalJobState = (state: string): boolean => (TERMINAL_JOB_STATES as readonly string[]).includes(state)

/** A bundle can exist once the runner may upload (RUNNING partial on cancel, UPLOADING) or the job ended. */
export const mayHaveBundle = (state: string): boolean => state === 'UPLOADING' || isTerminalJobState(state)

/** Dispatch and requeue: project ADMIN (`canManage`) or DEVELOPER (S1 spec §2.2); one rule for every fleet page. */
export function canWorkOnFleet(role: { canManage: boolean; viewerRole: string | null }): boolean {
  return role.canManage || role.viewerRole === 'DEVELOPER'
}

export interface JobViewer {
  userId: string | null
  /** Project ADMIN or DEVELOPER (S1 spec §2.2), from canWorkOnFleet. */
  canWork: boolean
}

/** Cancel: project DEVELOPER+ or the requester, and only while the job is unfinished. */
export function canCancelJob(job: Pick<FleetJobDto, 'state' | 'requestedById'>, viewer: JobViewer): boolean {
  if (isTerminalJobState(job.state)) return false
  return viewer.canWork || (viewer.userId !== null && viewer.userId === job.requestedById)
}

export function canRequeueJob(job: Pick<FleetJobDto, 'state'>, viewer: JobViewer): boolean {
  return viewer.canWork && (REQUEUEABLE_JOB_STATES as readonly string[]).includes(job.state)
}

/** "$0.42" from the API's decimal string; sub-cent values keep 4 decimals; garbage is shown raw. */
export function formatUsd(decimal: string | null | undefined): string {
  if (decimal === null || decimal === undefined || decimal.trim() === '') return '-'
  const n = Number(decimal)
  if (!Number.isFinite(n)) return decimal
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2
  return `$${n.toFixed(digits)}`
}

export interface JobProgress {
  total: number
  passed: number
  failed: number
  pending: number
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** nax status.json progress ({ total, passed, failed, paused, blocked, pending }); null when unusable. */
export function extractProgress(progress: unknown): JobProgress | null {
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return null
  const p = progress as Record<string, unknown>
  const total = count(p.total)
  if (total === null || total === 0) return null
  return { total, passed: count(p.passed) ?? 0, failed: count(p.failed) ?? 0, pending: count(p.pending) ?? 0 }
}

/** Only an https PR link is rendered as a link (the API also accepts http). */
export function safePrUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  }
  catch {
    return null
  }
}

export type TimelineEntry =
  | { kind: 'transition'; from: string | null; to: string; reason: string | null; source: 'server' | 'runner' }
  | { kind: 'snapshot'; parts: string[] }
  | { kind: 'lifecycle'; level: string; message: string }
  | { kind: 'log'; text: string }
  | { kind: 'unknown'; type: string }

const LOG_PREVIEW = 300
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

/** One timeline row from a job event; the payload is untrusted JSON, so every field is checked. */
export function summarizeEvent(event: Pick<FleetJobEventDto, 'type' | 'payload' | 'runnerSeq'>): TimelineEntry {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>
  switch (event.type) {
    case 'state': {
      const to = text(p.to)
      if (!to) return { kind: 'unknown', type: event.type }
      return { kind: 'transition', from: text(p.from), to, reason: text(p.reason), source: event.runnerSeq === null ? 'server' : 'runner' }
    }
    case 'snapshot': {
      const progress = extractProgress(p.progress)
      const cost = text(p.costSpentUsd)
      const parts = [
        text(p.currentStoryId),
        text(p.currentPhase),
        progress ? `${progress.passed}/${progress.total}` : null,
        cost ? formatUsd(cost) : null,
        text(p.finishResult),
      ].filter((part): part is string => part !== null)
      return { kind: 'snapshot', parts }
    }
    case 'lifecycle':
      return { kind: 'lifecycle', level: text(p.level) ?? 'info', message: text(p.message) ?? '' }
    case 'log': {
      const body = text(p.text) ?? ''
      return { kind: 'log', text: body.length > LOG_PREVIEW ? `${body.slice(0, LOG_PREVIEW)}...` : body }
    }
    default:
      return { kind: 'unknown', type: event.type }
  }
}

/**
 * Timeline rows: the runner's own `state` events (runnerSeq set) are dropped because the server writes
 * the transition it applied as well (runnerSeq null), with `from`; everything else is kept.
 */
export function visibleTimelineEvents(events: readonly FleetJobEventDto[]): FleetJobEventDto[] {
  return events.filter(event => !(event.type === 'state' && event.runnerSeq !== null))
}

/** The active job behind a dispatch 409 (D121): newest first, at most one is active. */
export function pickActiveJob(records: readonly FleetJobDto[]): FleetJobDto | null {
  return records.find(job => isActiveJobState(job.state)) ?? null
}

/** `koda-job-<id>.tar.gz`, same stem the API's Content-Disposition uses. */
export const bundleFileName = (jobId: string): string => `koda-job-${jobId}.tar.gz`

/** Merges a fetched events page into the loaded timeline: one row per id, ordered by seq. */
export function mergeEvents(existing: readonly FleetJobEventDto[], incoming: readonly FleetJobEventDto[]): FleetJobEventDto[] {
  const byId = new Map([...existing, ...incoming].map(event => [event.id, event]))
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}
```

Create `apps/web/lib/fleet-i18n.ts`:

```ts
export type Translate = (key: string) => string
export type HasKey = (key: string) => boolean

/** D126: the translation of a server code under `prefix`, or the raw code when no key exists. */
export function codeLabel(t: Translate, te: HasKey, prefix: string, code: string): string {
  const key = `${prefix}.${code}`
  return te(key) ? t(key) : code
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/web && npx jest tests/lib/fleet-jobs.spec.ts tests/lib/fleet-i18n.spec.ts`
Expected: PASS (36 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-jobs.ts apps/web/lib/fleet-i18n.ts apps/web/tests/lib/fleet-jobs.spec.ts apps/web/tests/lib/fleet-i18n.spec.ts
git commit -m "feat(web): fleet job types and pure helpers for states, permissions, cost and timeline"
```

### Task 4: Dispatch form rules

**Files:**
- Create: `apps/web/lib/fleet-dispatch.ts`
- Test: `apps/web/tests/lib/fleet-dispatch.spec.ts`

**Interfaces:**
- Consumes: `DispatchBody` (Task 3); `LABEL_PATTERN` from 4b's `lib/fleet-validation.ts`.
- Produces (Task 8): `buildDispatchSchema(t: (key: string) => string)` (a zod object), `type DispatchFormValues`, `DISPATCH_DEFAULTS` (`maxCostUsd: 5`, `command: 'RUN'`, everything else empty), `toDispatchBody(values): DispatchBody`, `addToken(list, token): string[]`, `removeToken(list, token): string[]`, and the constants `FEATURE_RE`, `PROFILE_NAME_RE`, `RESERVED_PROFILE_PREFIX`, `MAX_PROFILES` (8), `MAX_SELECTOR_LABELS` (16; not 4b's `MAX_LABELS`, which is the runner's 20), `MAX_COST_USD` (10000).

Mirrors (D140): `apps/api/src/fleet/jobs/dispatch-input.ts` (`FEATURE_RE`, `..` ban, PLAN needs `planFrom`, RUN must not send it, reserved `koda-job-` profiles, no duplicate profiles), `dto/dispatch-fleet-job.dto.ts` (profiles max 8, labels max 16, `maxCostUsd` 0.0001..10000 with at most 4 decimals), `common/capabilities.ts` (`PROFILE_NAME_RE`); selector labels use the label rule 4b already mirrors (`LABEL_PATTERN`, `runners/dto/create-enrollment.dto.ts`). `bashMode` is never sent (the server defaults to `raw`). A pin wins over labels in the body; the schema also rejects both together, so the form shows the conflict instead of silently dropping labels.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-dispatch.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { addToken, buildDispatchSchema, DISPATCH_DEFAULTS, removeToken, toDispatchBody, type DispatchFormValues } from '~/lib/fleet-dispatch'

const t = (key: string): string => key
const schema = buildDispatchSchema(t)
const valid = (over: Partial<DispatchFormValues> = {}): DispatchFormValues => ({ ...DISPATCH_DEFAULTS, repoId: 'r1', feature: 'login-fix', ...over })
const messages = (values: unknown): string[] => {
  const r = schema.safeParse(values)
  return r.success ? [] : r.error.issues.map(i => i.message)
}

describe('buildDispatchSchema', () => {
  test('accepts a minimal RUN', () => {
    expect(messages(valid())).toEqual([])
  })

  test('requires a repo', () => {
    expect(messages(valid({ repoId: '' }))).toContain('fleet.dispatch.validation.repoRequired')
  })

  test.each(['', '-x', 'a/b', 'a..b', 'x'.repeat(129)])('rejects feature %p', (feature) => {
    expect(messages(valid({ feature }))).toContain('fleet.dispatch.validation.feature')
  })

  test('PLAN needs planFrom; RUN does not', () => {
    expect(messages(valid({ command: 'PLAN', planFrom: '  ' }))).toContain('fleet.dispatch.validation.planFromRequired')
    expect(messages(valid({ command: 'PLAN', planFrom: 'docs/spec.md' }))).toEqual([])
  })

  test('profiles: names, reserved prefix, duplicates, max 8', () => {
    expect(messages(valid({ profiles: ['bad name'] }))).toContain('fleet.dispatch.validation.profileName')
    expect(messages(valid({ profiles: ['koda-job-1'] }))).toContain('fleet.dispatch.validation.profileName')
    expect(messages(valid({ profiles: ['a', 'a'] }))).toContain('fleet.dispatch.validation.profileDuplicate')
    expect(messages(valid({ profiles: Array.from({ length: 9 }, (_, i) => `p${i}`) }))).toContain('fleet.dispatch.validation.profilesMax')
  })

  test('max cost: > 0, <= 10000, at most 4 decimals, coerced from the input string', () => {
    expect(messages(valid({ maxCostUsd: 0 }))).toContain('fleet.dispatch.validation.maxCost')
    expect(messages(valid({ maxCostUsd: 10_001 }))).toContain('fleet.dispatch.validation.maxCost')
    expect(messages(valid({ maxCostUsd: 0.00001 }))).toContain('fleet.dispatch.validation.maxCost')
    expect(messages({ ...valid(), maxCostUsd: '2.5' })).toEqual([])
    expect(messages({ ...valid(), maxCostUsd: 'abc' })).toContain('fleet.dispatch.validation.maxCost')
  })

  test('labels: pattern and mutual exclusion with a pin', () => {
    expect(messages(valid({ selectorLabels: ['Linux'] }))).toContain('fleet.dispatch.validation.label')
    expect(messages(valid({ selectorLabels: ['linux'], pinnedRunnerId: 'run1' }))).toContain('fleet.dispatch.validation.labelsOrPin')
    expect(messages(valid({ selectorLabels: ['linux'] }))).toEqual([])
  })
})

describe('toDispatchBody', () => {
  test('a minimal RUN sends only the required fields', () => {
    expect(toDispatchBody(valid())).toEqual({ repoId: 'r1', command: 'RUN', feature: 'login-fix', maxCostUsd: 5 })
  })

  test('trims, keeps ref, profiles and labels', () => {
    expect(toDispatchBody(valid({ ref: ' dev ', feature: ' f1 ', profiles: ['fast', 'review'], selectorLabels: ['linux'] })))
      .toEqual({ repoId: 'r1', command: 'RUN', feature: 'f1', maxCostUsd: 5, ref: 'dev', profiles: ['fast', 'review'], selectorLabels: ['linux'] })
  })

  test('planFrom only for PLAN', () => {
    expect(toDispatchBody(valid({ planFrom: 'docs/x.md' }))).not.toHaveProperty('planFrom')
    expect(toDispatchBody(valid({ command: 'PLAN', planFrom: ' docs/x.md ' }))).toMatchObject({ planFrom: 'docs/x.md' })
  })

  test('a pin wins over labels and drops them', () => {
    const body = toDispatchBody(valid({ pinnedRunnerId: 'run1', selectorLabels: ['linux'] }))
    expect(body.pinnedRunnerId).toBe('run1')
    expect(body).not.toHaveProperty('selectorLabels')
  })

  test('does not share arrays with the form values', () => {
    const values = valid({ profiles: ['fast'] })
    const body = toDispatchBody(values)
    expect(body.profiles).toEqual(['fast'])
    expect(body.profiles).not.toBe(values.profiles)
  })
})

describe('token lists', () => {
  test('addToken trims, skips blanks and duplicates, never mutates', () => {
    const list = ['a']
    expect(addToken(list, ' b ')).toEqual(['a', 'b'])
    expect(addToken(list, 'a')).toEqual(['a'])
    expect(addToken(list, '  ')).toEqual(['a'])
    expect(list).toEqual(['a'])
  })

  test('removeToken', () => {
    expect(removeToken(['a', 'b'], 'a')).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx jest tests/lib/fleet-dispatch.spec.ts`
Expected: FAIL: `Cannot find module '~/lib/fleet-dispatch'`.

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-dispatch.ts`:

```ts
import * as z from 'zod'
import type { DispatchBody } from '~/lib/fleet-types'
import { LABEL_PATTERN } from '~/lib/fleet-validation'

/** apps/api/src/fleet/jobs/dispatch-input.ts FEATURE_RE (nax validateFeatureName). */
export const FEATURE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
/** apps/api/src/fleet/common/capabilities.ts PROFILE_NAME_RE. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const RESERVED_PROFILE_PREFIX = 'koda-job-'
export const MAX_PROFILES = 8
/** DispatchFleetJobDto selectorLabels max (a runner's own labels allow 20: 4b's MAX_LABELS). */
export const MAX_SELECTOR_LABELS = 16
export const MAX_COST_USD = 10_000

type Translate = (key: string) => string

/**
 * The dispatch form (S1 spec §5.1). Mirrors the server's checks so most mistakes are caught
 * before the request; the server stays the authority (its 400 message is shown as-is).
 */
export function buildDispatchSchema(t: Translate) {
  return z.object({
    repoId: z.string({ required_error: t('fleet.dispatch.validation.repoRequired') }).min(1, t('fleet.dispatch.validation.repoRequired')),
    ref: z.string().max(255, t('fleet.dispatch.validation.ref')).optional(),
    command: z.enum(['RUN', 'PLAN']),
    feature: z.string()
      .regex(FEATURE_RE, t('fleet.dispatch.validation.feature'))
      .refine(value => !value.includes('..'), t('fleet.dispatch.validation.feature')),
    planFrom: z.string().max(512, t('fleet.dispatch.validation.planFrom')).optional(),
    profiles: z.array(z.string()).max(MAX_PROFILES, t('fleet.dispatch.validation.profilesMax'))
      .refine(list => list.every(p => PROFILE_NAME_RE.test(p) && !p.startsWith(RESERVED_PROFILE_PREFIX)), t('fleet.dispatch.validation.profileName'))
      .refine(list => new Set(list).size === list.length, t('fleet.dispatch.validation.profileDuplicate')),
    maxCostUsd: z.coerce.number({ invalid_type_error: t('fleet.dispatch.validation.maxCost') })
      .gt(0, t('fleet.dispatch.validation.maxCost'))
      .max(MAX_COST_USD, t('fleet.dispatch.validation.maxCost'))
      .refine(n => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, t('fleet.dispatch.validation.maxCost')), // at most 4 decimals
    selectorLabels: z.array(z.string()).max(MAX_SELECTOR_LABELS, t('fleet.dispatch.validation.labelsMax'))
      .refine(list => list.every(l => LABEL_PATTERN.test(l)), t('fleet.dispatch.validation.label')),
    pinnedRunnerId: z.string().optional(),
  }).superRefine((v, ctx) => {
    if (v.command === 'PLAN' && !(v.planFrom ?? '').trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planFrom'], message: t('fleet.dispatch.validation.planFromRequired') })
    }
    if (v.pinnedRunnerId && v.selectorLabels.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectorLabels'], message: t('fleet.dispatch.validation.labelsOrPin') })
    }
  })
}

export type DispatchFormValues = z.infer<ReturnType<typeof buildDispatchSchema>>

export const DISPATCH_DEFAULTS: DispatchFormValues = {
  repoId: '',
  ref: '',
  command: 'RUN',
  feature: '',
  planFrom: '',
  profiles: [],
  maxCostUsd: 5,
  selectorLabels: [],
  pinnedRunnerId: '',
}

/** Form values -> request body: trims, drops empty optionals, planFrom only for PLAN. */
export function toDispatchBody(v: DispatchFormValues): DispatchBody {
  const ref = (v.ref ?? '').trim()
  const planFrom = (v.planFrom ?? '').trim()
  const pin = (v.pinnedRunnerId ?? '').trim()
  return {
    repoId: v.repoId,
    command: v.command,
    feature: v.feature.trim(),
    maxCostUsd: v.maxCostUsd,
    ...(ref ? { ref } : {}),
    ...(v.command === 'PLAN' && planFrom ? { planFrom } : {}),
    ...(v.profiles.length > 0 ? { profiles: [...v.profiles] } : {}),
    ...(pin ? { pinnedRunnerId: pin } : v.selectorLabels.length > 0 ? { selectorLabels: [...v.selectorLabels] } : {}),
  }
}

/** Adds a token to a chain once, trimmed; the list is never mutated. */
export function addToken(list: readonly string[], token: string): string[] {
  const value = token.trim()
  if (!value || list.includes(value)) return [...list]
  return [...list, value]
}

export const removeToken = (list: readonly string[], token: string): string[] => list.filter(item => item !== token)
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/web && npx jest tests/lib/fleet-dispatch.spec.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-dispatch.ts apps/web/tests/lib/fleet-dispatch.spec.ts
git commit -m "feat(web): fleet dispatch form schema and request body"
```

### Task 5: Fleet job composables

**Files:**
- Create: `apps/web/lib/save-blob.ts`, `apps/web/composables/useFleetJobs.ts`, `apps/web/composables/useFleetDispatchOptions.ts`, `apps/web/composables/useProjectMemberNames.ts`
- Test: `apps/web/tests/lib/save-blob.spec.ts`, `apps/web/tests/composables/useFleetJobs.spec.ts`, `apps/web/tests/composables/useFleetDispatchOptions.spec.ts`, `apps/web/tests/composables/useProjectMemberNames.spec.ts`

**Interfaces:**
- Consumes: `$api.get/post/download` (Task 2), `apiPath`, types and helpers from Task 3, `FleetPage<T>`, `FleetRepo`, `FleetRunnerSummary`, `FLEET_LIST_SIZE` (4b), `ProjectMember` (exported by `composables/useProjectMembers.ts`).
- Produces (Tasks 7-9):
  - `FLEET_JOB_PAGE_SIZE` (20), `FLEET_EVENT_PAGE_SIZE` (50), `interface FleetJobFilters { state?; repoId?; runnerId?; requestedById?; page? }`, `buildJobQuery(filters): Record<string, string>`;
  - `REVOKE_DELAY_MS` (1000) and `saveBlob(blob: Blob, fileName: string): void` (`lib/save-blob.ts`);
  - `useFleetJobs(slug)` returns `{ jobs, total, page, hasNext, load(filters), get(id), events(id, current), dispatch(body), cancel(id), requeue(id), findActiveJob(repoId, feature), downloadBundle(id) }` (refs are `Ref`s; `get` returns `FleetJobDto`, `events` a `FleetPage<FleetJobEventDto>`, `dispatch` and `requeue` a `DispatchResultDto`, `cancel` a `FleetJobDto`);
  - `useFleetDispatchOptions(slug)` returns `{ repos, runners, moreRepos, moreRunners, load(), profileOptions, labelOptions, repoName(id), runnerName(id | null) }` (one page of 4b's `FLEET_LIST_SIZE`);
  - `useProjectMemberNames(slug)` returns `{ members, load(), nameOf(userId): string | null }` (null for a user who is not in the loaded members: a former member, or beyond the first 100; pages show `fleet.jobs.unknownMember`).

Routes: `GET|POST /projects/:slug/fleet/jobs`, `GET .../jobs/:id`, `GET .../jobs/:id/events?current&size`, `POST .../jobs/:id/cancel`, `POST .../jobs/:id/requeue`, `GET .../jobs/:id/bundle`, `GET /projects/:slug/fleet/repos?size=100`, `GET /projects/:slug/fleet/runners?size=100` (4a, D118), `GET /projects/:slug/members?size=100`. `findActiveJob` implements D121. Runner names come from the summaries, which any member can read; the admin runner list is not used here.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/composables/useFleetJobs.spec.ts`:

```ts
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetJobs.ts')
const g = globalThis as Record<string, unknown>
const page = (records: unknown[], over: Record<string, unknown> = {}) => ({ records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over })
const job = (id: string, state: string) => ({ id, state, requestedById: 'u1' })

function withApi(api: Record<string, jest.Mock>) {
  g.useApi = () => ({ $api: api })
}

describe('buildJobQuery', () => {
  test('sends only set filters, a page size, and current past page 1', async () => {
    const { buildJobQuery } = await import(composablePath)
    expect(buildJobQuery({})).toEqual({ size: '20' })
    expect(buildJobQuery({ state: 'RUNNING', repoId: '', runnerId: 'r1', page: 1 })).toEqual({ state: 'RUNNING', runnerId: 'r1', size: '20' })
    expect(buildJobQuery({ requestedById: 'u1', page: 3 })).toEqual({ requestedById: 'u1', size: '20', current: '3' })
  })
})

describe('useFleetJobs', () => {
  beforeEach(() => { g.useApi = undefined })

  test('load reads the page into refs and encodes the slug', async () => {
    const get = jest.fn(async () => page([job('j1', 'RUNNING')], { total: 21, hasNext: true }))
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('my proj')

    await jobs.load({ state: 'RUNNING' })

    expect(get).toHaveBeenCalledWith('/projects/my%20proj/fleet/jobs', { query: { state: 'RUNNING', size: '20' } })
    expect(jobs.jobs.value).toHaveLength(1)
    expect(jobs.total.value).toBe(21)
    expect(jobs.hasNext.value).toBe(true)
  })

  test('get, events, cancel, requeue and dispatch hit their routes', async () => {
    const get = jest.fn(async () => page([]))
    const post = jest.fn(async () => ({}))
    withApi({ get, post })
    const { useFleetJobs } = await import(composablePath)
    const jobs = useFleetJobs('web')

    await jobs.get('j/1')
    await jobs.events('j1', 2)
    await jobs.cancel('j1')
    await jobs.requeue('j1')
    await jobs.dispatch({ repoId: 'r1', command: 'RUN', feature: 'f', maxCostUsd: 5 })

    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs/j%2F1')
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/events', { query: { current: '2', size: '50' } })
    expect(post).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/cancel')
    expect(post).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/requeue')
    expect(post).toHaveBeenCalledWith('/projects/web/fleet/jobs', { repoId: 'r1', command: 'RUN', feature: 'f', maxCostUsd: 5 })
  })

  test('findActiveJob filters by repo and feature and returns the active record', async () => {
    const get = jest.fn(async () => page([job('old', 'FAILED'), job('live', 'UPLOADING')]))
    withApi({ get })
    const { useFleetJobs } = await import(composablePath)

    const found = await useFleetJobs('web').findActiveJob('r1', 'login-fix')

    expect(get).toHaveBeenCalledWith('/projects/web/fleet/jobs', { query: { repoId: 'r1', feature: 'login-fix', size: '20' } })
    expect(found?.id).toBe('live')
  })

  test('findActiveJob returns null when the duplicate already finished', async () => {
    withApi({ get: jest.fn(async () => page([job('old', 'COMPLETED')])) })
    const { useFleetJobs } = await import(composablePath)
    expect(await useFleetJobs('web').findActiveJob('r1', 'f')).toBeNull()
  })

  test('downloadBundle saves the blob under koda-job-<id>.tar.gz', async () => {
    const blob = new Blob(['gz'])
    const download = jest.fn(async () => blob)
    withApi({ download })
    const link = { href: '', download: '', click: jest.fn(), remove: jest.fn() }
    g.document = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } }
    const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    jest.useFakeTimers()
    try {
      const { useFleetJobs } = await import(composablePath)
      await useFleetJobs('web').downloadBundle('j1')

      expect(download).toHaveBeenCalledWith('/projects/web/fleet/jobs/j1/bundle')
      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(link.download).toBe('koda-job-j1.tar.gz')
      expect(link.click).toHaveBeenCalled()
    }
    finally {
      jest.runOnlyPendingTimers()
      jest.useRealTimers()
      delete g.document
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
    }
  })

  test('downloadBundle propagates the API error and creates no link', async () => {
    withApi({ download: jest.fn(async () => { throw new Error('No bundle yet') }) })
    const createElement = jest.fn()
    g.document = { createElement, body: { appendChild: jest.fn() } }
    try {
      const { useFleetJobs } = await import(composablePath)
      await expect(useFleetJobs('web').downloadBundle('j1')).rejects.toThrow('No bundle yet')
    }
    finally {
      delete g.document
    }
    expect(createElement).not.toHaveBeenCalled()
  })
})
```

Create `apps/web/tests/lib/save-blob.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { REVOKE_DELAY_MS, saveBlob } from '~/lib/save-blob'

const g = globalThis as Record<string, unknown>

describe('saveBlob', () => {
  let link: { href: string; download: string; click: jest.Mock; remove: jest.Mock }
  let createObjectURL: jest.SpiedFunction<typeof URL.createObjectURL>
  let revokeObjectURL: jest.SpiedFunction<typeof URL.revokeObjectURL>

  beforeEach(() => {
    link = { href: '', download: '', click: jest.fn(), remove: jest.fn() }
    g.document = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } }
    createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    delete g.document
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  test('clicks a link to the object URL with the file name, then removes the link', () => {
    const blob = new Blob(['gz'])
    saveBlob(blob, 'koda-job-j1.tar.gz')
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(link).toMatchObject({ href: 'blob:x', download: 'koda-job-j1.tar.gz' })
    expect(link.click).toHaveBeenCalledTimes(1)
    expect(link.remove).toHaveBeenCalledTimes(1)
  })

  test('revokes the object URL only after the delay (Firefox and Safari drop a download revoked in the click tick)', () => {
    saveBlob(new Blob(['gz']), 'f.tar.gz')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    jest.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  test('still removes the link and revokes when the click throws', () => {
    link.click.mockImplementation(() => { throw new Error('blocked') })
    expect(() => saveBlob(new Blob(['gz']), 'f.tar.gz')).toThrow('blocked')
    expect(link.remove).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})
```

Create `apps/web/tests/composables/useFleetDispatchOptions.spec.ts`:

```ts
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetDispatchOptions.ts')
const g = globalThis as Record<string, unknown>
const page = (records: unknown[], hasNext = false) => ({ records, total: records.length, current: 1, size: 100, hasNext, hasPrev: false })
const runner = (id: string, name: string, profiles: string[], labels: string[]) => ({ id, name, os: 'linux', arch: 'x64', labels, enabled: true, online: true, profiles })
const repo = (id: string, owner: string, name: string) => ({ id, projectId: 'p1', provider: 'github', owner, name, defaultBranch: 'main', githubInstallationId: '7', createdAt: 'x' })

describe('useFleetDispatchOptions', () => {
  beforeEach(() => { g.useApi = undefined })

  test('loads repos and runner summaries, 100 each, and flags more', async () => {
    const get = jest.fn(async (path: string) => (path.endsWith('/repos')
      ? page([repo('r1', 'acme', 'app')])
      : page([runner('n1', 'mac-1', ['fast', 'review'], ['mac']), runner('n2', 'lin-1', ['fast', 'cheap'], ['linux', 'mac'])], true)))
    g.useApi = () => ({ $api: { get } })
    const { useFleetDispatchOptions } = await import(composablePath)
    const options = useFleetDispatchOptions('web')

    await options.load()

    expect(get).toHaveBeenCalledWith('/projects/web/fleet/repos', { query: { size: '100' } })
    expect(get).toHaveBeenCalledWith('/projects/web/fleet/runners', { query: { size: '100' } })
    expect(options.moreRepos.value).toBe(false)
    expect(options.moreRunners.value).toBe(true)
    expect(options.profileOptions.value).toEqual(['cheap', 'fast', 'review'])
    expect(options.labelOptions.value).toEqual(['linux', 'mac'])
    expect(options.repoName('r1')).toBe('acme/app')
    expect(options.repoName('gone')).toBe('gone')
    expect(options.runnerName('n2')).toBe('lin-1')
    expect(options.runnerName(null)).toBeNull()
    expect(options.runnerName('deleted')).toBe('deleted')
  })
})
```

Create `apps/web/tests/composables/useProjectMemberNames.spec.ts`:

```ts
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useProjectMemberNames.ts')
const g = globalThis as Record<string, unknown>

describe('useProjectMemberNames', () => {
  beforeEach(() => { g.useApi = undefined })

  test('loads 100 members and resolves names, falling back to email, null for an unknown id', async () => {
    const get = jest.fn(async () => ({
      records: [
        { userId: 'u1', email: 'ann@k.t', name: 'Ann', role: 'ADMIN', joinedAt: 'x' },
        { userId: 'u2', email: 'bob@k.t', name: null, role: 'DEVELOPER', joinedAt: 'x' },
      ],
    }))
    g.useApi = () => ({ $api: { get } })
    const { useProjectMemberNames } = await import(composablePath)
    const people = useProjectMemberNames('web')

    await people.load()

    expect(get).toHaveBeenCalledWith('/projects/web/members', { query: { size: '100' } })
    expect(people.nameOf('u1')).toBe('Ann')
    expect(people.nameOf('u2')).toBe('bob@k.t')
    expect(people.nameOf('gone')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx jest tests/lib/save-blob.spec.ts tests/composables/useFleet tests/composables/useProjectMemberNames.spec.ts`
Expected: FAIL: `Cannot find module '~/lib/save-blob'` and `Cannot find module '.../composables/useFleetJobs.ts'` (and the other two).

- [ ] **Step 3: Implement**

Create `apps/web/lib/save-blob.ts`:

```ts
/**
 * Hands a Blob to the browser as a file download (D127). The object URL is revoked after a delay:
 * Firefox and Safari can drop a download whose URL is revoked in the same tick as the click.
 */
export const REVOKE_DELAY_MS = 1000

export function saveBlob(blob: Blob, fileName: string): void {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  try {
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
  }
  finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  }
}
```

Create `apps/web/composables/useFleetJobs.ts`:

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { bundleFileName, pickActiveJob } from '~/lib/fleet-jobs'
import type { DispatchBody, DispatchResultDto, FleetJobDto, FleetJobEventDto, FleetPage } from '~/lib/fleet-types'
import { saveBlob } from '~/lib/save-blob'

export const FLEET_JOB_PAGE_SIZE = 20
export const FLEET_EVENT_PAGE_SIZE = 50

export interface FleetJobFilters {
  state?: string
  repoId?: string
  runnerId?: string
  requestedById?: string
  page?: number
}

/** Only set filters reach the query; `current` only past page 1 (same rule as the admin users page). */
export function buildJobQuery(filters: FleetJobFilters): Record<string, string> {
  const entries: Array<[string, string | undefined]> = [
    ['state', filters.state],
    ['repoId', filters.repoId],
    ['runnerId', filters.runnerId],
    ['requestedById', filters.requestedById],
  ]
  const query = Object.fromEntries(entries.filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0))
  return {
    ...query,
    size: String(FLEET_JOB_PAGE_SIZE),
    ...(filters.page && filters.page > 1 ? { current: String(filters.page) } : {}),
  }
}

/** Fleet jobs of one project (S1 spec §3.4). Every call goes through useApi; nothing here is page state but the list. */
export function useFleetJobs(slug: string) {
  const { $api } = useApi()
  const base = apiPath`/projects/${slug}/fleet/jobs`
  const jobPath = (id: string): string => apiPath`/projects/${slug}/fleet/jobs/${id}`

  const jobs = ref<FleetJobDto[]>([])
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)

  async function load(filters: FleetJobFilters = {}): Promise<void> {
    const res = await $api.get<FleetPage<FleetJobDto>>(base, { query: buildJobQuery(filters) })
    jobs.value = res.records ?? []
    total.value = res.total ?? 0
    page.value = res.current ?? 1
    hasNext.value = res.hasNext === true
  }

  const get = (id: string): Promise<FleetJobDto> => $api.get<FleetJobDto>(jobPath(id))

  const events = (id: string, current: number): Promise<FleetPage<FleetJobEventDto>> =>
    $api.get<FleetPage<FleetJobEventDto>>(apiPath`/projects/${slug}/fleet/jobs/${id}/events`, {
      query: { current: String(current), size: String(FLEET_EVENT_PAGE_SIZE) },
    })

  const dispatch = (body: DispatchBody): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(base, { ...body })

  const cancel = (id: string): Promise<FleetJobDto> => $api.post<FleetJobDto>(apiPath`/projects/${slug}/fleet/jobs/${id}/cancel`)

  const requeue = (id: string): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(apiPath`/projects/${slug}/fleet/jobs/${id}/requeue`)

  /** D121: the job behind a dispatch 409 (at most one active job per repo and feature). */
  async function findActiveJob(repoId: string, feature: string): Promise<FleetJobDto | null> {
    const res = await $api.get<FleetPage<FleetJobDto>>(base, { query: { repoId, feature, size: '20' } })
    return pickActiveJob(res.records ?? [])
  }

  /** D127: fetch the bundle as a Blob (an API error propagates, no file is made), then save it. */
  async function downloadBundle(id: string): Promise<void> {
    saveBlob(await $api.download(apiPath`/projects/${slug}/fleet/jobs/${id}/bundle`), bundleFileName(id))
  }

  return { jobs, total, page, hasNext, load, get, events, dispatch, cancel, requeue, findActiveJob, downloadBundle }
}
```

Create `apps/web/composables/useFleetDispatchOptions.ts`:

```ts
import { computed, ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE, type FleetPage, type FleetRepo, type FleetRunnerSummary } from '~/lib/fleet-types'

const sortedUnion = (lists: ReadonlyArray<readonly string[]>): string[] =>
  [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b))

/** Repos and runner summaries a project member may dispatch to (D118), and the pickers derived from them. */
export function useFleetDispatchOptions(slug: string) {
  const { $api } = useApi()
  const repos = ref<FleetRepo[]>([])
  const runners = ref<FleetRunnerSummary[]>([])
  const moreRepos = ref(false)
  const moreRunners = ref(false)

  async function load(): Promise<void> {
    // D125: fleets are small; one page of FLEET_LIST_SIZE, with a hint when there is more.
    const query = { size: String(FLEET_LIST_SIZE) }
    const [repoPage, runnerPage] = await Promise.all([
      $api.get<FleetPage<FleetRepo>>(apiPath`/projects/${slug}/fleet/repos`, { query }),
      $api.get<FleetPage<FleetRunnerSummary>>(apiPath`/projects/${slug}/fleet/runners`, { query }),
    ])
    repos.value = repoPage.records ?? []
    runners.value = runnerPage.records ?? []
    moreRepos.value = repoPage.hasNext === true
    moreRunners.value = runnerPage.hasNext === true
  }

  /** Machine profiles any runner reports; repo-provided names are typed in (S1 spec §2.1). */
  const profileOptions = computed(() => sortedUnion(runners.value.map(r => r.profiles)))
  const labelOptions = computed(() => sortedUnion(runners.value.map(r => r.labels)))

  const repoName = (id: string): string => {
    const repo = repos.value.find(r => r.id === id)
    return repo ? `${repo.owner}/${repo.name}` : id
  }
  const runnerName = (id: string | null): string | null =>
    id === null ? null : (runners.value.find(r => r.id === id)?.name ?? id)

  return { repos, runners, moreRepos, moreRunners, load, profileOptions, labelOptions, repoName, runnerName }
}
```

Create `apps/web/composables/useProjectMemberNames.ts`:

```ts
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ProjectMember } from '~/composables/useProjectMembers'

/** Display names for user ids on fleet pages (requester column and filter); one page of 100 members. */
export function useProjectMemberNames(slug: string) {
  const { $api } = useApi()
  const members = ref<ProjectMember[]>([])

  async function load(): Promise<void> {
    const res = await $api.get<{ records?: ProjectMember[] }>(apiPath`/projects/${slug}/members`, { query: { size: '100' } })
    members.value = res.records ?? []
  }

  /** The member's name, else email; null when the id is not among the loaded members (a former member). */
  const nameOf = (userId: string): string | null => {
    const member = members.value.find(m => m.userId === userId)
    return member ? (member.name || member.email) : null
  }

  return { members, load, nameOf }
}
```

- [ ] **Step 4: Run them and the apiPath guard**

Run: `cd apps/web && npx jest tests/lib/save-blob.spec.ts tests/composables/useFleet tests/composables/useProjectMemberNames.spec.ts tests/lib/api-path-guard.spec.ts`
Expected: PASS (3 save-blob and 9 composable tests; the guard finds no raw `/projects/${...}` template).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/save-blob.ts apps/web/tests/lib/save-blob.spec.ts apps/web/composables/useFleetJobs.ts apps/web/composables/useFleetDispatchOptions.ts apps/web/composables/useProjectMemberNames.ts apps/web/tests/composables/useFleetJobs.spec.ts apps/web/tests/composables/useFleetDispatchOptions.spec.ts apps/web/tests/composables/useProjectMemberNames.spec.ts
git commit -m "feat(web): fleet job, dispatch-option and member-name composables"
```

### Task 6: Locale keys and project navigation

**Files:**
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Modify: `apps/web/layouts/default.vue` (icon import, breadcrumbs, project link)
- Modify: `apps/web/tests/i18n/fleet-locale-parity.spec.ts` (4b's spec: one more test)
- Test: `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`

**Interfaces:**
- Consumes: 4b's `fleet` locale object and its parity spec, which already checks the whole `fleet` and `nav` subtrees (en/zh key parity, non-empty zh values, no `|` or `@` in en messages), so the new `fleet.jobs`/`fleet.dispatch` keys are covered without a second parity spec.
- Produces: `nav.fleetJobs`, `fleet.jobs.*`, `fleet.dispatch.*` (every literal key the Task 7-9 pages and components use; `tests/i18n/used-keys-exist.spec.ts` enforces it); the sidebar link `/${projectSlug}/fleet` for every project member; breadcrumbs for `/:project/fleet`, `/:project/fleet/dispatch` and `/:project/fleet/jobs/:id`.

All keys land in this task so each page task stays green under `used-keys-exist.spec.ts`.

- [ ] **Step 1: Write the failing tests**

In 4b's `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, directly below the test `'nav has the two admin fleet links'`, add:

```ts
  test('nav has the project fleet jobs link (slice 4c)', () => {
    expect(at(en, 'nav.fleetJobs')).toBe('Fleet jobs')
    expect(at(zh, 'nav.fleetJobs')).toBeTruthy()
  })
```

(4c adds no new code-to-label map, so `ENUMS` stays as 4b left it.)

Create `apps/web/tests/layouts/fleet-jobs-nav.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const layout = readFileSync(join(__dirname, '../..', 'layouts', 'default.vue'), 'utf-8')
const template = layout.slice(layout.indexOf('<template>'))
const projectLinks = template.slice(template.indexOf('<template v-if="projectSlug">'), template.indexOf('</template>', template.indexOf('<template v-if="projectSlug">')))

describe('fleet jobs navigation', () => {
  test('a project link to /:project/fleet with the Rocket icon and nav.fleetJobs, for every member', () => {
    expect(projectLinks).toContain(':to="`/${projectSlug}/fleet`"')
    expect(projectLinks).toMatch(/<Rocket class="h-4 w-4 shrink-0" \/>\s*\{\{ t\('nav\.fleetJobs'\) \}\}/)
    expect(layout).toMatch(/import \{[^}]*\bRocket\b[^}]*\} from 'lucide-vue-next'/)
  })

  test('breadcrumbs cover the jobs list, dispatch and a job', () => {
    expect(layout).toContain('if (path === `/${project}/fleet`) {')
    expect(layout).toContain('if (path.startsWith(`/${project}/fleet/`)) {')
    expect(layout).toContain("t('fleet.jobs.dispatch')")
    expect(layout).toContain("t('fleet.jobs.detail.title')")
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx jest tests/i18n/fleet-locale-parity.spec.ts tests/layouts/fleet-jobs-nav.spec.ts`
Expected: FAIL: `nav.fleetJobs` is undefined, and the layout has no `/fleet` link (4b's other parity tests still pass).

- [ ] **Step 3: Add the locale keys**

Edit by hand (keep the files' existing compact formatting; do not reformat them with a JSON tool). In `en.json`, in `nav`, replace 4b's `    "fleetRepos": "Repos"` with `    "fleetRepos": "Repos",` followed by `    "fleetJobs": "Fleet jobs"`, and add these two members inside 4b's `"fleet"` object:

```json
{
  "jobs": {
    "title": "Fleet jobs",
    "subtitle": "nax runs and plans dispatched to fleet runners",
    "dispatch": "Dispatch",
    "empty": "No fleet jobs yet",
    "total": "{total} jobs",
    "unknownMember": "Unknown member",
    "previous": "Previous",
    "next": "Next",
    "filters": {
      "state": "State",
      "repo": "Repo",
      "runner": "Runner",
      "requester": "Requested by",
      "allStates": "All states",
      "allRepos": "All repos",
      "allRunners": "All runners",
      "allRequesters": "Everyone"
    },
    "table": {
      "feature": "Feature",
      "command": "Command",
      "repo": "Repo",
      "runner": "Runner",
      "state": "State",
      "cost": "Cost",
      "requester": "Requested by",
      "queued": "Queued"
    },
    "detail": {
      "title": "Job",
      "progress": "Progress",
      "progressValue": "{passed} of {total} stories passed, {failed} failed",
      "story": "Current story",
      "phase": "Phase",
      "cost": "Cost",
      "costOf": "{spent} of {max}",
      "runner": "Runner",
      "unassigned": "Not assigned",
      "requester": "Requested by",
      "profiles": "Profile chain",
      "queuedAt": "Queued",
      "startedAt": "Started",
      "finishedAt": "Finished",
      "heartbeat": "Last heartbeat",
      "finishResult": "Finish result",
      "branch": "Branch",
      "pr": "Pull request",
      "planFrom": "Spec path",
      "escalation": "Escalation reason",
      "cancelRequested": "Cancel requested at {at}"
    },
    "actions": {
      "cancel": "Cancel job",
      "requeue": "Requeue",
      "bundle": "Download bundle"
    },
    "confirmCancel": {
      "title": "Cancel this job?",
      "body": "The runner stops nax and the job ends as cancelled. Work already pushed stays on its branch."
    },
    "toast": {
      "cancelRequested": "Cancel requested",
      "requeued": "Job requeued"
    },
    "requeuePlacement": "Requeue placement",
    "timeline": {
      "title": "Timeline",
      "empty": "No events yet",
      "loadMore": "Load more",
      "transition": "{from} to {to}",
      "queued": "Queued",
      "snapshot": "Status: {detail}",
      "snapshotEmpty": "Status update",
      "lifecycle": "Runner {level}: {message}",
      "log": "Log: {text}",
      "unknown": "Unknown event {type}"
    }
  },
  "dispatch": {
    "title": "Dispatch a job",
    "subtitle": "Run nax on one of the fleet runners",
    "noPermission": "Only project developers and admins can dispatch jobs.",
    "noRepos": "No repos are registered for this project yet. A global admin registers them on the Fleet repos page.",
    "repo": "Repo",
    "repoPlaceholder": "Select a repo",
    "moreRepos": "Only the first 100 repos are listed.",
    "command": "Command",
    "commandRun": "nax run",
    "commandPlan": "nax plan",
    "ref": "Git ref",
    "refHint": "Leave empty for the repo's default branch.",
    "feature": "Feature",
    "planFrom": "Spec path",
    "planFromHint": "Repo-relative path of the spec nax plan reads.",
    "profiles": "Profile chain",
    "profilesHint": "Later profiles override earlier ones. Pick a machine profile or type the name of a profile in the repo.",
    "profilePlaceholder": "Profile name",
    "add": "Add",
    "remove": "Remove {item}",
    "maxCost": "Max cost (USD)",
    "placement": "Placement",
    "placementAuto": "Any runner that fits",
    "placementLabels": "Runners with these labels",
    "placementPin": "One specific runner",
    "labelPlaceholder": "Label",
    "pinPlaceholder": "Select a runner",
    "runnerOffline": "offline",
    "runnerDisabled": "disabled",
    "moreRunners": "Only the first 100 runners are listed.",
    "submit": "Dispatch",
    "submitting": "Dispatching...",
    "conflict": "An active job already runs this feature on this repo.",
    "conflictLink": "Open the active job",
    "result": {
      "assigned": "Assigned to {runner}",
      "queued": "Queued: no runner fits right now. It starts when one does.",
      "misfitsTitle": "Why each runner does not fit",
      "openJob": "Open job"
    },
    "validation": {
      "repoRequired": "Select a repo",
      "ref": "The git ref is at most 255 characters",
      "feature": "Use letters, digits, dot, dash or underscore; start with a letter or digit; at most 128 characters",
      "planFrom": "The spec path is at most 512 characters",
      "planFromRequired": "nax plan needs a spec path",
      "profilesMax": "At most 8 profiles",
      "profileName": "Profile names use letters, digits, dot, dash or underscore, and cannot start with koda-job-",
      "profileDuplicate": "Each profile can appear once",
      "maxCost": "Enter an amount above 0 and at most 10000, with at most 4 decimals",
      "labelsMax": "At most 16 labels",
      "label": "Labels use lowercase letters, digits, dot, dash or underscore",
      "labelsOrPin": "Choose labels or a runner, not both"
    }
  }
}
```

In `zh.json`, in `nav`, replace 4b's `    "fleetRepos": "仓库"` with `    "fleetRepos": "仓库",` followed by `    "fleetJobs": "Fleet 任务"`, and inside `"fleet"`:

```json
{
  "jobs": {
    "title": "Fleet 任务",
    "subtitle": "派发到 fleet 执行机的 nax run 与 nax plan",
    "dispatch": "派发",
    "empty": "还没有 fleet 任务",
    "total": "共 {total} 个任务",
    "unknownMember": "未知成员",
    "previous": "上一页",
    "next": "下一页",
    "filters": {
      "state": "状态",
      "repo": "仓库",
      "runner": "执行机",
      "requester": "发起人",
      "allStates": "全部状态",
      "allRepos": "全部仓库",
      "allRunners": "全部执行机",
      "allRequesters": "所有人"
    },
    "table": {
      "feature": "功能",
      "command": "命令",
      "repo": "仓库",
      "runner": "执行机",
      "state": "状态",
      "cost": "费用",
      "requester": "发起人",
      "queued": "排队时间"
    },
    "detail": {
      "title": "任务",
      "progress": "进度",
      "progressValue": "{total} 个故事中 {passed} 个通过，{failed} 个失败",
      "story": "当前故事",
      "phase": "阶段",
      "cost": "费用",
      "costOf": "{spent} / {max}",
      "runner": "执行机",
      "unassigned": "未分配",
      "requester": "发起人",
      "profiles": "配置链",
      "queuedAt": "排队时间",
      "startedAt": "开始时间",
      "finishedAt": "结束时间",
      "heartbeat": "最近心跳",
      "finishResult": "收尾结果",
      "branch": "分支",
      "pr": "拉取请求",
      "planFrom": "规格路径",
      "escalation": "升级原因",
      "cancelRequested": "已于 {at} 请求取消"
    },
    "actions": {
      "cancel": "取消任务",
      "requeue": "重新排队",
      "bundle": "下载产物包"
    },
    "confirmCancel": {
      "title": "取消这个任务？",
      "body": "执行机会停止 nax，任务以已取消结束。已推送的提交仍保留在分支上。"
    },
    "toast": {
      "cancelRequested": "已请求取消",
      "requeued": "任务已重新排队"
    },
    "requeuePlacement": "重新排队的调度结果",
    "timeline": {
      "title": "时间线",
      "empty": "还没有事件",
      "loadMore": "加载更多",
      "transition": "{from} 变为 {to}",
      "queued": "已排队",
      "snapshot": "状态：{detail}",
      "snapshotEmpty": "状态更新",
      "lifecycle": "执行机 {level}：{message}",
      "log": "日志：{text}",
      "unknown": "未知事件 {type}"
    }
  },
  "dispatch": {
    "title": "派发任务",
    "subtitle": "在一台 fleet 执行机上运行 nax",
    "noPermission": "只有项目开发者和管理员可以派发任务。",
    "noRepos": "这个项目还没有登记仓库。全局管理员在 Fleet 仓库页面登记。",
    "repo": "仓库",
    "repoPlaceholder": "选择仓库",
    "moreRepos": "只列出前 100 个仓库。",
    "command": "命令",
    "commandRun": "nax run",
    "commandPlan": "nax plan",
    "ref": "Git 引用",
    "refHint": "留空则使用仓库默认分支。",
    "feature": "功能",
    "planFrom": "规格路径",
    "planFromHint": "nax plan 读取的规格文件，相对仓库根目录。",
    "profiles": "配置链",
    "profilesHint": "后面的配置覆盖前面的。可选择机器上的配置，或输入仓库内配置的名称。",
    "profilePlaceholder": "配置名称",
    "add": "添加",
    "remove": "移除 {item}",
    "maxCost": "费用上限（美元）",
    "placement": "调度",
    "placementAuto": "任意合适的执行机",
    "placementLabels": "带这些标签的执行机",
    "placementPin": "指定一台执行机",
    "labelPlaceholder": "标签",
    "pinPlaceholder": "选择执行机",
    "runnerOffline": "离线",
    "runnerDisabled": "已停用",
    "moreRunners": "只列出前 100 台执行机。",
    "submit": "派发",
    "submitting": "派发中...",
    "conflict": "这个仓库上已有一个进行中的任务在处理这个功能。",
    "conflictLink": "打开进行中的任务",
    "result": {
      "assigned": "已分配给 {runner}",
      "queued": "已排队：目前没有合适的执行机，有合适的执行机时开始。",
      "misfitsTitle": "各执行机不合适的原因",
      "openJob": "打开任务"
    },
    "validation": {
      "repoRequired": "请选择仓库",
      "ref": "Git 引用最多 255 个字符",
      "feature": "只能使用字母、数字、点、短横线或下划线，以字母或数字开头，最多 128 个字符",
      "planFrom": "规格路径最多 512 个字符",
      "planFromRequired": "nax plan 需要规格路径",
      "profilesMax": "最多 8 个配置",
      "profileName": "配置名称只能使用字母、数字、点、短横线或下划线，且不能以 koda-job- 开头",
      "profileDuplicate": "每个配置只能出现一次",
      "maxCost": "请输入大于 0、不超过 10000 且最多 4 位小数的金额",
      "labelsMax": "最多 16 个标签",
      "label": "标签只能使用小写字母、数字、点、短横线或下划线",
      "labelsOrPin": "请选择标签或执行机，不能同时选择"
    }
  }
}
```

Check the result parses: `node -e "require('./i18n/locales/en.json'); require('./i18n/locales/zh.json')"` (from `apps/web`) prints nothing.

- [ ] **Step 4: Add the link and the breadcrumbs**

In `apps/web/layouts/default.vue`:

1. Replace the lucide import (4b's line, which ends `Users, Server, FolderGit2`) with:

```ts
import { LayoutDashboard, Kanban, Bot, Tag, BookOpen, Clock, Brain, Code2, Activity, Users, Server, FolderGit2, Rocket } from 'lucide-vue-next'
```

2. In `breadcrumbItems`, directly above `const ticketRef = (route.params.ref as string | undefined)`, add:

```ts
  if (path === `/${project}/fleet`) {
    return [{ label: 'Koda', to: '/' }, projectBase, { label: t('nav.fleetJobs') }]
  }
  if (path.startsWith(`/${project}/fleet/`)) {
    const leaf = path === `/${project}/fleet/dispatch` ? t('fleet.jobs.dispatch') : t('fleet.jobs.detail.title')
    return [{ label: 'Koda', to: '/' }, projectBase, { label: t('nav.fleetJobs'), to: `/${project}/fleet` }, { label: leaf }]
  }
```

3. In the project-scoped links, directly above the `settings` link, add:

```vue
          <NuxtLink
            :to="`/${projectSlug}/fleet`"
            :class="navLinkClass"
            :active-class="activeClass"
          >
            <Rocket class="h-4 w-4 shrink-0" />
            {{ t('nav.fleetJobs') }}
          </NuxtLink>
```

- [ ] **Step 5: Run the i18n and layout specs**

Run: `cd apps/web && npx jest tests/i18n tests/layouts`
Expected: PASS (all i18n and layout specs, including `used-keys-exist` and the existing SSR nav renders).

- [ ] **Step 6: Commit**

```bash
git add apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/layouts/default.vue apps/web/tests/i18n/fleet-locale-parity.spec.ts apps/web/tests/layouts/fleet-jobs-nav.spec.ts
git commit -m "feat(web): fleet jobs locale keys, project nav link and breadcrumbs"
```

### Task 7: Jobs list page

**Files:**
- Create: `apps/web/components/fleet/FleetJobStateBadge.vue`, `apps/web/pages/[project]/fleet/index.vue`
- Test: `apps/web/tests/pages/fleet-jobs-list.spec.ts`

**Interfaces:**
- Consumes: `useFleetJobs`, `useFleetDispatchOptions`, `useProjectMemberNames` (Task 5), `useProjectViewerRole`, `useProjectEvents` with `onFleetJob` (Task 1), `createDebouncer`, `codeLabel`, `canWorkOnFleet`, `formatUsd`, `FLEET_JOB_STATES`.
- Produces: `FleetJobStateBadge` (prop `state: string`; renders `data-testid="fleet-job-state"` and `data-state="<STATE>"`, used by Tasks 9 and 10); test ids `fleet-dispatch-button`, `fleet-jobs-table`, `fleet-job-row-<id>`, `fleet-filter-{state,repo,runner,requester}`.

Pages in this repo are tested by source wiring (no component mounting; see `tests/pages/live-wiring.spec.ts`); the behaviour lives in the helpers and composables tested in Tasks 3-5, and Task 10 exercises the page in a browser. Data loads on mount (client), like the live parts of the board. Radix `SelectItem` cannot take an empty value, so "no filter" is the sentinel `__all__`. Names (repo, runner, requester) are cosmetic: a failed lookup leaves ids on screen.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/pages/fleet-jobs-list.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const list = read('pages', '[project]', 'fleet', 'index.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('fleet jobs list', () => {
  test('loads through useFleetJobs with the four filters, sentinel for "all"', () => {
    expect(list).toContain('useFleetJobs(slug)')
    expect(list).toMatch(/state: pick\(filters\.state\)[\s\S]*repoId: pick\(filters\.repoId\)[\s\S]*runnerId: pick\(filters\.runnerId\)[\s\S]*requestedById: pick\(filters\.requestedById\)/)
    expect(list).toContain("const ALL = '__all__'")
  })

  test('refreshes on any fleet_job event, debounced, and cancels on unmount', () => {
    const handlers = liveHandlers(list)
    expect(handlers).toContain('onFleetJob: () => liveReload.trigger()')
    expect(handlers).toContain('onResync: () => liveReload.trigger()')
    expect(list).toMatch(/onBeforeUnmount\(\(\) => liveReload\.cancel\(\)\)/)
  })

  test('the dispatch button is shown to project ADMIN and DEVELOPER only, through the shared rule', () => {
    expect(list).toContain('const canWork = computed(() => canWorkOnFleet(viewer.value))')
    expect(list).toMatch(/<Button v-if="canWork"[^>]*data-testid="fleet-dispatch-button"/)
  })

  test('the table scrolls sideways on narrow screens and names a requester who left', () => {
    expect(list).toMatch(/<div class="overflow-x-auto">\s*<Table data-testid="fleet-jobs-table">/)
    expect(list).toContain("people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember')")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx jest tests/pages/fleet-jobs-list.spec.ts`
Expected: FAIL: `ENOENT: no such file or directory, open '.../pages/[project]/fleet/index.vue'`.

- [ ] **Step 3: Implement**

Create `apps/web/components/fleet/FleetJobStateBadge.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'

const props = defineProps<{ state: string }>()
const { t, te } = useI18n()

type Variant = 'default' | 'secondary' | 'destructive' | 'outline'
const VARIANTS: Readonly<Record<string, Variant>> = {
  COMPLETED: 'default',
  FAILED: 'destructive',
  CRASHED: 'destructive',
  ESCALATED: 'outline',
  CANCELLED: 'outline',
}

const variant = computed<Variant>(() => VARIANTS[props.state] ?? 'secondary')
const label = computed(() => codeLabel(t, te, 'fleet.state', props.state))
</script>

<template>
  <Badge :variant="variant" data-testid="fleet-job-state" :data-state="state">{{ label }}</Badge>
</template>
```

Create `apps/web/pages/[project]/fleet/index.vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { createDebouncer } from '~/lib/debounce'
import { codeLabel } from '~/lib/fleet-i18n'
import { canWorkOnFleet, formatUsd } from '~/lib/fleet-jobs'
import { FLEET_JOB_STATES } from '~/lib/project-event-stream'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t, te } = useI18n()
const toast = useAppToast()
const jobsApi = useFleetJobs(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const { data: viewer } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewer.value))

/** Radix Select items cannot have an empty value, so "no filter" is a sentinel. */
const ALL = '__all__'
const filters = reactive({ state: ALL, repoId: ALL, runnerId: ALL, requestedById: ALL })
const page = ref(1)
const pending = ref(true)
const loadFailed = ref(false)

const pick = (value: string): string | undefined => (value === ALL ? undefined : value)

async function reload(): Promise<void> {
  try {
    await jobsApi.load({
      state: pick(filters.state),
      repoId: pick(filters.repoId),
      runnerId: pick(filters.runnerId),
      requestedById: pick(filters.requestedById),
      page: page.value,
    })
    loadFailed.value = false
  }
  catch (err: unknown) {
    loadFailed.value = jobsApi.jobs.value.length === 0
    toast.error(extractApiError(err))
  }
  finally {
    pending.value = false
  }
}

onMounted(() => {
  void reload()
  // Names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
})

watch(filters, () => {
  page.value = 1
  void reload()
})

function goTo(next: number): void {
  page.value = next
  void reload()
}

// Live: any fleet job notice of this project refreshes the visible page, debounced (S1 spec §1).
const liveReload = createDebouncer(() => { void reload() }, 300)
onBeforeUnmount(() => liveReload.cancel())
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})

const stateLabel = (state: string): string => codeLabel(t, te, 'fleet.state', state)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.jobs.title')" :subtitle="t('fleet.jobs.subtitle')">
      <template #actions>
        <Button v-if="canWork" data-testid="fleet-dispatch-button" @click="navigateTo(`/${slug}/fleet/dispatch`)">
          {{ t('fleet.jobs.dispatch') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-3 sm:grid-cols-4">
      <Select v-model="filters.state">
        <SelectTrigger data-testid="fleet-filter-state"><SelectValue :placeholder="t('fleet.jobs.filters.state')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allStates') }}</SelectItem>
          <SelectItem v-for="state in FLEET_JOB_STATES" :key="state" :value="state">{{ stateLabel(state) }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="filters.repoId">
        <SelectTrigger data-testid="fleet-filter-repo"><SelectValue :placeholder="t('fleet.jobs.filters.repo')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allRepos') }}</SelectItem>
          <SelectItem v-for="repo in options.repos.value" :key="repo.id" :value="repo.id">{{ repo.owner }}/{{ repo.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="filters.runnerId">
        <SelectTrigger data-testid="fleet-filter-runner"><SelectValue :placeholder="t('fleet.jobs.filters.runner')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allRunners') }}</SelectItem>
          <SelectItem v-for="runner in options.runners.value" :key="runner.id" :value="runner.id">{{ runner.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="filters.requestedById">
        <SelectTrigger data-testid="fleet-filter-requester"><SelectValue :placeholder="t('fleet.jobs.filters.requester')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allRequesters') }}</SelectItem>
          <SelectItem v-for="member in people.members.value" :key="member.userId" :value="member.userId">{{ member.name || member.email }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="reload()" />
    <EmptyState v-else-if="jobsApi.jobs.value.length === 0" :message="t('fleet.jobs.empty')" />
    <template v-else>
      <div class="overflow-x-auto">
        <Table data-testid="fleet-jobs-table">
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('fleet.jobs.table.feature') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.command') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.repo') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.runner') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.state') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.cost') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.requester') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.queued') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="job in jobsApi.jobs.value" :key="job.id" :data-testid="`fleet-job-row-${job.id}`">
              <TableCell>
                <NuxtLink :to="`/${slug}/fleet/jobs/${job.id}`" class="font-medium text-primary underline-offset-4 hover:underline">{{ job.feature }}</NuxtLink>
              </TableCell>
              <TableCell>{{ job.command }}</TableCell>
              <TableCell>{{ options.repoName(job.repoId) }}</TableCell>
              <TableCell>{{ options.runnerName(job.runnerId) ?? '-' }}</TableCell>
              <TableCell><FleetJobStateBadge :state="job.state" /></TableCell>
              <TableCell>{{ formatUsd(job.costSpentUsd) }}</TableCell>
              <TableCell>{{ people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember') }}</TableCell>
              <TableCell>{{ new Date(job.queuedAt).toLocaleString() }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <span>{{ t('fleet.jobs.total', { total: jobsApi.total.value }) }}</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="page <= 1" @click="goTo(page - 1)">{{ t('fleet.jobs.previous') }}</Button>
          <Button variant="outline" size="sm" :disabled="!jobsApi.hasNext.value" @click="goTo(page + 1)">{{ t('fleet.jobs.next') }}</Button>
        </div>
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 4: Run the page spec, i18n, guard, lint**

Run: `cd apps/web && npx jest tests/pages/fleet-jobs-list.spec.ts tests/i18n/used-keys-exist.spec.ts tests/lib/api-path-guard.spec.ts && npx eslint 'pages/[project]/fleet/index.vue' components/fleet/FleetJobStateBadge.vue --max-warnings=0`
Expected: PASS, and ESLint reports no problems.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/FleetJobStateBadge.vue 'apps/web/pages/[project]/fleet/index.vue' apps/web/tests/pages/fleet-jobs-list.spec.ts
git commit -m "feat(web): fleet jobs list page with filters and live refresh"
```

### Task 8: Dispatch page

**Files:**
- Create: `apps/web/components/fleet/FleetTokenListInput.vue`, `apps/web/components/fleet/FleetPlacementResult.vue`, `apps/web/pages/[project]/fleet/dispatch.vue`
- Test: `apps/web/tests/pages/fleet-dispatch-page.spec.ts`

**Interfaces:**
- Consumes: `buildDispatchSchema`, `DISPATCH_DEFAULTS`, `toDispatchBody`, `addToken`, `removeToken` (Task 4), `useFleetJobs().dispatch/findActiveJob`, `useFleetDispatchOptions` (Task 5), `canWorkOnFleet` (Task 3), `<FleetNativeSelect>` (4b D137), `ApiError`, `extractApiError`, `codeLabel`.
- Produces: `<FleetPlacementResult :slug :result :runner-name :hide-open-link? />` (Task 9 reuses it after a requeue); test ids used by Task 10 (`dispatch-repo`, `dispatch-command` and `dispatch-pin` are native `<select>`s, driven with Playwright's `selectOption`): `dispatch-repo`, `dispatch-command`, `dispatch-ref`, `dispatch-feature`, `dispatch-plan-from`, `dispatch-profiles-{input,add,item,suggestion}`, `dispatch-max-cost`, `placement-{auto,labels,pin}`, `dispatch-labels-*`, `dispatch-pin`, `dispatch-submit`, `placement-result`, `placement-assigned`, `placement-queued`, `placement-misfit`, `placement-open-job`, `dispatch-conflict`, `dispatch-conflict-link`, `dispatch-no-permission`, `dispatch-no-repos`.

Behaviour (S1 spec §11 "Dispatch"): repo, ref (placeholder = the selected repo's default branch; empty sends no `ref`), command, feature, spec path (PLAN only), profile chain (ordered; machine profiles from the runner summaries offered as suggestions, any repo-provided name typed in, S1 spec §2.1), max cost, and placement as one of: any runner, labels, or a pinned runner. Switching the placement mode clears the other mode's field. After submit the page shows the placement: the assigned runner, or "queued" plus each runner's misfit reason (translated, D126), with a link to the job. A 409 (`ApiError.code === 409`) looks up the active job (D121) and links it; a pinned misfit (422) and validation errors (400) show the API's message. The token list and labels fields are driven with `values`/`setFieldValue` rather than `FormField` slot props: shadcn's `FormField` types its slot as `{ componentField }` only (Nuxt typecheck rejects `value`/`handleChange`). Repo, command and pin are `<FleetNativeSelect v-bind="componentField">` (4b D137, issue #58): the E2E drives this form, and Radix `Select` options sit in a portal Playwright reaches unreliably (`tests/e2e/vcs-integration-settings.e2e.spec.ts:207`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/pages/fleet-dispatch-page.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const dispatch = read('pages', '[project]', 'fleet', 'dispatch.vue')

describe('dispatch page', () => {
  test('validates with the shared schema and sends toDispatchBody', () => {
    expect(dispatch).toContain('toTypedSchema(buildDispatchSchema(t))')
    expect(dispatch).toContain('jobsApi.dispatch(toDispatchBody(formValues))')
  })

  test('a 409 (ret 409) looks up and links the active job (D121); other errors toast the API message', () => {
    expect(dispatch).toContain('err instanceof ApiError && err.code === 409')
    expect(dispatch).toContain('jobsApi.findActiveJob(formValues.repoId, formValues.feature.trim())')
    expect(dispatch).toContain('data-testid="dispatch-conflict-link"')
    expect(dispatch).toContain('toast.error(extractApiError(err))')
  })

  test('placement modes clear the other field, so labels and pin never travel together', () => {
    expect(dispatch).toContain("if (mode !== 'labels') setFieldValue('selectorLabels', [])")
    expect(dispatch).toContain("if (mode !== 'pin') setFieldValue('pinnedRunnerId', '')")
  })

  test('PLAN shows the spec path; the placement result is rendered after submit', () => {
    expect(dispatch).toContain('v-if="values.command === \'PLAN\'"')
    expect(dispatch).toContain('<FleetPlacementResult v-if="result"')
  })

  test('repo, command and pin are native selects bound through FleetNativeSelect (4b D137)', () => {
    for (const testid of ['dispatch-repo', 'dispatch-command', 'dispatch-pin']) {
      expect(dispatch).toMatch(new RegExp(`<FleetNativeSelect v-bind="componentField"[^>]*testid="${testid}"`))
    }
    expect(dispatch).not.toContain('<SelectContent')
    expect(dispatch).not.toMatch(/<select[^>]*v-bind="componentField"/)
  })

  test('only project ADMIN and DEVELOPER get the form, through the shared rule', () => {
    expect(dispatch).toContain('const canWork = computed(() => canWorkOnFleet(viewer.value))')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx jest tests/pages/fleet-dispatch-page.spec.ts`
Expected: FAIL: `ENOENT: no such file or directory, open '.../pages/[project]/fleet/dispatch.vue'`.

- [ ] **Step 3: Implement**

Create `apps/web/components/fleet/FleetTokenListInput.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { addToken, removeToken } from '~/lib/fleet-dispatch'

/** An ordered list of names (profile chain, labels): typed or picked from suggestions. */
const props = defineProps<{
  modelValue: string[]
  suggestions?: string[]
  placeholder?: string
  testId: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useI18n()

const draft = ref('')
const unused = computed(() => (props.suggestions ?? []).filter(s => !props.modelValue.includes(s)))

function add(token: string): void {
  emit('update:modelValue', addToken(props.modelValue, token))
  draft.value = ''
}

function remove(token: string): void {
  emit('update:modelValue', removeToken(props.modelValue, token))
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length > 0" class="flex flex-wrap gap-2">
      <Badge v-for="(item, index) in modelValue" :key="item" variant="secondary" class="gap-1" :data-testid="`${testId}-item`">
        <span class="text-muted-foreground">{{ index + 1 }}.</span>
        {{ item }}
        <Button type="button" variant="ghost" size="icon" class="h-4 w-4" :aria-label="t('fleet.dispatch.remove', { item })" @click="remove(item)">
          <X class="h-3 w-3" />
        </Button>
      </Badge>
    </div>
    <div class="flex gap-2">
      <Input v-model="draft" :placeholder="placeholder" :data-testid="`${testId}-input`" @keydown.enter.prevent="add(draft)" />
      <Button type="button" variant="outline" :data-testid="`${testId}-add`" @click="add(draft)">{{ t('fleet.dispatch.add') }}</Button>
    </div>
    <div v-if="unused.length > 0" class="flex flex-wrap gap-2">
      <Button v-for="s in unused" :key="s" type="button" variant="ghost" size="sm" :data-testid="`${testId}-suggestion`" @click="add(s)">
        + {{ s }}
      </Button>
    </div>
  </div>
</template>
```

Create `apps/web/components/fleet/FleetPlacementResult.vue`:

```vue
<script setup lang="ts">
import { codeLabel } from '~/lib/fleet-i18n'
import type { DispatchResultDto } from '~/lib/fleet-types'

defineProps<{
  slug: string
  result: DispatchResultDto
  runnerName: (id: string | null) => string | null
  /** The job page shows a requeue's placement; it does not link to itself. */
  hideOpenLink?: boolean
}>()
const { t, te } = useI18n()
</script>

<template>
  <div class="space-y-3 rounded-md border border-border p-4" data-testid="placement-result">
    <p v-if="result.placement.assigned" class="font-medium" data-testid="placement-assigned">
      {{ t('fleet.dispatch.result.assigned', { runner: runnerName(result.placement.runnerId) ?? '-' }) }}
    </p>
    <p v-else class="font-medium" data-testid="placement-queued">{{ t('fleet.dispatch.result.queued') }}</p>
    <div v-if="result.placement.misfits.length > 0" class="space-y-1">
      <p class="text-sm text-muted-foreground">{{ t('fleet.dispatch.result.misfitsTitle') }}</p>
      <ul class="space-y-1 text-sm">
        <li v-for="misfit in result.placement.misfits" :key="misfit.runnerId" data-testid="placement-misfit">
          <span class="font-medium">{{ misfit.name }}</span>: {{ codeLabel(t, te, 'fleet.misfit', misfit.reason) }}
        </li>
      </ul>
    </div>
    <NuxtLink
      v-if="!hideOpenLink"
      :to="`/${slug}/fleet/jobs/${result.job.id}`"
      class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
      data-testid="placement-open-job"
    >
      {{ t('fleet.dispatch.result.openJob') }}
    </NuxtLink>
  </div>
</template>
```

Create `apps/web/pages/[project]/fleet/dispatch.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { ApiError, extractApiError } from '~/composables/useApi'
import { buildDispatchSchema, DISPATCH_DEFAULTS, toDispatchBody } from '~/lib/fleet-dispatch'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto, FleetRunnerSummary } from '~/lib/fleet-types'
import FleetPlacementResult from '~/components/fleet/FleetPlacementResult.vue'
import FleetTokenListInput from '~/components/fleet/FleetTokenListInput.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const jobsApi = useFleetJobs(slug)
const options = useFleetDispatchOptions(slug)
const { data: viewer } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewer.value))

const loadFailed = ref(false)
onMounted(async () => {
  try {
    await options.load()
  }
  catch (err: unknown) {
    loadFailed.value = true
    toast.error(extractApiError(err))
  }
})

const { handleSubmit, isSubmitting, values, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildDispatchSchema(t)),
  initialValues: { ...DISPATCH_DEFAULTS },
})

/** Placement is one of: any fitting runner, runners with all of some labels, or one pinned runner (S1 spec §4). */
type PlacementMode = 'auto' | 'labels' | 'pin'
const placementMode = ref<PlacementMode>('auto')
function setPlacementMode(mode: string): void {
  placementMode.value = mode as PlacementMode
  if (mode !== 'labels') setFieldValue('selectorLabels', [])
  if (mode !== 'pin') setFieldValue('pinnedRunnerId', '')
}

const selectedRepo = computed(() => options.repos.value.find(r => r.id === values.repoId) ?? null)

// Native select options (4b D137).
const repoOptions = computed(() => options.repos.value.map(r => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const commandOptions = computed(() => [
  { value: 'RUN', label: t('fleet.dispatch.commandRun') },
  { value: 'PLAN', label: t('fleet.dispatch.commandPlan') },
])
function runnerOptionLabel(runner: FleetRunnerSummary): string {
  if (!runner.enabled) return `${runner.name} (${t('fleet.dispatch.runnerDisabled')})`
  return runner.online ? runner.name : `${runner.name} (${t('fleet.dispatch.runnerOffline')})`
}
const pinOptions = computed(() => options.runners.value.map(r => ({ value: r.id, label: runnerOptionLabel(r) })))
const result = ref<DispatchResultDto | null>(null)
const activeJob = ref<FleetJobDto | null>(null)

const onSubmit = handleSubmit(async (formValues) => {
  result.value = null
  activeJob.value = null
  try {
    result.value = await jobsApi.dispatch(toDispatchBody(formValues))
  }
  catch (err: unknown) {
    // D121: a 409 means an active job already runs this (repo, feature); link to it.
    if (err instanceof ApiError && err.code === 409) {
      activeJob.value = await jobsApi.findActiveJob(formValues.repoId, formValues.feature.trim()).catch(() => null)
    }
    toast.error(extractApiError(err))
  }
})
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <PageHeader :title="t('fleet.dispatch.title')" :subtitle="t('fleet.dispatch.subtitle')" />

    <p v-if="!canWork" class="text-sm text-muted-foreground" data-testid="dispatch-no-permission">{{ t('fleet.dispatch.noPermission') }}</p>
    <ErrorState v-else-if="loadFailed" @retry="options.load()" />
    <p v-else-if="options.repos.value.length === 0" class="text-sm text-muted-foreground" data-testid="dispatch-no-repos">{{ t('fleet.dispatch.noRepos') }}</p>

    <form v-else class="space-y-5" data-testid="dispatch-form" @submit="onSubmit">
      <FormField v-slot="{ componentField }" name="repoId">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.repo') }}</FormLabel>
          <FormControl>
            <FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.dispatch.repoPlaceholder')" testid="dispatch-repo" />
          </FormControl>
          <p v-if="options.moreRepos.value" class="text-xs text-muted-foreground">{{ t('fleet.dispatch.moreRepos') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField v-slot="{ componentField }" name="command">
          <FormItem>
            <FormLabel>{{ t('fleet.dispatch.command') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="commandOptions" testid="dispatch-command" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>
        <FormField v-slot="{ componentField }" name="ref">
          <FormItem>
            <FormLabel>{{ t('fleet.dispatch.ref') }}</FormLabel>
            <FormControl>
              <Input v-bind="componentField" :placeholder="selectedRepo?.defaultBranch ?? ''" data-testid="dispatch-ref" />
            </FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.refHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
      </div>

      <FormField v-slot="{ componentField }" name="feature">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.feature') }}</FormLabel>
          <FormControl>
            <Input v-bind="componentField" data-testid="dispatch-feature" />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField v-if="values.command === 'PLAN'" v-slot="{ componentField }" name="planFrom">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.planFrom') }}</FormLabel>
          <FormControl>
            <Input v-bind="componentField" data-testid="dispatch-plan-from" />
          </FormControl>
          <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.planFromHint') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField name="profiles">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.profiles') }}</FormLabel>
          <FleetTokenListInput
            :model-value="values.profiles ?? []"
            :suggestions="options.profileOptions.value"
            :placeholder="t('fleet.dispatch.profilePlaceholder')"
            test-id="dispatch-profiles"
            @update:model-value="setFieldValue('profiles', $event)"
          />
          <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.profilesHint') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField v-slot="{ componentField }" name="maxCostUsd">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.maxCost') }}</FormLabel>
          <FormControl>
            <Input v-bind="componentField" type="number" min="0.0001" step="0.0001" data-testid="dispatch-max-cost" />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <div class="space-y-3">
        <Label>{{ t('fleet.dispatch.placement') }}</Label>
        <RadioGroup :model-value="placementMode" class="flex flex-wrap gap-4" @update:model-value="setPlacementMode">
          <label class="flex items-center gap-2 text-sm"><RadioGroupItem value="auto" data-testid="placement-auto" />{{ t('fleet.dispatch.placementAuto') }}</label>
          <label class="flex items-center gap-2 text-sm"><RadioGroupItem value="labels" data-testid="placement-labels" />{{ t('fleet.dispatch.placementLabels') }}</label>
          <label class="flex items-center gap-2 text-sm"><RadioGroupItem value="pin" data-testid="placement-pin" />{{ t('fleet.dispatch.placementPin') }}</label>
        </RadioGroup>

        <FormField v-if="placementMode === 'labels'" name="selectorLabels">
          <FormItem>
            <FleetTokenListInput
              :model-value="values.selectorLabels ?? []"
              :suggestions="options.labelOptions.value"
              :placeholder="t('fleet.dispatch.labelPlaceholder')"
              test-id="dispatch-labels"
              @update:model-value="setFieldValue('selectorLabels', $event)"
            />
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-if="placementMode === 'pin'" v-slot="{ componentField }" name="pinnedRunnerId">
          <FormItem>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="pinOptions" :placeholder="t('fleet.dispatch.pinPlaceholder')" testid="dispatch-pin" />
            </FormControl>
            <p v-if="options.moreRunners.value" class="text-xs text-muted-foreground">{{ t('fleet.dispatch.moreRunners') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
      </div>

      <Button type="submit" :disabled="isSubmitting" data-testid="dispatch-submit">
        {{ isSubmitting ? t('fleet.dispatch.submitting') : t('fleet.dispatch.submit') }}
      </Button>
    </form>

    <div v-if="activeJob" class="rounded-md border border-border p-4 text-sm" data-testid="dispatch-conflict">
      {{ t('fleet.dispatch.conflict') }}
      <NuxtLink :to="`/${slug}/fleet/jobs/${activeJob.id}`" class="font-medium text-primary underline-offset-4 hover:underline" data-testid="dispatch-conflict-link">
        {{ t('fleet.dispatch.conflictLink') }}
      </NuxtLink>
    </div>

    <FleetPlacementResult v-if="result" :slug="slug" :result="result" :runner-name="options.runnerName" />
  </div>
</template>
```

- [ ] **Step 4: Run the page spec, i18n, lint and types**

Run: `cd apps/web && npx jest tests/pages/fleet-dispatch-page.spec.ts tests/i18n/used-keys-exist.spec.ts && npx eslint 'pages/[project]/fleet/dispatch.vue' components/fleet/FleetTokenListInput.vue components/fleet/FleetPlacementResult.vue --max-warnings=0 && bun run type-check`
Expected: PASS, no ESLint problems, and `nuxt typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/FleetTokenListInput.vue apps/web/components/fleet/FleetPlacementResult.vue 'apps/web/pages/[project]/fleet/dispatch.vue' apps/web/tests/pages/fleet-dispatch-page.spec.ts
git commit -m "feat(web): fleet dispatch page with placement result and duplicate-job link"
```

### Task 9: Job detail page

**Files:**
- Create: `apps/web/components/fleet/FleetJobProgress.vue`, `apps/web/components/fleet/FleetJobTimeline.vue`, `apps/web/pages/[project]/fleet/jobs/[id].vue`
- Test: `apps/web/tests/pages/fleet-job-detail.spec.ts`

**Interfaces:**
- Consumes: `useFleetJobs().get/events/cancel/requeue/downloadBundle`, `useFleetDispatchOptions().repoName/runnerName`, `useProjectMemberNames().nameOf` (Task 5), `canWorkOnFleet`, `canCancelJob`, `canRequeueJob`, `isTerminalJobState`, `mayHaveBundle`, `mergeEvents`, `safePrUrl`, `summarizeEvent`, `visibleTimelineEvents`, `extractProgress`, `formatUsd` (Task 3), `FleetJobStateBadge` (Task 7), `FleetPlacementResult` (Task 8), `useAuth().user.value?.id`.
- Produces: test ids used by Task 10 (plus `fleet-job-requeue-result`): `fleet-job-state` (badge), `fleet-job-state-reason`, `fleet-job-cancel-pending`, `fleet-job-progress`, `fleet-job-story`, `fleet-job-phase`, `fleet-job-cost`, `fleet-job-runner`, `fleet-job-finish`, `fleet-job-pr`, `fleet-job-escalation`, `fleet-job-timeline`, `fleet-job-event`, `fleet-job-events-more`, `fleet-job-bundle`, `fleet-job-requeue`, `fleet-job-cancel`, `fleet-job-cancel-confirm`.

Behaviour (S1 spec §11 "Jobs" detail): state with reason, a pending-cancel note, progress (stories passed of total), current story and phase, live cost against the cap, runner, requester, profile chain, times, finish result, branch and short sha, the PR link (https only), the escalation reason, and the event timeline paged by `seq` (50 a page, load more). Live (D139): only this job's notices reload it, and the reload follows `hasNext` for at most 10 more event pages so a busy job's new rows are not stuck past the loaded page. The timeline shows each transition once (the server's row; `visibleTimelineEvents`), the dispatch row as "Queued". Cancel asks for confirmation; requeue and cancel replace the job from the response, and a requeue also shows its placement (`FleetPlacementResult` without the open-job link). The bundle button appears from UPLOADING on and on terminal states, and a missing bundle shows the API's message. A failed first timeline load is a toast, not an empty "No events yet".

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/pages/fleet-job-detail.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const detail = read('pages', '[project]', 'fleet', 'jobs', '[id].vue')
const timeline = read('components', 'fleet', 'FleetJobTimeline.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('job detail', () => {
  test('reacts only to events for this job and never flips pending from live handlers', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).toContain('if (event.jobId === jobId) liveReload.trigger()')
    expect(handlers).not.toContain('loadJob(')
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?catch \{/)
  })

  test('actions are gated by the pure permission helpers', () => {
    expect(detail).toContain('canWork: canWorkOnFleet(viewerRole.value)')
    expect(detail).toContain('canCancelJob(job.value, viewer.value)')
    expect(detail).toContain('canRequeueJob(job.value, viewer.value)')
    expect(detail).toContain('mayHaveBundle(job.value.state)')
  })

  test('a live reload catches up a bounded number of event pages; a failed first load is reported', () => {
    expect(detail).toContain('const LIVE_CATCH_UP_PAGES = 10')
    expect(detail).toMatch(/for \(let i = 0; i < LIVE_CATCH_UP_PAGES && moreEvents\.value; i \+= 1\)/)
    expect(detail).toContain('void loadEventsFrom(1).catch((err: unknown) => toast.error(extractApiError(err)))')
  })

  test('a requeue shows its placement without a link to this same job', () => {
    expect(detail).toContain('<FleetPlacementResult v-if="requeueResult"')
    expect(detail).toContain('hide-open-link')
  })

  test('cancel asks for confirmation first', () => {
    expect(detail).toContain('@click="confirmCancel = true"')
    expect(detail).toContain('data-testid="fleet-job-cancel-confirm"')
  })

  test('the timeline lists each transition once (server rows only) and names the dispatch row Queued', () => {
    expect(timeline).toContain('visibleTimelineEvents(props.events)')
    expect(timeline).toContain("t('fleet.jobs.timeline.queued')")
    expect(timeline).not.toContain('timeline.reported')
  })

  test('the PR link is rendered only through safePrUrl, opened without opener', () => {
    expect(detail).toContain('safePrUrl(job.value?.resultPrUrl)')
    expect(detail).toMatch(/<a v-if="prUrl" :href="prUrl" target="_blank" rel="noopener noreferrer"/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx jest tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL: `ENOENT: no such file or directory, open '.../pages/[project]/fleet/jobs/[id].vue'`.

- [ ] **Step 3: Implement**

Create `apps/web/components/fleet/FleetJobProgress.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { extractProgress, formatUsd } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto }>()
const { t } = useI18n()

const progress = computed(() => extractProgress(props.job.progress))
const percent = computed(() => (progress.value ? Math.round((progress.value.passed / progress.value.total) * 100) : 0))
</script>

<template>
  <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.progress') }}</dt>
      <dd data-testid="fleet-job-progress">
        <template v-if="progress">
          {{ t('fleet.jobs.detail.progressValue', { passed: progress.passed, total: progress.total, failed: progress.failed }) }}
          <div class="mt-1 h-1.5 w-full rounded bg-muted">
            <div class="h-1.5 rounded bg-primary" :style="{ width: `${percent}%` }" />
          </div>
        </template>
        <template v-else>-</template>
      </dd>
    </div>
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.story') }}</dt>
      <dd data-testid="fleet-job-story">{{ job.currentStoryId ?? '-' }}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.phase') }}</dt>
      <dd data-testid="fleet-job-phase">{{ job.currentPhase ?? '-' }}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.cost') }}</dt>
      <dd data-testid="fleet-job-cost">{{ t('fleet.jobs.detail.costOf', { spent: formatUsd(job.costSpentUsd), max: formatUsd(job.maxCostUsd) }) }}</dd>
    </div>
  </dl>
</template>
```

Create `apps/web/components/fleet/FleetJobTimeline.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import { summarizeEvent, visibleTimelineEvents, type TimelineEntry } from '~/lib/fleet-jobs'
import type { FleetJobEventDto } from '~/lib/fleet-types'

const props = defineProps<{ events: FleetJobEventDto[]; hasMore: boolean; loading: boolean }>()
const emit = defineEmits<{ loadMore: [] }>()
const { t, te } = useI18n()

const stateLabel = (code: string): string => codeLabel(t, te, 'fleet.state', code)

function describe(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'transition':
      // Only server rows reach here (visibleTimelineEvents); the one without `from` is the dispatch.
      return entry.from
        ? t('fleet.jobs.timeline.transition', { from: stateLabel(entry.from), to: stateLabel(entry.to) })
        : t('fleet.jobs.timeline.queued')
    case 'snapshot':
      return entry.parts.length > 0
        ? t('fleet.jobs.timeline.snapshot', { detail: entry.parts.join(' | ') })
        : t('fleet.jobs.timeline.snapshotEmpty')
    case 'lifecycle':
      return t('fleet.jobs.timeline.lifecycle', { level: entry.level, message: entry.message })
    case 'log':
      return t('fleet.jobs.timeline.log', { text: entry.text })
    default:
      return t('fleet.jobs.timeline.unknown', { type: entry.type })
  }
}

const rows = computed(() => visibleTimelineEvents(props.events).map((event) => {
  const entry = summarizeEvent(event)
  return {
    id: event.id,
    seq: event.seq,
    at: new Date(event.createdAt).toLocaleString(),
    text: describe(entry),
    reason: entry.kind === 'transition' ? entry.reason : null,
  }
}))
</script>

<template>
  <section class="space-y-3" data-testid="fleet-job-timeline">
    <h2 class="text-lg font-semibold">{{ t('fleet.jobs.timeline.title') }}</h2>
    <p v-if="rows.length === 0 && !loading" class="text-sm text-muted-foreground">{{ t('fleet.jobs.timeline.empty') }}</p>
    <ol class="space-y-2">
      <li v-for="row in rows" :key="row.id" class="flex gap-3 text-sm" data-testid="fleet-job-event">
        <span class="w-10 shrink-0 text-right text-muted-foreground">{{ row.seq }}</span>
        <span class="w-44 shrink-0 text-muted-foreground">{{ row.at }}</span>
        <span class="break-all">
          {{ row.text }}
          <span v-if="row.reason" class="text-muted-foreground"> - {{ row.reason }}</span>
        </span>
      </li>
    </ol>
    <Button v-if="hasMore" variant="outline" size="sm" :disabled="loading" data-testid="fleet-job-events-more" @click="emit('loadMore')">
      {{ t('fleet.jobs.timeline.loadMore') }}
    </Button>
  </section>
</template>
```

Create `apps/web/pages/[project]/fleet/jobs/[id].vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { createDebouncer } from '~/lib/debounce'
import { canCancelJob, canRequeueJob, canWorkOnFleet, isTerminalJobState, mayHaveBundle, mergeEvents, safePrUrl } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto, FleetJobEventDto } from '~/lib/fleet-types'
import FleetJobProgress from '~/components/fleet/FleetJobProgress.vue'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import FleetJobTimeline from '~/components/fleet/FleetJobTimeline.vue'
import FleetPlacementResult from '~/components/fleet/FleetPlacementResult.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const jobId = route.params.id as string
const { t } = useI18n()
const toast = useAppToast()
const auth = useAuth()
const jobsApi = useFleetJobs(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const { data: viewerRole } = useProjectViewerRole(slug)

const job = ref<FleetJobDto | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const busy = ref(false)
const confirmCancel = ref(false)
const requeueResult = ref<DispatchResultDto | null>(null)

const events = ref<FleetJobEventDto[]>([])
const eventPage = ref(0)
const moreEvents = ref(false)
const loadingEvents = ref(false)

const viewer = computed(() => ({
  userId: auth.user.value?.id ?? null,
  canWork: canWorkOnFleet(viewerRole.value),
}))
const canCancel = computed(() => job.value !== null && canCancelJob(job.value, viewer.value))
const canRequeue = computed(() => job.value !== null && canRequeueJob(job.value, viewer.value))
const showBundle = computed(() => job.value !== null && mayHaveBundle(job.value.state))
const prUrl = computed(() => safePrUrl(job.value?.resultPrUrl))
const cancelPending = computed(() => job.value !== null && job.value.cancelRequestedAt !== null && !isTerminalJobState(job.value.state))

/** Events only append (ordered by seq), so refetching from the last loaded page is enough. */
async function loadEventsFrom(pageNo: number): Promise<void> {
  loadingEvents.value = true
  try {
    const res = await jobsApi.events(jobId, pageNo)
    events.value = mergeEvents(events.value, res.records ?? [])
    eventPage.value = pageNo
    moreEvents.value = res.hasNext === true
  }
  finally {
    loadingEvents.value = false
  }
}

async function loadJob(): Promise<void> {
  try {
    job.value = await jobsApi.get(jobId)
    loadFailed.value = false
  }
  catch (err: unknown) {
    loadFailed.value = true
    toast.error(extractApiError(err))
  }
  finally {
    pending.value = false
  }
}

onMounted(async () => {
  await loadJob()
  if (!job.value) return
  // An empty timeline must not read as "No events yet" when the load failed.
  void loadEventsFrom(1).catch((err: unknown) => toast.error(extractApiError(err)))
  // Names are cosmetic: a failure leaves ids (or "Unknown member") on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
})

/** A busy job's runner logs can push new rows past the loaded page: follow hasNext, bounded (D139). */
const LIVE_CATCH_UP_PAGES = 10
async function catchUpEvents(): Promise<void> {
  await loadEventsFrom(Math.max(eventPage.value, 1))
  for (let i = 0; i < LIVE_CATCH_UP_PAGES && moreEvents.value; i += 1) {
    await loadEventsFrom(eventPage.value + 1)
  }
}

/** Live: never flip `pending` (it would swap the page for LoadingState); a failure waits for the next event. */
async function reloadSilently(): Promise<void> {
  try {
    job.value = await jobsApi.get(jobId)
    await catchUpEvents()
  }
  catch {
    // The next live event or a resync retries.
  }
}

const liveReload = createDebouncer(() => { void reloadSilently() }, 300)
onBeforeUnmount(() => liveReload.cancel())
useProjectEvents(slug, {
  onFleetJob: (event) => {
    if (event.jobId === jobId) liveReload.trigger()
  },
  onResync: () => liveReload.trigger(),
})

async function act(run: () => Promise<void>): Promise<void> {
  busy.value = true
  try {
    await run()
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    busy.value = false
  }
}

const cancelJob = (): Promise<void> => act(async () => {
  job.value = await jobsApi.cancel(jobId)
  confirmCancel.value = false
  toast.success(t('fleet.jobs.toast.cancelRequested'))
})

const requeueJob = (): Promise<void> => act(async () => {
  const result = await jobsApi.requeue(jobId)
  job.value = result.job
  requeueResult.value = result
  toast.success(t('fleet.jobs.toast.requeued'))
  await catchUpEvents()
})

const downloadBundle = (): Promise<void> => act(() => jobsApi.downloadBundle(jobId))

const formatTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '-')
</script>

<template>
  <div class="space-y-6">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed || !job" @retry="loadJob()" />
    <template v-else>
      <PageHeader :title="job.feature" :subtitle="`${job.command} | ${options.repoName(job.repoId)} @ ${job.ref}`">
        <template #actions>
          <Button v-if="showBundle" variant="outline" :disabled="busy" data-testid="fleet-job-bundle" @click="downloadBundle()">
            {{ t('fleet.jobs.actions.bundle') }}
          </Button>
          <Button v-if="canRequeue" variant="outline" :disabled="busy" data-testid="fleet-job-requeue" @click="requeueJob()">
            {{ t('fleet.jobs.actions.requeue') }}
          </Button>
          <Button v-if="canCancel" variant="destructive" :disabled="busy" data-testid="fleet-job-cancel" @click="confirmCancel = true">
            {{ t('fleet.jobs.actions.cancel') }}
          </Button>
        </template>
      </PageHeader>

      <div class="flex flex-wrap items-center gap-3">
        <FleetJobStateBadge :state="job.state" />
        <span v-if="job.stateReason" class="text-sm text-muted-foreground" data-testid="fleet-job-state-reason">{{ job.stateReason }}</span>
        <span v-if="cancelPending" class="text-sm text-muted-foreground" data-testid="fleet-job-cancel-pending">
          {{ t('fleet.jobs.detail.cancelRequested', { at: formatTime(job.cancelRequestedAt) }) }}
        </span>
      </div>

      <section v-if="requeueResult" class="space-y-2" data-testid="fleet-job-requeue-result">
        <h2 class="text-sm font-medium">{{ t('fleet.jobs.requeuePlacement') }}</h2>
        <FleetPlacementResult v-if="requeueResult" :slug="slug" :result="requeueResult" :runner-name="options.runnerName" hide-open-link />
      </section>

      <FleetJobProgress :job="job" />

      <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.runner') }}</dt><dd data-testid="fleet-job-runner">{{ options.runnerName(job.runnerId) ?? t('fleet.jobs.detail.unassigned') }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.requester') }}</dt><dd>{{ people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember') }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.profiles') }}</dt><dd>{{ job.profiles.length > 0 ? job.profiles.join(' > ') : '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.queuedAt') }}</dt><dd>{{ formatTime(job.queuedAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.startedAt') }}</dt><dd>{{ formatTime(job.startedAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.finishedAt') }}</dt><dd>{{ formatTime(job.finishedAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.heartbeat') }}</dt><dd>{{ formatTime(job.lastHeartbeatAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.finishResult') }}</dt><dd data-testid="fleet-job-finish">{{ job.finishResult ?? '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.branch') }}</dt><dd class="break-all">{{ job.resultBranch ?? '-' }}<template v-if="job.resultSha"> ({{ job.resultSha.slice(0, 12) }})</template></dd></div>
        <div v-if="job.planFrom"><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.planFrom') }}</dt><dd class="break-all">{{ job.planFrom }}</dd></div>
        <div>
          <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.pr') }}</dt>
          <dd>
            <a v-if="prUrl" :href="prUrl" target="_blank" rel="noopener noreferrer" class="break-all text-primary underline-offset-4 hover:underline" data-testid="fleet-job-pr">{{ prUrl }}</a>
            <span v-else class="break-all">{{ job.resultPrUrl ?? '-' }}</span>
          </dd>
        </div>
      </dl>

      <div v-if="job.escalationReason" class="rounded-md border border-border p-4 text-sm" data-testid="fleet-job-escalation">
        <p class="font-medium">{{ t('fleet.jobs.detail.escalation') }}</p>
        <p class="whitespace-pre-wrap text-muted-foreground">{{ job.escalationReason }}</p>
      </div>

      <FleetJobTimeline :events="events" :has-more="moreEvents" :loading="loadingEvents" @load-more="loadEventsFrom(eventPage + 1)" />

      <Dialog :open="confirmCancel" @update:open="confirmCancel = $event">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{{ t('fleet.jobs.confirmCancel.title') }}</DialogTitle>
            <DialogDescription>{{ t('fleet.jobs.confirmCancel.body') }}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" @click="confirmCancel = false">{{ t('common.cancel') }}</Button>
            <Button variant="destructive" :disabled="busy" data-testid="fleet-job-cancel-confirm" @click="cancelJob()">{{ t('fleet.jobs.actions.cancel') }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
```

- [ ] **Step 4: Run the whole web suite, lint and types**

Run: `cd apps/web && bun run test && bun run lint && bun run type-check`
Expected: all jest suites PASS, ESLint exits 0 with no warnings, `nuxt typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/FleetJobProgress.vue apps/web/components/fleet/FleetJobTimeline.vue 'apps/web/pages/[project]/fleet/jobs/[id].vue' apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): fleet job detail page with live progress, timeline, cancel, requeue and bundle"
```

### Task 10: End-to-end: dispatch, live job page, bundle (D128, D138)

**Files:**
- Modify: `apps/api/prisma/seed-e2e.ts` (wipe fleet tables, seed project `fleet-e2e` and repo `acme/e2e-app`)
- Modify: `apps/web/playwright.config.ts` (API env: `FLEET_SYNC_WAIT_MS`, `FLEET_ARTIFACT_DIR`)
- Create: `apps/web/tests/e2e/fixtures/scripted-runner.ts`
- Test: `apps/web/tests/e2e/fleet-dispatch.e2e.spec.ts`

**Interfaces:**
- Consumes: the API's runner routes (`POST /api/fleet/enrollments` as admin, `POST /api/fleet/runner/enroll`, `POST /api/fleet/runner/sync`, `PUT /api/fleet/runner/jobs/:jobId/bundle?leaseEpoch=` with `Content-Type: application/gzip` and `X-Content-SHA256`, all with `Authorization: Bearer <kr_ key>`), the test ids of Tasks 7-9, `login`/`E2E_ADMIN` (`fixtures/api-client.ts`), `webLogin`/`waitForHydration` (`fixtures/page-helpers.ts`).
- Produces: `ScriptedRunner.enroll(adminToken, name)`, `runner.heartbeat()`, `runner.acceptAssign(jobId): Promise<Lease>`, `runner.report(lease, events)`, `runner.uploadBundle(lease, content)`, `E2E_RUNNER_CAPABILITIES`, `interface Lease { jobId; leaseEpoch }`.

Protocol facts the script relies on (read in `apps/api/src/fleet/sync/`):
- `parseSyncRequest` needs `protocolVersion`, `bootId`, `daemonVersion`, `freeSlots` (0..64) and arrays `jobs`, `commandAcks`, `tokenRequests`; events are `{ seq >= 1, type: state|snapshot|lifecycle|log, payload: object }`.
- Runner transitions allowed: ASSIGNED to RUNNING, RUNNING to UPLOADING, UPLOADING to COMPLETED (`jobs/job-state.ts`); COMPLETED needs no bundle, but the bundle is accepted only while RUNNING or UPLOADING, so it is uploaded in UPLOADING.
- Snapshot fields are mirrored when they pass their bound (`event-payloads.ts`): `costSpentUsd` matches `^\d{1,8}(\.\d{1,4})?$`, `resultPrUrl` http(s), `progress` an object under 4 KiB.
- An idle sync long-polls `FLEET_SYNC_WAIT_MS` (default 25 s); e2e sets 1 s so `acceptAssign` polls quickly. Bundles go to `FLEET_ARTIFACT_DIR`, set to a temp dir so e2e never writes into `apps/api/data`.
- Placement for a GitHub repo needs `tools.git` and `tools.gh`; a pinned, online, fitting runner is assigned during the dispatch request, so the dispatch page shows "Assigned to <runner>". "Online" means a sync within `FLEET_RUNNER_OFFLINE_SEC` (90 s); login and a cold `nuxt dev` compile can take longer than that after `beforeAll` enrolled the runner, and an offline pin is not a permanent misfit, so the job would just queue. The test therefore syncs once (`heartbeat()`) right before it submits.
- On COMPLETED the API's PR attribution runs fire-and-forget; with no GitHub App configured in e2e it does nothing and never throws (`sync/pr-attribution.service.ts`).

- [ ] **Step 1: Write the spec and the scripted runner**

Create `apps/web/tests/e2e/fixtures/scripted-runner.ts`:

```ts
/**
 * Fleet S1 slice 4c (D128): a runner that speaks the sync protocol from the test.
 * It stands in for apps/runner + fake nax: the job pages only ever see state that
 * runner syncs produce, so scripted syncs exercise them exactly.
 * Shapes: packages/fleet-protocol (SyncRequest/SyncResponse), payload rules:
 * apps/api/src/fleet/sync/event-payloads.ts.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const BOOT_ID = 'e2e-boot-1';
const DAEMON_VERSION = '0.1.0-e2e';

/** A machine profile `fast` and every tool, so placement accepts the runner for a GitHub repo. */
export const E2E_RUNNER_CAPABILITIES = {
  nax: { version: '0.83.1', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
};

export interface Lease {
  jobId: string;
  leaseEpoch: number;
}

interface SyncCommand {
  commandId: string;
  type: 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON';
  jobId: string;
  leaseEpoch: number;
}

interface SyncReply {
  jobAcks: Array<{ jobId: string; ackedSeq: number }>;
  commands: SyncCommand[];
}

type EventType = 'state' | 'snapshot' | 'lifecycle' | 'log';

async function call<T>(path: string, init: { method: string; token?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method} ${path} failed: ${res.status} ${text}`);
  const body = JSON.parse(text) as { ret?: number; data?: T };
  if (body.ret !== 0) throw new Error(`${init.method} ${path} answered ret ${String(body.ret)}: ${text}`);
  return body.data as T;
}

export class ScriptedRunner {
  private seqByJob: ReadonlyMap<string, number> = new Map();

  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly apiKey: string,
  ) {}

  /** Issues a single-use enrollment token as the admin and enrolls over HTTP, like `koda-runner enroll`. */
  static async enroll(adminToken: string, name: string): Promise<ScriptedRunner> {
    const { token } = await call<{ token: string }>('/fleet/enrollments', { method: 'POST', token: adminToken, body: { labels: ['e2e'] } });
    const { runnerId, apiKey } = await call<{ runnerId: string; apiKey: string }>('/fleet/runner/enroll', {
      method: 'POST',
      body: {
        enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: DAEMON_VERSION,
        protocolVersion: 1, bootId: BOOT_ID, labels: [], capabilities: E2E_RUNNER_CAPABILITIES,
      },
    });
    return new ScriptedRunner(runnerId, name, apiKey);
  }

  /** One idle sync: refreshes lastSeenAt so placement sees the runner online (FLEET_RUNNER_OFFLINE_SEC). */
  async heartbeat(): Promise<void> {
    await this.sync({});
  }

  private sync(over: Record<string, unknown>): Promise<SyncReply> {
    return call<SyncReply>('/fleet/runner/sync', {
      method: 'POST',
      token: this.apiKey,
      body: {
        protocolVersion: 1, bootId: BOOT_ID, daemonVersion: DAEMON_VERSION, freeSlots: 0,
        jobs: [], commandAcks: [], tokenRequests: [], ...over,
      },
    });
  }

  /** Polls (an idle sync long-polls FLEET_SYNC_WAIT_MS) until the ASSIGN for `jobId` arrives, then acks it. */
  async acceptAssign(jobId: string, timeoutMs = 15_000): Promise<Lease> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = await this.sync({ freeSlots: 1 });
      const assign = reply.commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
      if (assign) {
        await this.sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: assign.leaseEpoch, result: 'ok' }] });
        return { jobId, leaseEpoch: assign.leaseEpoch };
      }
    }
    throw new Error(`No ASSIGN for job ${jobId} within ${timeoutMs} ms`);
  }

  /** Sends events with the next runner seqs and checks the server stored all of them (cumulative ack). */
  async report(lease: Lease, events: ReadonlyArray<{ type: EventType; payload: Record<string, unknown> }>): Promise<void> {
    const first = (this.seqByJob.get(lease.jobId) ?? 0) + 1;
    const numbered = events.map((e, i) => ({ seq: first + i, type: e.type, payload: e.payload }));
    const last = first + events.length - 1;
    const reply = await this.sync({ jobs: [{ jobId: lease.jobId, leaseEpoch: lease.leaseEpoch, events: numbered }] });
    const ack = reply.jobAcks.find((a) => a.jobId === lease.jobId);
    if (ack?.ackedSeq !== last) throw new Error(`Job ${lease.jobId}: expected ack ${last}, got ${JSON.stringify(reply.jobAcks)}`);
    this.seqByJob = new Map([...this.seqByJob, [lease.jobId, last]]);
  }

  /** PUT the run bundle (accepted while RUNNING or UPLOADING, spec §3.3). */
  async uploadBundle(lease: Lease, content: string): Promise<void> {
    const body = gzipSync(Buffer.from(content, 'utf8'));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/bundle?leaseEpoch=${lease.leaseEpoch}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/gzip', 'X-Content-SHA256': sha256 },
      body,
    });
    if (res.status !== 201) throw new Error(`Bundle upload failed: ${res.status} ${await res.text()}`);
  }
}
```

Create `apps/web/tests/e2e/fleet-dispatch.e2e.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S1 spec §12 E2E (D128): dispatch from the web, the job detail page follows the
 * job live to COMPLETED, and the bundle downloads. The runner is scripted over the real
 * sync protocol; project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';

async function expectState(page: Page, state: string): Promise<void> {
  await expect(page.getByTestId('fleet-job-state').first()).toHaveAttribute('data-state', state, { timeout: 10_000 });
}

test.describe('Fleet dispatch (scripted runner)', () => {
  let runner: ScriptedRunner;
  const suffix = Date.now().toString().slice(-6);
  const feature = `e2e-${suffix}`;

  test.beforeAll(async () => {
    const { token } = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    runner = await ScriptedRunner.enroll(token, `e2e-runner-${suffix}`);
  });

  test('dispatch, live progress to COMPLETED, bundle download', async ({ page }) => {
    // About 15 sequential steps against `nuxt dev`, each waiting on a sync or a live update.
    test.setTimeout(90_000);
    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/dispatch`);
    await waitForHydration(page);

    // Native selects (4b D137): selectOption, never a portal click.
    await page.getByTestId('dispatch-repo').selectOption({ label: 'acme/e2e-app' });
    await page.getByTestId('dispatch-feature').fill(feature);
    await page.getByTestId('dispatch-max-cost').fill('3');
    await page.getByTestId('placement-pin').click();
    // By value: the label gains an "(offline)" suffix if the runner has gone quiet.
    await page.getByTestId('dispatch-pin').selectOption(runner.id);
    await runner.heartbeat();
    await page.getByTestId('dispatch-submit').click();

    await expect(page.getByTestId('placement-assigned')).toContainText(runner.name);

    // Open the job and wait for its live stream before the runner reports anything.
    const streamOpen = page.waitForResponse(
      (res) => res.url().includes(`/api/projects/${SLUG}/events`) && res.status() === 200,
      { timeout: 10_000 },
    );
    await page.getByTestId('placement-open-job').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/[^/]+$`));
    await streamOpen;
    const jobId = page.url().split('/').pop() ?? '';
    await expectState(page, 'ASSIGNED');
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    const lease: Lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [
      { type: 'state', payload: { to: 'RUNNING' } },
      {
        type: 'snapshot',
        payload: {
          naxRunId: `run-${suffix}`, currentStoryId: 'US-001', currentPhase: 'implement',
          progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 },
          costSpentUsd: '0.4200', heartbeatAt: new Date().toISOString(),
        },
      },
    ]);
    await expectState(page, 'RUNNING');
    await expect(page.getByTestId('fleet-job-story')).toHaveText('US-001');
    await expect(page.getByTestId('fleet-job-cost')).toContainText('$0.42');

    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadBundle(lease, `bundle of ${jobId}`);
    await runner.report(lease, [
      {
        type: 'snapshot',
        payload: {
          finishResult: 'opened', resultBranch: `feat/${feature}`,
          resultPrUrl: 'https://github.com/acme/e2e-app/pull/7', costSpentUsd: '0.9000',
        },
      },
      { type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } },
    ]);
    await expectState(page, 'COMPLETED');
    await expect(page.getByTestId('fleet-job-finish')).toHaveText('opened');
    await expect(page.getByTestId('fleet-job-pr')).toHaveAttribute('href', 'https://github.com/acme/e2e-app/pull/7');
    await expect(page.getByTestId('fleet-job-event').filter({ hasText: 'US-001' }).first()).toBeVisible();

    // Every update above arrived over SSE: the page never reloaded.
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    const download = page.waitForEvent('download');
    await page.getByTestId('fleet-job-bundle').click();
    expect((await download).suggestedFilename()).toBe(`koda-job-${jobId}.tar.gz`);

    // The jobs list shows the finished job.
    await page.goto(`/${SLUG}/fleet`);
    await expect(page.getByTestId(`fleet-job-row-${jobId}`).getByTestId('fleet-job-state')).toHaveAttribute('data-state', 'COMPLETED');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && cd ../web && bunx playwright test tests/e2e/fleet-dispatch.e2e.spec.ts`
Expected: FAIL: `selectOption` on `getByTestId('dispatch-repo')` times out. Project `fleet-e2e` is not seeded yet, so the page shows the no-permission or no-repos notice instead of the form.

- [ ] **Step 3: Seed the fixture and set the e2e API env**

In `apps/api/prisma/seed-e2e.ts`, at the start of the wipe, replace:

```ts
  // Wipe all test data so hardcoded keys/slugs do not conflict across runs.
  // Order: deepest relations first to satisfy FK constraints.
  await prisma.ticketActivity.deleteMany();
```

with:

```ts
  // Wipe all test data so hardcoded keys/slugs do not conflict across runs.
  // Order: deepest relations first to satisfy FK constraints.
  // Fleet first: jobs reference projects, repos and runners (events, commands, artifacts cascade).
  await prisma.fleetJob.deleteMany();
  await prisma.fleetRepo.deleteMany();
  await prisma.runner.deleteMany();
  await prisma.runnerEnrollment.deleteMany();
  await prisma.fleetActivity.deleteMany();
  await prisma.ticketActivity.deleteMany();
```

and replace the admin creation:

```ts
  await prisma.user.create({
    data: {
      email: 'admin@koda-e2e.test',
      name: 'E2E Admin',
      passwordHash,
      role: 'ADMIN',
    },
  });
```

with:

```ts
  const admin = await prisma.user.create({
    data: {
      email: 'admin@koda-e2e.test',
      name: 'E2E Admin',
      passwordHash,
      role: 'ADMIN',
    },
  });

  // Fleet slice 4c (D138): registering a repo needs a live forge (GitHub App or GitLab token),
  // which e2e has not got, so the fleet project and its repo are seeded directly.
  const fleetProject = await prisma.project.create({
    data: { name: 'E2E Fleet', slug: 'fleet-e2e', key: 'FLTE' },
  });
  await prisma.projectMember.create({ data: { projectId: fleetProject.id, userId: admin.id, role: 'ADMIN' } });
  await prisma.fleetRepo.create({
    data: {
      projectId: fleetProject.id, provider: 'github', owner: 'acme', name: 'e2e-app', defaultBranch: 'main',
      githubInstallationId: BigInt(1), createdById: admin.id,
    },
  });
```

In `apps/web/playwright.config.ts`, add `import os from 'os';` above `import path from 'path';`, and in the API `webServer.env`, after `AUTH_LOGIN_THROTTLE_LIMIT`, add:

```ts
        // Fleet slice 4c: the scripted runner's idle sync returns within 1 s instead of
        // long-polling 25 s, and job bundles land outside the repo.
        FLEET_SYNC_WAIT_MS: '1000',
        FLEET_ARTIFACT_DIR: path.join(os.tmpdir(), `koda-e2e-fleet-artifacts-${API_PORT}`),
```

- [ ] **Step 4: Run the fleet E2E, then the whole E2E suite**

Run: `cd apps/web && bunx playwright test tests/e2e/fleet-dispatch.e2e.spec.ts`
Expected: PASS (1 test): dispatch shows "Assigned to e2e-runner-...", the job page moves ASSIGNED, RUNNING (story `US-001`, `$0.42`), COMPLETED (finish `opened`, PR link) with `__noReload` still set, the download is `koda-job-<id>.tar.gz`, and the list row shows COMPLETED.

Run: `cd apps/web && bun run test:e2e`
Expected: every spec PASS (the seeded `fleet-e2e` project must not disturb the others; none of them counts projects).

If a step times out, the Playwright trace (`retain-on-failure`) shows which sync or locator stalled; a `report()` error names the ack it expected, and an `acceptAssign` timeout means placement did not assign (check the misfits on the dispatch page).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/seed-e2e.ts apps/web/playwright.config.ts apps/web/tests/e2e/fixtures/scripted-runner.ts apps/web/tests/e2e/fleet-dispatch.e2e.spec.ts
git commit -m "test(web): fleet dispatch E2E with a scripted runner"
```

### Task 11: Final verification

**Files:** none new.

- [ ] **Step 1: Repo gates**

Run from the repo root: `bun run lint && bun run test` (turbo), then `cd apps/web && bun run type-check`.
Expected: all green. If `bun run test` at the root includes the API, it needs the test Postgres (`cd apps/api && bun run test:db:up`).

- [ ] **Step 2: Manual smoke (optional, local dev stack)**

With the dev stack running and a runner enrolled, open `/<project>/fleet`, dispatch a PLAN with a missing spec path (the form blocks it), dispatch a RUN twice with the same feature (the second shows the conflict link), open the job, and check the state badge and timeline update without a reload.

- [ ] **Step 3: Self-review against the spec**

Walk S1 spec §11 "Dispatch" and "Jobs" line by line against the three pages; walk overview D115, D121, D125-D128. Confirm no `fleet` path is built without `apiPath`, no UI string is hardcoded, and `git status` is clean apart from the commits above.
