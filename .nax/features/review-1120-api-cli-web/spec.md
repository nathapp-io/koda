# SPEC: Review 1120 API, CLI and web fixes

## Summary

This feature fixes the API, CLI and web findings of the 2026-11-20 whole-repo review
(`docs/20261120-review-whole-repo-consolidated.md`): K2, K9, K12, K14, K15, K16 and K17. The deploy, CI and release
findings shipped in #487; the runner findings (K10, K11, K13, K18) are a separate feature.

1. **CI webhook payload and ticket URL (K14, K15).** The inbound CI webhook refuses a payload without a `pipeline` or
   `commit` object with a 400 instead of a 500, and a CI failure ticket links each failure's source file when the
   project has a git remote.
2. **PR ruling lookup (K12).** `latestRunForPr` finds a RUN job whose stored PR URL has a trailing slash, a query
   string or a fragment, so the newest run of a PR is always the one rulings target.
3. **CLI v2 signatures (K2).** `koda ci-webhook trigger` signs the delivery with webhook signature v2 when
   `KODA_CI_WEBHOOK_SECRET` is set, so it keeps working once an operator sets `CI_WEBHOOK_REQUIRE_V2=true`.
4. **CLI repo shorthand (K9).** An `owner/name` repo reference that matches repos on two hosts is refused, with each
   host and id listed, instead of silently picking the first.
5. **Web repo choosers (K9).** The seven repo choosers add the host to a label that two repos share.
6. **Web inbox state and log download (K16, K17).** A stale bell refresh can no longer undo "Mark all read" on screen,
   and the log Download control renews an expired access cookie before the browser starts the download.

## Motivation

- **K14.** `CiWebhookPayloadDto` (`apps/api/src/ci-webhook/ci-webhook.dto.ts`) marks `pipeline` and `commit` with
  `@ValidateNested()` and `@Type()` only. class-validator skips nested validation of an absent value, so a payload with
  neither object passes `parseInboundPayload`, and `CiWebhookService.createTicket` then reads `payload.pipeline.id` and
  throws a `TypeError` (500). Reproduced in review: no `pipeline` and no `commit` accepted, `pipeline` only accepted,
  `pipeline: {}` rejected.
- **K15.** `CiWebhookService.buildDescription` builds `{ gitRemoteUrl: undefined }` inline and passes it to
  `buildGitUrl`, so the `URL:` line never appears, and `PrismaCiWebhookRepository.findProjectBySlug` does not select
  `Project.gitRemoteUrl`.
- **K12.** `prNumberFor` (`apps/api/src/fleet/sync/pr-attribution.service.ts`) reads the PR number from the URL path and
  accepts a trailing `/`; `new URL(...).pathname` drops any query or fragment. The pre-filter in
  `PrismaFleetPrRulingRepository.latestRunForPr` is `resultPrUrl: { endsWith: '/pull/42' }` (or `/merge_requests/42`),
  so `.../pull/42/`, `.../pull/42?w=1` and `.../pull/42#x` never reach the parser. When the newest RUN's URL is such a
  variant, `ruleTarget` answers `fleet.rulings.notLatest`, a FIX snapshot misses pending rulings, and an older run with
  a canonical URL is picked. Owner ruling (2026-11-20): widen the filter, no migration.
