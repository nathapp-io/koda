# API integration test performance investigation

Revision: `1c345e0b`. Local macOS arm64, Bun 1.4.4, Vitest 4.1.12, compose Postgres on port 5433. Existing serial DB projects and shared module imports retained. These are local exploratory measurements, not matched CI benchmarks.

Latest verified result after the follow-ups below: exact `bun run test:integration` **passes in 11 min 17.87 s**, with **579 passed / 1 skipped files** and **6330 passed / 20 skipped tests**, no heap crash. Extending member fixtures to 13 further suites reduced the measured three-suite cohort's median command time by 32.6%; the latest full run was slower than the earlier 10 min 13.06 s run, so a full-tier speedup is not established. The original three HTTP failures remain resolved. The complete shuffled API unit suite also passes (864 files / 11,515 tests). Earlier sections retain the investigation's intermediate results and limitations.

## Baseline

A clean scoped disabled-user run passed 5 tests in 9.09 s (imports 6.43 s, tests/hooks 0.652 s). The full `bun run test:integration` run was deliberately interrupted after 1293.40 s (21m33s); it is NOT a complete suite measurement. The final report listed 270 passed files, 3 failed files, 3497 passed tests and 3 failed tests, plus an interruption error. Reported test/hook time was 1262.96 s, imports 19.41 s and transforms 9.18 s. These runner timing categories must not be added as an exclusive wall-time partition.

Failures observed before interruption:
- `audit/audit-core-transitions.integration.spec.ts`: AC-1,2 CREATED via verify records the exact edge.
- `fleet/assistant-get-memory-tool.integration.spec.ts`: AC-17 missing/foreign/deleted memory item.
- `fleet/placement-queued-scan.integration.spec.ts`: leaves a job past the page cap QUEUED for the next sync (timeout).

The worker RSS rose from about 1.4 GB to 3.8 GB. This is not proof of a leak. A two-second native process sample showed substantial bcrypt activity. `seedFleetHttpWorld` still registers the root user via the real HTTP endpoint; secondary users already reuse a fixture hash. Registration remains unchanged.

## Phase measurements

Temporary worker-local timers around `bootHttpApp` and `resetDb` were used for the auth group. All 4 files / 28 tests passed in 13.01 s, with tests/hooks totaling 6.21 s. Example boot spans were 196, 439 and 452 ms; reset spans were mostly 37–62 ms. These are inclusive helper spans, not a full decomposition of fixture/request/body time. Temporary probes were removed.

## Database reset experiment

Compared the current client-side table discovery plus TRUNCATE against one PostgreSQL DO block that discovers and safely quotes the same tables and executes TRUNCATE with RESTART IDENTITY CASCADE. Both create and disconnect the Prisma client per reset. No table-list cache or weaker cleanup was introduced.

Three alternating rounds, 20 resets per measurement, milliseconds for each batch:

| Round | Current | One statement |
|---|---:|---:|
| 1 | 951.80 | 727.24 |
| 2 | 695.74 | 752.69 |
| 3 | 679.59 | 658.78 |

No consistent win. Reject adoption; the effect is small and within the observed variation. This benchmark uses an empty schema after the first reset and does not establish populated-fixture or CI performance.

## App reuse experiment

A throwaway helper retained an app for exactly two compatible suites (`disabled-user` and `actor-principal-loader`), reset throttle counters before reuse, and actually closed it on the second release. Assertions were unchanged. All six runs passed the same 2 files / 11 tests. This limited probe does not prove general cross-suite isolation.

| Run order | Mode | Complete command (s) | Tests/hooks (s) |
|---|---|---:|---:|
| 1 | fresh | 10.49 | 1.83 |
| 2 | reuse | 5.40 | 0.904 |
| 3 | reuse | 10.37 | 1.15 |
| 4 | fresh | 7.37 | 1.20 |
| 5 | fresh | 7.67 | 1.39 |
| 6 | reuse | 9.77 | 2.07 |

No reliable end-to-end improvement. Import variance dominates the comparison. Reject general reuse for now: permission/auth caches, throttles, event subscriptions, background tasks, temporary LanceDB directories and boot-time environment differ across suites. A safe retained implementation would need explicit lifecycle ownership and state-reset contracts, plus shuffled and full-tier verification. Probe removed; no test behavior changed.

## Practical outcome

