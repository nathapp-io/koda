# SPEC: FIX on repos whose checks nax only detects

Closes: #374, #367

## Summary

A registered GitHub fleet repo gains a setting, `fixTrustDetectedChecks` (default `false`), that lets a `FIX` job run
`nax bot fix` with `--trust`. An admin turns it on or off with a new route, `PATCH /api/fleet/repos/:id/fix-checks`.
The route goes through the existing approval gate under the `fleet.repo.review.configure` key, the same key that
guards the auto-review setting. The API reads the setting when it assigns a `FIX` job and, when it is on, adds
`review.trustDetectedChecks: true` to the ASSIGN payload. The runner then appends `--trust` to the `nax bot fix`
command. When the setting is off, nothing changes: nax refuses, and its refusal text becomes the job's failure reason
(`stateReason`), which the job page, `koda fleet job show` and the assistant's job tool already display. The admin
Repos page gets a switch for the setting.

The branch also carries the `@nathapp/nax-agent` bump from `0.91.6` to `0.91.7` (#367), already committed as
`178554a8`. That release is additive, so no thread code changes, and no story covers it.

## Motivation

`nax bot fix` refuses a PR whose base branch has no nax check commands. Its check resolution
(`fixChecks`, nax `packages/nax/src/bot/fix-run.ts:394`) tries `.nax/config.json` `quality.commands`, then commands
listed in `AGENTS.md` or `CLAUDE.md`, then scripts it detects in `package.json`. A `detected` result is refused unless
the caller passes `--trust`, with the reason `the base branch has no nax config and no AGENTS.md or CLAUDE.md checks;
run nax setup, or pass --trust to run the package scripts nax detected`. A `none` result is always refused.
koda's runner never passes `--trust` (`buildFixArgv`, `apps/runner/src/executor/nax-process.ts:37`), so a `FIX` on
such a repo always fails, after its review step has already run and posted (#374).

Ruling (2026-11-02): a per-repo toggle, off by default and changed through the approval gate; when on, the runner
passes `--trust`; when off, the FIX fails with nax's refusal text as the job's failure reason. No dispatch-time
refusal or preflight, because that would copy nax's check-resolution rules into koda.

Facts that shape this spec (koda `main` `5be70960`, nax `0.91.7`):

- The runner already turns a refused `nax bot fix` into `FAILED` with the first non-empty line of `fix.stderr`
  (at most 200 characters) as the reason (`JobRun` FIX verdict, `apps/runner/src/supervisor/job-run.ts:490`;
  `HostExecutor.readFixOutcome`, `apps/runner/src/executor/host-executor.ts:327`). nax writes the refusal reason to
  stderr (`botFixCommand`, nax `packages/nax/src/cli/bot.ts:139`), and a successful fix leaves `fix.stderr` empty.
  The verdict reason is stored as `FleetJob.stateReason`, which the job page, the CLI `Reason` row and the assistant
  job tool show. So the "clear reason" half of the ruling needs no new code.
- The assign payload is built at placement (`buildAssignPayload` call, `apps/api/src/fleet/jobs/placement.service.ts:211`)
  from the `FleetRepoRef` that `PrismaFleetJobRepository.findRepo` loads in `placeJob` (line 73) and `fillRunner` (line 133). Reading the setting
  there means turning it off before a queued `FIX` is placed takes effect.
- The runner's assign parser rebuilds `review` from an allow-list (`parseAssign`,
  `apps/runner/src/supervisor/assign-parser.ts:236`), so it must accept the new field explicitly.

## Design

### Integration

Symbols the feature only reads:

- `ApprovalRouteGate.run<T>({ key, variant, projectId, input })` returning `{ status: 'pending', request } | { status: 'done', result }`, as used by `FleetReposController.configureAutoReview` (`apps/api/src/fleet/repos/fleet-repos.controller.ts:94`).
- `routeCommand<TInput, TResult>({ key, variant, parse, run, toResult })` and `ApprovalCommandRegistry.register` (`apps/api/src/fleet/repos/fleet-repo-route.commands.ts:57`).
- `parseRouteInput(input, ['id'])` and `parseBody(Dto, raw)` from `apps/api/src/approvals/route/`.
- `AuditService.record({ key, resourceType, resourceId, projectId, summary })` as called in `FleetReposService.configureAutoReview` (`apps/api/src/fleet/repos/fleet-repos.service.ts:104`).
- `AutoReviewException` (`apps/api/src/fleet/repos/auto-review.exception.ts`), the 422 `{ reason }` pattern to mirror.
- `useGlobalPermissions()` (`permissions.value.has(key)`), `extractApiError(err)` and `$api.patch` as used in `apps/web/components/fleet/RepoAutoReview.vue` and `apps/web/composables/useFleetRepos.ts:80`.

Symbols the feature changes. The baseline only locates the code; implement the target.

- `FleetRepo` (Prisma model, `apps/api/prisma/schema.prisma:767`)
  - Baseline: no fix setting.
  - Target: adds `fixTrustDetectedChecks Boolean @default(false)`, created by migration `apps/api/prisma/migrations/20261119090000_fleet_repo_fix_trust/migration.sql` (`ALTER TABLE "FleetRepo" ADD COLUMN "fixTrustDetectedChecks" BOOLEAN NOT NULL DEFAULT false;`).
- `FleetRepoRecord` (`apps/api/src/fleet/repos/domain/fleet-repo.domain.ts:6`)
  - Target: adds optional `fixTrustDetectedChecks?: boolean` (absent means `false`). Optional so existing fixtures stay valid. `IFleetRepoRepository` gains `updateFixChecks(id: string, value: boolean): Promise<FleetRepoRecord>`. The `create(...)` parameter type also omits `fixTrustDetectedChecks`.
- `FleetRepoDto` (`apps/api/src/fleet/repos/dto/fleet-repo.dto.ts`)
  - Target: adds `@ApiProperty() fixTrustDetectedChecks: boolean`, set by `FleetRepoDto.from` as `record.fixTrustDetectedChecks === true`.
- New `UpdateFixChecksDto` (`apps/api/src/fleet/repos/dto/update-fix-checks.dto.ts`): `@ApiProperty() @IsBoolean() trustDetectedChecks!: boolean`.
- New `FixChecksException` (`apps/api/src/fleet/repos/fix-checks.exception.ts`): a 422 whose body carries `{ reason }`, mirroring `AutoReviewException`; the only reason is `github app required`.
- `FleetReposService` gains `configureFixChecks(principal: UserPrincipal | AgentPrincipal, id: string, dto: UpdateFixChecksDto): Promise<FleetRepoDto>`. Inside `txManager.run`: load the row (missing -> `NotFoundAppException({}, 'fleet.repos')`); when enabling, refuse with `FixChecksException('github app required')` unless `provider === 'github'` and `githubInstallationId !== null`; disabling is always allowed. Then `repo.updateFixChecks(id, dto.trustDetectedChecks)`, then `audit.record({ key: 'fleet.repo.review.configure', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId, summary: 'fix detected checks enabled' | 'fix detected checks disabled' })`, and return `FleetRepoDto.from(updated)`.
- `FleetReposController` gains `@Patch(':id/fix-checks')`, `@HttpCode(200)`, `@UseGuards(RequiresGuard)`, `@Requires('fleet.repo.review.configure')`, `@ApprovalGated()`, with Swagger `@ApiOperation({ summary: 'Allow FIX on detected checks for a registered repo (fleet.repo.review.configure, global)' })` and responses 200/403/404/422. Its body mirrors `configureAutoReview`, with `variant: FLEET_REPO_ROUTE_VARIANTS.fixChecks` and `input: { id, patch: dto }`.
- `FLEET_REPO_ROUTE_VARIANTS` gains `fixChecks: 'rest:fleet-repos.fix-checks'`. `FleetRepoRouteCommands.onModuleInit` registers a fifth command for `fleet.repo.review.configure` at that variant (parse `{ id, patch }` with `UpdateFixChecksDto`, run `configureFixChecks`).
- `FleetRepoRef` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:216`)
  - Target: adds optional `fixTrustDetectedChecks?: boolean`. `PrismaFleetJobRepository.findRepo` (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:51`) adds it to its `select`.