- **K2.** `apps/cli/src/commands/ci-webhook.ts` exposes only `--signature` (sent as `x-ci-signature`) and generates
  `x-ci-delivery` internally, so a caller cannot pre-compute a v2 signature, which covers
  `<timestamp>.<delivery>.<body>`. With `ciRequireV2` true, `CiWebhookController.handleCiWebhook` refuses every request
  without `x-ci-signature-v2`. K1 (#487) made that switch reachable, so this must ship before anyone sets it.
- **K9.** `resolveRepo` (`apps/cli/src/commands/fleet-shared.ts`) returns the first repo whose `owner/name` matches.
  `FleetRepo.host` is part of repo identity (`apps/api/prisma/schema.prisma`, `FleetRepo.host`), so two GitLab hosts can
  share an `owner/name`, and `koda fleet dispatch`, `fleet job list`, `fleet schedule create` and `fleet budget`
  act on whichever repo the API listed first. The web repo choosers in `dispatch.vue`, `threads/new.vue`,
  `schedules/index.vue`, `schedules/[id].vue`, `budgets.vue`, the jobs list filter in `fleet/index.vue` and the REPO
  scope select in `SettingsProviderKeysCard.vue` all label both options `owner/name`.
- **K16.** `useNotifications.refresh` (`apps/web/composables/useNotifications.ts`) writes the shared `useState` without
  checking which refresh is newest. A bell refresh that started earlier and finishes after the inbox's
  post-`markAllRead` refresh puts the badge back to unread until the next 60 s poll.
- **K17.** The Download control on `pages/[project]/fleet/jobs/[id]/logs.vue` is a plain `<a href download>` to the Nuxt
  `/api` proxy. `shouldRefreshSession` (`apps/web/server/utils/session-refresh.ts`) refreshes only `text/html` requests
  outside `/api/`, so after the 15-minute access cookie expires the download gets a 401 although the refresh cookie is
  still valid.

## Design

### Calls made in this spec

- **K14.** Both parent fields gain `@IsDefined()` and `@IsObject()` (class-validator), ahead of the existing
  `@ValidateNested()`. Validation is event-independent: a `pipeline_success` payload without `pipeline` is now a 400
  too, as the DTO already documents both fields as required. The OpenAPI schema does not change (`@ApiProperty` already
  marks both required), so `openapi.json` and the CLI client are not regenerated.
- **K15.** `CiProjectDomain` gains `gitRemoteUrl: string | null`; `findProjectBySlug` selects it; `buildDescription`
  takes the project and passes `project.gitRemoteUrl` to `buildGitUrl`. `buildGitUrl` is unchanged.
- **K12.** `latestRunForPr` replaces the single `endsWith` with an `OR` that matches every URL `prNumberFor` can accept
  for that number. With `s` the existing `prUrlSuffix(provider, prNumber)`, the job filter is
  `OR: [{ resultPrUrl: { endsWith: s } }, { resultPrUrl: { endsWith: s + '/' } }, { resultPrUrl: { contains: s + '?' } },
  { resultPrUrl: { contains: s + '/?' } }, { resultPrUrl: { contains: s + '#' } }, { resultPrUrl: { contains: s + '/#' } }]`.
  The `OR` covers the canonical URL and every trailing-slash, query and fragment variant of it; `prNumberFor` still
  confirms every candidate, so `/pull/420?x` and `/pull/42x` never match. A zero-padded number (`/pull/042`), which
  `prNumberFor` also parses as 42, matches neither the old filter nor the new one.
  `runsForPr` already scans every RUN with a URL and is unchanged.
- **K2.** The secret comes only from the environment variable `KODA_CI_WEBHOOK_SECRET`, never a flag, so it stays out
  of argv and shell history. When it is set and non-empty, the command serializes the body once with `JSON.stringify`,
  sets `x-ci-timestamp` to `String(Math.floor(Date.now() / 1000))`, computes
  `x-ci-signature-v2 = 'sha256=' + hex(HMAC-SHA256(secret, timestamp + '.' + delivery + '.' + serialized))` with
  `node:crypto` `createHmac`, and passes `bodySerializer: () => serialized` to `ciWebhookControllerHandleCiWebhook`, so
  the bytes sent are the bytes signed (the generated client calls `opts.bodySerializer(opts.body)`,
  `apps/cli/src/generated/client/client.gen.ts`). `--signature` stays through the deprecation window: when given it is
  still sent as `x-ci-signature`, alongside v2 when the secret is set. An empty `KODA_CI_WEBHOOK_SECRET` counts as unset,
  as the API treats an empty token as no token. The `trigger` description names the variable.
- **K9 (CLI).** `resolveRepo` matches an exact id first. Otherwise it collects every repo whose `owner/name` matches
  case-insensitively; one match is returned, none returns `null` (callers keep their "Unknown repo" refusal), and two or
  more call `handleFleetValidation` (exit 3) with the message
  `Repo "<ref>" matches <n> repos in project <slug>: <host> (id <id>), <host> (id <id>). Pass the repo id instead.`,
  hosts and ids in the API's list order, and then returns `null`, so with a stubbed `process.exit` (the CLI specs' harness) each caller still stops at its own "Unknown repo" check and sends nothing. The four callers (`fleet dispatch`, `fleet job list`, `fleet schedule create`, `fleet budget set`) need no change: each
  already refuses a `null` repo before any API write; the ACs drive the first two.
- **K9 (web).** New pure helper `repoChoices` in `apps/web/lib/fleet-repo-choices.ts` builds the `{ value, label }`
  options from a repo list. The label is `owner/name`; when two or more repos in the list share `owner/name`
  case-insensitively, each of those gets ` (<host label>)`, where the host label is `URL.host` plus the pathname
  without a trailing `/` when `host` parses as a URL, else the raw `host`. The five form pages replace their inline
  `repoOptions` computed with `computed(() => repoChoices(options.repos.value))`; the jobs list repo filter
  (`pages/[project]/fleet/index.vue`) and the REPO scope select of `components/SettingsProviderKeysCard.vue` render
  their `SelectItem`s from `repoChoices(...)` (value and label) instead of `{{ repo.owner }}/{{ repo.name }}`. Page specs stub
  `useFleetDispatchOptions` with repos that have no `host`, so `host` is optional in the helper's input type; a
  colliding repo without a `host` gets ` (<id>)`.
- **K16.** `useNotifications` keeps a refresh generation in `useState` keyed `notifications-refresh-gen:<owner>` (the
  same `owner` key as the other two states). `refresh` increments it before its requests and writes `unreadCount` and
  `latest` only if the generation is still its own when both responses arrive.
- **K17.** The anchor keeps its `href` and `download` attributes (copy-link and middle-click still work) and gains a
  click handler that prevents the default navigation and calls the new helper `startLogDownload(href, { probe, open })`
  (`apps/web/lib/fleet-log-download.ts`). `startLogDownload` awaits `probe()` and then calls `open(href)`; a rejected
  probe rejects `startLogDownload` and `open` is not called. The page passes `probe: () => logsApi.list()` (a `$api`
  GET, which refreshes the session and retries once on a 401, `useApi` M22) and an `open` that creates an anchor with
  that `href` and the `download` attribute and clicks it. On a rejection the page shows `extractApiError(err)` in an
  element with `data-testid="fleet-log-download-error"`.