Use `bun run test:scoped test/integration/<feature>` from `apps/api` for development. Keep the complete tier for broader verification. Do not append a narrow filter to the existing broad `test:integration` script and assume it narrows selection.

Neither requested optimization is adopted based on these measurements. Next evidence-driven experiments are redundant root-user registration in fleet fixtures (preserving real login and dedicated registration coverage), and bounded worker batches to test whether long-worker growth affects runtime. Neither was implemented in this investigation.

Raw local evidence: `/private/tmp/koda-integration-baseline.log`, `/private/tmp/koda-auth-profile.log`, `/private/tmp/koda-reuse-comparison.log`, `/private/tmp/koda-worker-sample.txt`. These temporary files are not portable repository artifacts.

## Follow-up: remove root registration from fleet setup

`seedFleetHttpWorld` now inserts root with `TEST_PASSWORD_HASH`, grants the existing `member` baseline and the first registrant's global `owner` binding, then authenticates through real login. The three secondary users are unchanged. Fixture setup consumes four of five allowed logins; callers with extra logins are included in targeted verification. Production hashing and dedicated registration tests are unchanged.

The fixture regression test first failed on the original cost-12 hash, then passed with the shared hash, exact member/owner bindings and a working root login token.

Three alternating control/candidate pairs each executed ten fresh reset/boot/seed/close cycles with unchanged assertions. Full command times:

| Pair | Original (s) | Candidate (s) |
|---|---:|---:|
| 1 | 11.00 | 7.49 |
| 2 (candidate first) | 10.37 | 6.82 |
| 3 | 11.22 | 9.57 |

Median command duration fell from 11.00 s to 7.49 s (32%). All six commands passed. These are repeated-fixture microbenchmarks, not full-suite timings; do not apply the percentage to the complete integration tier. The temporary benchmark was removed. The helper is referenced by 231 integration files.

Lint passes. Spec type-checking reports errors in unchanged files (including action-context tests, obsolete agentRoles fixtures and runner union narrowing); no diagnostics name either changed file.

Final candidate verification: all 17 selected files / 184 tests passed in 67.78 s. Selection included all 15 shared-fixture callers with additional login operations, the fixture binding regression suite and dedicated registration tests. Final lint and diff whitespace checks passed. The complete integration tier was not rerun for this follow-up.

Intermittent failures during comparison remain material limitations: an initial candidate group returned 401 while seeding an agent in `approval-decide-route` (US-005 AC-3); this entire suite subsequently passed all 12 tests with both original and candidate helpers. The grouped original run had a 407 proxy-authentication response in `fleet-budgets-api` (members list policies), plus the expected new reusable-hash assertion failure. The final candidate group had neither failure. These results do not prove the root cause of the intermittent failures.

Follow-up evidence: `/private/tmp/koda-fleet-benchmark-final.log`, `/private/tmp/koda-fleet-group-control.log`, `/private/tmp/koda-fleet-group-candidate.log`, `/private/tmp/koda-fleet-typecheck.log`.

## Follow-up: approval test member setup

Four approval suites (`approval-cancel`, `approval-decide-route`, `approval-request-routes`, `approval-request-counts`) now create their per-test member users with `createMemberWithToken` in `test/helpers/user-fixtures.ts`. Each call inserts a fresh user with the reusable immutable password hash, grants the member baseline and uses real HTTP login. Project-specific grants, per-test user identity, throttle resets, cleanup and approval assertions remain intact. These suites test approvals; dedicated auth, admin-user and audit paths retain real creation endpoints.

The new helper regression checks distinct users, stored fixture hash, exact member-only grants (including the first inserted user), authenticated requests, refusal at an admin route and wrong-password rejection. It failed before the helper existed, then passed.

The fixed performance cohort is the first three suites, with the exact same 27 tests in every run. Three alternating control/candidate pairs (order: C1,N1,N2,C2,C3,N3):

| Pair | Original command (s) | Candidate command (s) | Original tests/hooks (s) | Candidate tests/hooks (s) |
|---|---:|---:|---:|---:|
| 1 | 33.73 | 6.52 | 28.94 | 2.45 |
| 2 | 34.80 | 6.52 | 26.76 | 2.49 |
| 3 | 36.51 | 12.04 | 27.21 | 3.02 |

