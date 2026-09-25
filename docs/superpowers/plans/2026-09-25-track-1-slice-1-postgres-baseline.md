# Track 1 Slice 1 — Postgres Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostgreSQL koda's only database: fresh baseline migration, DB-free unit runs, integration/e2e suites green on Postgres in CI, and the Postgres-only correctness fixes (M6 ticket-number race, M14 `code_document`, case-insensitive symbol search).

**Architecture:** Switch the Prisma datasource to `postgresql` and replace the 28 SQLite migrations with one `0_init` baseline that ports the current schema unchanged. Split the Jest scripts so `bun run test` never touches a database, and `test:integration` (flag `KODA_DB_TESTS=1`) runs integration + e2e suites against a Postgres 16 on port 5433. The three `max(number)+1` ticket allocators share one retry helper that re-runs the whole transaction on a `(projectId, number)` unique violation.

**Tech Stack:** NestJS 11 + Fastify, Prisma 6, `@nathapp/nestjs-prisma` 3.3.0 (`PrismaTransactionManager`), Jest (ts-jest, `maxWorkers: 1`), Bun 1.3.11, Docker `postgres:16`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` — section "Slice 1 — Postgres baseline". Read it before starting.

## Global Constraints

- Postgres only. No dual-provider support; `DATABASE_PROVIDER` is removed everywhere.
- The baseline is a faithful port of the current schema. **No model changes in this slice** (the `OutboxEvent` reshape is slice 2).
- String-typed enum fields and JSON-as-String columns stay as they are.
- Test database: `postgresql://koda:koda@localhost:5433/koda_test`. Port 5433 so tests can never hit a dev DB on 5432.
- `bun run test` / `test:unit` must pass with **no database running** (apps/api context rule: DI/module tests are DB-free).
- 409 responses use koda's existing convention `new HttpException(message, HttpStatus.CONFLICT)` (there is no conflict `AppException` in `@nathapp/nestjs-common`).
- Ticket-number retry: only P2002 whose target includes `number`; up to 10 attempts; jitter `attempt × (10..50) ms`; inside an outer transaction run once and map a conflict to 409.
- Follow `nathapp-nestjs-patterns`: `AppException` subclasses for errors (except the 409 convention above), no `console.log`, no raw `process.env` outside config files and test harness files.
- Never edit generated files (`apps/cli/src/generated/`, root `CLAUDE.md`/`AGENTS.md` — regenerate with `nax generate`).
- Do not push, open a PR, or touch `projects/koda/deployments/koda-local` without the user's explicit approval at that moment.
- Git: this repo's hook rewrites git commands through `rtk`; if a git command misbehaves, prefix it with `RTK_DISABLED=1`.

## Review Focus