### Integration

Read-only:

- `apps/api/src/webhook-security/inbound-webhook-request.ts` `parseInboundPayload(cls, body)`: throws
  `ValidationAppException({ param })` on the first validation error. Unchanged.
- `apps/api/src/common/utils/git-url.util.ts`
  `buildGitUrl(gitRemoteUrl: string | null | undefined, ref: string, filePath: string, line?: number): string | null`.
  Unchanged.
- `apps/api/src/fleet/sync/pr-attribution.service.ts` `prNumberFor(repo, url): number | null`. Unchanged.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts`: the ruling path throws
  `ConflictAppException({}, 'fleet.rulings.notLatest')` when `latestRunForPr(target.repoId, target.prNumber)` is not
  the job being ruled. Unchanged.
- `apps/cli/src/utils/error.ts` `handleApiError(err, { validationError: true })`: prints and exits 3. Unchanged.
- `apps/web/composables/useApi.ts`: a client-side `get` retries once after `useAuth().refresh()` on a 401. Unchanged.
- `apps/web/composables/useFleetJobLogs.ts` `list()` and `downloadHref(stream, leaseEpoch)`. Unchanged.

Changed. Each **Baseline** exists only to locate the code; it is never the shape to implement.

- `CiWebhookPayloadDto.pipeline` and `.commit`
  - Baseline: `@ApiProperty(...) @ValidateNested() @Type(() => CiPipelineDto)` (and `CiCommitDto`).
  - Target: `@ApiProperty(...) @IsDefined() @IsObject() @ValidateNested() @Type(...)`.
- `CiProjectDomain` (`apps/api/src/ci-webhook/domain/ci-webhook.domain.ts`)
  - Baseline: `{ id; key; deletedAt; ciWebhookToken }`.
  - Target: adds `gitRemoteUrl: string | null`.
- `CiWebhookService.buildDescription`
  - Baseline: `private buildDescription(_failure: CiFailureDto, payload: CiWebhookPayloadDto): string`.
  - Target: `private buildDescription(project: { gitRemoteUrl: string | null }, payload: CiWebhookPayloadDto): string`;
    `createTicket` receives the full `CiProjectDomain`.
- `PrismaFleetPrRulingRepository.latestRunForPr(repoId, prNumber)`: signature unchanged; the `where` gains the `OR`
  above in place of `resultPrUrl: { endsWith }`.
- `ciWebhookCommand` `trigger` action: adds the v2 path above.
- `resolveRepo(slug: string, ref: string): Promise<FleetRepoDto | null>`: signature unchanged; ambiguity exits 3.
- The five form pages' `repoOptions` computed: replaced by `repoChoices(options.repos.value)`.
- The jobs list repo filter and the provider-keys REPO scope select: `SelectItem`s from `repoChoices(...)`.
- `useNotifications().refresh`: signature unchanged; drops superseded responses.
- `logs.vue` Download anchor: gains the click handler and the error element.

New:

```ts
// apps/web/lib/fleet-repo-choices.ts
export interface RepoChoiceInput { id: string; owner: string; name: string; host?: string }
export function repoChoices(repos: readonly RepoChoiceInput[]): Array<{ value: string; label: string }>

// apps/web/lib/fleet-log-download.ts
export function startLogDownload(
  href: string,
  deps: { probe: () => Promise<unknown>; open: (href: string) => void },
): Promise<void>
```

### Failure Handling

| Case | Behaviour |
|---|---|
| CI webhook: signed payload without `pipeline`, or without `commit` | 400 `ValidationAppException`; not processed; delivery id not recorded |
| CI webhook: `pipeline` or `commit` is `null`, a string or an array | 400 `ValidationAppException` |
| CI ticket: project has no `gitRemoteUrl` | no `URL:` line |
| CI ticket: failure without `file` | no `URL:` line for that failure |
| Ruling lookup: newest RUN URL has a trailing `/`, `?query` or `#fragment` | that RUN is the latest run |
| Ruling lookup: a URL for a longer number sharing the prefix (`/pull/420?x`) | not matched |
| CLI: `KODA_CI_WEBHOOK_SECRET` unset or empty | no v2 headers; request as before |
| CLI: repo shorthand matches repos on two hosts | exit 3, hosts and ids listed, no API write |
| Web: the newer of two overlapping notification refreshes rejects | the older is still dropped; the state keeps its value until the next poll |
| Web: log list probe rejects (refresh refused) | error shown in `fleet-log-download-error`; no download started |

## Out of Scope

- A zero-padded PR number in a stored URL (`/pull/042`): no forge emits one, and the lookup filter does not match it.
- Storing a normalized PR number or URL on `FleetJob`: the owner ruled a wider lookup filter with no migration (2026-11-20).
- `PrismaFleetPrRulingRepository.runsForPr`: it already scans every RUN job with a URL and confirms through `prNumberFor`.
- A `--secret` flag on `koda ci-webhook trigger`: the secret comes only from `KODA_CI_WEBHOOK_SECRET` so it never appears in argv or shell history.
- Removing `--signature` or the v1 header from the CLI: it stays through the v1 deprecation window.
- A `host/owner/name` repo shorthand in the CLI: an ambiguous shorthand is refused and the user passes the repo id.
- Display-only repo names (CLI tables from `repoNamesOrEmpty`, `useFleetDispatchOptions().repoName`, the admin repos page, the `repoName` helper in `SettingsProviderKeysCard` that labels existing keys, `RepoConfigList`, the repo list in `SettingsKnowledgeCard`): they keep `owner/name`; only the seven choosers change.
- `buildGitUrl` support for SSH remotes or self-hosted GitLab hosts: unchanged; it already returns its existing URL shapes.
- Refreshing the session inside the Nuxt `/api` proxy or `shouldRefreshSession` for stream requests: the click handler renews the session instead.
- The job bundle download: it goes through `$api.download`, which already refreshes and retries on a 401.
- Regenerating `openapi.json` or the CLI client: no API contract changes.
- The runner findings K10, K11, K13 and K18: a separate feature.