All six commands passed all 27 tests. Median command duration fell from 34.80 s to 6.52 s (81%); median tests/hooks time fell from 27.21 s to 2.49 s (91%). Candidate run 3 had slower imports; the end-to-end numbers retain that cost. These are local executed tests, not cache replay. The control already includes the earlier root-fixture optimization. This is a cohort measurement, not a full integration-tier speedup claim. No timing probes remain in repository code.

All four converted suites plus the helper regression passed shuffled execution (`--sequence.shuffle --sequence.seed=711`): 5 files / 42 tests in 9.44 s. Spec type-checking reports 463 errors with either the original or changed four files; their normalized diagnostics match, and the new helper/test add none. Lint passes.

Evidence: `/private/tmp/koda-approvals-{control,candidate}-{1,2,3}.log`, `/private/tmp/koda-approval-shuffle.log`, `/private/tmp/koda-approval-typecheck{,-control}.log`.

Final broader verification for approval setup: complete `test/integration/approvals`, `test/integration/auth`, `test/integration/users` and `test/integration/audit/audit-core-invites-users.integration.spec.ts` passed: **37 files / 335 tests**, command duration **56.34 s**. Final lint and `git diff --check` passed. Full integration/e2e tier was not rerun; no full-tier percentage is claimed. Log: `/private/tmp/koda-approval-full-verification.log`.

## Follow-up: permission test member setup

Ten permission suites now use the verified `createMemberWithToken` helper for ordinary setup users: `core-ticket-routes`, `core-ticket-transitions`, `core-ticket-links`, `core-comments-labels-watchers`, `enforce-fleet-jobs`, `enforce-fleet-config-knowledge`, `enforce-fleet-project-reads`, `enforce-fleet-approvals-budgets`, `enforce-fleet-global`, and `enforce-fleet-schedules`. The fixtures preserve lowercase email storage (including mixed-case actor names), member baseline bindings, fresh user rows, real logins, project grants and all existing assertions. First-user registration and user-creation/admin/audit contracts retain their real API paths.

Performance cohort: `core-ticket-routes`, `enforce-fleet-jobs`, `enforce-fleet-schedules`, exactly 70 tests in every run. Three alternating pairs, order C1,N1,N2,C2,C3,N3:

| Pair | Original command (s) | Candidate command (s) | Original tests/hooks (s) | Candidate tests/hooks (s) |
|---|---:|---:|---:|---:|
| 1 | 14.42 | 8.04 | 9.78 | 3.18 |
| 2 | 16.13 | 10.58 | 11.48 | 3.02 |
| 3 | 13.99 | 7.32 | 9.66 | 3.03 |

All six commands passed 3 files / 70 tests. Median command duration fell from 14.42 s to 8.04 s (44%); median tests/hooks time fell from 9.78 s to 3.03 s (69%). These local executed results include imports/setup; they are not cache replay or a full-tier speedup estimate. The control includes earlier fixture optimizations in this investigation.

Lint and diff whitespace checks pass. Spec type-checking still reports 463 errors, with normalized diagnostic messages identical to the pre-change snapshot. Evidence: `/private/tmp/koda-permissions-{control,candidate}-{1,2,3}.log`, `/private/tmp/koda-permission-typecheck.log`.

Final permission verification: the complete `test/integration/permissions` directory plus the member-helper regression passed with shuffled file order (`--sequence.shuffle.files --sequence.seed=711`): **63 files / 771 tests**, **110.63 s**. Test order inside files was preserved because several suites intentionally delete shared fixtures last. Log: `/private/tmp/koda-permission-full-verification.log`. The full integration/e2e tier was not rerun for this follow-up.

## Full integration/e2e measurement after fixture optimizations

Executed the exact `bun run test:integration` command from `apps/api` on 2026-11-11, with all the fixture changes above present. The command ran to natural termination against local Postgres, outside the sandbox. It was not manually interrupted. Runtime: Bun 1.4.4, Node v22.22.2, macOS arm64, 10 logical CPUs, existing installed dependencies and warm local caches; no cache replay. No code changes were made during the measurement.

**Result: 32 min 39.50 s wall time, exit 1, JavaScript heap out of memory.** Vitest measured 1958.95 s, including 1925.68 s in tests/hooks, 19.85 s imports, 7.78 s transforms and 2.80 s setup. This is time to failure, not a successful full-suite duration.

