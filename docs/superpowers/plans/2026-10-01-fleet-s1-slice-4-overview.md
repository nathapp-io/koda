# Fleet S1 Slice 4 — Web Pages and CLI: Split and Shared Decisions

> Read this before any slice 4 plan. It splits slice 4 into three plans (one PR each), fixes the API contract
> the web and CLI plans build on, and carries the decisions all three share.

**Spec:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec"): §11 Web and CLI (this
slice), §1 (live events, Runners page polls), §2.2 permissions, §3.4 user-facing endpoints, §12 Testing (E2E
line), §13 Delivery item 4. Issue #158 (bootId on `RunnerDto`) is folded in.

**Base:** `main` at `0ba9ba94` (#175, slice 3 complete). Decision numbers continue the fleet S1 register:
D1-D113 are used (slices 2-3b-2, including the 3b-2 whole-branch review's D110-D113). Slice 4 uses **D114-D140**;
this file holds D114-D129, each plan adds its own after that range (4a: D130-D134, 4b: D135-D137, 4c: D138-D140).

## Split

| Plan | Branch | Scope | Depends on |
|:--|:--|:--|:--|
| **4a** API completions + CLI (`2026-10-01-fleet-s1-slice-4a-api-cli.md`) | `feat/fleet-s1-slice4a-api-cli` | The API additions below (D116-D121), `openapi.json` + CLI client regen, the `koda fleet` CLI | `main` |
| **4b** Web foundation + admin pages (`2026-10-01-fleet-s1-slice-4b-web-admin.md`) | `feat/fleet-s1-slice4b-web-admin` | Fleet i18n section, apiPath guard, admin nav, Runners page (enroll token, enable/disable, labels/capacity, delete, 15 s poll), Repos page (add, delete, reachability badges) | 4a merged |
| **4c** Web project pages + E2E (`2026-10-01-fleet-s1-slice-4c-web-jobs.md`) | `feat/fleet-s1-slice4c-web-jobs` | `fleet_job` live events in the web stream, project nav, Jobs list, Dispatch page, Job detail (timeline, live, cancel, requeue, bundle), Playwright E2E | 4b merged |

All three plans are written now against the contract below; 4b and 4c are executed after their predecessor
merges, and their executors rebase first. If 4a's contract changes in review, 4b and 4c are patched before they
run.

## API contract added by 4a (4b and 4c rely on these names exactly)

### `RunnerDto` (admin, `GET /api/fleet/runners`, `GET|PATCH /api/fleet/runners/:id`)

Existing fields unchanged; three added (D116, D117):

```ts
bootId: string           // #158
bootedAt: string | null  // ISO; null until the runner's first boot after this migration
online: boolean          // now - lastSeenAt <= FLEET_RUNNER_OFFLINE_SEC (server-side, same rule as placement)
```

`capabilities` stays `Record<string, unknown>` on the wire. Its shape is `RunnerCapabilities` from
`packages/fleet-protocol` (nax `{version, protocols}`, `sandbox {available, probedAt, error?}`,
`profiles: Record<name, {protocol, providers, sandbox}>`, `credentials: Array<{providerId, available, stored:
{kind, expires?, expired} | null, exec?, ambient}>`, `tools {git, gh, glab}`, `executors`).

### `RunnerSummaryDto` (project member, NEW `GET /api/projects/:slug/fleet/runners`, paged, D118)

```ts
{ id: string; name: string; os: string; arch: string; labels: string[]; enabled: boolean; online: boolean; profiles: string[] }
```

`profiles` = the sorted keys of `capabilities.profiles` (machine profiles). Ordered by `name`. Same page query as
every list (`current`, `size` 1..100).

### Repo reachability (admin, NEW `POST /api/fleet/repos/:id/check`, D119)

```ts
// 200, JsonResponse.Ok
{ repoId: string; reachable: boolean; reason: string | null; checkedAt: string }
```

`reason` is a `RepoCheckReason` (`github_app_not_configured`, `github_app_key_unreadable`, `app_not_installed`,
`app_permissions_insufficient`, `repo_not_found`, `provider_unreachable`, `provider_error`,
`vcs_connection_missing`, `vcs_connection_mismatch`, `vcs_encryption_key_missing`, `gitlab_token_invalid`,
`gitlab_access_insufficient`, `gitlab_scope_missing`), exactly as registration reports it. 404 `fleet.repos`
for an unknown id. Not stored, no activity row.

### OpenAPI path params (D120)

The three project-scoped fleet controllers declare `@ApiParam({ name: 'slug' })` at class level, so generated
`*Data.path` types carry `slug` (today they are `never` / `{ id }`).

### Unchanged and relied on

- Job list `GET /api/projects/:slug/fleet/jobs?current&size&state&repoId&runnerId&requestedById&feature`,
  ordered `queuedAt desc, id desc`; `FleetJobDto` fields as in `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`.
- Dispatch/requeue answer `{ job: FleetJobDto, placement: { assigned, runnerId, misfits: [{ runnerId, name,
  reason }] } }`; `reason` is a `MisfitReason` (`disabled`, `offline`, `labels`, `executor`, `protocol`,
  `provider_missing`, `provider_unavailable`, `sandbox`, `tools`, `busy_repo`, `capacity`).
- Errors arrive as `{ ret, message }` (nathapp `GlobalExceptionsFilter`); exception args are not on the wire.
- SSE `GET /api/projects/:slug/events` already emits named `fleet_job` events
  `{ id, type: 'fleet_job', projectId, jobId, state, at }` (`apps/api/src/live/live-event.ts`).
- Bundle `GET /api/projects/:slug/fleet/jobs/:id/bundle` streams `application/gzip`, 404 when none.

## Shared decisions

| # | Decision | Why |
|:--|:--|:--|
| D114 | Slice 4 is three plans and three PRs, 4a then 4b then 4c (table above). | One plan for API + CLI + four web pages + E2E would be past 400 KB; the 3a/3b splits worked. 4a lands the contract first, so neither web plan changes the API. |
| D115 | Web routes: admin pages at `/admin/fleet/runners` and `/admin/fleet/repos`; project pages at `/:project/fleet` (jobs list), `/:project/fleet/dispatch`, `/:project/fleet/jobs/:id`. S1 spec §11's "under `/fleet`" is read as "the fleet section". | A top-level `pages/fleet/` shadows a project slugged `fleet` (`pages/[project]/` is the dynamic root). Admin pages already live under `/admin`. Dispatch and jobs are project-scoped in the API and the SSE stream, so their pages carry the slug like every other project page, and get breadcrumbs. |
| D116 | `RunnerDto` gains `bootId` and `bootedAt` (#158). `createdById` stays off the DTO. | #158 asks to decide `createdById`: nothing displays it, and the activity log already attributes `enrollment.created`/`runner.enrolled`. Adding it later is additive. |
| D117 | `RunnerDto.online` is computed by the API with the placement rule (`now - lastSeenAt <= runnerOfflineSec`); the threshold itself is not exposed. | Web, CLI and placement must agree on "online"; computing it client-side would copy the rule and the config default. |
| D118 | New `GET /api/projects/:slug/fleet/runners` returns `RunnerSummaryDto` to any project member. | A DEVELOPER dispatches with labels or a pin and picks a profile chain, and the jobs list shows runner names, but the runner list is global ADMIN. The summary carries no versions, capacity, credentials or sandbox detail: only what dispatch needs. Runners are global (not per project), so every runner is listed. |
| D119 | Repo reachability is an on-demand `POST /api/fleet/repos/:id/check` that re-runs the registration forge check and returns 200 with `reachable` and `reason`; nothing is stored. The Repos page checks the rows it shows on load and on a per-row button. | S1 spec §11 wants "a reachability badge" but nothing records reachability, and storing a check result goes stale. Re-running the same check registration runs (GitHub App installation token / GitLab stored token) answers the real question: can koda broker git for this repo now. A failed check is data, not an error, so it is 200. |
| D120 | `@ApiParam({ name: 'slug', required: true })` on `FleetJobsController`, `JobBundleController`, `ProjectFleetReposController` and the new project runners controller; regenerate `openapi.json` and the CLI client in 4a. | Without it the generated CLI types for those routes have no `slug`, so the CLI could only call them through a cast. |
| D121 | Clients find the active job behind a dispatch 409 by listing `jobs?repoId=<id>&feature=<f>&size=20` and taking the first record whose state is `QUEUED`, `ASSIGNED`, `RUNNING` or `UPLOADING`. No error-envelope change. | The nathapp exception filter writes only `{ret, message}`, so `activeJobId` never reaches the client as data, and parsing the message is banned (`.nax/rules/common.md`: structured codes, not message matching). The partial unique index guarantees at most one active job per (repo, feature). |
| D122 | #167 (bundle upload post-stream recheck) is not in slice 4. | It is an API/runner fence fix with no web or CLI surface; it stays a separate fix PR. |
| D123 | Runner packaging needs no work: `apps/runner` already has `build:binary` / `build:all` (`scripts/build-binary.ts`). | S1 spec §11's packaging paragraph shipped with slice 3. |
| D124 | The fleet activity log (`GET /api/fleet/activity`) gets no page in slice 4. | S1 spec §11 lists four pages and none is an activity page; the job detail timeline uses job events. |
| D125 | Runner and repo lists in the web and CLI ask for `size=100` and show a "more" hint when `hasNext`. | Fleets are a handful of machines; paging controls on admin tables that never page are noise, but a silent cap is wrong. |
| D126 | Misfit reasons, job states, finish results and repo check reasons are translated in the web from fixed key maps (`fleet.misfit.<reason>`, `fleet.state.<STATE>`, `fleet.repoReason.<reason>`); an unknown value falls back to the raw string. The CLI prints the raw codes. | Codes are stable and enumerable; the API sends codes, not prose. |
| D127 | Web downloads (job bundle) go through a new `useApi().download(path)` that returns a `Blob` (cookie auth via the `/api` proxy, one refresh retry on 401, `ApiError` on a JSON error), then a temporary object URL. | `.nax/rules/web.md` forbids raw `$fetch` in pages; a bare link cannot show a 404 as a toast and gets no auth refresh. |
| D128 | E2E (S1 spec §12: "dispatch → job detail updates live → COMPLETED, with the fake-nax runner") drives the protocol from the Playwright test: it enrolls a runner and plays `sync` calls (ack ASSIGN, RUNNING snapshot, UPLOADING, COMPLETED), with the fleet repo row seeded directly. The real runner + fake nax is already proven against the real API in `apps/runner/test/integration`, and the two-machine live check covers real forges. | A real daemon in Playwright needs git hosting and a GitHub App or GitLab token on the CI box; the page under test only sees sync-driven state changes, which a scripted runner produces exactly. **Deviation from the spec's wording; flagged for user review.** |
| D129 | No new required CI check; the fleet E2E spec joins the existing Playwright job. | Same rule as slices 1-3. |