- `AssignPayload.review` (`packages/fleet-protocol/src/index.ts:265`, types only)
  - Baseline: `review?: { prNumber: number; botLogin: string; decisions?: ReviewDecision[] }`.
  - Target: `review?: { prNumber: number; botLogin: string; decisions?: ReviewDecision[]; trustDetectedChecks?: true }`, documented as FIX-only. The API imports the protocol with `import type`, so this edit rides the API story, as in K3.
- `buildAssignPayload(job, repo, cloneUrl, gitIdentity, thread?)` (`apps/api/src/fleet/jobs/assign-payload.ts:28`)
  - Target: inside `review`, spreads `{ trustDetectedChecks: true }` only when `job.command === 'FIX'` and `repo.fixTrustDetectedChecks === true`; otherwise the key is absent.
- `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts`)
  - Target: for a `FIX`, `review.trustDetectedChecks` may be absent or exactly `true`, and is copied into the cleaned `review`; any other value, or the key on a `REVIEW`, fails with `bad('review')`.
- `buildFixArgv(naxCommand, assign)` (`apps/runner/src/executor/nax-process.ts:37`)
  - Baseline: `[...naxCommand, 'bot', 'fix', String(prNumber), '--no-rereview', '--profile', chain]`.
  - Target: the same list, followed by `'--trust'` when `assign.review?.trustDetectedChecks === true`.