The selected integration/e2e scope contained 579 spec files. Before the worker crash, Vitest reported `7 failed | 446 passed (454)` files, `3 failed | 4938 passed | 57 skipped (5012)` tests and one unhandled worker error. The reported file count includes an unfinished file; the complete scope did not finish.

The log contains `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`, followed by `Worker exited unexpectedly`. A brief native worker sample near minute 29 showed substantial garbage collection activity, consistent with memory pressure. This does not establish which objects are retained or prove a specific memory leak; the sample also adds a small amount of diagnostic overhead to this measurement.

Failures reported before the crash:

- Hook timeouts in `approval-policy-update-routes`, `email-dispatcher` and `enforce-fleet-requesters`; the last also failed teardown because module initialization had not completed.
- A `Role_key_key` unique constraint failure in `approval-policy-writes`.
- A fixture login returned 401 in `placement-trust-domain`.
- One failed assertion in `gated-decide-route` and one in `runner-sync-lifecycle` received HTTP 407. A second `runner-sync-lifecycle` assertion did not receive the expected ASSIGN command.

These failures were not separately rerun as part of this measurement, and their causes are unconfirmed. They must not be dismissed as consequences of memory pressure without further checks.

There is still no completed original full-suite baseline: the earlier baseline was manually interrupted after 21 min 33 s. Consequently, neither a full-suite speedup percentage nor a successful full-suite duration can be inferred from these runs. The earlier passing cohort measurements remain scoped to their selected files.

The next performance experiment should bound worker lifetime (for example, sequential batches with a fresh worker) and measure both memory and total wall time. That experiment must preserve all selected files and database isolation. It was not implemented in this measurement.

Local evidence: `/private/tmp/koda-full-suite-current.log`, `/private/tmp/koda-full-suite-current.json`, `/private/tmp/koda-full-suite-current-specs.json`, `/private/tmp/koda-full-suite-worker-sample.txt`. These temporary artifacts are not portable repository files.


## Follow-up: bound DB worker lifetime

The heap investigation distinguished application lifetime from test-worker lifetime. A temporary three-boot/close reproduction and snapshots after three and 62 real files showed that earlier closed applications can be collected; they do not establish an application leak. The first memory probe did not actually receive `--expose-gc` in its child-project worker, so its heap readings must not be described as retained heap after GC. The corrected 62-file permission diagnostic explicitly enabled and verified GC in the child project: post-GC heap ranged from 209.5 to 298.7 MiB, with first/last readings 238.8/298.7 MiB. This establishes that much of that cohort's allocation was reclaimable, not the precise cause of every allocation in the failed full run. All temporary test/setup probes and GC flags were removed.

The candidate splits the sorted shared-file list into projects of at most 25 files. Within a batch, `isolate: false` still reuses the imported app graph. Each batch gets a fresh worker; unique `sequence.groupOrder` values and the existing `fileParallelism: false` keep all DB work serial. Module-mocking files remain isolated. No heap limit, production password cost or general suite timeout was increased.

`test/vitest-global-setup.ts` now provisions only for Vitest's root project and returns its teardown. Vitest initializes that root setup even when only child projects have selected files. This preserves one schema preparation, one DB lock and one container lifecycle for the whole command instead of repeating them for every batch. Acceptance configuration clears the child projects and keeps the same root lifecycle.

Runner regressions first failed on the original configuration: only one unbounded shared project was discovered, and the lifecycle wrapper provisioned for each child. They passed after the fix. The actual Vitest `list --filesOnly --json` outputs reconcile the exact same 579 integration/e2e files, each once: 22 full shared batches, one 19-file batch and 10 isolated files. The discovery regression exercises the real configuration rather than only a partition helper.

Four runner/lifecycle regression files pass (10 tests). API lint passes. Spec type-checking still reports 463 diagnostics; normalized diagnostic messages match the pre-fix snapshot exactly, and none name the changed runner files. Read-only code review found no defects in the bounded partitioning, serial execution, root lifecycle or acceptance configuration. The first complete batched run finished all 579 files without OOM in 732.03 s wall time (Vitest 730.25 s). It reported 14 failed / 564 passed / 1 skipped files, and 72 failed / 6240 passed / 37 skipped tests. This is a completed command with failing tests, not a green suite. Five-second process sampling observed a maximum worker RSS of 1753.2 MiB and maximum process-tree RSS of 2699.1 MiB; sampled peaks can miss shorter spikes. The raw log confirms one schema reset. Artifacts: `/private/tmp/koda-full-suite-batched.{log,json}`.