## Stories

Six stories, one package each, all independent: two API stories, two CLI stories, two web stories. They are one
bundle by owner ruling (the 2026-11-20 split into three specs by area).

**US-001: CI webhook payload validation and ticket source URL.** Workdir: `apps/api`. No dependencies.
`CiWebhookPayloadDto` requires `pipeline` and `commit` objects (K14), and CI failure tickets carry each failure's
source URL from the project's `gitRemoteUrl` (K15).

**US-002: PR ruling lookup accepts URL variants.** Workdir: `apps/api`. No dependencies.
`latestRunForPr` matches a stored PR URL with a trailing slash, a query string or a fragment, and still never a longer
number (K12).

**US-003: CLI signs CI webhooks with v2.** Workdir: `apps/cli`. No dependencies.
`koda ci-webhook trigger` sends `x-ci-timestamp` and `x-ci-signature-v2` over the exact body it sends when
`KODA_CI_WEBHOOK_SECRET` is set (K2).

**US-004: CLI refuses an ambiguous repo shorthand.** Workdir: `apps/cli`. No dependencies.
`resolveRepo` matches an id first and exits 3 listing hosts and ids when an `owner/name` matches more than one repo
(K9).

**US-005: Web repo choosers show the host on a shared name.** Workdir: `apps/web`. No dependencies.
New `repoChoices` helper, used by the dispatch, new thread, schedule list, schedule detail and budgets pages, the jobs
list repo filter and the provider-keys REPO scope select (K9).

**US-006: Web inbox refresh ordering and log download session.** Workdir: `apps/web`. No dependencies.
`useNotifications.refresh` drops superseded responses (K16); the log Download control renews the session through
`startLogDownload` before downloading (K17).

### Context Files

**US-001**
- `apps/api/src/ci-webhook/ci-webhook.dto.ts`
- `apps/api/src/ci-webhook/ci-webhook.service.ts`
- `apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts`
- `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts`
- `apps/api/test/integration/audit/audit-ci-webhook.integration.spec.ts`

**US-002**
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts`
- `apps/api/src/fleet/sync/pr-attribution.service.ts`
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts`
- `apps/api/test/integration/fleet/fleet-pr-ruling.repository.integration.spec.ts`

**US-003**
- `apps/cli/src/commands/ci-webhook.ts`
- `apps/cli/src/commands/ci-webhook.spec.ts`
- `apps/cli/src/generated/client/client.gen.ts`
- `apps/api/src/webhook-security/webhook-signature.ts`

**US-004**
- `apps/cli/src/commands/fleet-shared.ts`
- `apps/cli/src/commands/fleet-shared.spec.ts`
- `apps/cli/src/commands/fleet-dispatch.spec.ts`
- `apps/cli/src/commands/fleet-job.spec.ts`

**US-005**
- `apps/web/lib/fleet-types.ts`
- `apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts`
- `apps/web/tests/pages/fleet-schedule-approval-gates.spec.ts`
- `apps/web/tests/pages/fleet-jobs-list.spec.ts`
- `apps/web/tests/components/SettingsProviderKeysCard.spec.ts`

**US-006**
- `apps/web/composables/useNotifications.ts`
- `apps/web/tests/composables/useNotifications.spec.ts`
- `apps/web/composables/useFleetJobLogs.ts`
- `apps/web/tests/pages/fleet-job-logs-page.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/ci-webhook/ci-webhook-repository.integration.spec.ts`

**US-005**
- `apps/web/lib/fleet-repo-choices.ts`
- `apps/web/tests/lib/fleet-repo-choices.spec.ts`

**US-006**
- `apps/web/lib/fleet-log-download.ts`
- `apps/web/tests/lib/fleet-log-download.spec.ts`

### Modifies

No existing assertion breaks: the CI controller spec's valid payloads carry both objects, the service spec's project
fixture is an untyped literal, the CLI specs match headers and bodies with `objectContaining`, `fleet-shared.spec.ts`
uses repos with distinct `owner/name`, and the web page specs assert `owner/name` labels for single repos, which
`repoChoices` keeps. The entries below authorise the source files each story changes and the specs it extends.

