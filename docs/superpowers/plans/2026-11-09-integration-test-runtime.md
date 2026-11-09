# Integration Test Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the normal-PR `integration` CI job from 14–19 minutes to at most 7 minutes without dropping suites, weakening assertions, or changing the required-check contract.

**Architecture:** First split the serial 571-file Vitest run across four CI jobs that each own a Postgres service and use `--shard`, then aggregate them behind a job still named `integration`. Then reduce total fixture work by replacing per-user cost-12 bcrypt hashing and login comparisons in `seedFleetHttpWorld` with one precomputed cost-4 fixture hash plus direct user seeding. Real registration/login paths stay covered by the auth suites.

**Tech Stack:** GitHub Actions matrix + aggregator, Vitest 4 `--shard`, Bun 1.4.4, NestJS 12, Prisma 7, bcrypt, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-11-09-integration-test-runtime-design.md`

## Global Constraints

- Work on branch `feat/ci-integration-runtime`; do not modify the active `main` checkout.
- Keep production password hashing at bcrypt cost 12. Only test fixtures may use the cost-4 hash.
- Keep every DB suite and every assertion: the full run must still report **571 files, 6264 passed / 20 skipped** (or a strictly explained superset).
- Keep the required status check named exactly `integration`; the shard jobs are not required checks.
- Do not edit `apps/api/src/generated/**` or any generated file.
- Run API commands from `apps/api`; the test database is the compose one on port 5433 (`bun run test:db:up`).
- Never commit the temporary probes used for measurement.

## Review Focus

- A spec that asserts `user.create` audit entries or registration behavior must keep the real HTTP path; a direct insert removes the audit row and silently stops covering the behavior. Task 3 excludes `test/integration/auth/**`, `test/integration/audit/**`, and `test/integration/users/**` and re-runs those suites unchanged.
- A directly inserted fixture user without the member baseline binding gets 403 from permission routes. Task 3 calls `grantBaseline` for every inserted user and runs `project-membership-gate`.
- A placeholder `passwordHash` makes every fixture login fail and can turn auth assertions into false negatives. Task 2 pins a real bcrypt hash of `TEST_PASSWORD` with a unit test.
- Sharding must run every spec exactly once. Task 4 verifies the summed per-shard `Test Files` count is 571 and that no file was dropped.
- Renaming the aggregator removes the required check and allows merges without the suite. Task 1 pins `name: integration` and Task 4 confirms the check appears in the run.

---

### Task 1: Shard the integration job across four runners

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: job `integration-shards` (matrix `shard: [1,2,3,4]`, `shards: [4]`) and job `integration` (aggregator with `needs: [changes, integration-shards]`).

**Status:** already applied in commit `591781cf` on this branch. An executor starting from `main` performs the steps; an executor on this branch verifies them and moves on.

- [ ] **Step 1: Confirm the baseline workflow is lint-clean**

Run: `actionlint .github/workflows/ci.yml`
Expected: exit 0, no output.

- [ ] **Step 2: Replace the single integration job with the matrix job**

Keep the Postgres service block unchanged. The job header and shard step must be:

```yaml
  integration-shards:
    name: integration shard ${{ matrix.shard }}/${{ matrix.shards }}
    needs: changes
    if: needs.changes.outputs.code == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
        shards: [4]
```

```yaml
      - name: Integration + e2e (Postgres, shard ${{ matrix.shard }}/${{ matrix.shards }})
        run: cd apps/api && bun run test:integration -- --shard=${{ matrix.shard }}/${{ matrix.shards }}
        env:
          KODA_TEST_DATABASE_URL: postgresql://koda:koda@localhost:5433/koda_test
```

Each matrix job gets its own service container and database, so the existing run lock, schema reset and per-file `resetDb()` behavior is unchanged.

- [ ] **Step 3: Add the aggregator job that preserves the required check name**

Place it after the shard job:

```yaml
  integration:
    name: integration
    needs: [changes, integration-shards]
    if: always() && needs.changes.outputs.code == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check shard results
        run: |
          echo "integration shards: ${{ needs.integration-shards.result }}"
          test "${{ needs.integration-shards.result }}" = "success"
```

`needs.integration-shards.result` is `success` only when all four shards succeeded. When `changes` reports no code changes, both jobs are skipped exactly as before.

- [ ] **Step 4: Verify syntax and job wiring**

Run: `actionlint .github/workflows/ci.yml`
Expected: exit 0.

Run:
```sh
python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(list(d['jobs'])); print(d['jobs']['integration']['needs']); print(d['jobs']['integration']['name'])"
```
Expected: `integration-shards` and `integration` are present; aggregator needs `['changes', 'integration-shards']`; aggregator name is `integration`.

- [ ] **Step 5: Verify the shard command selects files**

With the test database up (`cd apps/api && bun run test:db:up`):

```sh
cd apps/api && KODA_DB_TESTS=1 bun run test:integration -- --shard=1/60
cd apps/api && KODA_DB_TESTS=1 bun run test:integration -- --shard=59/60
```

Expected: both commands run a non-empty subset and pass. The two file counts must be 10 and 9 respectively (571 files over 60 shards).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "perf(ci): shard integration suite across four runners"
```

---

### Task 2: Add the precomputed fixture password hash

**Files:**
- Create: `apps/api/test/helpers/test-credentials.ts`
- Create: `apps/api/test/unit/helpers/fixture-credentials.spec.ts`
- Modify: `apps/api/test/helpers/http-app.ts:15` (the `TEST_PASSWORD` definition)

**Interfaces:**
- Produces: `export const TEST_PASSWORD: string` and `export const TEST_PASSWORD_HASH: string` from `test/helpers/test-credentials.ts`, re-exported by `test/helpers/http-app.ts`.
- `TEST_PASSWORD_HASH` is a real bcrypt hash of `TEST_PASSWORD` at cost 4, matching the cost already used by `test/integration/auth/role-claim-from-bindings.integration.spec.ts` and `disabled-user.integration.spec.ts`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/unit/helpers/fixture-credentials.spec.ts`:

```ts
import * as bcrypt from 'bcrypt';
import { TEST_PASSWORD, TEST_PASSWORD_HASH } from '../../helpers/test-credentials';

describe('fixture credentials', () => {
  it('hashes the fixture password at test cost', async () => {
    expect(bcrypt.getRounds(TEST_PASSWORD_HASH)).toBe(4);
    await expect(bcrypt.compare(TEST_PASSWORD, TEST_PASSWORD_HASH)).resolves.toBe(true);
    await expect(bcrypt.compare('not-the-password', TEST_PASSWORD_HASH)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bunx vitest run test/unit/helpers/fixture-credentials.spec.ts`
Expected: FAIL — cannot resolve `../../helpers/test-credentials`.

- [ ] **Step 3: Create the credentials module and re-export it**

`apps/api/test/helpers/test-credentials.ts`:

```ts
import * as bcrypt from 'bcrypt';

/** The password every fixture user shares. Real login still verifies it. */
export const TEST_PASSWORD = 'Admin1234!Aa';