That run exposed an ordering defect in `fleet-flow-schema.integration.spec.ts`: its published-thread migration case dropped the shared `FleetFlow` and `FleetFlowFeature` tables and recreated their November migration versions, leaving later columns such as `setSha` absent. Eleven subsequent files failed from that schema damage. Two other files received HTTP 407 (`fleet-project-threads`, `skills-routes`), and `rag/acceptance-mem-phase2.spec.ts` hit a 5 s retrieval-command timeout; these are separate failures, not heap crashes.

The migration case now uses the existing scratch-schema helper to replay the actual pre-migration chain, seed the published row with historical columns, apply the committed migration and check all original preserved fields. A new assertion also checks that the shared `FleetFlow.setSha` column still exists. Scratch cleanup runs in `finally`. This migration-chain case uses a 120 s timeout consistent with other scratch migration tests. The unchanged companion flow suite plus that case first failed 5 of 22 tests (including the missing shared column), then passed all 22 after isolation. Candidate review found no defects. Evidence: `/private/tmp/koda-flow-schema-{red,green}.log`.

Production type-checking (`bun run type-check`) passes. The complete API unit command, shuffled with seed 23 and JSON reporting, passes: 864 files / 11,515 tests, no skips or failures, 93.96 s external wall time. The JSON reporter calls nested describe groups “suites”; 864 is the actual file-entry count, not its 2915 nested-suite count. Artifacts: `/private/tmp/koda-heap-fix-unit.{log,json}`. Spec type-checking still has the same 463 normalized pre-existing diagnostics after the migration fixture change.

Final exact `bun run test:integration` verification, with the migration correction in place, completed all 579 files in **622.07 s wall time (10 min 22.07 s)**; Vitest measured 620.34 s. No heap error, worker crash or missing-column error occurred. The database was reset once. Results: **3 failed / 575 passed / 1 skipped files**, **3 failed / 6326 passed / 20 skipped tests (6349 total)**, exit 1. This proves full-scope completion without OOM, not a green integration suite.

The remaining failures were:

- `agents/gated-agent-key-routes.integration.spec.ts`, AC-5 (redeemed-key authentication): its approval request expected 200 but received 401.
- `permissions/core-members-invites.integration.spec.ts`, AC-4 (refused binding deletion preserves membership): listing members expected 200 but received 407.
- `project-provider-credentials.integration.spec.ts`, AC-11 (credential deletion audit): deletion expected 200 but received 401.

These are unresolved HTTP/auth failures, not worker errors; no assertions were weakened or automatic retries added. A separate run of all three files passed **46/46 tests** in 19.99 s wall time (18.93 s Vitest). That narrower pass does not turn the failing full run green or establish the cause of the intermittent responses. Log: `/private/tmp/koda-heap-fix-auth-rerun.log`. The earlier HTTP 407 and retrieval-timeout failures did not recur in this full run.

Five-second process sampling observed a maximum worker RSS of **2703.2 MiB (2.64 GiB)** and maximum test-process-tree RSS of **3415.5 MiB (3.34 GiB)**. Memory peaks varied between the two complete batched runs, so the lower first-run value must not be presented as a fixed ceiling. These are local sampled measurements, not a CI resource guarantee. No full-suite speedup percentage is claimed against the incomplete original baseline.

Final artifacts: `/private/tmp/koda-full-suite-batched-final.{log,json}`, `/private/tmp/koda-heap-fix-production-typecheck.log`, `/private/tmp/koda-heap-fix-spec-typecheck.log`.

## Follow-up: stabilize the shared HTTP listener

All three remaining failing files used `bootHttpApp`, which returned an initialized but unbound server. Supertest bound that server to an unspecified-address ephemeral port and closed it for every request. The endpoint e2e suite already avoids that port churn with one explicit IPv4 loopback listener.

A temporary diagnostic attached a unique response header to the actual API server, then repeatedly requested `/api/auth/me` with a real login token. Against the original helper it failed at request index 1480 after 2785 ms: HTTP 401, no application marker, and the root user still present in Postgres. This proves that reproduced response did not originate in the API; it does not identify the external responder. A plain HTTP-server probe had not reproduced the problem. No credentials or tokens were recorded in the diagnostic output.

