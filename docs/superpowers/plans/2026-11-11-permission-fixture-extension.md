# Permission Fixture Extension Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session.

**Goal:** Reduce integration setup time by extending the verified member fixture to permission suites.

**Architecture:** Reuse `createMemberWithToken(server, prisma, { email, name })` without changing the helper. Each call creates a fresh member with the shared immutable password hash, its baseline binding, and a real login token. Keep bootstrap registration, explicit grants and post-admin-grant re-login.

**Tech Stack:** TypeScript, Vitest 4.1.12, Supertest, Prisma/PostgreSQL, existing API test helpers.

**Spec:** User-approved option #1: extend faster setup-user fixtures while preserving real login, permissions, and dedicated user-creation tests. Prior evidence: `docs/test-performance-2026-11-11.md`.

## Global Constraints

- Preserve test identities, assertions, mutable-user independence and real authentication.
- Normalize fixture email to lowercase as the original creation API does.
- Keep owner/bootstrap registration and dedicated creation/auth/audit coverage intact.
- Preserve admin grants, token revocation/re-login, and intentional removal of baseline bindings.
- Keep bounded serial DB workers, cleanup, production password hashing and retry settings unchanged.
- Preserve existing workspace changes; benchmark snapshots contain the current versions, not HEAD.

## Review Focus

Mixed-case actor names; admin promotions invalidating tokens; VCS fixtures removing member baselines; login throttles; setup users reused by later grant/revocation assertions.

## Task 1: Extend permission setup and measure equivalent executed tests

**Files:** Existing integration suites: `permissions/{core-project-routes,core-members-invites,core-agent-routes}`, `fleet/permissions-{project-threads,workspace-threads,assistant-tools}`, `memory/permissions-memory-routes`, `rag/permissions-kb-routes`, `projects/project-{role-permissions,membership-gate}`, `webhook/webhook-permissions`, `vcs/vcs-permissions`, `context/context-permissions`; report in `docs/test-performance-2026-11-11.md`.

**Interface:** Consume unchanged `createMemberWithToken(...): Promise<{ id: string; token: string }>` from `test/helpers/user-fixtures.ts`.

- [x] Save exact current versions and measure the unchanged three-suite cohort: core-project-routes, permissions-project-threads, permissions-workspace-threads.
- [x] Replace ordinary setup-user creation with the existing helper; preserve role changes and re-login after admin promotion.
- [x] Verify the cohort and helper regression; compare unchanged test bodies and reconcile executed case identities.
- [x] Complete three alternating control/candidate pairs; restore candidate files after every comparison sequence.
- [x] Run all affected suites with file-only shuffle, review the diff, and run lint/type checks plus shuffled API units.
- [x] Run the exact full integration/e2e command; record outcomes and timing without inferring a full-tier percentage from cohort measurements.

## Execution Record

- All six 55-test benchmark runs pass with identical executed case identities/statuses. Median command time: control 18.366 s, candidate 12.382 s (32.6% reduction for this cohort).
- All 13 candidate versions restored. TypeScript AST comparison confirms unchanged test bodies/declarations (207 static test-call nodes).
- Affected suites plus helper regression pass shuffled file order, seed 711: 14 files / 324 tests, 48.77 s Vitest.
- Review of the exact 13-file snapshot diff found no issues. Lint and production type-check pass; spec type-check has the same 463 normalized pre-existing diagnostics.
- Implementation uses the existing helper only: no production code or helper contract changed, and existing behavior tests provide the equivalence checks.
- Complete shuffled API unit suite passes: 864 files / 11,515 tests, seed 23, 133.43 s external wall time.
- Exact full integration/e2e command passes: 579 passed / 1 skipped files, 6330 passed / 20 skipped tests, 677.87 s wall time, no heap error. This single run was slower than the previous 613.06 s run; a full-tier speedup is not established.