- Web `FleetRepo` (`apps/web/lib/fleet-types.ts:128`) adds `fixTrustDetectedChecks: boolean`. `useFleetRepos()` gains `setFixChecks(id: string, body: { trustDetectedChecks: boolean }): Promise<AutoReviewResult>`, a `$api.patch` of `/fleet/repos/${id}/fix-checks` that returns `{ kind: 'pending', request }` when the answer has `permissionKey` and otherwise `{ kind: 'saved', repo }`, updating `repos`. New component `apps/web/components/fleet/RepoFixChecks.vue` (auto-registered as `FleetRepoFixChecks`). It renders a `Switch` bound to `repo.fixTrustDetectedChecks` with the `fleet.repos.fixChecks.toggle` aria-label and the `fleet.repos.fixChecks.hint` text beside it, disabled unless `permissions.value.has('fleet.repo.review.configure')` or while saving. A toggle calls `setFixChecks`, emits `saved` with the returned repo, shows the `fleet.repos.fixChecks.pending` notice on a pending answer, and shows `extractApiError(err)` on failure. `apps/web/pages/admin/fleet/repos.vue` mounts it in the auto-review cell, under the same GitHub-with-installation condition.

### Approach

- The setting is read at assignment, not snapshotted at dispatch, so the value in force when the job is placed wins.
  A readopted job keeps the argv built from its stored assign payload.
- The key is reused rather than adding `fleet.repo.fix.configure`. It is global and high risk (`fleet.repo.` prefix
  in `HIGH_RISK_PREFIXES`), so an agent caller waits for a human by default. A new key would need the inventory TSV,
  the role-matrix snapshot and the catalog spec edited.
- Mixed versions are safe. An older runner drops the unknown field and does not pass `--trust`, so nax refuses as
  today. An older API never sends the field. No capability or protocol version change is needed.

### Failure Handling

| Case | Behaviour |
|---|---|
| Enable on a GitLab repo, or a GitHub repo with no App installation | 422 `{ reason: 'github app required' }`; the row is unchanged |
| Unknown repo id | 404 `fleet.repos` |
| Body missing `trustDetectedChecks`, or a non-boolean value | 400 validation error |
| Caller lacks `fleet.repo.review.configure` globally | 403 |
| Agent caller with the key and no matching policy | 202 approval request; the row changes only when a human approves |
| ASSIGN with `review.trustDetectedChecks` other than `true`, or on a `REVIEW` | runner `parseAssign` refuses with `bad('review')` |
| Setting off and nax refuses the fix | unchanged existing behaviour (`job-run.ts:490`, covered by `job-run.spec.ts:420`): `FAILED`, `stateReason` = nax's refusal line; no new AC |

## Out of Scope