**US-001**
- `apps/api/src/ci-webhook/ci-webhook.dto.ts` — `pipeline` and `commit` gain `@IsDefined()` and `@IsObject()` before `@ValidateNested()`; nothing else in the DTO changes.
- `apps/api/src/ci-webhook/domain/ci-webhook.domain.ts` — `CiProjectDomain` gains `gitRemoteUrl: string | null`.
- `apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts` — `findProjectBySlug` also selects `gitRemoteUrl`.
- `apps/api/src/ci-webhook/ci-webhook.service.ts` — `createTicket` takes the full project and `buildDescription passes project.gitRemoteUrl to buildGitUrl` instead of the inline `{ gitRemoteUrl: undefined }`.
- `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts` — gains the missing, null, string and array parent-object cases in the existing signed-payload 400 table.
- `apps/api/src/ci-webhook/ci-webhook.service.spec.ts` — gains the source-URL description cases.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the `ci-webhook` block gains a v1-signed payload without `pipeline` answering 400 (rule `api-testing`: at least one error case per endpoint).

**US-002**
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts` — `latestRunForPr`'s `resultPrUrl: { endsWith }` filter becomes the six-way `OR` from Design; the paging loop and the `prNumberFor` confirmation are unchanged.
- `apps/api/test/integration/fleet/fleet-pr-ruling.repository.integration.spec.ts` — gains the URL-variant cases, each on its own PR number so they do not collide with the existing pull 42 fixture jobs.

**US-003**
- `apps/cli/src/commands/ci-webhook.ts` — the `trigger` action gains the `KODA_CI_WEBHOOK_SECRET` v2 path (one serialization, `x-ci-timestamp`, `x-ci-signature-v2`, `bodySerializer`) and its description names the variable; the v1 `--signature` path is unchanged.
- `apps/cli/src/commands/ci-webhook.spec.ts` — gains the v2 cases with a fixed clock and the variable set, unset and empty.

**US-004**
- `apps/cli/src/commands/fleet-shared.ts` — `resolveRepo` matches an exact id first and exits 3 through `handleFleetValidation` when the owner and name match two or more repos.
- `apps/cli/src/commands/fleet-shared.spec.ts` — gains the two-host fixtures.
- `apps/cli/src/commands/fleet-dispatch.spec.ts` — gains the ambiguous-shorthand and id cases.
- `apps/cli/src/commands/fleet-job.spec.ts` — gains the ambiguous-shorthand `job list` case.

**US-005**
- `apps/web/pages/[project]/fleet/dispatch.vue` — the inline `repoOptions` computed becomes repoChoices(options.repos.value).
- `apps/web/pages/[project]/threads/new.vue` — the inline `repoOptions` computed becomes repoChoices(options.repos.value).
- `apps/web/pages/[project]/fleet/schedules/index.vue` — the inline `repoOptions` computed becomes repoChoices(options.repos.value).
- `apps/web/pages/[project]/fleet/schedules/[id].vue` — the inline `repoOptions` computed becomes repoChoices(options.repos.value).
- `apps/web/pages/[project]/fleet/budgets.vue` — the inline `repoOptions` computed becomes repoChoices(options.repos.value).
- `apps/web/pages/[project]/fleet/index.vue` — the repo filter's `SelectItem`s come from repoChoices(options.repos.value).
- `apps/web/components/SettingsProviderKeysCard.vue` — the REPO scope select's `SelectItem`s come from `repoChoices(repos)`; the `repoName` display helper is unchanged.
- `apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts` — gains a new test that repeats the existing test's mount stubs with the two-host repos and reads the dispatch-repo select's options (the dispatch page's only mounting spec; fleet-dispatch-page.spec.ts reads source text only).
- `apps/web/tests/pages/threads-new-page.spec.ts` — gains the two-host repo case.
- `apps/web/tests/pages/fleet-schedules-list-page.spec.ts` — gains the two-host repo case.
- `apps/web/tests/pages/fleet-schedule-approval-gates.spec.ts` — mountScheduleDetail gains a repos parameter (it hardcodes an empty list) and its schedule detail ([id].vue) mount gains the two-host repo case (fleet-schedule-detail.spec.ts reads source text only).
- `apps/web/tests/pages/fleet-jobs-list.spec.ts` — its fleet/index.vue mount gains the two-host repo case.
- `apps/web/tests/components/SettingsProviderKeysCard.spec.ts` — gains the two-host repo case for the REPO scope select.
- `apps/web/tests/pages/fleet-budgets-project-page.spec.ts` — gains the two-host repo case.

**US-006**
- `apps/web/composables/useNotifications.ts` — `refresh` increments and checks a per-owner generation in `useState`; nothing else changes.
- `apps/web/tests/composables/useNotifications.spec.ts` — gains the two-instance overlapping-refresh cases.
- `apps/web/pages/[project]/fleet/jobs/[id]/logs.vue` — the Download anchor gains a click handler that calls `startLogDownload` and an error element `fleet-log-download-error`; the anchor's `href` and `download` attributes stay.
- `apps/web/tests/pages/fleet-job-logs-page.spec.ts` — the `useFleetJobLogs` stub's `list` is hoisted into one jest.fn that can reject once, a globalThis.document anchor recorder is installed, and the click, probe-order and probe-failure cases are added.

### Seams

- US-005: `repoChoices` is new and exported; AC-8 to AC-12 mount each of the five pages with two repos that share
  `owner/name` and assert the labels the page hands to its repo chooser, and AC-13 and AC-14 do the same for the jobs list filter and the
  provider-keys REPO select, proving each of the seven choosers calls it.
- US-006: `startLogDownload` is new and exported; AC-9 to AC-12 click the Download control on the logs page and assert
  the list probe runs before the download and that a rejected probe shows the error and starts no download, proving the page
  calls it.

## Acceptance Criteria

### US-001

Controller ACs call `CiWebhookController.handleCiWebhook('koda', request, signature, deliveryId)` with a raw body that
the existing spec helpers sign with the project's token, as the existing "a signed payload with ... is a 400" table
does. The valid payload is `pipeline_failed` with `pipeline: { id: '12345' }`, `commit: { sha: 'abc123' }` and one
failure.

- AC-1 [unit] A signed payload with the valid payload's `pipeline` key removed makes `handleCiWebhook` reject with a `ValidationAppException` whose status is 400.
- AC-2 [unit] A signed payload with the valid payload's `commit` key removed makes `handleCiWebhook` reject with a `ValidationAppException` whose status is 400.
- AC-3 [unit] A signed payload with `pipeline: null` makes `handleCiWebhook` reject with a `ValidationAppException` whose status is 400.
- AC-4 [unit] A signed payload with `pipeline: '12345'` (a string) makes `handleCiWebhook` reject with a `ValidationAppException` whose status is 400.
- AC-5 [unit] A signed payload with `commit: []` (an array) makes `handleCiWebhook` reject with a `ValidationAppException` whose status is 400.
- AC-6 [unit] For the signed payload without `pipeline`, `CiWebhookService.processCiWebhook` is never called.
- AC-7 [unit] For the signed payload without `pipeline`, the replay guard's `assertFresh` is never called.
- AC-8 [integration] `PrismaCiWebhookRepository.findProjectBySlug` on a project created with `gitRemoteUrl: 'https://github.com/acme/app'` returns `gitRemoteUrl: 'https://github.com/acme/app'`.
- AC-9 [unit] `CiWebhookService.processCiWebhook('koda', payload)` with the repository returning a project whose `gitRemoteUrl` is `https://github.com/acme/app`, and a `pipeline_failed` payload with `commit.sha` `abc123` and one failure `{ test: 'T', file: 'src/a.ts', line: 7 }`, passes `repo.createTicket` a `description` with the line `  - URL: https://github.com/acme/app/blob/abc123/src/a.ts#L7`.
- AC-10 [unit] The same call with the project's `gitRemoteUrl` `null` passes a `description` with no line that starts with `  - URL:`.
- AC-11 [unit] The same call with `gitRemoteUrl` `https://github.com/acme/app` and the failure `{ test: 'T' }` (no `file`) passes a `description` with no line that starts with `  - URL:`.
- AC-12 [integration] Through the real route in `endpoint.e2e.spec.ts`, `POST /api/projects/:slug/ci-webhook` with a correctly v1-signed body that has no `pipeline` answers status 400.