`bootHttpApp` now binds once on `127.0.0.1`, port 0, and keeps that listener until `app.close()`. Four streaming suites reuse it instead of calling `listen()` again. The real guards, login flow, HTTP status assertions and test retry settings are unchanged. The permanent listener regression failed before the fix because `server.address()` was null; it passes after the fix and checks authenticated and refused requests, stable listener ownership between requests, and release on close.

The same diagnostic completed all 20,000 authenticated requests after the fix. Both it and the permanent regression passed in one command (22.91 s Vitest); the temporary diagnostic was then removed. Read-only review found no defects in listener lifecycle or caller compatibility. Evidence: `/private/tmp/koda-http-response-origin-probe.log`, `/private/tmp/koda-http-listener-red.log`, `/private/tmp/koda-http-listener-green-probe.log`.

Targeted verification passed **8 files / 94 tests** with shuffled file order, seed 711, in **58.34 s Vitest**. This includes the three previously failing files, all four streaming callers and the new listener regression. Lint and production type-checking pass. Spec type-checking reports the same 463 existing diagnostics; they match the prior snapshot after normalizing source positions and TypeScript's union-member order, with none in the changed helper or regression. Logs: `/private/tmp/koda-http-listener-targeted.log`, `/private/tmp/koda-http-listener-{lint,typecheck,spec-typecheck}.log`.

The first complete listener run finished all **580 files** in **624.95 s wall time**, without recurrence of the original three failures or heap exhaustion. It did expose a missed compatibility requirement: `approvals/approval-pending-status` and `audit/audit-core-roles-bindings` assert an unbound server before every Fastify injection. Their setup failed with the new default listener, producing 2 failed / 577 passed / 1 skipped files and 6316 passed / 34 skipped tests. This was not a green run. The helper now supports `listen: false` for those injection-only suites; their socket-free, status, authorization and audit assertions remain intact. Supertest and streaming callers keep the persistent listener by default. First-run artifacts: `/private/tmp/koda-http-listener-full.{log,json}`.

Review found one further injection-only caller with a documented socket-free contract. A complete injection-call search identified four such integration files, all now using `listen: false`: `approval-pending-status`, `audit-core-roles-bindings`, `audit-core-invites-users`, and `thread-approval-decision-http-boundary`. The final targeted run, including all four plus the original three failures and listener regression, passed **8 files / 76 tests** with file shuffle seed 711 (48.82 s Vitest). Review confirmed its finding resolved with no remaining concerns. Log: `/private/tmp/koda-http-listener-final-targeted.log`.

The complete API unit command passed with shuffle seed 23 after the final code changes: **864 files / 11,515 tests**, no failures or skips, **80.81 s external wall time** (80.52 s Vitest). The targeted DB verification overlapped the beginning of this unit run, so its duration is not a controlled performance comparison. The subsequent full integration measurement runs on its own. Artifacts: `/private/tmp/koda-http-listener-unit.{log,json}`.

Final verification executed the exact `bun run test:integration` command from `apps/api`, after the unit run finished and with no test code changes during measurement. It exited **0** after **613.06 s wall time (10 min 13.06 s)**; Vitest measured 611.41 s. All **580 selected files** completed: **579 passed / 1 skipped**, with **6330 passed / 20 skipped tests (6350 total)** and no failures. Neither the original three HTTP failures nor the two injected-suite setup failures recurred. The schema was reset once; no heap error or worker crash occurred.

Five-second process sampling observed a maximum worker RSS of **1698.6 MiB (1.66 GiB)** and maximum test-process-tree RSS of **3056.4 MiB (2.98 GiB)**. These sampled local peaks can miss shorter spikes and vary between runs; they are not fixed ceilings. No full-suite speedup percentage is inferred from the original incomplete/OOM baseline. Final evidence: `/private/tmp/koda-http-listener-final.{log,json}`.

## Follow-up: extend member fixtures to remaining permission suites

Thirteen further suites now use the unchanged `createMemberWithToken` helper for ordinary setup users: `permissions/{core-project-routes,core-members-invites,core-agent-routes}`, `fleet/permissions-{project-threads,workspace-threads,assistant-tools}`, `memory/permissions-memory-routes`, `rag/permissions-kb-routes`, `projects/project-{role-permissions,membership-gate}`, `webhook/webhook-permissions`, `vcs/vcs-permissions`, and `context/context-permissions`.