- A CLI command, assistant tool or MCP tool to change the setting; this feature adds the REST route and the web switch only.
- Refusing a FIX at dispatch, or any preflight that reads the base branch's nax config, AGENTS.md or CLAUDE.md before the review step runs (ruled out 2026-11-02 to avoid copying nax's check resolution).
- Snapshotting the setting onto the job at dispatch; the setting is read when the job is assigned.
- Rewording nax's refusal text or adding a koda hint to it; the failure reason stays nax's line as the runner reads it today.
- Passing `--trust` to `nax bot review`, to the follow-up REVIEW, or to any job kind other than FIX.
- A new permission key for the setting; it reuses `fleet.repo.review.configure`.
- GitLab FIX support; FIX stays GitHub-only.
- The branch-protection reason label for FIX tokens (#382).
- Adopting any nax-agent 0.91.7 session capability in threads (tracked in #368, #369, #375); the bump commit `178554a8` changes only the version.
- Recording who turned the setting on in columns on the repo row; the audit entry is the record.
- Concurrent toggles of the same repo; the last committed write wins.
- A new AC for the FIX verdict when nax refuses; that path already exists (`JobRun` FIX verdict, `apps/runner/src/supervisor/job-run.ts:490`) and is covered by `job-run.spec.ts`.
- Probing `bot fix --trust` as a runner capability; a runner whose nax predates `--trust` (canaries before 2026-10-24) fails a trusted FIX with nax's unknown-option line, and every current runner has nax 0.91.7.
- An `endpoint.e2e.spec.ts` case for the fix-checks route; like the sibling auto-review route, it is covered by its route integration spec.

## Stories

### US-001: Repo fix-checks setting and route

No dependencies. Workdir: apps/api. Adds the `fixTrustDetectedChecks` column and migration, the optional
`FleetRepoRecord` field, `IFleetRepoRepository.updateFixChecks` in `PrismaFleetRepoRepository`, the
`FleetRepoDto.fixTrustDetectedChecks` field, `UpdateFixChecksDto`, `FixChecksException`,
`FleetReposService.configureFixChecks`, the `PATCH /api/fleet/repos/:id/fix-checks` route and its
`rest:fleet-repos.fix-checks` route command, a `fixChecks` entry with a `"422"` message in `apps/api/src/i18n/en/fleet.json` and `apps/api/src/i18n/zh/fleet.json` (beside the existing `autoReview` entry, used by `FixChecksException`),
and the regenerated `openapi.json` and CLI types (`bun run generate`).

### US-002: FIX assign payload carries the setting

Depends on US-001. Workdir: apps/api. Adds `trustDetectedChecks?: true` to `AssignPayload.review` in
`packages/fleet-protocol/src/index.ts` (types only), the optional `FleetRepoRef.fixTrustDetectedChecks` field and its
`findRepo` select, and the conditional spread in `buildAssignPayload`.

### US-003: Runner passes --trust

Depends on US-002. Workdir: apps/runner. `parseAssign` accepts and copies `review.trustDetectedChecks` for FIX only,
and `buildFixArgv` appends `--trust` when it is `true`.

### US-004: Web switch on the admin Repos page

Depends on US-001. Workdir: apps/web. Adds `FleetRepo.fixTrustDetectedChecks`, `useFleetRepos().setFixChecks`, the
`FleetRepoFixChecks` component, its mount on `pages/admin/fleet/repos.vue`, and the `fleet.repos.fixChecks.*` keys
(`toggle`, `pending`, `hint`) in `i18n/locales/en.json` and `i18n/locales/zh.json`.

### Context Files

**US-001**

- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `configureAutoReview`, the pattern for the new method
- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — `configureAutoReview` route
- `apps/api/src/fleet/repos/fleet-repo-route.commands.ts` — variant table and command registration
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — `updateAutoReview` and `toDomain`
- `apps/api/test/integration/fleet/fleet-repo-auto-review-route.integration.spec.ts` — route integration test pattern

**US-002**

- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findRepo`
- `apps/api/src/fleet/jobs/assign-payload.spec.ts` — existing payload tests
- `apps/api/test/integration/fleet/placement.integration.spec.ts` — ASSIGN command integration pattern

**US-003**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign` review branch
- `apps/runner/src/executor/nax-process.ts` — `buildFixArgv`
- `apps/runner/src/supervisor/assign-parser.spec.ts` — review assignment tests
- `apps/runner/src/executor/nax-process.spec.ts` — `buildFixArgv` tests

**US-004**

- `apps/web/components/fleet/RepoAutoReview.vue` — switch, notice and error pattern
- `apps/web/composables/useFleetRepos.ts` — `setAutoReview`
- `apps/web/pages/admin/fleet/repos.vue` — auto-review cell
- `apps/web/tests/components/repo-auto-review.spec.ts` — component test pattern

### Creates

**US-001**

- `apps/api/prisma/migrations/20261119090000_fleet_repo_fix_trust/migration.sql`
- `apps/api/src/fleet/repos/dto/update-fix-checks.dto.ts`
- `apps/api/src/fleet/repos/fix-checks.exception.ts`
- `apps/api/src/fleet/repos/fleet-repos.fix-checks.spec.ts`
- `apps/api/test/integration/fleet/fleet-repo-fix-checks-route.integration.spec.ts`

**US-002**

- `apps/api/test/integration/fleet/placement-fix-trust.integration.spec.ts`

**US-004**

- `apps/web/components/fleet/RepoFixChecks.vue`
- `apps/web/tests/components/repo-fix-checks.spec.ts`

### Modifies

**US-001**

- `apps/api/src/fleet/repos/fleet-repo-route.commands.spec.ts` — `AC-12: registers the four matching variants` asserts `Object.values(FLEET_REPO_ROUTE_VARIANTS)` has length 4; it becomes 5. The case table gains `fixChecks` (key `fleet.repo.review.configure`, raw `{ id: 'r1', patch: { trustDetectedChecks: true } }`), the `build()` repos mock gains `configureFixChecks`, and the per-action execute assertions gain a `fixChecks` branch expecting `configureFixChecks` called with `'r1'` and the patch.
- `apps/api/src/fleet/repos/dto/fleet-repo.dto.spec.ts` — gains the US-001 `FleetRepoDto.from` cases for `fixTrustDetectedChecks` (absent -> `false`, `true` -> `true`); the existing `toMatchObject` case is unchanged.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — gains the US-001 case for the fix-checks PATCH operation and the UpdateFixChecksDto properties, and a row for the fix-checks PATCH route with key fleet.repo.review.configure in the global admin route table; existing cases are unchanged.
- `openapi.json` — regenerated by `bun run generate` for the new route, `UpdateFixChecksDto` and the `FleetRepoDto` field; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` for the new route, `UpdateFixChecksDto` and the `FleetRepoDto` field; never hand-edited.

**US-002**

- `apps/api/src/fleet/jobs/assign-payload.spec.ts` — gains the US-002 `buildAssignPayload` cases for `review.trustDetectedChecks`; existing cases are unchanged because an absent field keeps the payload as it is.

**US-003**

- `apps/runner/src/supervisor/assign-parser.spec.ts` — gains the US-003 `parseAssign` cases for `review.trustDetectedChecks`; existing review cases are unchanged.
- `apps/runner/src/executor/nax-process.spec.ts` — gains the US-003 `buildFixArgv` `--trust` cases; `AC-11` (no flag) is unchanged.
- `apps/runner/test/unit/host-executor.spec.ts` — gains the US-003 `spawnFixStep` case asserting `--trust` in the argv passed to the injected `spawnNax`; existing FIX cases are unchanged.

**US-004**

- `apps/web/tests/pages/admin-fleet-repos.spec.ts` — the page mounts real `fleetComponents: ['FleetRepoReachabilityBadge', 'FleetRepoAutoReview']`; add `FleetRepoFixChecks`, and the assertion that one `[data-stub="switch"]` renders for the single GitHub repo with an installation becomes two (auto-review and fix-checks). The repo fixture gains `fixTrustDetectedChecks: false`.
- `apps/web/tests/components/repo-auto-review.spec.ts` — its `FleetRepo` fixture gains `fixTrustDetectedChecks: false` so it still matches the type.
- `apps/web/tests/composables/useFleetRepos.spec.ts` — gains the US-004 `setFixChecks` cases beside the existing `setAutoReview` case; a `FleetRepo` fixture there, if any, gains `fixTrustDetectedChecks: false`.

### Seams

- US-001 -> US-002: the `fixTrustDetectedChecks` column written by `configureFixChecks` is what `findRepo` reads; US-002's integration AC sets it through the US-001 route or repository and asserts the ASSIGN payload.
- US-002 -> US-003: the wire field is `review.trustDetectedChecks`, a JSON boolean `true` inside the ASSIGN command payload, present only on FIX; US-003 parses exactly that shape.
- US-001 -> US-004: the web calls `PATCH /fleet/repos/{id}/fix-checks` with the JSON body `{ "trustDetectedChecks": true }` or `{ "trustDetectedChecks": false }` and reads `fixTrustDetectedChecks` from the returned `FleetRepoDto`.

## Acceptance Criteria

### US-001

1. [integration] With the test Postgres, `PATCH /api/fleet/repos/:id/fix-checks` with `{ "trustDetectedChecks": true }` by a user holding `fleet.repo.review.configure` globally, on a GitHub repo with a `githubInstallationId`, answers 200 with a `FleetRepoDto` whose `fixTrustDetectedChecks` is `true`, and the `FleetRepo` row's `fixTrustDetectedChecks` is `true`.
2. [integration] The same route with `{ "trustDetectedChecks": false }` on that repo answers 200 with `fixTrustDetectedChecks` `false`, and the row is `false`.
3. [integration] Enabling on a GitLab repo answers 422 with body reason `github app required`, and the row stays `false`.
4. [integration] Enabling on a GitHub repo whose `githubInstallationId` is null answers 422 with reason `github app required`.
5. [integration] Disabling on a GitLab repo answers 200 with `fixTrustDetectedChecks` `false`.
6. [integration] An unknown repo id answers 404.
7. [integration] A body without `trustDetectedChecks`, and a body with `"trustDetectedChecks": "yes"`, each answer 400 and leave the row unchanged.
8. [integration] A user without `fleet.repo.review.configure` globally gets 403 and the row is unchanged.
9. [integration] An agent holding `fleet.repo.review.configure` globally, with no approval policy, gets 202 with an approval request whose `permissionKey` is `fleet.repo.review.configure`, and the row stays `false`.
10. [integration] Approving that request through `POST /api/approvals/:id/decisions` with `{ "decision": "approve" }` sets the row's `fixTrustDetectedChecks` to `true`.
11. [unit] `FleetReposService.configureFixChecks` records one audit entry with key `fleet.repo.review.configure`, resource type `fleet-repo`, the repo id and summary `fix detected checks enabled` when enabling, and summary `fix detected checks disabled` when disabling.
12. [unit] `FleetRepoRouteCommands` registers a command for key `fleet.repo.review.configure` at variant `rest:fleet-repos.fix-checks`, whose `parse` accepts `{ id: 'r1', patch: { trustDetectedChecks: true } }` and whose execution calls `FleetReposService.configureFixChecks` with that id and patch.
13. [unit] `FleetRepoDto.from` on a `FleetRepoRecord` without `fixTrustDetectedChecks` yields `fixTrustDetectedChecks: false`, and on one with `true` yields `true`.
14. [integration] A `FleetRepo` row created without `fixTrustDetectedChecks` (the migration default) is listed by `GET /api/fleet/repos` with `fixTrustDetectedChecks` `false`.
15. [unit] The committed `openapi.json` has a `patch` operation at `/api/fleet/repos/{id}/fix-checks`, and the `UpdateFixChecksDto` schema's properties are exactly `trustDetectedChecks`.

### US-002

1. [unit] `buildAssignPayload` for a FIX job whose `feature` is `review-pr-7`, with a repo whose `fixTrustDetectedChecks` is `true`, returns `review` equal to `{ prNumber: 7, botLogin: <bot>, trustDetectedChecks: true }`.
2. [unit] `buildAssignPayload` for a FIX job with a repo whose `fixTrustDetectedChecks` is `false` returns a `review` with no `trustDetectedChecks` key.
3. [unit] `buildAssignPayload` for a FIX job with a repo that has no `fixTrustDetectedChecks` field returns a `review` with no `trustDetectedChecks` key.
4. [unit] `buildAssignPayload` for a REVIEW job with a repo whose `fixTrustDetectedChecks` is `true` returns a `review` with no `trustDetectedChecks` key.
5. [integration] With the test Postgres, `PrismaFleetJobRepository.findRepo` returns `fixTrustDetectedChecks: true` for a `FleetRepo` row stored with `true`, and `false` for a row stored with the default.
6. [integration] With the test Postgres, a GitHub repo with `fixTrustDetectedChecks` `true` and one online runner whose capabilities include `botFix: true`, dispatching a FIX through `POST /api/projects/:slug/fleet/jobs` writes one ASSIGN `FleetCommand` whose `payload.review.trustDetectedChecks` is `true`.
7. [integration] The same dispatch on a repo with `fixTrustDetectedChecks` `false` writes an ASSIGN whose `payload.review` has no `trustDetectedChecks` key.
8. [integration] A FIX dispatched while the only runner is at capacity stays QUEUED; after the repo's `fixTrustDetectedChecks` is set from `true` to `false` and the runner syncs with a free slot through `POST /api/fleet/runner/sync`, the ASSIGN written for it has no `trustDetectedChecks` key.

### US-003

1. [unit] `parseAssign` on a FIX ASSIGN whose `review` is `{ prNumber: 4, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true }` returns ok with `assign.review.trustDetectedChecks` `true`.
2. [unit] `parseAssign` on a FIX ASSIGN whose `review` has no `trustDetectedChecks` returns ok with no `trustDetectedChecks` key in `assign.review`.
3. [unit] `parseAssign` on a FIX ASSIGN whose `review.trustDetectedChecks` is `false` fails with reason `review`.
4. [unit] `parseAssign` on a FIX ASSIGN whose `review.trustDetectedChecks` is the string `'true'` fails with reason `review`.
5. [unit] `parseAssign` on a REVIEW ASSIGN whose `review.trustDetectedChecks` is `true` fails with reason `review`.
6. [unit] `buildFixArgv(['nax'], assign)` for a FIX with `review: { prNumber: 4, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true }`, profiles `['native-codex']` and job id `j1` returns `['nax', 'bot', 'fix', '4', '--no-rereview', '--profile', 'native-codex,koda-job-j1', '--trust']`.
7. [unit] `buildFixArgv` for the same FIX without `trustDetectedChecks` returns the list without `'--trust'`.
8. [unit] `HostExecutor.spawnFixStep` for a FIX job whose assign has `review.trustDetectedChecks: true` spawns nax with an argv that includes `--trust`, observed through the injected spawn.

### US-004

1. [unit] `useFleetRepos().setFixChecks('r1', { trustDetectedChecks: true })` sends `PATCH` to `/fleet/repos/r1/fix-checks` with body `{ trustDetectedChecks: true }` and, for a `FleetRepo` answer, returns `{ kind: 'saved', repo }` and replaces that repo in `repos`.
2. [unit] `setFixChecks` returns `{ kind: 'pending', request }` when the answer carries `permissionKey`, and leaves `repos` unchanged.
3. [unit] `FleetRepoFixChecks` renders its switch checked when `repo.fixTrustDetectedChecks` is `true` and unchecked when `false`.
4. [unit] `FleetRepoFixChecks` disables the switch when the global permissions lack `fleet.repo.review.configure`.
5. [unit] Toggling the switch on calls `setFixChecks` with `{ trustDetectedChecks: true }` and emits `saved` with the returned repo.
6. [unit] When `setFixChecks` returns `pending`, the component shows the `fleet.repos.fixChecks.pending` text and emits nothing.
7. [unit] When `setFixChecks` rejects, the component shows the `extractApiError` message in an element with `role="alert"`.
8. [unit] The admin Repos page renders `FleetRepoFixChecks` for a GitHub repo with an installation, and not for a GitLab repo or a GitHub repo without an installation.
9. [unit] `FleetRepoFixChecks` renders the `fleet.repos.fixChecks.hint` text, and the `fleet.repos.fixChecks.toggle`, `fleet.repos.fixChecks.pending` and `fleet.repos.fixChecks.hint` keys resolve to non-empty strings in both the `en` and `zh` locales.