1. **Ticket create inside an outer transaction** — the retry helper must not retry inside an aborted transaction; a conflict must surface as 409, never 500. Pinned in Task 4 (`isInTransaction` case).
2. **A P2002 on some other unique constraint during ticket create** (e.g. a future unique column) must propagate untouched, not be retried or turned into a 409. Pinned in Task 4.
3. **Mixed-case symbol search** — `q=userservice` must find `UserService`, and `file=SRC/` must find `src/...`, as it did on SQLite. Pinned in Task 7.
4. **GraphNode rows with `type` or `sourceFile` null** — mapping must not crash and must not index them as `code_module`. Pinned in Task 6.
5. **`bun run test` with no Postgres running** — must pass (global-setup must not try `db push`). Pinned in Task 2, Step 9.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/config/database.config.ts` (+ `.spec.ts`) | database config without `provider` | 1 |
| `apps/api/src/config/env.validation.ts` (+ new `env.validation.spec.ts`) | env schema without `DATABASE_PROVIDER` | 1 |
| `apps/api/.env.example`, `apps/api/.env.test` | env files | 1, 2 |
| `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/**` | PG datasource + `0_init` baseline | 2 |
| `docker-compose.test.yml` (new) | local Postgres 16 on 5433 for tests | 2 |
| `apps/api/package.json` (scripts + jest config) | DB-free `test`, `KODA_DB_TESTS=1` `test:integration` | 2 |
| `apps/api/test/global-setup.ts`, `test/global-teardown.ts`, `test/helpers/reset-db.ts` | PG test DB lifecycle | 2 |
| `apps/api/test/integration/db/reset-db.integration.spec.ts` (new) | reset-db behavior | 2 |
| integration/e2e specs under `apps/api/test/**` | PG compatibility fixes | 3 |
| `apps/api/src/common/utils/ticket-number-retry.ts` (+ `.spec.ts`) | shared retry helper | 4 |
| `apps/api/src/tickets/tickets.service.ts`, `src/ci-webhook/prisma-ci-webhook.repository.ts`, `src/vcs/prisma-vcs.repository.ts` | use the helper | 5 |
| `apps/api/test/integration/tickets/ticket-number-allocation.integration.spec.ts` (new) | M6 concurrency proof | 5 |
| `apps/api/src/rag/prisma-rag.repository.ts` (+ integration spec) | M14 GraphNode query | 6 |
| `apps/api/src/code-intel/prisma-code-intel.repository.ts` (+ integration spec) | case-insensitive search | 7 |
| `.github/workflows/ci.yml`, `scripts/smoke-test-cli.sh` | CI on Postgres | 8 |
| `apps/web/playwright.config.ts` | web e2e API on Postgres | 9 |
| `docker-compose.yml`, `docker-compose.dev.yml`, `.nax/context.md`, `README.md`, `docs/architecture.md` | runtime + docs | 10 |

---

### Task 1: Remove the phantom `DATABASE_PROVIDER`

`DATABASE_PROVIDER` is validated and defaulted but read by nothing (`IDatabaseConfig.provider` has no consumer). Remove it before the provider switch so nothing implies a choice exists.

**Files:**
- Modify: `apps/api/src/config/database.config.ts`
- Modify: `apps/api/src/config/database.config.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts:11-13`
- Create: `apps/api/src/config/env.validation.spec.ts`
- Modify: `apps/api/.env.example`, `apps/api/.env.test` (delete the `DATABASE_PROVIDER` line only)

**Interfaces:**
- Produces: `IDatabaseConfig = { url: string }` (the `provider` field is gone).

- [ ] **Step 1: Write the failing tests**

Replace the body of `apps/api/src/config/database.config.spec.ts`:

```typescript
import { databaseConfig, IDatabaseConfig } from './database.config';

describe('databaseConfig', () => {
  beforeEach(() => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env['DATABASE_URL'];
  });

  it('returns the database url', () => {
    const cfg: IDatabaseConfig = databaseConfig();
    expect(cfg.url).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('does not expose a provider (Postgres is the only provider)', () => {
    const cfg = databaseConfig() as unknown as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('provider');
  });
});
```

Create `apps/api/src/config/env.validation.spec.ts`:

```typescript
import { validate } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 's',
  JWT_REFRESH_SECRET: 'r',
  API_KEY_SECRET: 'k',
};

describe('env validation', () => {
  it('does not inject a DATABASE_PROVIDER default', () => {
    const out = validate({ ...REQUIRED });
    expect(out).not.toHaveProperty('DATABASE_PROVIDER');
  });

  it('still requires DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...withoutUrl } = REQUIRED;
    expect(() => validate(withoutUrl)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/config/database.config.spec.ts src/config/env.validation.spec.ts`
Expected: FAIL — `provider` property present; `DATABASE_PROVIDER` defaulted to `'sqlite'`.

- [ ] **Step 3: Implement**

`apps/api/src/config/database.config.ts` becomes:

```typescript
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsString } from 'class-validator';

export const DATABASE_CFG = 'database';

export interface IDatabaseConfig {
  url: string;
}

export class DatabaseConfigSchema {
  @IsString()
  DATABASE_URL: string;
}

export const databaseConfig = registerAs(DATABASE_CFG, (): IDatabaseConfig => {
  validateUtil(process.env, DatabaseConfigSchema);
  return {
    url: process.env['DATABASE_URL'],
  };
});
```

In `apps/api/src/config/env.validation.ts` delete these three lines:

```typescript
  DATABASE_PROVIDER: Joi.string()
    .valid('sqlite', 'postgresql', 'mysql')
    .default('sqlite'),
```

Delete the `DATABASE_PROVIDER=...` line from `apps/api/.env.example` and `apps/api/.env.test`.

- [ ] **Step 4: Verify no other reader exists, then run the tests**

Run: `grep -rn "DATABASE_PROVIDER\|\.provider\b" apps/api/src --include='*.ts' | grep -iv "vcs\|embedding\|llm\|rag"` — expected: no output.
Run: `cd apps/api && bunx jest src/config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config apps/api/.env.example apps/api/.env.test
git commit -m "refactor(api): remove unused DATABASE_PROVIDER config"
```

---

### Task 2: Postgres datasource, baseline migration, test DB lifecycle

**Files:**
- Modify: `apps/api/prisma/schema.prisma:8-11`
- Delete: `apps/api/prisma/migrations/*` (all 28 directories + `migration_lock.toml`)
- Create: `apps/api/prisma/migrations/<timestamp>_init/migration.sql` (generated), `migration_lock.toml` (generated)
- Create: `docker-compose.test.yml`
- Modify: `apps/api/.env.test` (`DATABASE_URL`)
- Modify: `apps/api/package.json` (`test`, `test:unit`, `test:integration`, new `test:db:up`/`test:db:down`)
- Modify: `apps/api/test/global-setup.ts`, `apps/api/test/global-teardown.ts`, `apps/api/test/helpers/reset-db.ts`
- Create: `apps/api/test/integration/db/reset-db.integration.spec.ts`

**Interfaces:**
- Produces: `resetDb(databaseUrl?: string): Promise<void>` (same signature, PG implementation) — every later integration test calls it in `beforeAll`.
- Produces: env flag `KODA_DB_TESTS=1` — the only switch that makes `global-setup` push the schema.
- Produces: `bun run test:db:up` / `test:db:down` (local Postgres 16 on 5433).

- [ ] **Step 1: Add the local test database**

Create `docker-compose.test.yml` at the repo root:

```yaml
# Local Postgres for apps/api integration/e2e tests and the CLI smoke test.
# Port 5433 so tests can never hit a dev database on 5432.
services:
  postgres-test:
    image: postgres:16
    environment:
      POSTGRES_USER: koda
      POSTGRES_PASSWORD: koda
      POSTGRES_DB: koda_test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U koda -d koda_test"]
      interval: 2s
      timeout: 3s
      retries: 20
```

Add to `apps/api/package.json` `scripts`:

```json
"test:db:up": "docker compose -f ../../docker-compose.test.yml up -d --wait",
"test:db:down": "docker compose -f ../../docker-compose.test.yml down",
```

Run: `cd apps/api && bun run test:db:up`
Expected: container `postgres-test` healthy.

- [ ] **Step 2: Switch the datasource and regenerate the baseline**

In `apps/api/prisma/schema.prisma` change the datasource to:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then:

```bash
cd apps/api
rm -rf prisma/migrations
DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_test bunx prisma migrate dev --name init --skip-seed
```

Expected: `prisma/migrations/<timestamp>_init/migration.sql` and `migration_lock.toml` with `provider = "postgresql"`. The migration contains `CREATE TABLE` statements only; open it and confirm it has a `"Ticket_projectId_number_key"` unique index and no `code_document` table.

Run: `bun run db:generate && bunx tsc --noEmit -p tsconfig.json`
Expected: exit 0 (the generated client compiles against unchanged models).

- [ ] **Step 3: Write the failing reset-db test**

Create `apps/api/test/integration/db/reset-db.integration.spec.ts`:

```typescript
/**
 * resetDb() must empty every application table on Postgres and leave
 * _prisma_migrations alone.
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/db/reset-db.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('resetDb (Postgres)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('empties application tables', async () => {
    await resetDb();
    const project = await prisma.project.create({
      data: { name: 'P', slug: 'reset-p', key: 'RST' },
    });
    await prisma.ticket.create({
      data: { projectId: project.id, number: 1, type: 'TASK', title: 't', status: 'CREATED', priority: 'MEDIUM' },
    });

    await resetDb();

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.ticket.count()).toBe(0);
  });

  it('is safe to call twice in a row', async () => {
    await resetDb();
    await expect(resetDb()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Split the Jest scripts and gate the DB lifecycle on `KODA_DB_TESTS`**

In `apps/api/package.json` `scripts`, replace `test`, `test:unit`, `test:integration`:

```json
"test": "jest --forceExit --passWithNoTests --testPathIgnorePatterns=integration --testPathIgnorePatterns=e2e",
"test:unit": "jest --forceExit --passWithNoTests --testPathIgnorePatterns=integration --testPathIgnorePatterns=e2e",
"test:integration": "KODA_DB_TESTS=1 jest --forceExit --passWithNoTests --testPathPattern='(integration|e2e)'",
```

Keep the `jest.testPathIgnorePatterns: [".nax/"]` config entry as is (CLI flags add to it).

`apps/api/.env.test`: set

```
DATABASE_URL="postgresql://koda:koda@localhost:5433/koda_test"
```

(dotenv never overrides an existing variable, so CI's job-level `DATABASE_URL` wins.)

`apps/api/test/global-setup.ts` — replace the gate. The function body becomes:

```typescript
export default async function globalSetup(): Promise<void> {
  config({ path: resolve(__dirname, '../.env.test'), quiet: true });

  // Only `bun run test:integration` sets KODA_DB_TESTS=1. Unit runs
  // (`bun run test`) must never need a database.
  if (process.env.KODA_DB_TESTS !== '1') return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('KODA_DB_TESTS=1 but DATABASE_URL is not set');
  }

  execSync('bunx prisma db push --force-reset --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
```

Update its header comment: "Pushes the Prisma schema to the Postgres test database once, when `KODA_DB_TESTS=1`."

`apps/api/test/global-teardown.ts` — the SQLite file deletion no longer applies (the next run's `db push --force-reset` resets the schema). Replace the whole file with:

```typescript
/**
 * Jest globalTeardown. The Postgres test database is reset by the next run's
 * globalSetup (`prisma db push --force-reset`), so there is nothing to delete.
 * Kept as an explicit no-op so the jest config stays stable.
 */