### US-002

Each AC creates RUN jobs on the existing spec's GitHub repo `acme/app` (or its GitLab repo `acme/gitlab-app` on
`https://gitlab.com`) with the stated `resultPrUrl`, on a PR number no other test in the file uses, and calls
`PrismaFleetPrRulingRepository.latestRunForPr(repoId, prNumber)`.

- AC-1 [integration] With one RUN job whose `resultPrUrl` is `https://github.com/acme/app/pull/51/`, `latestRunForPr(githubRepoId, 51)` returns that job's id.
- AC-2 [integration] With one RUN job whose `resultPrUrl` is `https://github.com/acme/app/pull/52?w=1`, `latestRunForPr(githubRepoId, 52)` returns that job's id.
- AC-3 [integration] With one RUN job whose `resultPrUrl` is `https://github.com/acme/app/pull/53#discussion_r1`, `latestRunForPr(githubRepoId, 53)` returns that job's id.
- AC-4 [integration] With one RUN job whose `resultPrUrl` is `https://gitlab.com/acme/gitlab-app/-/merge_requests/54/?tab=notes`, `latestRunForPr(gitlabRepoId, 54)` returns that job's id.
- AC-5 [integration] With an older RUN job at `https://github.com/acme/app/pull/55` and a newer one (created 1 s later) at `https://github.com/acme/app/pull/55/`, `latestRunForPr(githubRepoId, 55)` returns the newer job's id.
- AC-6 [integration] With only a RUN job at `https://github.com/acme/app/pull/560?w=1`, `latestRunForPr(githubRepoId, 56)` returns `null`.
- AC-7 [integration] With an older RUN job at `https://github.com/acme/app/pull/57` and a newer draft RUN job (created 1 s later) at `https://github.com/acme/app/pull/57/` with open item `D-1`, both built by a new URL-parametrised variant of the spec's `newJob` helper (which hardcodes `pull/42`), the spec's existing `create(newerJobId)` helper (`FleetPrRulingsService.create(principal, 'rulings', newerJobId, { itemId: 'D-1', text: 'confirm: test green' })`) resolves with a ruling instead of rejecting with `fleet.rulings.notLatest`.

### US-003

Each AC runs `koda ci-webhook trigger --event pipeline_failed --pipeline-id pipe-1 --commit-sha abc123` through
`ciWebhookCommand` with `ciWebhookControllerHandleCiWebhook` mocked, the clock fixed at `Date.now() = 1763600000000`,
and reads the options object of the mocked call. "The serialized body" is the string the call's `bodySerializer`
returns for the call's `body`.

