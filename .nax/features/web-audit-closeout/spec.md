# SPEC: Audit close-out: viewer-local times without hydration mismatches, faster repo nax config page

## Summary

Two items left from the 2026-11 web audit (`docs/ux/redesign/AUDIT-2026-11.md`): R2-25 and R2-21.
Dates are formatted in the viewer's time zone only after the component mounts: a new `lib/local-dates.ts`
helper returns an empty string for the server render and the hydration pass, then the viewer-local text.
Every date site in the web app moves to it, so server-rendered pages stop showing a UTC time that flips to
local time and stop logging hydration mismatches. R2-21: the repo nax config page waits ~1.65 s on
`GET .../nax-files`, which makes four sequential GitHub calls; the reader drops the root-tree call and reads the
`.nax` tree directly as `<commit>:.nax`, keeping a fresh token per request (D468).

## Motivation

- R2-25 (F3 live check §9.192): every ticket page (`/sandbox/tickets/SB-1`, `SB-12`, `SB-17`) logs "Hydration
  completed but contains mismatches". The server (container zone UTC) renders `Oct 24, 2026, 02:21 AM` in
  `components/CommentThread.vue`; the browser (Asia/Kuala_Lumpur) renders `10:21 AM`. The viewer sees the UTC
  time, then the local one. `components/TicketHeader.vue` and `components/TicketProperties.vue` format dates the
  same way (`toLocaleDateString(locale.value, ...)`), which differs between zones for 8 hours of every day.
- 11 other sites call `toLocaleString`/`toLocaleDateString` with the runtime's zone, and `timeText` in
  `lib/fleet-analytics-format.ts` does the same for 5 more consumers. They are clean today only because their
  data loads on the client; any of them that moves to a server fetch would mismatch the same way. Several use the
  bare `toLocaleString()` (numeric date with seconds) while others use the short form, so the app shows two date
  styles.
- R2-21 (live, koda-wk `168dff93`, 3 loads): the page shell loads in ~35 ms; `GET /api/projects/sandbox/fleet/repos/<id>/nax-files`
  takes 1651 ms while every other call takes ~10 ms. `GithubFleetRepoFilesReader.list` runs mint token ->
  branch head -> root tree -> `.nax` tree, one after another. GitHub serves `GET /git/trees/<commit>%3A.nax?recursive=1`
  directly (verified on `nathapp-io/koda-fleet-sandbox`: 27 entries); a missing `.nax` returns 404, and a
  `.nax` that is a file returns 422.

## Design

Ruling (owner, 2026-11-12): times render in the viewer's zone, filled in after load; the server renders the
`<time datetime>` element with no text. R2-21: fewer GitHub calls, D468 (fresh token per request, no caching)
unchanged.

### Viewer-local dates

`lib/format-date-time.ts` keeps `formatDateTime(iso, locale)` and gains:

```ts
/** "Nov 10, 2026": year numeric, month short, day numeric. An invalid date returns the input unchanged. */
export function formatDate(iso: string, locale: string | undefined): string
```

New `lib/local-dates.ts`. It is a composable but lives in `lib/` on purpose: an explicit import, not a Nuxt
auto-import, so every existing `mountSfc` harness mounts its consumers without a new global.

```ts
import { onMounted, ref } from 'vue'
import { formatDate, formatDateTime } from '~/lib/format-date-time'

export interface LocalDates {
  /** '' until the calling component has mounted; then formatDateTime in the viewer's zone. null/undefined/'' -> '-'. */
  dateTime(iso: string | null | undefined): string
  /** Same gating; then formatDate. null/undefined/'' -> '-'. */
  date(iso: string | null | undefined): string
}

/** Call in a component's setup. `i18n` is the object useI18n() returned; its `locale.value` is read when it is a non-empty string, else the runtime default locale is used. */
export function useLocalDates(i18n: { locale?: { value?: unknown } } | undefined): LocalDates
```

