# SPEC: Fleet PR review and fix dispatch surfaces (S6 K3, part B2)

## Summary

The dispatch route has accepted `REVIEW` (K1-A) and `FIX` (K3-A) with a `prNumber` since PR #360 and PR #364, but no
client surface sends either: the only way to start one is a raw REST call. This feature adds the surfaces the approved
K3 design (§D7) lists. The CLI `koda fleet dispatch` gains `--review <pr>` and `--fix <pr>`. The assistant and MCP tool
`koda_dispatch_job` accepts `command` `REVIEW` or `FIX` with a `prNumber`. The web dispatch form gains `PR review` and
`PR fix` commands with a pull request number field, and a completed `REVIEW` job's page offers a `Fix` action that opens
the dispatch form prefilled with the review's repo, pull request and profiles. No API route, permission key or job
behaviour changes: every surface sends the existing `DispatchFleetJobDto` to the existing dispatch path, so the
`fleet.job.dispatch` key, the approval policy and the audit stay as they are.

## Motivation

K3-A shipped the `FIX` job kind and K3-B1 (PR #365) the follow-up review after a pushed fix, both live-checked
(§9.155, §9.156) only through `curl` against the REST route. The K3 design goal 1 says a `FIX` can be dispatched "from
REST, CLI, MCP and web (agent-first: no surface special-cased)", and §D7 notes K1 shipped `REVIEW` without a CLI flag.
Today an agent in a koda thread or over MCP cannot ask for a review or a fix (the tool's `command` enum is `RUN` and
`PLAN`), a CLI user cannot either (`--feature` is required and there is no PR flag), and a person reading a finished
review on the web has no way to act on it except by hand.

## Design

### Calls made in this spec

1. **One field, two commands, every surface.** `REVIEW` and `FIX` take a `prNumber` (an integer from 1 to 2147483647,
   the DTO's bounds) and no `feature`, `ref`, `planFrom`, `ticketRefs` or non-`raw` `bashMode`; the server derives the
   feature `review-pr-<prNumber>` and checks out the default branch (`normalizeDispatch`, unchanged), and refuses a
   non-GitHub repo (`FleetJobsService.dispatch`, reason `review is GitHub-only` / `fix is GitHub-only`). Each surface
   sends `{ repoId, command, prNumber, maxCostUsd }` plus the optional `profiles` and placement fields, and nothing else.
2. **CLI flags.** `koda fleet dispatch` gains `--review <pr>` and `--fix <pr>`, each parsed with the existing
   `parsePositiveInt` (a malformed value fails inside commander with exit 1, as `--max-cost` does today). `--feature`
   changes from a required option to an optional one. Before any request, these validation failures exit 3 through the
   command's existing `invalid()` helper, in this order:
   - `--review` and `--fix` together: `Use --review or --fix, not both`.
   - `--review` or `--fix` with any of `--feature`, `--plan`, `--ref`, `--ticket`, `--bash-mode` or
     `--approval-timeout`: `--feature, --plan, --ref, --ticket, --bash-mode and --approval-timeout are not for --review or --fix`.
   - Neither `--review` nor `--fix`, and no `--feature`: `--feature is required unless --review or --fix is given`.
   After those, the existing checks run unchanged (`bashFlagProblem`, `--label` with `--pin`, unknown repo, unknown
   runner). The narrow `DispatchRunBody` type (`feature: string`) and its "only ever sends PLAN or RUN" comment go;
   `explainConflict` takes the lookup feature as an argument. A 409 on a `REVIEW` or `FIX` dispatch looks up the active
   job with feature `review-pr-<n>` (REVIEW and FIX of one PR share that feature, so the active job may be either kind)
   and prints the existing conflict message with that feature.
3. **Assistant tool descriptor.** `koda_dispatch_job`'s descriptor `command` enum becomes
   `['RUN', 'PLAN', 'REVIEW', 'FIX']`, it gains an optional `prNumber` property (`type: 'integer'`, `minimum: 1`,
   `maximum: 2147483647`) and `required` becomes `['repo', 'command', 'maxCostUsd']`. The catalog description names
   `REVIEW` (review an open pull request) and `FIX` (review then fix an open pull request) and says they take `prNumber`
   instead of `feature`; it keeps its "only after the user approves" and "do not call this tool again" sentences and stays
   within the 2000-character cap with the workspace sentence appended. `MCP_DESCRIPTIONS.koda_dispatch_job` names the
   same three terms and keeps its run-at-once sentence and `MCP_PROJECT_SENTENCE`. Neither side validates the schema
   itself (MCP delegates validation to the executor; the runner's assign parser checks only that `inputSchema` is an
   object), so the new property and `required` list need no other change.
4. **Assistant tool behaviour.** The tool's `COMMANDS` list becomes `['RUN', 'PLAN', 'REVIEW', 'FIX']`.
   `DispatchJobInput` becomes `command: 'RUN' | 'PLAN' | 'REVIEW' | 'FIX'`, `feature?: string`, `prNumber?: number`.
   `parse` keeps every existing check and adds: for `RUN` and `PLAN` a missing `feature` refuses with reason `feature`
   (the existing rule, now conditional); a present `feature` on any command keeps its existing string bounds (reason
   `feature`); for `REVIEW` and `FIX` a missing `prNumber` refuses with reason `prNumber`; a present `prNumber` on any
   command that is not an integer from 1 to 2147483647 refuses with reason `prNumber`. Cross-field refusals (a
   `feature` on `FIX`, a `prNumber` on `RUN`, a `ref` on `REVIEW`) are left to `normalizeDispatch` in `preview`, which
   already turns its reason into a `ToolInputError`. Before that, `preview` refuses a `REVIEW` or `FIX` on a repo whose
   `provider` is not `github` with `ToolInputError` reason `review is GitHub-only` or `fix is GitHub-only` (the
   service's own wording), so the user is never asked to approve a dispatch that would be refused. `preview` for
   `REVIEW` and `FIX` answers `Dispatch <command> in <slug>:`, then `repo: <owner>/<name> @ <defaultBranch>`, then
   `pull request: #<prNumber>`, then `max cost: $<maxCostUsd>`, then one `profiles:` line when profiles are given; the
   `RUN`/`PLAN` preview is unchanged. `toDto` carries `prNumber` when present and `feature` only when present.
5. **Web PR number format.** The form's `prNumber` is text. It is accepted when, after trimming, it matches
   `^[1-9][0-9]*$` and its value is at most 2147483647; `' 23 '` is accepted, `'023'`, `'+5'`, `'1e3'`, `'0'` and `''` are
   not. Everywhere the value is used it is `Number(trimmed)`, so the body, the 409 lookup feature and the prefill agree
   with the server's `review-pr-<n>`.
6. **Web form library: schema, body, lookup feature.** `buildDispatchSchema` accepts `command` `RUN`, `PLAN`, `REVIEW`
   or `FIX` and a new optional text field `prNumber`. For `RUN` and `PLAN` every existing check applies unchanged, and an
   empty `feature` still yields `fleet.dispatch.validation.feature`. For `REVIEW` and `FIX` the schema checks `prNumber`
   (call 5; otherwise the issue `fleet.dispatch.validation.prNumber` on path `prNumber`) and does not check `feature`,
   `ref`, `planFrom`, `ticketRefs`, `bashMode` or `approvalTimeoutMinutes`: those fields are hidden for the PR commands
   and keep stale values (`keepValuesOnUnmount`), so a stale invalid value must not block the submit. `repoId`,
   `profiles`, `maxCostUsd`, `selectorLabels` and the pin keep their checks for every command. Mechanism: zod runs
   field-level checks before the object's `superRefine` regardless of `command`, so the field schemas of `feature`
   (`.regex(FEATURE_RE)` and the `..` refine), `ref` (`.max(255)`), `planFrom` (`.max(512)`) and `ticketRefs`
   (`.max(MAX_DISPATCH_TICKETS)` and the `TICKET_REF_RE` refine) become lenient (`z.string()` /
   `z.string().optional()` / `z.array(z.string())`), and each of those checks moves into `superRefine` under
   `command === 'RUN' || command === 'PLAN'`, adding the same message on the same path with `ctx.addIssue`. The
   existing `approvalTimeoutMinutes` guard already follows this pattern.
   `DISPATCH_DEFAULTS.prNumber` is `''`. `toDispatchBody` for `REVIEW`/`FIX` returns
   `{ repoId, command, prNumber: Number(trimmed prNumber), maxCostUsd }` plus `profiles` and the placement field when
   set, and never `feature`, `ref`, `planFrom`, `ticketRefs`, `bashMode`, `approvalTimeoutSec` or `acknowledgeOpenPr`.
   The `DispatchBody` type's `command` becomes the four-kind union, and it gains `prNumber?: number` with `feature`
   optional. A new `dispatchFeatureOf(values)` returns `review-pr-<Number(trimmed prNumber)>` for `REVIEW`/`FIX` and the
   trimmed `feature` otherwise.
7. **Web form library: prefill and the `Fix` helpers.** `dispatchPrefillFromQuery` accepts `command` `REVIEW` and
   `FIX`, a `prNumber` query (kept as `String(Number(trimmed))` only when it passes call 5 and the query's `command` is
   `REVIEW` or `FIX`) and a `profiles` query (one
   value or an array; each kept only when it matches `PROFILE_NAME_RE` and does not start with
   `RESERVED_PROFILE_PREFIX`, duplicates dropped, at most `MAX_PROFILES` kept). `DispatchQuery` gains
   `prNumber?: unknown` and `profiles?: unknown`. `prefillNotice` returns `'review'` when the prefill's `command` is
   `REVIEW` or `FIX`, before its existing rules, so its type is `'ticket' | 'plan' | 'review' | null`. `lib/fleet-jobs.ts` gains
   `showFixAction(job, canDispatch): boolean` (true only for a `REVIEW` job in `COMPLETED` whose feature
   `reviewPrNumber` parses to at most 2147483647, when `canDispatch`) and
   `fixDispatchQuery(job): { command: 'FIX', repoId, prNumber, profiles? } | null` (`prNumber` the decimal string,
   `profiles` a new array copied from the job's profiles when non-empty, never the job's own array; `null` when the
   feature does not parse or exceeds 2147483647).
8. **Web dispatch page.** The command select lists `RUN`, `PLAN`, `REVIEW` (label `fleet.dispatch.commandReview`) and
   `FIX` (label `fleet.dispatch.commandFix`). For `REVIEW` and `FIX` the page shows a pull request number input
   (`data-testid="dispatch-pr-number"`, label `fleet.dispatch.prNumber`, hint `fleet.dispatch.prNumberHint`) and hides
   the ref, feature, spec path and tickets fields. Hiding wraps each existing `FormField` in a `<template v-if>` and
   leaves the `FormField` tags as they are. The bash fields are already `RUN`-only. The prefill applies `prNumber` and
   `profiles` from the query. The page's `prefilled` ref widens to `'ticket' | 'plan' | 'review' | null`, and the notice
   reads `prefilled === 'review' ? t('fleet.dispatch.prefilledReview') : prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled')`.
   A 409 looks up the active job with `jobsApi.findActiveJob(formValues.repoId, dispatchFeatureOf(formValues))`; the
   ticket open-PR confirmation stays `RUN`-only.
9. **Web `Fix` action.** The job page renders a `NuxtLink` (`data-testid="fleet-job-dispatch-fix"`, text
   `fleet.jobs.actions.dispatchFix`) to `{ path: '/<slug>/fleet/dispatch', query: fixDispatchQuery(job) }` when
   `showFixAction(job, viewer.canDispatch)`, next to the existing `Dispatch run` link. The cost cap is not carried: the
   person sets it on the form.
10. **i18n.** New keys in both `en.json` and `zh.json`; the existing `used-keys-exist` spec requires every literal
    `t('...')` key to exist, and the fleet locale parity spec keeps the locales aligned. Dispatch page:
    `fleet.dispatch.commandReview`, `fleet.dispatch.commandFix`, `fleet.dispatch.prNumber`,
    `fleet.dispatch.prNumberHint`, `fleet.dispatch.prefilledReview`, `fleet.dispatch.validation.prNumber`. Job page:
    `fleet.jobs.actions.dispatchFix`.

### Integration

Symbols read unchanged:

- `normalizeDispatch(dto, defaultBranch)` (`apps/api/src/fleet/jobs/dispatch-input.ts:27`): for `REVIEW`/`FIX`
  refuses a missing `prNumber` (`prNumber required for <command>`), a `feature` (`feature is derived for <command>`),
  a `planFrom`, a `ref`, a non-`raw` `bashMode` and `ticketRefs`; for `RUN`/`PLAN` refuses a `prNumber`
  (`prNumber is only for REVIEW and FIX`).
- `FleetJobsService.dispatch` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:79`): throws `ReviewProviderException`
  (reason `review is GitHub-only` / `fix is GitHub-only`) for a non-GitHub repo.
- `KnowledgeRepoRef.provider: 'github' | 'gitlab'` (`apps/api/src/fleet/knowledge/knowledge-index.domain.ts:12`).
- `DispatchFleetJobDto.prNumber` (`apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts:13`): integer, 1 to 2147483647.
- `fleetWriteRefusal`, `maskSecrets`, `jobPath` as used by `dispatch-job-tool.ts`.
- CLI generated `DispatchFleetJobDto` (`apps/cli/src/generated/types.gen.ts:1211-1219`): `command: 'RUN' | 'PLAN' | 'REVIEW' | 'FIX'`,
  `feature?: string`, `prNumber?: number` (already regenerated; no `generate:cli` run needed).
- CLI `parsePositiveInt` (`apps/cli/src/utils/parse-positive-int.ts`), `findActiveJob(slug, repoId, feature)`
  (`apps/cli/src/commands/fleet-dispatch.ts:37`) and `invalid(message)` (`fleet-dispatch.ts:43`).
- Web `reviewPrNumber(feature)` (`apps/web/lib/fleet-jobs.ts:216`), `useFleetJobs(slug).findActiveJob(repoId, feature)`
  (`apps/web/composables/useFleetJobs.ts:81`), `PROFILE_NAME_RE`, `RESERVED_PROFILE_PREFIX`, `MAX_PROFILES`
  (`apps/web/lib/fleet-dispatch.ts`).
- Pattern to mirror for the `Fix` action: `showDispatchRun` / `dispatchRunHref` and the `fleet-job-dispatch-run` link
  (`apps/web/pages/[project]/fleet/jobs/[id]/index.vue:91-98,282`).
- Test harnesses: the job page mount `mountEnginePage` (`apps/web/tests/pages/fleet-job-detail.spec.ts:308`, module
  private, stubs `useProjectPermissions` with `projectPermissionsStub([])` at line 351); the dispatch page mount
  (`apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts:48`, stubs `TicketPicker.vue` as rendering nothing);
  the runner tool route harness (`apps/api/test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts`; decide route `POST /api/approvals/:id/decisions`, world repo `acme/app` on GitHub with default branch `trunk`).

Symbols this feature changes. Each baseline only locates the code; the target is the interface to implement.

- `KODA_DISPATCH_JOB` (`apps/api/src/fleet/assistant/koda-tool-descriptors.ts:551`). Baseline: `command` enum
  `['RUN', 'PLAN']`, `required` `['repo', 'command', 'feature', 'maxCostUsd']`, no `prNumber`. Target: call 3.
- `MCP_DESCRIPTIONS.koda_dispatch_job` (`apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts:66`). Target: call 3.
- `COMMANDS`, `DispatchJobInput`, `dispatchJobTool` (`apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts:25,38,55`).
  Baseline: `command: 'RUN' | 'PLAN'`, `feature: string` required. Target: call 4.
- `registerFleetDispatch`, `DispatchOptions`, `DispatchRunBody`, `explainConflict`
  (`apps/cli/src/commands/fleet-dispatch.ts:81,19,31,69`). Baseline: `--feature` required, body command `PLAN` or `RUN`.
  Target: call 2; `DispatchOptions` gains `review?: number` and `fix?: number`, `feature?: string`.
- `buildDispatchSchema`, `DISPATCH_DEFAULTS`, `toDispatchBody`, `dispatchPrefillFromQuery`, `DispatchQuery`,
  `prefillNotice` (`apps/web/lib/fleet-dispatch.ts`). Target: calls 5, 6 and 7.
- `DispatchBody` (`apps/web/lib/fleet-types.ts:330`). Target: call 6.

New code:

- `dispatchFeatureOf(values: DispatchFormValues): string` in `apps/web/lib/fleet-dispatch.ts`.
- `showFixAction(job: Pick<FleetJobDto, 'command' | 'state' | 'feature'>, canDispatch: boolean): boolean` and
  `fixDispatchQuery(job: Pick<FleetJobDto, 'repoId' | 'feature' | 'profiles'>): { command: 'FIX'; repoId: string; prNumber: string; profiles?: string[] } | null`
  in `apps/web/lib/fleet-jobs.ts`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| CLI: `--review` and `--fix` together | exit 3, `Use --review or --fix, not both`, no request |
| CLI: `--review`/`--fix` with a RUN/PLAN-only flag | exit 3, the not-for message, no request |
| CLI: no PR flag and no `--feature` | exit 3, `--feature is required unless --review or --fix is given`, no request |
| CLI: `--review 0` or `--fix abc` | commander rejects through `parsePositiveInt` before any request |
| CLI: 409 on a REVIEW/FIX dispatch | names the active job found by feature `review-pr-<n>`, exit 1 |
| Tool: REVIEW/FIX without a valid `prNumber` | `ToolInputError` reason `prNumber` |
| Tool: RUN/PLAN without `feature` | `ToolInputError` reason `feature` |
| Tool: REVIEW/FIX on a non-GitHub repo | `preview` raises `ToolInputError` reason `review is GitHub-only` / `fix is GitHub-only`; no action stored |
| Tool: cross-field refusal (feature on FIX, prNumber on RUN, ref on REVIEW) | `preview` raises `ToolInputError` with `normalizeDispatch`'s reason |
| Web: REVIEW/FIX with an empty or malformed PR number | issue `fleet.dispatch.validation.prNumber`, no request |
| Web: 409 on a REVIEW/FIX dispatch | looks up `review-pr-<n>` and links the active job |

## Out of Scope

- Any API route, DTO, permission key, approval policy or audit change: the dispatch route already accepts `REVIEW` and `FIX`.
- A CLI flag or web field for the cost cap of a `Fix` action prefilled from a review: the person or agent sets `maxCostUsd` on every dispatch.
- Carrying the review job's placement (labels, pinned runner) into the prefilled `Fix` dispatch: only repo, pull request and profiles are prefilled.
- A `Review` action on a `FIX` job page, or a `Fix` action on a `REVIEW` job that is not `COMPLETED`: a follow-up review already runs after a pushed fix (K3-B1).
- Hiding the web `Fix` action or the PR commands for a non-GitHub repo: the API refuses the dispatch with 422 and the form shows the API message.
- Choosing the pull request from a list of open pull requests on the web form or the CLI: the number is typed.
- Checking on the client that the pull request is open, belongs to the repo or is not from a fork: the runner's nax refuses those and the job fails with nax's reason.
- CLI: rejecting `--review`/`--fix` values above 2147483647 on the client: `parsePositiveInt` accepts them and the API answers 400, which the CLI reports as an API error (exit 1).
- CLI: exit code 3 for a malformed `--review`/`--fix` value: commander's option parser exits 1, as it already does for `--max-cost`.
- CLI `koda fleet job show` and `job list` display of `fixOutcome`: the job page already shows it (K3-A); the CLI prints the API's fields as they are.
- Regenerating the CLI client: the generated types already carry `REVIEW`, `FIX` and `prNumber`.
- Updating the CLI examples in `docs/deployment/runner.md`.
- The assistant tool's `RUN`/`PLAN` behaviour, preview lines and refusal reasons: unchanged.
- Clearing the hidden RUN/PLAN form fields when the command changes: they keep their values and are simply not checked or sent for `REVIEW`/`FIX`.

## Stories

### US-001: Assistant tool descriptor and descriptions for REVIEW and FIX

No dependencies. Workdir: apps/api. The `koda_dispatch_job` descriptor's `command` enum, `prNumber` property and
`required` list, and both descriptions (call 3).

### US-002: Assistant tool parses REVIEW and FIX input

Depends on US-001. Workdir: apps/api. `COMMANDS`, `DispatchJobInput` and `parse` per call 4.

### US-003: Assistant tool previews and dispatches REVIEW and FIX

Depends on US-002. Workdir: apps/api. The GitHub-only preview refusal, the REVIEW/FIX preview text and the service DTO
(call 4), plus an integration test through the real runner tool route and the approval decide route
`POST /api/approvals/:id/decisions`, in a new file that copies the harness of
`assistant-dispatch-job-tool.integration.spec.ts` (copy the helpers it uses). The test uses pull request number 7023,
so its feature `review-pr-7023` is used by no other spec (`.nax/rules/api-test-isolation.md`).

### US-004: CLI `--review` and `--fix` dispatch

No dependencies. Workdir: apps/cli. `koda fleet dispatch` gains `--review <pr>` and `--fix <pr>`, makes `--feature`
optional, sends the REVIEW/FIX body and looks up a 409's active job by `review-pr-<n>` (call 2, body and conflict).

### US-005: CLI `--review` and `--fix` validation

Depends on US-004. Workdir: apps/cli. The three exit-3 validation failures of call 2, before any request.

### US-006: Web dispatch schema and body for REVIEW and FIX

No dependencies. Workdir: apps/web. The form schema (with the lenient-field mechanism of call 6), defaults, request body
and wire type (calls 5 and 6).

### US-007: Web prefill, notice and lookup feature

Depends on US-006. Workdir: apps/web. `dispatchPrefillFromQuery`, `prefillNotice` (call 7) and `dispatchFeatureOf`
(call 6).

### US-008: Web `Fix` helpers

No dependencies. Workdir: apps/web. `showFixAction` and `fixDispatchQuery` in `lib/fleet-jobs.ts` (call 7).

### US-009: Web dispatch page renders REVIEW and FIX

Depends on US-006, US-007. Workdir: apps/web. The dispatch page's command options, PR number field, hidden RUN/PLAN
fields, prefill and review notice (call 8) and its six locale keys (call 10). Its tests live in a new file that copies
the dispatch page mount from `fleet-dispatch-placement-runtime.spec.ts` together with the helpers it uses (the
`useField` and `FormField` doubles), with these changes: `TicketPicker.vue` is stubbed by a component that renders an
element carrying `data-testid` equal to its `testId` prop; the `FleetTokenListInput` stub declares a `modelValue` prop
as well as `testId`, so the profile chain can be read from it; `fleetComponents: ['FleetNativeSelect']` is passed so
the command select renders its options (`uiStubs` is not spread into `components`, because a duplicate registration is
ignored); and `useRoute` returns `{ params: { project: 'koda' }, query: <the test's query> }`.

### US-010: Web dispatch page submits REVIEW and FIX

Depends on US-009. Workdir: apps/web. The submit, the empty-PR-number block and the `dispatchFeatureOf` 409 lookup and
conflict link (call 8). Its tests reuse the US-009 test file's mount, adding `alias: { '~/composables/useApi': apiModule }`
(with `import * as apiModule from '../../composables/useApi'`), as `fleet-job-detail.spec.ts` does, so the `ApiError`
the test throws is the class the page checks with `instanceof`, and registering a `NuxtLink` stub that exposes its `to`
prop so `dispatch-conflict-link` resolves.

### US-011: Web `Fix` action on a completed REVIEW job

Depends on US-008. Workdir: apps/web. The job page `Fix` link of call 9 and its locale key (call 10). Its tests live in
a new file that copies `mountEnginePage` from `fleet-job-detail.spec.ts` together with the helpers it uses
(`jobFixture`, the `useApi` module alias and the request doubles), with `useProjectPermissions` returning
`projectPermissionsStub(['fleet.job.dispatch'])` (or `[]` for the negative case), and reads the link's `to` prop from
the `NuxtLink` stub that `uiStubs` provides.

### Context Files

**US-001**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_DISPATCH_JOB` and its bounds constants.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — AC-8, AC-9 and the bounds test being updated.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — the MCP description map.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.spec.ts` — how MCP descriptions are read in tests.

**US-002**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts` — the parser being extended.
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.spec.ts` — harness, `VALID` fixture and `reasonOf` to reuse.

**US-003**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts` — changed by US-002; preview and DTO extended here.
- `apps/api/src/fleet/jobs/dispatch-input.ts` — `normalizeDispatch`'s REVIEW/FIX rules and reasons.
- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `ReviewProviderException` wording.
- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.spec.ts` — preview and execute harness to reuse.
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts` — the runner tool route harness to copy.

**US-004**

- `apps/cli/src/commands/fleet-dispatch.ts` — the command being extended.
- `apps/cli/src/commands/fleet-dispatch.spec.ts` — harness and mocks to reuse.
- `apps/cli/src/commands/fleet-shared.ts` — `handleFleetConflict`.
- `apps/cli/src/utils/parse-positive-int.ts` — the option parser.

**US-005**

- `apps/cli/src/commands/fleet-dispatch.ts` — changed by US-004, extended here.
- `apps/cli/src/commands/fleet-dispatch-pr.spec.ts` — created by US-004; harness reused.
- `apps/cli/src/commands/fleet-shared.ts` — `bashFlagProblem`, `handleFleetValidation`.

**US-006**

- `apps/web/lib/fleet-dispatch.ts` — schema and body.
- `apps/web/lib/fleet-types.ts` — `DispatchBody`.
- `apps/web/lib/fleet-bash-mode.ts` — `bashCreateFields`, `isBashTimeoutValid`.
- `apps/web/tests/lib/fleet-dispatch.spec.ts` — the `valid()` and `messages()` helpers to reuse.

**US-007**

- `apps/web/lib/fleet-dispatch.ts` — prefill and notice, changed by US-006.
- `apps/web/lib/fleet-ticket-links.ts` — `ticketRefsFromQuery`, the array-query pattern.
- `apps/web/tests/lib/fleet-dispatch.spec.ts` — the `valid()` helper to reuse.

**US-008**

- `apps/web/lib/fleet-jobs.ts` — `reviewPrNumber`, home of the two new helpers.
- `apps/web/lib/fleet-types.ts` — `FleetJobDto`.

**US-009**

- `apps/web/pages/[project]/fleet/dispatch.vue` — the form page.
- `apps/web/tests/pages/fleet-dispatch-placement-runtime.spec.ts` — the dispatch page mount and doubles to copy.
- `apps/web/tests/pages/fleet-dispatch-page.spec.ts` — source-text assertions being updated.
- `apps/web/tests/helpers/mount-sfc.ts` — `mountSfc` and its `fleetComponents` option.

**US-010**

- `apps/web/pages/[project]/fleet/dispatch.vue` — changed by US-009; submit and 409 extended here.
- `apps/web/tests/pages/fleet-dispatch-pr-page.spec.ts` — created by US-009; mount reused.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — the `useApi` module alias pattern.

**US-011**

- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the job page and its `Dispatch run` link.
- `apps/web/tests/pages/fleet-job-detail.spec.ts` — `mountEnginePage` and its helpers to copy.
- `apps/web/tests/helpers/permission-nav.ts` — `projectPermissionsStub`.
- `apps/web/tests/helpers/fleet-harness.ts` — `uiStubs` (renders `NuxtLink` as a stub with a `to` prop).

### Creates

**US-001**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.pr.spec.ts`

**US-002**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.pr-parse.spec.ts`

**US-003**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.pr.spec.ts`
- `apps/api/test/integration/fleet/assistant-dispatch-job-tool-pr.integration.spec.ts`

**US-004**

- `apps/cli/src/commands/fleet-dispatch-pr.spec.ts`

**US-005**

- `apps/cli/src/commands/fleet-dispatch-pr-validation.spec.ts`

**US-006**

- `apps/web/tests/lib/fleet-dispatch-pr.spec.ts`

**US-007**

- `apps/web/tests/lib/fleet-dispatch-pr-prefill.spec.ts`

**US-008**

- `apps/web/tests/lib/fleet-jobs-fix-action.spec.ts`

**US-009**

- `apps/web/tests/pages/fleet-dispatch-pr-page.spec.ts`

**US-010**

- `apps/web/tests/pages/fleet-dispatch-pr-submit.spec.ts`

**US-011**

- `apps/web/tests/pages/fleet-job-fix-action.spec.ts`

### Modifies

**US-001**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_DISPATCH_JOB` command enum gains `REVIEW` and `FIX`, gains the `prNumber` integer property, `required` drops `feature`, and its description names REVIEW, FIX and `prNumber` while keeping its approval and do-not-call-again sentences.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — AC-8 (`required` equals `['repo', 'command', 'feature', 'maxCostUsd']`) becomes `['repo', 'command', 'maxCostUsd']`, and AC-9 (`command` enum equals `['RUN', 'PLAN']`) becomes `['RUN', 'PLAN', 'REVIEW', 'FIX']`; the bounds test gains `prNumber` as `{ type: 'integer', minimum: 1, maximum: 2147483647 }`. Every other assertion stays.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `MCP_DESCRIPTIONS.koda_dispatch_job` names REVIEW, FIX and `prNumber`; it keeps the run-at-once sentence and `MCP_PROJECT_SENTENCE`.

**US-002**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts` — `COMMANDS` and `DispatchJobInput` gain `REVIEW`/`FIX` and `prNumber`, `feature` becomes optional, and `parse` gains the rules of call 4; the RUN/PLAN parse results are unchanged, so every assertion in the existing tool spec keeps holding.

**US-003**

- `apps/api/src/fleet/assistant/tools/dispatch-job-tool.ts` — `preview` gains the GitHub-only refusal and the REVIEW/FIX lines, and `toDto` carries `prNumber`, per call 4; the RUN/PLAN preview and DTO are unchanged, so every assertion in the existing tool spec keeps holding.

**US-004**

- `apps/cli/src/commands/fleet-dispatch.ts` — `--review` and `--fix` options, `--feature` optional, the REVIEW/FIX body, `DispatchRunBody` removed, and `explainConflict` taking the lookup feature, per call 2; the RUN/PLAN body is unchanged, so every assertion in the existing dispatch command spec keeps holding.

**US-005**

None. US-005 extends `fleet-dispatch.ts`, already changed by US-004 in this branch, and adds a new test file; no pre-existing assertion breaks.

**US-006**

- `apps/web/lib/fleet-dispatch.ts` — schema (lenient field schemas with the RUN/PLAN checks moved into `superRefine`), defaults and body per calls 5 and 6. The RUN/PLAN results are unchanged, so the existing dispatch library spec's assertions keep holding (an empty `feature` on a RUN still yields `fleet.dispatch.validation.feature`).
- `apps/web/lib/fleet-types.ts` — `DispatchBody.command` becomes `'RUN' | 'PLAN' | 'REVIEW' | 'FIX'`, `feature` becomes optional and `prNumber?: number` is added.

**US-007**

- `apps/web/lib/fleet-dispatch.ts` — `DispatchQuery`, `dispatchPrefillFromQuery`, `prefillNotice` and the new `dispatchFeatureOf` per calls 6 and 7; the existing prefill assertions keep holding because a query without `prNumber` or `profiles` yields the same result as today.

**US-008**

- `apps/web/lib/fleet-jobs.ts` — adds `showFixAction` and `fixDispatchQuery`.

**US-009**

- `apps/web/pages/[project]/fleet/dispatch.vue` — REVIEW/FIX command options, the PR number field, the `<template v-if>` wrappers that hide the RUN/PLAN fields, the prNumber/profiles prefill, and the widened `prefilled` ref and review notice, per call 8.
- `apps/web/tests/pages/fleet-dispatch-page.spec.ts` — the C9 tickets test's expected notice text `prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled')` becomes `prefilled === 'review' ? t('fleet.dispatch.prefilledReview') : prefilled === 'ticket' ? t('fleet.dispatch.prefilledTicket') : t('fleet.dispatch.prefilled')`. The tickets `FormField` regex keeps holding because the field is wrapped, not edited. Every other assertion stays.
- `apps/web/i18n/locales/en.json` — the six dispatch keys of call 10.
- `apps/web/i18n/locales/zh.json` — the same six dispatch keys in Chinese.

**US-010**

- `apps/web/pages/[project]/fleet/dispatch.vue` — the 409 lookup uses `dispatchFeatureOf(formValues)` per call 8.
- `apps/web/tests/pages/fleet-dispatch-page.spec.ts` — the 409 test's expected source text `jobsApi.findActiveJob(formValues.repoId, formValues.feature.trim())` becomes `jobsApi.findActiveJob(formValues.repoId, dispatchFeatureOf(formValues))`; the test still asserts the 409 branch, the conflict link and the toast.

**US-011**

- `apps/web/pages/[project]/fleet/jobs/[id]/index.vue` — the `Fix` link beside `Dispatch run`, shown by `showFixAction` and pointing at `fixDispatchQuery` per call 9.
- `apps/web/i18n/locales/en.json` — the key `fleet.jobs.actions.dispatchFix`.
- `apps/web/i18n/locales/zh.json` — the key `fleet.jobs.actions.dispatchFix` in Chinese.

### Seams

- The descriptor (US-001) and parser (US-002) are consumed by the tool route: US-003's integration ACs post a `FIX` call to the real runner tool route `POST /api/fleet/runner/jobs/:jobId/tools/koda_dispatch_job` and approve it through `POST /api/approvals/:id/decisions`, ending at the created job row.
- `dispatchFeatureOf` and `prefillNotice`'s `'review'` (US-007) are consumed by the dispatch page (US-009, US-010); their ACs mount the page and assert the rendered notice and the 409 lookup argument.
- `showFixAction` and `fixDispatchQuery` (US-008) are consumed by the job page (US-011); its ACs mount the page and assert the rendered link and its `to`.
- The CLI (US-004) ends at `fleetJobsControllerDispatch`; its ACs assert the exact body.

## Acceptance Criteria

### US-001: Assistant tool descriptor and descriptions for REVIEW and FIX

- `[unit]` `KODA_DISPATCH_JOB.inputSchema` property `command` has `enum` `['RUN', 'PLAN', 'REVIEW', 'FIX']`.
- `[unit]` `KODA_DISPATCH_JOB.inputSchema` property `prNumber` matches `{ type: 'integer', minimum: 1, maximum: 2147483647 }`.
- `[unit]` `KODA_DISPATCH_JOB.inputSchema.required` equals `['repo', 'command', 'maxCostUsd']`.
- `[unit]` `KODA_DISPATCH_JOB.description` mentions each of `REVIEW`, `FIX` and `prNumber`.
- `[unit]` the description `kodaToolDescriptorsFor('WORKSPACE')` gives `koda_dispatch_job` is at most 2000 characters long.
- `[unit]` the MCP tool catalog's description of `koda_dispatch_job` mentions each of `REVIEW`, `FIX` and `prNumber`.
- `[unit]` the MCP tool catalog's description of `koda_dispatch_job` ends with the MCP project sentence naming the `project` argument.

### US-002: Assistant tool parses REVIEW and FIX input

- `[unit]` `parse({ repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1 })` returns `{ repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1 }`.
- `[unit]` table-driven: `parse` with `command` `REVIEW` and `prNumber` absent, `0`, `1.5`, `'23'` or `2147483648` throws `ToolInputError` with reason `prNumber`.
- `[unit]` `parse` with `command` `RUN`, a valid `feature` and `prNumber` `0` throws `ToolInputError` with reason `prNumber`.
- `[unit]` `parse` with `command` `PLAN` and no `feature` throws `ToolInputError` with reason `feature`.
- `[unit]` `parse` with `command` `FIX`, `prNumber` `23` and a `feature` of 129 characters throws `ToolInputError` with reason `feature`.

### US-003: Assistant tool previews and dispatches REVIEW and FIX

- `[unit]` `preview` for `{ repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] }` in project `web` with the repo's default branch `main` returns the lines `Dispatch FIX in web:`, `repo: acme/app @ main`, `pull request: #23`, `max cost: $1`, `profiles: native-codex`, in that order and nothing else.
- `[unit]` table-driven: `preview` on a resolved repo with `provider` `'gitlab'` throws `ToolInputError` with reason `fix is GitHub-only` for a `FIX` and `review is GitHub-only` for a `REVIEW`.
- `[unit]` `preview` for `{ repo: 'acme/app', command: 'REVIEW', prNumber: 23, feature: 'x', maxCostUsd: 1 }` throws `ToolInputError` with reason `feature is derived for REVIEW`.
- `[unit]` `preview` for `{ repo: 'acme/app', command: 'REVIEW', prNumber: 23, ref: 'dev', maxCostUsd: 1 }` throws `ToolInputError` with reason `ref is the default branch for REVIEW`.
- `[unit]` `preview` for `{ repo: 'acme/app', command: 'RUN', feature: 'login', prNumber: 23, maxCostUsd: 1 }` throws `ToolInputError` with reason `prNumber is only for REVIEW and FIX`.
- `[unit]` `execute` for `{ repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] }` calls `FleetJobsService.dispatch` with a DTO deep-equal to `{ repoId: <resolved repo id>, command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] }`.
- `[integration]` on the real test database, a `koda_dispatch_job` call `{ repo: 'acme/app', command: 'FIX', prNumber: 7023, maxCostUsd: 1 }` posted to `POST /api/fleet/runner/jobs/:jobId/tools/koda_dispatch_job?leaseEpoch=1` by the runner holding the thread job stores an action whose preview's third line is `pull request: #7023`.
- `[integration]` after that call and before any decision, no `FleetJob` with feature `review-pr-7023` exists.
- `[integration]` after the developer approves that action through `POST /api/approvals/:id/decisions`, exactly one `FleetJob` with feature `review-pr-7023` exists.
- `[integration]` that job's `command` is `FIX` and its `requestedById` is the developer's id.

### US-004: CLI `--review` and `--fix` dispatch

- `[cli]` `koda fleet dispatch --repo acme/app --fix 23 --max-cost 1 --profile native-codex` calls `fleetJobsControllerDispatch` with `body` deep-equal to `{ repoId: 'fr1', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] }`.
- `[cli]` `koda fleet dispatch --repo acme/app --review 23 --max-cost 1` calls `fleetJobsControllerDispatch` with `body` deep-equal to `{ repoId: 'fr1', command: 'REVIEW', prNumber: 23, maxCostUsd: 1 }`.
- `[cli]` `koda fleet dispatch --repo acme/app --fix 23 --max-cost 1 --pin box-1` sends a body whose `pinnedRunnerId` is `'r1'`.
- `[cli]` `koda fleet dispatch --repo acme/app --feature login --max-cost 1` sends a body deep-equal to `{ repoId: 'fr1', command: 'RUN', feature: 'login', maxCostUsd: 1 }`.
- `[cli]` `koda fleet dispatch --repo acme/app --fix 0 --max-cost 1` rejects with a commander error whose code is `commander.invalidArgument` (the test program uses `exitOverride`) and makes no `fleetJobsControllerDispatch` call.
- `[cli]` a 409 from a `--fix 23` dispatch calls `fleetJobsControllerList` with a `query` containing `repoId: 'fr1'` and `feature: 'review-pr-23'`.
- `[cli]` when that lookup finds an active job `j9` in state `RUNNING`, stderr contains `An active job already runs review-pr-23 on this repo: j9 (RUNNING)`.

### US-005: CLI `--review` and `--fix` validation

- `[cli]` `koda fleet dispatch --repo acme/app --review 23 --fix 23 --max-cost 1` exits 3.
- `[cli]` that run writes `Use --review or --fix, not both` to stderr and makes no `fleetJobsControllerDispatch` call.
- `[cli]` `--fix 23 --feature login` (with `--repo acme/app --max-cost 1`) exits 3.
- `[cli]` table-driven: `--fix 23` with each of `--feature login`, `--ref dev` and `--bash-mode gated` writes `are not for --review or --fix` to stderr and makes no dispatch call.
- `[cli]` `koda fleet dispatch --repo acme/app --max-cost 1` with neither `--feature` nor a PR flag exits 3.
- `[cli]` that run writes `--feature is required unless --review or --fix is given` to stderr and makes no dispatch call.

### US-006: Web dispatch schema and body for REVIEW and FIX

- `[unit]` `buildDispatchSchema` accepts `{ ...DISPATCH_DEFAULTS, repoId: 'r1', command: 'FIX', feature: '', prNumber: '23' }` with no issues.
- `[unit]` `buildDispatchSchema` accepts `prNumber` `' 23 '` for `command` `REVIEW`.
- `[unit]` table-driven: with `command` `REVIEW`, a `prNumber` of `''`, `'0'`, `'023'`, `'1e3'` or `'2147483648'` yields the issue message `fleet.dispatch.validation.prNumber`.
- `[unit]` with `command` `FIX`, `prNumber` `'23'`, `feature` `'a/b'`, `ref` of 300 characters and `ticketRefs` `['bad']`, the schema yields no issues.
- `[unit]` with `command` `RUN` and `feature` `''` the schema still yields the issue message `fleet.dispatch.validation.feature`.
- `[unit]` with `command` `RUN` and `ref` of 300 characters the schema still yields the issue message `fleet.dispatch.validation.ref`.
- `[unit]` `DISPATCH_DEFAULTS.prNumber` equals `''`.
- `[unit]` `toDispatchBody` for `command` `FIX`, `prNumber` `' 23 '`, `feature` `'login'`, `ref` `'dev'`, `ticketRefs` `['KD-1']`, `bashMode` `'escalate'`, `profiles` `['fast']` and `maxCostUsd` `1` returns exactly `{ repoId: 'r1', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['fast'] }`.
- `[unit]` `toDispatchBody` for `command` `REVIEW` with the option `{ acknowledgeOpenPr: true }` returns a body with no `acknowledgeOpenPr` key.

### US-007: Web prefill, notice and lookup feature

- `[unit]` `dispatchPrefillFromQuery({ command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex', 'fast'] })` returns `{ command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex', 'fast'] }`.
- `[unit]` table-driven: `dispatchPrefillFromQuery` with `command` `FIX` returns an object with no `prNumber` key for a `prNumber` of `'0'`, `'023'`, `'2.5'` or `'2147483648'`.
- `[unit]` `dispatchPrefillFromQuery({ command: 'RUN', prNumber: '23' })` returns an object with no `prNumber` key.
- `[unit]` `dispatchPrefillFromQuery({ profiles: ['bad name', 'koda-job-1', 'fast', 'fast'] })` returns `{ profiles: ['fast'] }`.
- `[unit]` `dispatchPrefillFromQuery({ profiles: 'fast' })` returns `{ profiles: ['fast'] }`.
- `[unit]` `prefillNotice({ command: 'FIX', repoId: 'r1', prNumber: '23' })` returns `'review'`.
- `[unit]` `prefillNotice({ command: 'FIX', repoId: 'r1' })` returns `'review'`.
- `[unit]` `dispatchFeatureOf` returns `'review-pr-23'` for `command` `FIX` with `prNumber` `' 23 '`.
- `[unit]` `dispatchFeatureOf` returns `'login'` for `command` `RUN` with `feature` `' login '`.

### US-008: Web `Fix` helpers

- `[unit]` `showFixAction({ command: 'REVIEW', state: 'COMPLETED', feature: 'review-pr-23' }, true)` returns true.
- `[unit]` table-driven: `showFixAction` returns false for that job with `canDispatch` false, with state `FAILED`, with command `FIX`, with feature `login` and with feature `review-pr-2147483648`.
- `[unit]` `fixDispatchQuery({ repoId: 'r1', feature: 'review-pr-23', profiles: ['native-codex'] })` returns `{ command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex'] }`.
- `[unit]` the `profiles` array `fixDispatchQuery` returns is not the same array object as the job's `profiles`.
- `[unit]` `fixDispatchQuery({ repoId: 'r1', feature: 'review-pr-23', profiles: [] })` returns `{ command: 'FIX', repoId: 'r1', prNumber: '23' }`.
- `[unit]` `fixDispatchQuery` returns null for feature `login`.

### US-009: Web dispatch page renders REVIEW and FIX

- `[unit]` the mounted dispatch page's command select offers the option values `RUN`, `PLAN`, `REVIEW` and `FIX`.
- `[unit]` with command `FIX` selected, the mounted dispatch page renders an element with `data-testid="dispatch-pr-number"`.
- `[unit]` table-driven: with command `FIX` selected, the mounted dispatch page renders no element with `data-testid` `dispatch-feature`, `dispatch-ref`, `dispatch-plan-from` or `dispatch-tickets`.
- `[unit]` with command `RUN` selected, the mounted dispatch page renders `dispatch-feature` and `dispatch-tickets`.
- `[unit]` with command `RUN` selected, the mounted dispatch page renders no `dispatch-pr-number`.
- `[unit]` the dispatch page mounted with route query `{ command: 'FIX', repoId: <a listed repo id>, prNumber: '23', profiles: 'native-codex' }` sets the `prNumber` field to `'23'`.
- `[unit]` that mount passes `['native-codex']` as the profile chain stub's `modelValue`.
- `[unit]` that mount renders `data-testid="dispatch-prefilled"` with the text of `fleet.dispatch.prefilledReview`.

### US-010: Web dispatch page submits REVIEW and FIX

- `[unit]` submitting the mounted dispatch page with command `FIX`, a repo and PR number `23` calls `useFleetJobs(slug).dispatch` with a body whose `command` is `'FIX'` and `prNumber` is `23`.
- `[unit]` submitting the mounted dispatch page with command `FIX`, a repo and an empty PR number makes no `dispatch` call.
- `[unit]` when the `FIX` dispatch rejects with an `ApiError` of code 409, the page calls `findActiveJob` with the repo id and `'review-pr-23'`.
- `[unit]` when that lookup resolves an active job `j9`, the page renders `data-testid="dispatch-conflict-link"` whose `to` is `/<slug>/fleet/jobs/j9`.

### US-011: Web `Fix` action on a completed REVIEW job

- `[unit]` the job page mounted with a `COMPLETED` `REVIEW` job (feature `review-pr-23`, repo `r1`, profiles `['native-codex']`) and a viewer holding `fleet.job.dispatch` renders `data-testid="fleet-job-dispatch-fix"`.
- `[unit]` that link's `to` is `{ path: '/<slug>/fleet/dispatch', query: { command: 'FIX', repoId: 'r1', prNumber: '23', profiles: ['native-codex'] } }`.
- `[unit]` that link's text is the English value of `fleet.jobs.actions.dispatchFix`.
- `[unit]` the job page mounted with the same job and a viewer without `fleet.job.dispatch` renders no `fleet-job-dispatch-fix`.
- `[unit]` the job page mounted with a `FAILED` `REVIEW` job and a viewer holding `fleet.job.dispatch` renders no `fleet-job-dispatch-fix`.