export default async function globalTeardown(): Promise<void> {
  return;
}
```

`apps/api/test/helpers/reset-db.ts` — replace the SQLite implementation:

```typescript
/**
 * Fast per-file database reset for Postgres integration/e2e suites.
 *
 * The schema is created ONCE by the Jest globalSetup (test/global-setup.ts).
 * Test files call `resetDb()` in `beforeAll`, which truncates every
 * application table in one statement and restarts identity sequences,
 * leaving the schema and `_prisma_migrations` intact.
 */
import { PrismaClient } from '@prisma/client';

interface PgTable {
  tablename: string;
}

/**
 * @param databaseUrl Connection string. Defaults to DATABASE_URL; a no-op when
 *   unset, matching how the DB-backed suites skip without a configured DB.
 */
export async function resetDb(
  databaseUrl: string | undefined = process.env.DATABASE_URL
): Promise<void> {
  if (!databaseUrl) return;

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  try {
    const tables = await prisma.$queryRawUnsafe<PgTable[]>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename <> '_prisma_migrations'`
    );
    if (tables.length === 0) return;

    const list = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}
```

- [ ] **Step 5: Run the reset-db test**

Run: `cd apps/api && bun run test:integration -- test/integration/db/reset-db.integration.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Switch every DB-suite gate to `KODA_DB_TESTS`**

The existing DB-backed specs gate on `process.env.DATABASE_URL ? describe : describe.skip`. With `.env.test` always setting `DATABASE_URL`, that gate no longer means "a DB is available". Find them:

Run: `cd apps/api && grep -rln "DATABASE_URL ? describe\|DATABASE_URL) ? describe\|describe.skip" test src | sort`

In each listed file replace the gate expression with `process.env.KODA_DB_TESTS === '1'`, keeping the variable name the file already uses, e.g.:

```typescript
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
```

Also update the `Run:` doc comments in those files that say `DATABASE_URL=file:./koda-test.ephemeral.db ...` to:
` * Run: cd apps/api && bun run test:db:up && bun run test:integration -- <this file>`

Three specs push the schema themselves (`test/integration/vcs/schema-validation.integration.spec.ts:37`, `test/integration/vcs/prisma-models.integration.spec.ts:42`, `test/integration/outbox-event-schema/outbox-event-schema.validation.integration.spec.ts:37,444,449`). Leave the push calls (they work on PG) but make sure each passes `env: { ...process.env }` so it targets the same `DATABASE_URL`.

- [ ] **Step 7: Run the unit suite with the test DB stopped**

```bash
cd apps/api && bun run test:db:down && bun run test
```

Expected: PASS, and the output contains no `prisma db push` line (Review Focus 5). If a unit spec fails because it boots something that connects to the DB, it is misfiled: move it to `test/integration/` or make it mock `PrismaService` per the apps/api context rule — do not re-add a DB to `bun run test`.

- [ ] **Step 8: Run the whole DB suite once to record the baseline**

```bash
cd apps/api && bun run test:db:up && bun run test:integration 2>&1 | tee /tmp/koda-pg-baseline.log | tail -40
```

Expected: most suites pass; some may fail on Postgres. Do **not** fix them here — save the log; Task 3 owns them.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.test.yml apps/api/prisma apps/api/package.json apps/api/.env.test apps/api/test
git commit -m "feat(api): switch to postgres with a fresh baseline migration and DB-free unit runs"
```

---

### Task 3: Bring the integration and e2e suites green on Postgres

Task 2 Step 8 produced `/tmp/koda-pg-baseline.log`. This task fixes every failure in it. The failures cannot be listed in advance; the rules below decide how each is fixed.

**Files:**
- Modify: only the failing specs under `apps/api/test/**` and, where the failure is a real product bug, the production file it points at.

- [ ] **Step 1: List the failing suites**

Run: `grep -E "^(FAIL|PASS)" /tmp/koda-pg-baseline.log | sort | uniq -c`
Write the FAIL list into the task's scratch notes.

- [ ] **Step 2: Fix each failure, one suite at a time, using these rules**

For each failing suite run it alone (`bun run test:integration -- <path>`), read the first error, and classify:

| Symptom | Cause | Fix |
|---|---|---|
| Assertion on list order fails; rows are all present | Query has no `orderBy`; SQLite returned insertion order, Postgres does not guarantee it | If the **product** endpoint's contract implies an order (lists shown to users), add `orderBy` in the repository (e.g. `[{ createdAt: 'desc' }, { id: 'desc' }]`) and keep the assertion. If order is irrelevant to the product, make the assertion order-insensitive (`expect.arrayContaining` + length check). |
| `Unique constraint failed` / P2002 in a test that previously passed | Test data reused a unique value across tests without `resetDb()` | Add `await resetDb()` in `beforeAll` (or `beforeEach` if tests in the file collide). |
| String comparison differs only by case | Postgres `contains`/`startsWith` is case-sensitive | If it is symbol search, Task 7 fixes it — skip here. Otherwise treat as product behavior: ask whether the endpoint should be case-insensitive; if yes add `mode: 'insensitive'`, if no fix the test data. |
| `DateTime` equality off by sub-millisecond | Postgres stores microseconds, JS has milliseconds | Compare with `getTime()` or `toISOString()` rather than object identity. |
| A test depends on SQLite write serialization (e.g. comments say "SQLite serializes") | Concurrency now real | If it is a ticket-number test, Task 5 owns it — skip here. Otherwise the concurrency is a product bug: stop and report it to the user with the failing test, do not paper over it. |
| `relation "code_document" does not exist` | M14 | Task 6 owns it — skip here. |
| Anything else | — | Stop and report: file, test name, error, your hypothesis. |

Never delete a test, never add `.skip`, never loosen an assertion that encodes product behavior (only order-irrelevant or precision-irrelevant ones).

- [ ] **Step 3: Re-run the whole DB suite**

Run: `cd apps/api && bun run test:integration`
Expected: every suite passes except those owned by Tasks 5, 6 and 7 (list them explicitly in the commit message body).

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "test(api): make integration and e2e suites deterministic on postgres"
```

---

### Task 4: Ticket-number retry helper

**Files:**
- Create: `apps/api/src/common/utils/ticket-number-retry.ts`
- Create: `apps/api/src/common/utils/ticket-number-retry.spec.ts`

**Interfaces:**
- Consumes: `ITransactionManager` from `@nathapp/nestjs-data` (`run<T>(fn: () => Promise<T>): Promise<T>`, `getClient<C>(): C`). The concrete `PrismaTransactionManager` also has `isInTransaction(): boolean`, which is not on the interface — detect it structurally.
- Produces:
  - `isTicketNumberConflict(error: unknown): boolean`
  - `runWithTicketNumberRetry<T>(txManager: ITransactionManager, work: () => Promise<T>, options?: TicketNumberRetryOptions): Promise<T>`
  - `interface TicketNumberRetryOptions { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }`
  - `TICKET_NUMBER_MAX_ATTEMPTS = 10`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/common/utils/ticket-number-retry.spec.ts`:

```typescript
import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import {
  isTicketNumberConflict,
  runWithTicketNumberRetry,
  TICKET_NUMBER_MAX_ATTEMPTS,
} from './ticket-number-retry';

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function txManager(inTransaction = false): ITransactionManager & { run: jest.Mock } {
  return {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: () => inTransaction,
  } as unknown as ITransactionManager & { run: jest.Mock };
}

const noSleep = { sleep: jest.fn(() => Promise.resolve()), random: () => 0 };

describe('isTicketNumberConflict', () => {
  it('matches P2002 with an array target containing number', () => {
    expect(isTicketNumberConflict(p2002(['projectId', 'number']))).toBe(true);
  });

  it('matches P2002 with a constraint-name target containing number', () => {
    expect(isTicketNumberConflict(p2002('Ticket_projectId_number_key'))).toBe(true);
  });

  it('ignores P2002 on another unique constraint', () => {
    expect(isTicketNumberConflict(p2002(['externalVcsId']))).toBe(false);
  });

  it('ignores non-Prisma errors and other codes', () => {
    expect(isTicketNumberConflict(new Error('boom'))).toBe(false);
    const p2025 = new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' });
    expect(isTicketNumberConflict(p2025)).toBe(false);
  });
});

describe('runWithTicketNumberRetry', () => {
  it('returns the first successful result, one transaction per attempt', async () => {
    const tx = txManager();
    const work = jest
      .fn()
      .mockRejectedValueOnce(p2002(['projectId', 'number']))
      .mockResolvedValueOnce('ticket');

    await expect(runWithTicketNumberRetry(tx, work, noSleep)).resolves.toBe('ticket');
    expect(tx.run).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts with a 409', async () => {
    const tx = txManager();
    const work = jest.fn().mockRejectedValue(p2002(['projectId', 'number']));

    const err = await runWithTicketNumberRetry(tx, work, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(tx.run).toHaveBeenCalledTimes(TICKET_NUMBER_MAX_ATTEMPTS);
  });

  it('propagates a P2002 on another constraint untouched and does not retry', async () => {
    const tx = txManager();
    const other = p2002(['externalVcsId']);
    const work = jest.fn().mockRejectedValue(other);

    await expect(runWithTicketNumberRetry(tx, work, noSleep)).rejects.toBe(other);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  it('inside an outer transaction runs once and maps a conflict to 409', async () => {
    const tx = txManager(true);
    const work = jest.fn().mockRejectedValue(p2002(['projectId', 'number']));

    const err = await runWithTicketNumberRetry(tx, work, noSleep).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  it('backs off with jitter growing per attempt', async () => {
    const tx = txManager();
    const sleep = jest.fn(() => Promise.resolve());
    const work = jest
      .fn()
      .mockRejectedValueOnce(p2002(['projectId', 'number']))
      .mockRejectedValueOnce(p2002(['projectId', 'number']))
      .mockResolvedValueOnce('ok');

    await runWithTicketNumberRetry(tx, work, { sleep, random: () => 1 });
    // attempt × (10 + 40 × random): attempt 1 → 50, attempt 2 → 100
    expect(sleep.mock.calls).toEqual([[50], [100]]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bunx jest src/common/utils/ticket-number-retry.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/common/utils/ticket-number-retry.ts`:

```typescript
import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ITransactionManager } from '@nathapp/nestjs-data';

/**
 * Ticket numbers are allocated as MAX(number)+1 per project. On Postgres two
 * concurrent creators can read the same MAX; the @@unique([projectId, number])
 * index rejects the loser with P2002. Postgres aborts the loser's transaction,
 * so the retry must start a NEW transaction — never retry inside the failed one.
 *
 * 10 attempts: N concurrent creators need up to N rounds in the worst case.
 */
export const TICKET_NUMBER_MAX_ATTEMPTS = 10;

export interface TicketNumberRetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function conflict(): HttpException {
  // Koda's 409 convention (no conflict AppException exists in @nathapp/nestjs-common).
  return new HttpException('Ticket number allocation conflicted; retry the request', HttpStatus.CONFLICT);
}

export function isTicketNumberConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.includes('number');
  if (typeof target === 'string') return target.includes('number');
  return false;
}

function isInOuterTransaction(txManager: ITransactionManager): boolean {
  const probe = (txManager as { isInTransaction?: () => boolean }).isInTransaction;
  return typeof probe === 'function' && probe.call(txManager) === true;
}

export async function runWithTicketNumberRetry<T>(
  txManager: ITransactionManager,
  work: () => Promise<T>,
  options: TicketNumberRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  // PrismaTransactionManager.run() joins an active transaction, so a retry
  // there would reuse the aborted transaction. Run once and report 409.
  const maxAttempts = isInOuterTransaction(txManager)
    ? 1
    : (options.maxAttempts ?? TICKET_NUMBER_MAX_ATTEMPTS);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await txManager.run(work);
    } catch (error) {
      if (!isTicketNumberConflict(error)) throw error;
      if (attempt >= maxAttempts) throw conflict();
      await sleep(attempt * Math.round(10 + 40 * random()));
    }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bunx jest src/common/utils/ticket-number-retry.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/utils/ticket-number-retry.ts apps/api/src/common/utils/ticket-number-retry.spec.ts
git commit -m "feat(api): ticket-number allocation retry helper for postgres (M6)"
```

---

### Task 5: Use the helper in all three allocators, prove it under concurrency

**Files:**
- Modify: `apps/api/src/tickets/tickets.service.ts:114-130` (the `txManager.run` block in `create`)
- Modify: `apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts:26-49` (`createTicket`)
- Modify: `apps/api/src/vcs/prisma-vcs.repository.ts:158-195` (`createTicketFromIssue`)
- Modify: `apps/api/src/tickets/tickets.service.spec.ts`, `apps/api/src/vcs/prisma-vcs.repository.spec.ts` (only if existing expectations on `run` call counts break)
- Create: `apps/api/test/integration/tickets/ticket-number-allocation.integration.spec.ts`

**Interfaces:**
- Consumes: `runWithTicketNumberRetry(txManager, work)` from Task 4 (`src/common/utils/ticket-number-retry.ts`).
- Produces: no new public API; the three methods keep their signatures.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/tickets/ticket-number-allocation.integration.spec.ts`:

```typescript
/**
 * M6 — concurrent ticket creation must yield distinct, gapless numbers on
 * Postgres through every allocator (tickets service path, CI webhook, VCS import).
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/tickets/ticket-number-allocation.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '@prisma/client';
import { PrismaCiWebhookRepository } from '../../../src/ci-webhook/prisma-ci-webhook.repository';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { runWithTicketNumberRetry } from '../../../src/common/utils/ticket-number-retry';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const N = 10;

describeIntegration('M6 ticket-number allocation under concurrency', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let txManager: ITransactionManager;
  let ciRepo: PrismaCiWebhookRepository;
  let vcsRepo: PrismaVcsRepository;
  let ticketRepo: PrismaTicketsRepository;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [PrismaCiWebhookRepository, PrismaVcsRepository, PrismaTicketsRepository],
    }).compile();

    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    txManager = module.get<ITransactionManager>(TRANSACTION_MANAGER);
    ciRepo = module.get(PrismaCiWebhookRepository);
    vcsRepo = module.get(PrismaVcsRepository);
    ticketRepo = module.get(PrismaTicketsRepository);
  });

  afterAll(async () => {
    await module?.close();
  });

  async function newProject(key: string): Promise<string> {
    const p = await prisma.client.project.create({
      data: { name: key, slug: key.toLowerCase(), key },
    });
    return p.id;
  }

  async function numbersOf(projectId: string): Promise<number[]> {
    const rows = await prisma.client.ticket.findMany({
      where: { projectId },
      select: { number: true },
      orderBy: { number: 'asc' },
    });
    return rows.map((r) => r.number);
  }

  const expected = Array.from({ length: N }, (_, i) => i + 1);

  it('tickets-service path (repository + helper) allocates 1..N', async () => {
    const projectId = await newProject('SVC');
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runWithTicketNumberRetry(txManager, async () => {
          const last = await ticketRepo.findLastTicketInProject(projectId);
          return ticketRepo.createTicket({
            projectId,
            number: (last?.number ?? 0) + 1,
            type: 'TASK',
            title: `t${i}`,
            description: null,
            status: 'CREATED',
            priority: 'MEDIUM',
            createdByUserId: null,
            createdByAgentId: null,
          });
        }),
      ),
    );
    expect(await numbersOf(projectId)).toEqual(expected);
  });

  it('CI webhook allocator allocates 1..N', async () => {
    const projectId = await newProject('CIW');
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ciRepo.createTicket(projectId, {
          type: 'BUG',
          title: `ci${i}`,
          description: 'd',
          status: 'CREATED',
          priority: 'HIGH',
          gitRefVersion: 'abc',
          gitRefFile: null,
          gitRefLine: null,
        }),
      ),
    );
    expect(await numbersOf(projectId)).toEqual(expected);
  });

  it('VCS import allocator allocates 1..N', async () => {
    const projectId = await newProject('VCS');
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        vcsRepo.createTicketFromIssue(
          { id: projectId },
          {
            number: i + 1,
            title: `issue${i}`,
            body: null,
            authorLogin: 'octo',
            url: `https://example.test/${i}`,
            labels: [],
            createdAt: new Date(),
          },
        ),
      ),
    );
    expect(await numbersOf(projectId)).toEqual(expected);
  });
});
```

The literals match `CreateTicketData` (`src/tickets/domain/ticket.domain.ts:69-79`) and `VcsIssue` (`src/vcs/types.ts:4-12`) at `eb18be6c`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun run test:integration -- test/integration/tickets/ticket-number-allocation.integration.spec.ts`
Expected: the first test PASSES (it already uses the helper); the CI-webhook and VCS tests FAIL with a P2002 / `Unique constraint failed on the fields: (projectId,number)`.

- [ ] **Step 3: Wire the helper into the three allocators**

`apps/api/src/tickets/tickets.service.ts` — replace the false `@design` comment and the `txManager.run` call in `create`:

```typescript
    // @@unique([projectId, number]) rejects concurrent duplicate numbers on
    // Postgres; runWithTicketNumberRetry re-runs the whole transaction (M6).
    const ticket = await runWithTicketNumberRetry(this.txManager, async () => {
      const lastTicket = await this.ticketRepo.findLastTicketInProject(project.id);
      const nextNumber = (lastTicket?.number ?? 0) + 1;

      const creatorKeys = actorForeignKeys(principal, 'createdBy');
      return this.ticketRepo.createTicket({
        projectId: project.id,
        number: nextNumber,
        type: createTicketDto.type,
        title: createTicketDto.title,
        description: createTicketDto.description || null,
        status: TicketStatus.CREATED,
        priority: createTicketDto.priority || Priority.MEDIUM,
        createdByUserId: creatorKeys.createdByUserId,
        createdByAgentId: creatorKeys.createdByAgentId,
      });
    });
```

Add the import: `import { runWithTicketNumberRetry } from '../common/utils/ticket-number-retry';`

`apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts` — `createTicket` body becomes:

```typescript
    return runWithTicketNumberRetry(this.txManager, async () => {
      const lastTicket = await this.prisma.client.ticket.findFirst({
        where: { projectId },
        orderBy: { number: 'desc' },
      });
      const nextNumber = (lastTicket?.number ?? 0) + 1;
      return this.prisma.client.ticket.create({
        data: { projectId, number: nextNumber, ...data },
      });
    });
```

Add the import: `import { runWithTicketNumberRetry } from '../common/utils/ticket-number-retry';`

`apps/api/src/vcs/prisma-vcs.repository.ts` — in `createTicketFromIssue` replace `return this.txManager.run(async () => {` with `return runWithTicketNumberRetry(this.txManager, async () => {` (the closing `});` stays), update its doc comment to "Allocates ticket number as MAX(number)+1 scoped to the project; retried on a concurrent-number conflict (M6).", and add the same import.

- [ ] **Step 4: Run the integration test and the affected unit specs**

Run: `cd apps/api && bun run test:integration -- test/integration/tickets/ticket-number-allocation.integration.spec.ts`
Expected: PASS (3 tests).

Run: `cd apps/api && bunx jest src/tickets src/ci-webhook src/vcs`
Expected: PASS. The unit mocks' `txManager` objects have no `isInTransaction`, so the helper treats them as "not in a transaction" and calls `run` once on success — existing `toHaveBeenCalled()` expectations hold. If an assertion expects an exact call count that now differs, fix the assertion to the helper's documented behavior.

- [ ] **Step 5: Add the unit test for the service's 409 path**

Append to `apps/api/src/tickets/tickets.service.spec.ts` inside the existing `create` describe block. It reuses that file's `service`, `mockTxManager` (line ~116) and `mockUserPrincipal` (line ~26); `mockTicketRepo.findProjectBySlug` already resolves `mockProject` in that file's setup:

```typescript
  it('retries ticket creation on a concurrent-number conflict (M6)', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['projectId', 'number'] },
    });
    mockTxManager.run
      .mockImplementationOnce(() => Promise.reject(conflict))
      .mockImplementation((fn: () => unknown) => fn());

    await service.create('koda', { type: 'TASK', title: 'x' } as CreateTicketDto, mockUserPrincipal);

    expect(mockTxManager.run).toHaveBeenCalledTimes(2);
  });
```

Import `Prisma` from `@prisma/client` if the file does not already. Run: `cd apps/api && bunx jest src/tickets/tickets.service.spec.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tickets apps/api/src/ci-webhook apps/api/src/vcs apps/api/test/integration/tickets/ticket-number-allocation.integration.spec.ts
git commit -m "fix(api): retry ticket-number allocation on concurrent conflicts in all three allocators (M6)"
```

---

### Task 6: Query `GraphNode` instead of the non-existent `code_document` (M14)

`getProjectCodeDocuments` runs raw SQL against `code_document`, a table that never existed, so every `graphify_import` event fails. The real model is `GraphNode` (`schema.prisma`, fields `projectId`, `nodeId`, `label`, `type?`, `sourceFile?`). The graph layer identifies nodes by `nodeId` (`src/rag/graph-store.service.ts:26-27`), so the entity id is `nodeId`.

**Files:**
- Modify: `apps/api/src/rag/prisma-rag.repository.ts:12-17,178-182`
- Create: `apps/api/test/integration/rag/project-code-documents.integration.spec.ts`

**Interfaces:**
- Produces: `getProjectCodeDocuments(projectId: string): Promise<RagCodeDocumentRow[]>` where `RagCodeDocumentRow = { id: string; label: string; type: string; source_file?: string }` — unchanged shape, consumed by `EntityStore.indexGraphifyEntitiesForProject` (`src/rag/entity-store.ts:145-165`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/rag/project-code-documents.integration.spec.ts`:

```typescript
/**
 * M14 — getProjectCodeDocuments must read GraphNode rows (the code_document
 * table never existed).
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/rag/project-code-documents.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaRagRepository.getProjectCodeDocuments (M14)', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaRagRepository;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [PrismaRagRepository],
    }).compile();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    repo = module.get(PrismaRagRepository);
  });

  afterAll(async () => {
    await module?.close();
  });

  it('maps GraphNode rows of the project, including null type/sourceFile', async () => {
    const a = await prisma.client.project.create({ data: { name: 'A', slug: 'gn-a', key: 'GNA' } });
    const b = await prisma.client.project.create({ data: { name: 'B', slug: 'gn-b', key: 'GNB' } });
    await prisma.client.graphNode.createMany({
      data: [
        { projectId: a.id, nodeId: 'mod:auth', label: 'auth module', type: 'code_module', sourceFile: 'src/auth.ts' },
        { projectId: a.id, nodeId: 'note:1', label: 'loose node', type: null, sourceFile: null },
        { projectId: b.id, nodeId: 'mod:other', label: 'other', type: 'code_module', sourceFile: 'x.ts' },
      ],
    });

    const rows = await repo.getProjectCodeDocuments(a.id);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(rows).toHaveLength(2);
    expect(byId['mod:auth']).toEqual({ id: 'mod:auth', label: 'auth module', type: 'code_module', source_file: 'src/auth.ts' });
    expect(byId['note:1']).toEqual({ id: 'note:1', label: 'loose node', type: '', source_file: undefined });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun run test:integration -- test/integration/rag/project-code-documents.integration.spec.ts`
Expected: FAIL — `relation "code_document" does not exist`.

- [ ] **Step 3: Implement**

In `apps/api/src/rag/prisma-rag.repository.ts` replace `getProjectCodeDocuments`:

```typescript
  async getProjectCodeDocuments(projectId: string): Promise<RagCodeDocumentRow[]> {
    // M14: graphify nodes live in GraphNode; the code_document table never existed.
    const nodes = await this.prisma.client.graphNode.findMany({
      where: { projectId },
      select: { nodeId: true, label: true, type: true, sourceFile: true },
      orderBy: { nodeId: 'asc' },
    });
    return nodes.map((node) => ({
      id: node.nodeId,
      label: node.label,
      type: node.type ?? '',
      source_file: node.sourceFile ?? undefined,
    }));
  }
```

Remove the `Prisma` import from that file if it is now unused (`grep -n "Prisma\." apps/api/src/rag/prisma-rag.repository.ts`).

- [ ] **Step 4: Run to verify it passes, plus the rag unit specs**

Run: `cd apps/api && bun run test:integration -- test/integration/rag/project-code-documents.integration.spec.ts && bunx jest src/rag`
Expected: PASS.

- [ ] **Step 5: Confirm no raw SQL remains in src**

Run: `grep -rn '\$queryRaw\|\$executeRaw' apps/api/src --include='*.ts' | grep -v '\.spec\.'`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rag/prisma-rag.repository.ts apps/api/test/integration/rag/project-code-documents.integration.spec.ts
git commit -m "fix(rag): read graphify nodes from GraphNode instead of missing code_document (M14)"
```

---

### Task 7: Keep symbol search case-insensitive on Postgres

**Files:**
- Modify: `apps/api/src/code-intel/prisma-code-intel.repository.ts:159-160`
- Create: `apps/api/test/integration/code-intel/symbol-search-case.integration.spec.ts`

**Interfaces:**
- Consumes/produces: `searchSymbols(projectId, { q?, file?, page?, limit? })` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/code-intel/symbol-search-case.integration.spec.ts`:

```typescript
/**
 * SQLite LIKE was ASCII case-insensitive; Postgres `contains` is not.
 * Symbol search must keep matching regardless of case.
 *
 * Run: cd apps/api && bun run test:integration -- test/integration/code-intel/symbol-search-case.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaCodeIntelRepository } from '../../../src/code-intel/prisma-code-intel.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('symbol search case sensitivity', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaCodeIntelRepository;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [PrismaCodeIntelRepository],
    }).compile();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    repo = module.get(PrismaCodeIntelRepository);

    const project = await prisma.client.project.create({ data: { name: 'S', slug: 'sym', key: 'SYM' } });
    projectId = project.id;
    await prisma.client.symbol.create({
      data: {
        id: 'r1:src/auth/UserService.ts::UserService',
        symbolId: 'src/auth/UserService.ts::UserService',
        projectId,
        repoId: 'r1',
        commitHash: 'abc',
        name: 'UserService',
        kind: 'class',
        file: 'src/auth/UserService.ts',
        startLine: 1,
        endLine: 10,
      },
    });
  });

  afterAll(async () => {
    await module?.close();
  });

  it('matches name regardless of case', async () => {
    const res = await repo.searchSymbols(projectId, { q: 'userservice' });
    expect(res.total).toBe(1);
    expect(res.items[0].name).toBe('UserService');
  });

  it('matches file regardless of case', async () => {
    const res = await repo.searchSymbols(projectId, { file: 'SRC/AUTH' });
    expect(res.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun run test:integration -- test/integration/code-intel/symbol-search-case.integration.spec.ts`
Expected: FAIL — `total` is 0 for both.

- [ ] **Step 3: Implement**

In `apps/api/src/code-intel/prisma-code-intel.repository.ts` `searchSymbols`:

```typescript
    if (q !== undefined) where.name = { contains: q, mode: 'insensitive' };
    if (file !== undefined) where.file = { contains: file, mode: 'insensitive' };
```

Leave `memory` `subject startsWith` and the symbol-id `endsWith` (line ~115) unchanged: they are key matches and case-sensitive is correct (spec).

- [ ] **Step 4: Run to verify it passes, plus code-intel unit specs**

Run: `cd apps/api && bun run test:integration -- test/integration/code-intel/symbol-search-case.integration.spec.ts && bunx jest src/code-intel`
Expected: PASS. If a unit spec asserts the exact `where` object passed to a mocked `findMany`, update it to include `mode: 'insensitive'`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/code-intel/prisma-code-intel.repository.ts apps/api/src/code-intel apps/api/test/integration/code-intel/symbol-search-case.integration.spec.ts
git commit -m "fix(code-intel): keep symbol search case-insensitive on postgres"
```

---

### Task 8: CI and the CLI smoke test on Postgres

**Files:**
- Modify: `.github/workflows/ci.yml` (new `integration` job; `evaluate` and `smoke` jobs gain a Postgres service)
- Modify: `scripts/smoke-test-cli.sh:13,35,86-105,113,169-172`

- [ ] **Step 1: Add the `integration` job**

In `.github/workflows/ci.yml`, after the `test` job, add (copy the checkout / setup-bun / setup-node / cache / install / generate steps verbatim from the `test` job — they are shown in full here):

```yaml
  integration:
    name: integration
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: koda
          POSTGRES_PASSWORD: koda
          POSTGRES_DB: koda_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd "pg_isready -U koda -d koda_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.11"

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Cache bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Generate Prisma client
        run: bun run db:generate

      - name: Generate OPENAPI types
        run: bun run generate:cli

      - name: Integration + e2e (Postgres)
        run: cd apps/api && bun run test:integration
        env:
          DATABASE_URL: postgresql://koda:koda@localhost:5433/koda_test
```

- [ ] **Step 2: Move `evaluate` to Postgres**

Add the same `services.postgres` block to the `evaluate` job but with `POSTGRES_DB: koda_eval` and port `5432:5432`, and replace both `DATABASE_URL:` values in that job with:

```yaml
          DATABASE_URL: ${{ vars.EVAL_DATABASE_URL || 'postgresql://koda:koda@localhost:5432/koda_eval' }}
```

- [ ] **Step 3: Move the smoke script to Postgres**

In `scripts/smoke-test-cli.sh`:

- Replace line 13 `TEST_DB="/tmp/koda-smoke-$$.db"` with:
  ```bash
  SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://koda:koda@localhost:5433/koda_smoke}"
  ```
- In the cleanup (line ~35) replace `rm -f "$TEST_DB" "$API_LOG"` with `rm -f "$API_LOG"`.
- Replace the whole "STEP 2: Migrate DB" body (the `sqlite3` check and the `while ... done < <(find ...)` loop, lines ~86-105) with:
  ```bash
  log "Step 2: Running migrations..."
  if ! (cd "$API_DIR" && DATABASE_URL="$SMOKE_DATABASE_URL" bunx prisma migrate reset --force --skip-seed --skip-generate > /tmp/koda-smoke-migrate-$$.log 2>&1); then
    echo "--- Migration log ---"; cat "/tmp/koda-smoke-migrate-$$.log"; echo "---------------------"
    fail "DB migrations failed"; exit 1
  fi
  ok "DB migrations"
  ```
- Line 113: `DATABASE_URL="file:${TEST_DB}" \` → `DATABASE_URL="$SMOKE_DATABASE_URL" \`
- Replace the ADMIN promotion block (lines ~168-172) with:
  ```bash
  # Promote user to ADMIN (idempotent; the first registered user is already ADMIN on a fresh DB)
  if ! (cd "$API_DIR" && echo "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"id\" = '${USER_ID}';" \
      | DATABASE_URL="$SMOKE_DATABASE_URL" bunx prisma db execute --stdin > /tmp/koda-smoke-promote-$$.log 2>&1); then
    fail "ADMIN promotion failed: $(cat /tmp/koda-smoke-promote-$$.log)"; exit 1
  fi
  ```
  The script's existing re-login step that follows reads the role from the new token, which proves the promotion.
- Update the header comment: "Safe to re-run: resets the Postgres database at SMOKE_DATABASE_URL each run (default: the docker-compose.test.yml instance, db koda_smoke)."

- [ ] **Step 4: Give the `smoke` job a Postgres service**

Add a `services.postgres` block to the `smoke` job (same as Step 1, `POSTGRES_DB: koda_smoke`, ports `5433:5432`) and set on the "Smoke test" step:

```yaml
        env:
          SMOKE_DATABASE_URL: postgresql://koda:koda@localhost:5433/koda_smoke
```

- [ ] **Step 5: Run the smoke test locally**

```bash
cd apps/api && bun run test:db:up && cd ../.. && bash scripts/smoke-test-cli.sh
```

Expected: every step `✓`, final summary 0 failures. (`prisma migrate reset` creates the `koda_smoke` database on the test server if it does not exist.)

- [ ] **Step 6: Validate the workflow file**

Run: `bunx --yes @action-validator/cli .github/workflows/ci.yml` (or, if unavailable, `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`)
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml scripts/smoke-test-cli.sh
git commit -m "ci: run integration, eval and smoke against postgres"
```

---

### Task 9: Web Playwright e2e on Postgres

**Files:**
- Modify: `apps/web/playwright.config.ts:9-10,31-46`

- [ ] **Step 1: Point the API web server at Postgres**

Replace the `E2E_DB` constant with:

```typescript
// Postgres from docker-compose.test.yml (`bun run test:db:up` in apps/api).
// `prisma migrate reset` creates the koda_e2e database if missing.
const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://koda:koda@localhost:5433/koda_e2e';
```

Replace the API `webServer.command` with:

```typescript
      command: `bash -c "bunx prisma migrate reset --force --skip-seed --skip-generate && bun prisma/seed-e2e.ts && bunx nest start"`,
```

and its `env.DATABASE_URL` with `DATABASE_URL: E2E_DATABASE_URL,`.

- [ ] **Step 2: Run the web e2e suite**

```bash
cd apps/api && bun run test:db:up && cd ../web && bun run test:e2e
```

Expected: the same pass/fail set as on SQLite before this branch. To get that baseline, run `git stash && bun run test:e2e; git stash pop` once before editing, or run the suite on `main` in a second checkout. Any new failure is a Postgres difference: fix it with Task 3's rules.

- [ ] **Step 3: Commit**

```bash
git add apps/web/playwright.config.ts
git commit -m "test(web): run playwright e2e api against postgres"
```

---

### Task 10: Runtime compose and docs

**Files:**
- Modify: `docker-compose.yml:13-15,27-28,80+`
- Modify: `docker-compose.dev.yml:10-12,24-27,56+`
- Modify: `.nax/context.md:56`, then regenerate `CLAUDE.md`/`AGENTS.md`
- Modify: `README.md:31,55,183`, `docs/architecture.md:125`

- [ ] **Step 1: Add Postgres to `docker-compose.yml`**

Add a service:

```yaml
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-koda}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-koda}
    volumes:
      - koda_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-koda} -d ${POSTGRES_DB:-koda}"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
```

In the `api` service: delete `DATABASE_PROVIDER: sqlite`; set
`DATABASE_URL: postgresql://${POSTGRES_USER:-koda}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-koda}`; add

```yaml
    depends_on:
      postgres:
        condition: service_healthy
```

Keep the `koda_data:/data` volume (LanceDB still lives at `/data/lancedb`). Add `koda_pg:` under `volumes:` with `driver: local`.

- [ ] **Step 2: Same for `docker-compose.dev.yml`**

Add a `postgres` service identical to Step 1 but with `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-koda}` (dev default), volume `koda_pg_dev`, and publish `"5432:5432"` so `prisma studio` works from the host. In `api`: delete `DATABASE_PROVIDER`, set `DATABASE_URL: postgresql://koda:${POSTGRES_PASSWORD:-koda}@postgres:5432/koda`, add the `depends_on` block, and change its `command` to run migrations first:

```yaml
    command: sh -c "bun install --frozen-lockfile && bun run db:generate --filter=@nathapp/koda-api && (cd apps/api && bunx prisma migrate deploy) && bun run dev --filter=@nathapp/koda-api"
```

- [ ] **Step 3: Validate both compose files**

Run: `POSTGRES_PASSWORD=x docker compose -f docker-compose.yml config -q && docker compose -f docker-compose.dev.yml config -q && docker compose -f docker-compose.test.yml config -q`
Expected: exit 0, no output.

- [ ] **Step 4: Update docs**

- `.nax/context.md:56`: `| Database | Prisma with SQLite default; PostgreSQL/MySQL supported |` → `| Database | Prisma on PostgreSQL 16 |`
- `README.md:31`: `- **Multi-DB** — SQLite (default), PostgreSQL, MySQL via Prisma.` → `- **PostgreSQL** via Prisma.`
- `README.md:55`: `| ORM | Prisma (SQLite / PostgreSQL / MySQL) |` → `| ORM | Prisma (PostgreSQL) |`
- `README.md:183`: `DATABASE_URL="file:./dev.db"        # SQLite default` → `DATABASE_URL="postgresql://koda:koda@localhost:5432/koda"`; add below it a line: `# Tests: bun run test:db:up (Postgres on 5433), then bun run test:integration`
- `docs/architecture.md:125`: `Prisma enums are not used because SQLite is the default provider;` → `Prisma enums are not used (historical SQLite constraint; conversion is tracked debt);`
- `apps/api/.env.example`: `DATABASE_URL=file:./koda.db` → `DATABASE_URL=postgresql://koda:koda@localhost:5432/koda`

Run: `nax generate` from the repo root (regenerates `CLAUDE.md`/`AGENTS.md` from `.nax/context.md`).
Run: `grep -rn "sqlite\|SQLite" README.md docs/architecture.md .nax apps/api/.env.example apps/api/src apps/api/test docker-compose*.yml scripts apps/web/playwright.config.ts | grep -v "historical SQLite"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.dev.yml .nax/context.md CLAUDE.md AGENTS.md README.md docs/architecture.md apps/api/.env.example
git commit -m "docs: postgres is koda's only database; compose runs postgres 16"
```

---

### Task 11: Final verification and hand-off

- [ ] **Step 1: Full local gate**

```bash
cd apps/api && bun run test:db:up && cd ../..
bun run lint && bun run type-check && bun run test
(cd apps/api && bun run test:integration)
bash scripts/smoke-test-cli.sh
```

Expected: all green. Record the counts (suites/tests) for the PR body.

- [ ] **Step 2: Re-verify the closed review items against source**

- M6: `grep -rn "number: 'desc'" apps/api/src --include='*.ts' | grep -v spec` — every hit sits inside a `runWithTicketNumberRetry(` block (open each and confirm).
- M14: `grep -rn "code_document" apps/api/src` — no output.

- [ ] **Step 3: Stop for approval**

Do not push. Report to the user: branch `feat/track1-postgres-baseline`, commit list, test counts, and the two operational steps that need their approval:
1. push + open the PR;
2. the `koda-local` cutover (outside the repo, at `projects/koda/deployments/koda-local`): stop the stack, move `data/koda.db` to `backups/sqlite-final-<date>/`, delete `data/lancedb`, set `POSTGRES_PASSWORD` in its `.env`, switch `backup-db.sh` / `rollback.sh` to `pg_dump` / `pg_restore`, redeploy, run `prisma migrate deploy`, register the bootstrap admin.