The helper holds one `mounted` ref per call, set in `onMounted`. The server render never runs `onMounted`, and
the client's hydration render runs before it, so both render `''`; Vue then re-renders with the local text. A
component mounted later (client navigation) shows the text after one tick. The `-` for a missing value is the
same on both sides, so it renders immediately.

Every site below switches to `useLocalDates(useI18n())` (reusing the component's existing `useI18n()` result)
and to one of the two formats: `dateTime` where it shows a time today, `date` where it shows only a date.

| Story | File | Today | After |
|:--|:--|:--|:--|
| US-001 | `components/CommentThread.vue` | `formatDateTime(comment.createdAt, commentLocale())` | `dates.dateTime(comment.createdAt)` |
| US-001 | `components/TicketHeader.vue` | local `formatDate` (`toLocaleDateString`, short) | `dates.date(...)` |
| US-001 | `components/TicketProperties.vue` | local `formatDate` (same) | `dates.date(...)` |
| US-002 | `components/KbResultCard.vue` | `new Date(createdAt).toLocaleDateString(locale)` | `dates.date(createdAt)` |
| US-002 | `components/fleet/BudgetTable.vue` | `new Date(policy.pausedAt).toLocaleString()` | `dates.dateTime(policy.pausedAt)` |
| US-002 | `components/fleet/FleetJobTimeline.vue` | `new Date(event.createdAt).toLocaleString()` in the `rows` computed | `dates.dateTime(event.createdAt)` |
| US-002 | `components/fleet/EnrollmentTokenDialog.vue` | `new Date(created.expiresAt).toLocaleString()` | `dates.dateTime(created.expiresAt)` |
| US-002 | `components/fleet/threads/ThreadPreApprovalCard.vue` | `new Date(thread.preApproval.at).toLocaleString()` | `dates.dateTime(thread.preApproval.at)` |
| US-002 | `components/fleet/threads/ThreadListTable.vue` | `activityText`: `timeText(value)` behind a finite-date guard, else `-` | `activityText` keeps its finite-date guard and calls `dates.dateTime(value)` only for a valid date, else `-` |
| US-002 | `components/fleet/analytics/JobTable.vue` | `timeText(row.finishedAt)` | `dates.dateTime(row.finishedAt)` |
| US-002 | `components/fleet/analytics/IngestTable.vue` | `timeText(row.updatedAt)` | `dates.dateTime(row.updatedAt)` |
| US-002 | `components/fleet/analytics/StoryTable.vue` | `timeText(row.completedAt)` | `dates.dateTime(row.completedAt)` |
| US-003 | `pages/notifications.vue` | `new Date(item.createdAt).toLocaleString()` inside `<time :datetime>` | `dates.dateTime(item.createdAt)` |
| US-003 | `pages/admin/audit.vue` | `localTime(iso)` (`toLocaleString(activeLocale)`) | `dates.dateTime(iso)` |
| US-003 | `pages/[project]/timeline.vue` | local `formatDate` (`toLocaleString`, short with time) | `dates.dateTime(...)` |
| US-003 | `pages/[project]/kb.vue` | local `formatDate` (`toLocaleDateString(locale.value)`) | `dates.date(...)` |
| US-003 | `pages/[project]/fleet/index.vue` | `new Date(job.queuedAt).toLocaleString()` | `dates.dateTime(job.queuedAt)` |
| US-003 | `pages/[project]/fleet/jobs/[id]/index.vue` | `formatTime` (`toLocaleString()`, `-` for null; Queued, Started, Finished, Last heartbeat, cancel-requested text) | `dates.dateTime(iso)` |
| US-003 | `pages/[project]/flows/[id].vue` | `timeText(...)` for Created and Approved | `dates.dateTime(...)` |

US-003 then removes `timeText` from `lib/fleet-analytics-format.ts` (its last consumer is gone). Removal gate:
`bun run type-check` in `apps/web` fails if any consumer still imports it.

Static gate (not an AC): US-003 adds `tests/lib/no-runtime-zone-dates.spec.ts`, which scans every `.vue` and `.ts`
file under `apps/web/components`, `pages`, `layouts`, `composables` and `lib` (tests excluded) and fails, naming
each file, on a match for `/\.toLocale(Date|Time)?String\(/` outside `lib/format-date-time.ts`, or on an import
from `~/lib/format-date-time` in any file other than `lib/local-dates.ts`. It keeps new sites from returning to
the runtime zone.

`lib/fleet-schedules.ts` is unchanged: it formats with an explicit `timeZone`, the same on both sides.

### Integration

Read-only (verified, unchanged):

- `lib/format-date-time.ts` `formatDateTime(iso, locale)`: `toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })`, returns `iso` for an invalid date.
- `tests/helpers/mount-sfc.ts` mounts a real SFC through a custom renderer; `~/...` imports resolve to the real files under `apps/web` and share the test's one Vue runtime; Nuxt auto-imports come from `globals`. `app.mount` runs `onMounted` synchronously, and the re-render it triggers flushes on the next tick, so one `await nextTick()` shows the local text.
- `tests/components/comment-thread-time.spec.ts` is the CommentThread mount harness to reuse (i18n stub with a `locale` ref). `tests/layouts/default-fleet-nav.spec.ts` already loads `vue/server-renderer` under Jest.
- `apps/api/src/fleet/git-broker/github-app-client.ts` `getTree(token, owner, name, treeish, recursive)` URL-encodes `treeish`, maps any non-200 and a body without a `tree` array to `RepoCheckException('provider_error')`; `getBranchHead` maps 404 to `repo_not_found`. `getTree` is also used by `src/fleet/knowledge/knowledge-repo-indexer.ts` and stays unchanged.
- `apps/api/test/helpers/fake-forge.ts` routes on the raw request path (a literal `%3A` path matches) and records the query string separately.
- `apps/api/src/fleet/repo-config/fleet-repo-files.reader.ts` `toNaxEntries` filters and sorts entries; `forgeCall` maps `RepoCheckException` to 409/502.
- `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts` drives the real `GithubFleetRepoFilesReader` against the fake forge: it routes `git/trees/${HEAD}` and `git/trees/naxTree`, and its VIEWER test expects 2 listed files. The other nax-files integration specs spy on `reader.list` and are unaffected.

### Faster nax-files list

`GitHubAppClient` gains:

```ts
/**
 * The tree at `<commitSha>:<dirPath>` (one request). null when the forge answers 404 or 422. Other non-200, or a
 * 200 body without a `tree` array -> RepoCheckException('provider_error'), as getTree.
 */
async getSubtree(token: string, owner: string, name: string, commitSha: string, dirPath: string, recursive: boolean): Promise<{ entries: ForgeTreeEntry[]; truncated: boolean } | null>
```

It requests `GET /repos/{owner}/{name}/git/trees/{encodeURIComponent(commitSha + ':' + dirPath)}` (plus
`?recursive=1` when `recursive`) and parses the body exactly as `getTree` does (share the parser).

`GithubFleetRepoFilesReader.list` becomes: token -> `getBranchHead` -> `getSubtree(token, owner, name, baseSha, '.nax', true)`.
null -> `{ baseSha, defaultBranch, files: [] }`; truncated -> `ForgeErrorException`; otherwise the entries,
prefixed `.nax/`, through `toNaxEntries`. Three sequential GitHub requests instead of four; the token is still
minted per request (D468). `read` is unchanged.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `useLocalDates` gets an invalid date string | `''` before mount; after mount the string unchanged (as `formatDateTime` does). |
| `useLocalDates` gets null, undefined or '' | Returns `-` before and after mount. |
| i18n object without a string `locale.value` | Formats with the runtime default locale. |
| `.nax` missing at the head commit (404) | `list` returns no files, as today. The branch head was just read with the same token, so a 404 on the subtree is taken to mean "no `.nax`", not a lost repo. |
| `.nax` is a file (422) | `list` returns no files, as today (the old code ignored a non-tree `.nax`). |
| Tree request fails otherwise, or returns a body without `tree` | 502 (`ForgeErrorException`), as today. |
| `.nax` tree truncated | 502, as today. |

## Out of Scope

- `lib/fleet-schedules.ts` (explicit time zone) and its default-zone helper for the schedule form are unchanged.
- `lib/fleet-log-view.ts` `logTime` (log line times from `getHours()`) is unchanged: job logs load on the client only.
- Relative times ("3 min ago") and a per-user time-zone setting are not added.
- The installation token and the nax-files list are not cached (D468 stays); the GitLab reader is unchanged (one `listTree` call already).
- R1-14 (not reproduced) stays open.
- The audit tracker (`docs/ux/redesign/AUDIT-2026-11.md`) is updated by hand on this branch, not by a story.
- Live checks of the hydration warnings and the nax-files timing happen in the post-merge sweep on koda-wk.

## Stories

### US-001: Viewer-local date helper, used on the ticket page

No dependencies. Workdir: `apps/web`.

Add `formatDate` to `lib/format-date-time.ts`, create `lib/local-dates.ts`, and switch `CommentThread.vue`,
`TicketHeader.vue` and `TicketProperties.vue` to it.

### US-002: Fleet and KB components use the helper

Depends on US-001. Workdir: `apps/web`.

Switch the 9 US-002 component sites in the Design table to `useLocalDates`. `timeText` stays exported until
US-003 (the flows page still uses it).

### US-003: Pages use the helper; `timeText` removed; runtime-zone guard

Depends on US-002. Workdir: `apps/web`.

Switch the 7 US-003 page sites in the Design table to `useLocalDates`, remove `timeText`, and add the static
guard test described in Design.

### US-004: nax-files lists `.nax` with one tree request

No dependencies. Workdir: `apps/api`.

Add `GitHubAppClient.getSubtree` and use it in `GithubFleetRepoFilesReader.list`.

### Context Files

**US-001**

- `apps/web/lib/format-date-time.ts`
- `apps/web/components/CommentThread.vue`
- `apps/web/components/TicketHeader.vue`
- `apps/web/components/TicketProperties.vue`
- `apps/web/tests/components/comment-thread-time.spec.ts` — the mount harness to reuse

**US-002**

- `apps/web/lib/local-dates.ts` — created by US-001
- `apps/web/lib/fleet-analytics-format.ts`
- `apps/web/components/fleet/threads/ThreadListTable.vue`
- `apps/web/tests/components/thread-preapproval-card.spec.ts` — a harness that mounts a fleet component with i18n
- `apps/web/tests/components/fleet-budget-table.spec.ts`

**US-003**

- `apps/web/lib/local-dates.ts` — created by US-001
- `apps/web/lib/fleet-analytics-format.ts`
- `apps/web/pages/[project]/flows/[id].vue`
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- `apps/web/tests/pages/notifications-page.spec.ts`

**US-004**

- `apps/api/src/fleet/git-broker/github-app-client.ts`
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — the `.nax reads (fleet S3 §4.1)` describe and its fake forge
- `apps/api/src/fleet/repo-config/github-fleet-repo-files.reader.ts`
- `apps/api/src/fleet/repo-config/fleet-repo-files.reader.spec.ts`
- `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts`

### Creates

**US-001**

- `apps/web/lib/local-dates.ts`
- `apps/web/tests/lib/local-dates.spec.ts`

**US-003**

- `apps/web/tests/lib/no-runtime-zone-dates.spec.ts` — the static guard (Design § Viewer-local dates)

### Modifies

**US-001**

- `apps/web/lib/format-date-time.ts` — adds `formatDate`.
- `apps/web/tests/lib/format-date-time.spec.ts` — adds the `formatDate` cases; existing `formatDateTime` cases stay.
- `apps/web/components/CommentThread.vue` — formats its dates with `useLocalDates`.
- `apps/web/components/TicketHeader.vue` — formats its dates with `useLocalDates`.
- `apps/web/components/TicketProperties.vue` — formats its dates with `useLocalDates`.
- `apps/web/tests/components/comment-thread-time.spec.ts` — the text now appears after one tick: the existing assertions move after `await nextTick()`, and AC US-001-6 asserts the empty first render.

**US-002**

- `apps/web/components/KbResultCard.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/components/fleet/BudgetTable.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/components/fleet/FleetJobTimeline.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/components/fleet/EnrollmentTokenDialog.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/components/fleet/threads/ThreadPreApprovalCard.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/components/fleet/threads/ThreadListTable.vue` — formats its dates with `useLocalDates`, keeping its finite-date guard (Design table).
- `apps/web/components/fleet/analytics/JobTable.vue` — formats its dates with `useLocalDates` instead of `timeText` (Design table).
- `apps/web/components/fleet/analytics/IngestTable.vue` — formats its dates with `useLocalDates` instead of `timeText` (Design table).
- `apps/web/components/fleet/analytics/StoryTable.vue` — formats its dates with `useLocalDates` instead of `timeText` (Design table).
- `apps/web/tests/components/KbResultCard.spec.ts` — the source assertion `toLocaleDateString(\s*locale` (line 122) becomes an assertion that the card imports `useLocalDates` from the local-dates lib module.
- `apps/web/tests/components/thread-preapproval-card.spec.ts` — it expects `new Date(at).toLocaleString()`; it now expects `formatDateTime(at, <the stub's locale or undefined>)` after `await nextTick()`.
- `apps/web/tests/components/fleet-budget-table.spec.ts` — the paused-row test (line 131) asserts synchronously after mount; it becomes async and awaits `nextTick()` before the assertion.

**US-003**

- `apps/web/pages/notifications.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/pages/admin/audit.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/pages/[project]/timeline.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/pages/[project]/kb.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/pages/[project]/fleet/index.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — formats its dates with `useLocalDates` (Design table).
- `apps/web/pages/[project]/flows/[id].vue` — formats its dates with `useLocalDates` instead of `timeText` (Design table).
- `apps/web/lib/fleet-analytics-format.ts` — removes `timeText` (no consumer is left).
- `apps/web/tests/lib/fleet-analytics-format.spec.ts` — removes the `timeText` cases; the other cases stay.
- `apps/web/tests/pages/fleet-flow-detail.spec.ts` — it expects `new Date(...).toLocaleString()`; it now expects `formatDateTime(..., <the stub's locale or undefined>)` after `await nextTick()`.
- `apps/web/tests/pages/flow-detail-readable.spec.ts` — it expects `new Date(...).toLocaleString()`; it now expects `formatDateTime(..., <the stub's locale or undefined>)` after `await nextTick()`.

**US-004**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — adds `getSubtree`, sharing the tree parser with `getTree`.
- `apps/api/src/fleet/git-broker/github-app-client.spec.ts` — adds the `getSubtree` cases in the `.nax reads` describe.
- `apps/api/src/fleet/repo-config/github-fleet-repo-files.reader.ts` — `list` uses `getSubtree`.
- `apps/api/src/fleet/repo-config/fleet-repo-files.reader.spec.ts` — the `GithubFleetRepoFilesReader` stub gains `getSubtree`; the four `list` cases that stubbed `getTree` (default, no `.nax`, truncated, allowlist) now stub `getSubtree`.
- `apps/api/test/integration/fleet/fleet-repo-config-api.integration.spec.ts` — the fake forge's two tree routes (the head commit's root tree and the naxTree subtree) are replaced by one route for the head commit followed by %3A.nax, returning the `.nax` entries (paths relative to `.nax`).

### Seams

**US-001**: `useLocalDates` and `formatDate` (new exports) are consumed in the same story by the three ticket
components; ACs US-001-6..8 mount `CommentThread`, `TicketHeader` and `TicketProperties` and assert the empty
first render and the local text after a tick.

**US-002**: consumes `useLocalDates` from US-001; ACs US-002-1..4 mount real consumers and assert the formatted text.

**US-003**: consumes `useLocalDates` from US-001; ACs US-003-1..4 mount real pages and assert the formatted text.
The `timeText` removal is proven by `type-check`, and missed sites by the static guard.

**US-004**: `getSubtree` (new export) is consumed in the same story by `GithubFleetRepoFilesReader.list`, which
the `GET .../nax-files` route calls; AC US-004-9 drives that route end to end against the fake forge.

## Acceptance Criteria

### US-001

1. [unit] `formatDate('2026-11-10T14:07:45.657Z', 'en')` returns a string that includes `Nov` and `2026` and does not include `14:07`, `02:07` or `T14`.
2. [unit] `formatDate('not-a-date', 'en')` returns `not-a-date`.
3. [unit] A test component built with `h()` that renders `h('time', { datetime: iso }, dates.dateTime(iso))` for `iso` `2026-11-10T14:07:45.657Z`, where `dates = useLocalDates({ locale: ref('en') })` in its setup, rendered with `renderToString` from `vue/server-renderer` over `createSSRApp`, yields a `<time>` element with that `datetime` attribute and no text.
4. [unit] The same test component mounted through a `Vue.createRenderer` recorder (the node and text recorders of `tests/helpers/mount-sfc.ts`, copied or exported) has an empty `time` text right after `mount` returns and, after `await nextTick()`, the text `formatDateTime('2026-11-10T14:07:45.657Z', 'en')`; a variant rendering `dates.date(iso)` shows `formatDate('2026-11-10T14:07:45.657Z', 'en')`.
5. [unit] `useLocalDates` returns `-` for `null`, `undefined` and `''` both before and after mount; for `not-a-date` it returns `''` before mount and `not-a-date` after; with `{ locale: { value: 42 } }` or `undefined` as the i18n argument, after mount `dateTime(iso)` returns `formatDateTime(iso, undefined)`.
6. [unit] Mounting `CommentThread` (harness of `tests/components/comment-thread-time.spec.ts`, locale ref `en`) with a comment whose `createdAt` is `2026-11-10T14:07:45.657Z`: right after `mountSfc` returns, `comment-time` is a `time` element whose `datetime` is that ISO value and whose text is `''`.
7. [unit] On that mount, after `await nextTick()`, the `comment-time` text equals `formatDateTime('2026-11-10T14:07:45.657Z', 'en')`; with the locale ref holding `zh`, it equals `formatDateTime(..., 'zh')`.
8. [unit] Mounting `TicketHeader` and `TicketProperties` with a ticket whose `createdAt` is `2026-11-10T14:07:45.657Z` and an i18n stub with locale `en` renders `formatDate('2026-11-10T14:07:45.657Z', 'en')` in each after `await nextTick()`, and does not render it right after mount.

### US-002

1. [unit] Mounting `ThreadPreApprovalCard` with a pre-approval `at` of `2026-01-02T03:04:05.000Z`: after `await nextTick()` the card text contains `formatDateTime('2026-01-02T03:04:05.000Z', <stub locale>)`.
2. [unit] Mounting `ThreadListTable` with a thread whose `lastActivityAt` is `not-a-date` renders `-` in its last-activity cell, and with `lastActivityAt` `2026-11-10T14:07:45.657Z` renders `formatDateTime('2026-11-10T14:07:45.657Z', <stub locale>)` there after `await nextTick()`.
3. [unit] Mounting `BudgetTable` with a paused policy whose `pausedAt` is `2026-10-02T03:04:05.000Z`: after `await nextTick()` that row's text contains `formatDateTime('2026-10-02T03:04:05.000Z', <stub locale>)`.
4. [unit] Mounting `JobTable` with a row whose `finishedAt` is `2026-11-10T14:07:45.657Z` and another whose `finishedAt` is null renders `formatDateTime('2026-11-10T14:07:45.657Z', <stub locale>)` in the first row after `await nextTick()` and `-` in the second.

### US-003

1. [unit] Mounting `pages/notifications.vue` with one record whose `createdAt` is `2026-11-10T14:07:45.657Z`: after `await nextTick()`, that row's `time` element has `datetime` `2026-11-10T14:07:45.657Z` and text `formatDateTime('2026-11-10T14:07:45.657Z', <stub locale>)`.
2. [unit] Mounting `pages/[project]/fleet/jobs/[id]/index.vue` with a RUNNING job whose `lastHeartbeatAt` is null and `queuedAt` is `2026-11-10T14:07:45.657Z`: right after mount the Last heartbeat value reads `-`, and after `await nextTick()` the Queued value reads `formatDateTime('2026-11-10T14:07:45.657Z', <stub locale>)`.
3. [unit] Mounting `pages/admin/audit.vue` with an entry whose `createdAt` is `2026-11-10T14:07:45.657Z` renders `formatDateTime('2026-11-10T14:07:45.657Z', <stub locale>)` in that row after `await nextTick()`.
4. [unit] Mounting `pages/[project]/flows/[id].vue` with a flow whose `createdAt` is `2026-01-02T03:04:05.000Z` renders `formatDateTime('2026-01-02T03:04:05.000Z', <stub locale>)` for Created after `await nextTick()`.

### US-004

1. [unit] `getSubtree('t', 'acme', 'app', 'c0ffee1', '.nax', true)` against the fake forge requests the path `/repos/acme/app/git/trees/c0ffee1%3A.nax` with the query `recursive=1`, and returns the parsed entries and `truncated`.
2. [unit] `getSubtree` with `recursive` false requests the same path with no query.
3. [unit] `getSubtree` returns null when the forge answers 404, and null when it answers 422.
4. [unit] `getSubtree` rejects with a `RepoCheckException` whose reason is `provider_error` when the forge answers 500, and when it answers 200 with a body that has no `tree` array.
5. [unit] `GithubFleetRepoFilesReader.list(GH)`, with the client stubbed (`getBranchHead` -> `c0ffee1`, `getSubtree` -> one `context.md` blob of size 9 and sha `k`), resolves to `{ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [{ path: '.nax/context.md', size: 9, blobSha: 'k', group: 'context' }] }`, calls `mintInstallationToken` once, `getSubtree` once with `('ghs_t', 'acme', 'app', 'c0ffee1', '.nax', true)`, and never calls `getTree`.
6. [unit] With `getSubtree` resolving null, `list(GH)` resolves to `{ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [] }`.
7. [unit] With `getSubtree` resolving `{ truncated: true, entries: [] }`, `list(GH)` rejects with `ForgeErrorException`; with `githubInstallationId` null it rejects with `RepoUnreachableException` and makes no GitHub call.
8. [unit] With `getSubtree` returning `rules/my rule.md`, `rules/规则.md` and `rules/ok.md` blobs, `list(GH)` lists only `.nax/rules/ok.md`.
9. [integration] In `test/integration/fleet/fleet-repo-config-api.integration.spec.ts`, with the fake forge serving `git/trees/<HEAD>%3A.nax` (and no root-tree route), a VIEWER's `GET .../nax-files` returns 200 with `baseSha` `<HEAD>` and files `[['.nax/rules/testing.md', 'rules'], ['.nax/context.md', 'context']]`, and the fake forge received no request for `git/trees/<HEAD>` alone.