/**
 * One real bcrypt hash at the cost the repo already uses for test users (4).
 * Fixture inserts reuse it instead of paying cost-12 hashing per user; production
 * hashing stays at 12.
 */
export const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
```

In `apps/api/test/helpers/http-app.ts`, delete the local `export const TEST_PASSWORD = 'Admin1234!Aa';` and add:

```ts
import { TEST_PASSWORD } from './test-credentials';

export { TEST_PASSWORD, TEST_PASSWORD_HASH } from './test-credentials';
```

Keep `loginToken`'s default parameter pointing at `TEST_PASSWORD`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bunx vitest run test/unit/helpers/fixture-credentials.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the API unit suite**

Run: `cd apps/api && bun run test`
Expected: PASS. This suite needs no database.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/helpers/test-credentials.ts apps/api/test/helpers/http-app.ts apps/api/test/unit/helpers/fixture-credentials.spec.ts
git commit -m "test(api): add precomputed fixture password hash"
```

---

### Task 3: Seed `seedFleetHttpWorld` users directly

**Files:**
- Modify: `apps/api/test/helpers/fleet-fixtures.ts:78-88` (the `dev`/`viewer`/`outsider` loop and the `ids` lookup)

**Interfaces:**
- Consumes: `TEST_PASSWORD_HASH` from `./http-app` (re-exported from `../helpers/test-credentials`).
- Consumes: `grantBaseline` and `grantRole` already imported from `src/permissions/test-helpers/permission-fixtures`.
- Produces: unchanged `seedFleetHttpWorld(server, prisma): Promise<FleetHttpWorld>` signature and return shape.

- [ ] **Step 1: Record the control measurement**

With the test database up, run the cohort three times and record the per-file durations:

```sh
cd apps/api && KODA_DB_TESTS=1 bunx vitest run \
  test/integration/fleet/assistant-thread-direct.integration.spec.ts \
  test/integration/fleet/fleet-approvals-api.integration.spec.ts \
  --reporter=verbose
```

Run it three times. Record each file's `Duration` line. The world seed is in `beforeAll`, so this is the control for the change.

- [ ] **Step 2: Replace the admin-API user creations with direct inserts**

Add `TEST_PASSWORD_HASH` to the `./http-app` import. In `seedFleetHttpWorld`, replace the existing loop body with:

```ts
  for (const [who, role] of [['dev', 'developer'], ['viewer', 'viewer'], ['outsider', null]] as const) {
    const user = await prisma.user.create({
      data: { email: `${who}@koda.test`, name: who, passwordHash: TEST_PASSWORD_HASH },
    });
    await grantBaseline(prisma, { type: 'USER', id: user.id });
    ids[who] = user.id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    if (role) await grantRole(prisma, { type: 'USER', id: user.id }, role, web.id);
  }
```