- AC-1 [unit] With `KODA_CI_WEBHOOK_SECRET=s3cret`, the call's headers carry `x-ci-timestamp: '1763600000'`.
- AC-2 [unit] With `KODA_CI_WEBHOOK_SECRET=s3cret`, the call's `x-ci-signature-v2` header equals `'sha256='` followed by the hex HMAC-SHA256, keyed `s3cret`, of `1763600000.<the call's x-ci-delivery header>.<the serialized body>`.
- AC-3 [unit] With `KODA_CI_WEBHOOK_SECRET=s3cret`, the serialized body parsed as JSON equals the call's `body` under non-strict deep equality (`JSON.stringify` drops the absent `pipeline.url` and `commit.message`).
- AC-4 [unit] (regression guard: passes before the change) With `KODA_CI_WEBHOOK_SECRET=s3cret` and no `--signature`, the call's headers have no `x-ci-signature` value.
- AC-5 [unit] (regression guard: passes before the change) With `KODA_CI_WEBHOOK_SECRET=s3cret` and `--signature sha256=abc`, the call's headers carry `x-ci-signature: 'sha256=abc'`.
- AC-6 [unit] With `KODA_CI_WEBHOOK_SECRET=s3cret` and `--signature sha256=abc`, the call's headers carry an `x-ci-signature-v2` value.
- AC-7 [unit] (regression guard: passes before the change) With `KODA_CI_WEBHOOK_SECRET` unset and `--signature sha256=abc`, the call's headers carry `x-ci-signature: 'sha256=abc'`.
- AC-8 [unit] (regression guard: passes before the change) With `KODA_CI_WEBHOOK_SECRET` unset, the call's headers carry no `x-ci-signature-v2` value.
- AC-9 [unit] (regression guard: passes before the change) With `KODA_CI_WEBHOOK_SECRET` unset, the call's headers carry no `x-ci-timestamp` value.
- AC-10 [unit] (regression guard: passes before the change) With `KODA_CI_WEBHOOK_SECRET` set to the empty string, the call's headers carry no `x-ci-signature-v2` value.
- AC-11 [unit] (regression guard: passes before the change) Two runs with `KODA_CI_WEBHOOK_SECRET=s3cret` send two different `x-ci-delivery` values.
- AC-12 [unit] (regression guard: passes before the change) Parsing `koda ci-webhook trigger ... --secret s3cret` (with `exitOverride`) rejects with a commander error whose `code` is `commander.unknownOption`.
- AC-13 [unit] The `trigger` subcommand's description, as returned by its `description()`, names `KODA_CI_WEBHOOK_SECRET`.

### US-004

The two-host fixture is the project `web` with repos `fr1` (`acme/app`, host `https://gitlab.com`) and `fr2`
(`acme/app`, host `https://gitlab.example.com`), listed in that order by the mocked `projectFleetReposControllerList`. `fleet dispatch` declares `--max-cost` as a
required option, so every dispatch command below passes `--max-cost 1`; without it commander refuses the command before
the action runs.

- AC-1 [unit] `koda fleet dispatch --project web --repo acme/app --feature f1 --max-cost 1` with the two-host fixture exits with code 3.
- AC-2 [unit] The same command never calls `fleetJobsControllerDispatch`.
- AC-3 [unit] The same command's error output names both `https://gitlab.com` and `https://gitlab.example.com`.
- AC-4 [unit] The same command's error output names both `fr1` and `fr2`.
- AC-5 [unit] (regression guard: passes before the change) `koda fleet dispatch --project web --repo fr2 --feature f1 --max-cost 1` with the two-host fixture calls `fleetJobsControllerDispatch` with a body whose `repoId` is `fr2`.
- AC-6 [unit] `koda fleet job list --project web --repo acme/app` with the two-host fixture exits with code 3.
- AC-7 [unit] The same `job list` command never calls `fleetJobsControllerList`.
- AC-8 [unit] (regression guard: passes before the change) `resolveRepo('web', 'ACME/App')` with repos `fr1` (`acme/app`) and `fr3` (`acme/other`) on one host returns `fr1`.

### US-005

The two-host repos are `r1` (`acme/app`, host `https://gitlab.com`) and `r2` (`acme/app`, host
`https://gitlab.example.com`).

Page harness notes for AC-8 to AC-14:

- Each page or card is mounted with the permission key that renders its form: the schedule list needs `canEdit`, the
  schedule detail `canChange`, budgets `canCreate` or `canEdit` (the dialogs carry `v-if` on these).
- The schedule and budget dialogs are stubs that declare no `repoOptions` prop, so the test reads the stub's
  `repo-options` attribute.
- The schedule detail harness (`mountScheduleDetail` in `fleet-schedule-approval-gates.spec.ts`) hardcodes
  `repos: ref([])`; it gains a `repos` parameter.
- The dispatch test in `fleet-dispatch-placement-runtime.spec.ts` builds its mount inside one test, so the new test
  repeats that test's stubs (`FormField`, `TokenInput`, and the rest). It reads the `props.options` of the select whose
  `id` is `dispatch-repo`, because the page also renders the command, bash-mode and pin selects.
- The jobs list and provider-keys `SelectItem` lists also hold "all" items, so AC-13 and AC-14 read only the
  `SelectItem`s whose `value` is `r1` or `r2`.