Bootstrap registration remains real. Each fixture has a fresh user, lowercase stored email, original display name, member baseline and real login. Admin grants still happen explicitly, with a fresh login after promotion revokes the earlier token. The VCS suite still removes the member baseline after login so it tests only the explicit project binding. Production hashing, auth/user-creation/audit tests, all existing test bodies, cleanup, worker batching and retry settings are unchanged. No helper API or production code was changed.

The performance cohort is `core-project-routes`, `permissions-project-threads`, and `permissions-workspace-threads`, exactly **55 tests** in every run. Exact pre-pass source snapshots were compared against the candidate in alternating order C1,N1,N2,C2,C3,N3; candidate files were restored afterwards. Each command runs real tests, with matching runtime test identities and statuses confirmed from JSON reports. Three pairs:

| Pair | Control command (s) | Candidate command (s) | Control tests/hooks (s) | Candidate tests/hooks (s) |
|---|---:|---:|---:|---:|
| 1 | 18.37 | 12.38 | 8.52 | 3.00 |
| 2 | 22.97 | 12.38 | 8.81 | 3.45 |
| 3 | 17.48 | 16.15 | 8.51 | 3.22 |

All six commands passed. Median command time fell from **18.366 s to 12.382 s (32.6%)**. Median tests/hooks time fell from 8.52 s to 3.22 s; these are inclusive reporter timings, not an exclusive wall-time decomposition. Import variance in control run 2 and candidate run 3 remains included in command durations. This is a local three-suite measurement, not a full-tier percentage or cache replay.

The first cohort plus helper regression passed 4 files / 56 tests. Final targeted verification passed **14 files / 324 tests** in **48.77 s Vitest**, with shuffled file order, seed 711. TypeScript AST comparisons confirm unchanged test bodies and declarations across the 13 modified files (207 static test-call nodes; parameterized cases expand at runtime). Read-only review of the exact snapshot diff found no issues. Lint and production type-check pass. Spec type-checking reports the same 463 normalized pre-existing diagnostics. An undeclared client name introduced during editing was caught by spec type-checking and corrected to the app-owned `fixtureDb(app)` before final targeted verification.

Evidence: `/private/tmp/koda-fixture-extension-{control,candidate}-{1,2,3}.{log,json}`, `/private/tmp/koda-fixture-extension-benchmark-summary.json`, `/private/tmp/koda-fixture-extension-targeted.{log,json}`, `/private/tmp/koda-fixture-extension-{lint,production-typecheck,spec-typecheck}.log`. Plan: `docs/superpowers/plans/2026-11-11-permission-fixture-extension.md`.

The complete API unit command also passed after these changes with shuffle seed 23: **864 files / 11,515 tests**, no failures or skips, **133.43 s external wall time** (132.72 s Vitest). This verifies the broader test tooling and modules; it is not an optimization benchmark for these integration-only changes. Artifacts: `/private/tmp/koda-fixture-extension-unit.{log,json}`, `/private/tmp/koda-fixture-extension-unit-timing.json`.

Final exact `bun run test:integration` verification passed, exit **0**, in **677.87 s external wall time (11 min 17.87 s)**; Vitest measured 674.19 s. All **580 selected files** completed: **579 passed / 1 skipped files**, **6330 passed / 20 skipped tests (6350 total)**. The schema was reset once. No heap error, worker crash or original HTTP failure recurred.

This full run took longer than the earlier pre-extension 613.06 s run. Vitest reported 114.34 s imports and 549.87 s tests/hooks, compared with 90.29 s and 513.73 s previously; these categories overlap and are not an exclusive explanation of the wall-time difference. These single full runs are not alternating matched comparisons, so neither an overall speedup nor the cause of the longer duration is established. The 32.6% improvement applies only to the repeated, matched 55-test cohort. Five-second sampling observed worker RSS up to **1712.8 MiB (1.67 GiB)** and test-process-tree RSS up to **2944.3 MiB (2.88 GiB)**; sampled peaks are not fixed ceilings. Artifacts: `/private/tmp/koda-fixture-extension-full.{log,json}`.