Delete the later `for (const who of ['root', 'dev', 'viewer', 'outsider']) { ids[who] = ... }` loop. Fill the root id where the root token is created:

```ts
  ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;
```

Do not change the root registration path: it is the suite's real first-user/owner bootstrap. Update the function's doc comment (`fleet-fixtures.ts:59-66`) to say the three secondary users are inserted with the fixture hash and member baseline, and that the helper logs in three times (the root uses the registration token).

- [ ] **Step 3: Run the focused fleet suites**

```sh
cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/assistant-thread-direct.integration.spec.ts test/integration/fleet/fleet-approvals-api.integration.spec.ts
```
Expected: PASS.

```sh
cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/permissions/project-membership-gate.integration.spec.ts test/integration/fleet/permissions-project-threads.integration.spec.ts
```
Expected: PASS. These prove the inserted users still hold the member baseline and project role bindings.

- [ ] **Step 4: Run the excluded auth/audit/user suites unchanged**

```sh
cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/auth test/integration/users test/integration/audit/audit-core-invites-users.integration.spec.ts
```
Expected: PASS. These keep the real registration and `user.create` audit paths.

- [ ] **Step 5: Re-run the control cohort three times and compare**

Run the Step 1 command three more times. Each world-seeded file should be at least 1.5s faster in `beforeAll`-heavy runs, with identical test counts. If it is not, stop and report the measurement instead of committing.

- [ ] **Step 6: Run the full fleet directory**

```sh
cd apps/api && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet
```
Expected: PASS. This is the 174-file cohort that uses the helper most.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test/helpers/fleet-fixtures.ts
git commit -m "test(api): seed fleet fixture users without repeated bcrypt work"
```

---

### Task 4: Verify identities, measure CI, tune the shard count

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-integration-test-runtime-design.md` (record actual measurements)
- Modify: `.github/workflows/ci.yml` only if tuning is needed

**Interfaces:**
- Consumes: the shard matrix from Task 1 and the fixture change from Task 3.

- [ ] **Step 1: Run the complete DB suite once**

```sh
cd apps/api && KODA_DB_TESTS=1 bun run test:integration
```
Expected: PASS with **571 files, 6264 passed / 20 skipped**. Record the Vitest `Duration` and the `tests` bucket.

- [ ] **Step 2: Compare against the recorded local control**

The cohort comparison from Task 3 is the adoption evidence; do not attribute CI wall-time differences to CPU variance. Record both the cohort deltas and the full-run identity counts in the spec.

- [ ] **Step 3: Push the branch**

```sh
git push -u origin feat/ci-integration-runtime
gh run list --workflow=ci.yml --branch feat/ci-integration-runtime --limit 1
```

Expected: the branch is pushed and a CI run is queued for the new head.

- [ ] **Step 4: Read the first CI run**

```sh
gh run view <run-id> --json jobs \
  --jq '.jobs[] | select(.name | startswith("integration")) | [.name, .conclusion, .startedAt, .completedAt] | @tsv'
```

Expected: four `integration shard n/4` jobs plus the `integration` aggregator, all successful. Sum the shard `Test Files` counts from the job logs; the total must be 571.

- [ ] **Step 5: Tune only if the measured shard times justify it**

- Slowest shard > 7 minutes: change the matrix to `shard: [1, 2, 3, 4, 5, 6]` and `shards: [6]`.
- Slowest shard < 4 minutes: consider `shard: [1, 2, 3]` and `shards: [3]`.
- Otherwise keep four.

Run `actionlint .github/workflows/ci.yml` after any change and commit it as `perf(ci): tune integration shard count`.

- [ ] **Step 6: Commit the recorded measurements**

```bash
git add docs/superpowers/specs/2026-11-09-integration-test-runtime-design.md
git commit -m "docs(ci): record integration runtime measurements"
```

## Deferred Work

These were evaluated and deliberately left out of this plan:

- **Per-worker test databases + `fileParallelism: true`** (store-erp's approach). It would land at the same wall time as four shards on one 4-vCPU runner, while requiring provisioning, connection-count and isolation changes. Revisit only if CI runner count or cost becomes a constraint.
- **Sequential batch shards** (store-erp's five-batch fix). koda shows no late-run drift (r = −0.344), so batching would add cold starts. Rejected.
- **Suite consolidation / shared app boots.** The long-term way to reduce total work, but it changes test structure and needs its own plan.
- **Converting the 31 local `createUser` helpers under `test/integration/{permissions,projects}`.** Each creates users through `/api/admin/users` (cost-12 hash + login). A shared `createUserWithToken` helper would save roughly 0.5s per user, but the sweep needs case-by-case checks for audit assertions. Follow-up after this plan's measurements.