- AC-1 [unit] `repoChoices([{ id: 'r1', owner: 'acme', name: 'app', host: 'https://github.com' }])` returns `[{ value: 'r1', label: 'acme/app' }]`.
- AC-2 [unit] `repoChoices` of the two-host repos returns the labels `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`, in input order.
- AC-3 [unit] `repoChoices` of `r1` with owner `Acme`, name `App` and `r2` as above gives both entries a host suffix.
- AC-4 [unit] `repoChoices` of the two-host repos plus `r3` (`acme/other`, host `https://gitlab.com`) labels `r3` `acme/other`.
- AC-5 [unit] `repoChoices` of the two-host repos with `r2`'s host `gitlab.internal` (not a URL) labels `r2` `acme/app (gitlab.internal)`.
- AC-6 [unit] `repoChoices` of the two-host repos with `r2`'s host `https://gitlab.example.com/gl/` labels `r2` `acme/app (gitlab.example.com/gl)`.
- AC-7 [unit] `repoChoices` of `r1` and `r2` both without `host` labels them `acme/app (r1)` and `acme/app (r2)`.
- AC-8 [unit] The dispatch page (`pages/[project]/fleet/dispatch.vue`), mounted through `fleet-dispatch-placement-runtime.spec.ts`'s harness with `useFleetDispatchOptions` returning the two-host repos, offers the repo options `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.
- AC-9 [unit] The new thread page (`pages/[project]/threads/new.vue`), mounted with `useFleetDispatchOptions` returning the two-host repos, offers the repo options `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.
- AC-10 [unit] The schedule list page (`pages/[project]/fleet/schedules/index.vue`), mounted with `useFleetDispatchOptions` returning the two-host repos, passes its schedule form the repo options `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.
- AC-11 [unit] The schedule detail page (`pages/[project]/fleet/schedules/[id].vue`), mounted through `fleet-schedule-approval-gates.spec.ts`'s detail harness with `useFleetDispatchOptions` returning the two-host repos, passes its schedule form the repo options `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.
- AC-12 [unit] The budgets page (`pages/[project]/fleet/budgets.vue`), mounted with `useFleetDispatchOptions` returning the two-host repos, passes its budget form the repo options `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.
- AC-13 [unit] The jobs list page (`pages/[project]/fleet/index.vue`), mounted through `fleet-jobs-list.spec.ts`'s harness with `useFleetDispatchOptions` returning the two-host repos, renders, for the repo filter `SelectItem`s whose `value` is `r1` or `r2`, the texts `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.
- AC-14 [unit] `SettingsProviderKeysCard`, mounted with the `/fleet/repos` read returning the two-host repos and the REPO scope chosen, renders, for the repo select `SelectItem`s whose `value` is `r1` or `r2`, the texts `acme/app (gitlab.com)` and `acme/app (gitlab.example.com)`.

### US-006

AC-1 to AC-3 and AC-5 create two `useNotifications()` instances in one test, one standing in for the bell
(`NotificationBell.vue`) and one for the inbox (`pages/notifications.vue`), sharing the existing harness's stubbed
`useState` map, with `get` answers whose resolution order the test controls. Two instances are what the bug needs: a
counter local to one instance passes a single-instance test and still lets the bell overwrite the inbox.

- AC-1 [unit] When the bell instance's `refresh()` is pending with `count: 5` and the inbox instance's `refresh()` then resolves with `count: 0`, `unreadCount` is `0` after the bell's responses resolve.
- AC-2 [unit] In the same overlap, `latest` holds the inbox refresh's records after the bell's responses resolve.
- AC-3 [unit] When the bell instance's `refresh()` is pending with `count: 5` and the inbox instance's `markAllRead()` then completes with its own refresh answering `count: 0`, `unreadCount` is `0` after the bell's responses resolve.
- AC-4 [unit] (regression guard: passes before the change) A single `refresh()` with `count: 3` sets `unreadCount` to `3`.
- AC-5 [unit] When `unreadCount` is `2`, the bell instance's `refresh()` is pending with `count: 5` and the inbox instance's `refresh()` then rejects, `unreadCount` is still `2` after the bell's responses resolve.
- AC-6 [unit] `startLogDownload(href, { probe, open })` calls `probe` before `open`.
- AC-7 [unit] `startLogDownload` calls `open` once with `href` after `probe` resolves.
- AC-8 [unit] When `probe` rejects, `startLogDownload` rejects with the same error and never calls `open`.

Logs page ACs extend the mount harness in `fleet-job-logs-page.spec.ts`. Its `useFleetJobLogs` stub's `list` becomes
one hoisted `jest.fn` the test can read and make reject once. The web Jest environment is `node`, so the test installs
a `globalThis.document` stub whose `createElement('a')` returns a recorder of `href`, the `download` attribute and
`click` calls. These ACs prove the order of the calls; the session renewal itself is `useApi`'s existing one refresh
and retry on a 401.

- AC-9 [unit] Clicking the logs page's `fleet-log-download` control calls the `list` stub once more than the page's load did.
- AC-10 [unit] After that `list` call resolves, the click handler clicks an anchor whose `href` is the page's download href and that has the `download` attribute.
- AC-11 [unit] When that `list` call rejects on the click, the logs page renders the `extractApiError` message of the rejection in `fleet-log-download-error`.
- AC-12 [unit] When that `list` call rejects on the click, the click handler clicks no download anchor.
