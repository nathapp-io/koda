# @nathapp 4.1.0 + Prisma 7 Implementation Plan (koda PR 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/api` from `@nathapp/nestjs-* ~4.0.3` on Prisma 6 to `@nathapp/nestjs-* ~4.1.0` on Prisma 7.10 without any change in API behaviour.

**Architecture:**
- Prisma 7 generates the client as TypeScript into `apps/api/src/generated/prisma`. That directory is gitignored and rebuilt by `prisma generate`.
- The database URL moves from `schema.prisma` into `apps/api/prisma.config.ts`.
- Every `PrismaClient` takes an `@prisma/adapter-pg` adapter, built in one place: `src/prisma/pg-adapter.ts`. That module also translates Prisma 6's `?schema=` URL parameter, which adapter-pg ignores.
- The 204 files that import `@prisma/client` are rewritten mechanically to the generated client.
- P2002 field matching moves to `getUniqueConstraintTarget` from `@nathapp/nestjs-prisma` 4.1.0, because driver adapters no longer set `meta.target`.

**Tech Stack:** Bun 1.4.2, NestJS 11 + Fastify, `@nathapp/nestjs-prisma` 4.1.0, Prisma 7.10 (`prisma`, `@prisma/client`, `@prisma/adapter-pg`), PostgreSQL 16, Jest 29 + ts-jest.

**Spec:** No separate spec. Requirements come from:
- the core migration guide: `projects/nathapp-nestjs-core/repos/nathapp-nestjs/packages/nestjs-prisma/README.md`, section "Prisma 7 setup";
- the core master plan, rulings R1-R8 and its Probe results: `projects/nathapp-nestjs-core/prisma-7/00-master-plan.md`;
- the user's rulings of 2026-10-08: two PRs; PR 1 = #243 (4.0.3 on Prisma 6), which this branch builds on.

## Global Constraints

- `prisma`, `@prisma/client`, `@prisma/adapter-pg`: exactly `^7.10.0`. The `prisma` npm `latest` dist-tag is `8.0.0-rc.x`, so never run a bare `bun add prisma`. After every install, `bunx prisma --version` must print `7.10.x`.
- `@nathapp/nestjs-*` (all 9 in `apps/api/package.json`): `~4.1.0`.
- Generator: `provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "cjs"`. NestJS builds CommonJS; without `cjs` the build fails with `exports is not defined in ES module scope`.
- Nothing imports `@prisma/client` (an ESLint `no-restricted-imports` rule enforces it). `@prisma/client/runtime/*` would be allowed, but koda needs none.
- `src/generated/prisma/` is never committed and never hand-edited.
- No behaviour change visible through the HTTP API. All existing unit, integration, e2e and web Playwright suites stay green with no assertion edits. The only exceptions are the additions to `prisma-errors.spec.ts` in Task 4 and the `forRootAsync` assertion allowed in Task 3, Step 4.
- **Prisma blocks destructive commands run by an AI agent.** `db push --force-reset` and `migrate reset` refuse unless `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is set. Never set it yourself: STOP and ask the user to run the command (`! <command>`). The jest `globalSetup` already runs `db push --force-reset` on Prisma 6 and passes, so if the first DB run refuses, the cause is this gate, not the upgrade.
- Never `git stash` in this checkout (other sessions share it).
- Building images with `~/koda-wk/scripts/build-images.sh`, deploying to koda-wk, editing `~/koda-wk/docker-compose.yml`, and `git push` each need the user's go at that moment.

## Review Focus

1. **Duplicate email / slug / member / ticket number still returns 409, not 500.** `isUniqueViolation` read `meta.target`, which driver adapters drop; the violated index name now sits at `meta.driverAdapterError.cause.constraint.index`. Pinned by the integration spec in Task 4.
2. **Raw SQL in the scratch-schema migration tests lands in the scratch schema, not `public`.** adapter-pg ignores `?schema=`, and its `schema` option qualifies only Prisma-generated SQL, never `$executeRawUnsafe`. Pinned by probe P4 (Task 1), `createPgAdapter` (Task 2) and the existing `outbox-migration.integration.spec.ts` (Task 3).
3. **The production image starts and answers queries.** The Dockerfile today deletes `@prisma/client/runtime/query_*wasm-base64*`, which is exactly Prisma 7's PostgreSQL query compiler. Pinned by the image smoke in Task 5.
4. **`prisma migrate deploy` still runs inside the api image** (koda-wk `migrate` service). It needs `prisma.config.ts` in the image, and that config must load without the dev-only `prisma` package installed. Pinned by Task 5, Step 4.
5. **A fresh clone can run `bun run test` in `apps/api`.** nax quality commands call it directly, without turbo. Prisma 6's `@prisma/client` postinstall generated the client on `bun install`; Prisma 7 does not. Pinned by the clean-clone check in Task 3, Step 9.

---

## Probe results (filled in by Task 1)

| # | Question | Answer |
|---|---|---|
| P1 | Does `prisma generate` succeed with `DATABASE_URL` unset, when `prisma.config.ts` reads `process.env.DATABASE_URL ?? ''`? || Yes: `env -u DATABASE_URL bunx prisma generate` -> `Generated Prisma Client (7.10.0)`, exit 0 (no placeholder needed). |
| P2 | Does `bun install` run a package's own `postinstall` script? || Yes: a package `postinstall` ran on `bun install` (echo printed). |
| P3 | Which `@prisma/client/runtime/query_compiler_*` file does the generated client load for PostgreSQL? || `query_compiler_fast_bg.postgresql.js` + `query_compiler_fast_bg.postgresql.wasm-base64.js` (the `fast` build; `small` unused). |
| P4 | With `new PrismaPg({ connectionString, options: '-c search_path=s' }, { schema: 's' })`, do an ORM write and `$executeRawUnsafe('CREATE TABLE ...')` both land in schema `s`? || Yes: ORM create and raw `CREATE TABLE` both landed in `probe_s` (`tables in: ["probe_s"]`). |
| P5 | Does `bun install --production` pull `prisma` (a peer of `@prisma/client`) into node_modules? || Yes: Bun auto-installs the `prisma` peer under `--production` (`node_modules/prisma` + `.bin/prisma` present). Harmless; makes the CLI available in the image. |
| P6 | With `TZ=Asia/Singapore`, does `$queryRaw` of a `timestamp(3)` column equal the ORM read of the same row (same epoch ms)? || Yes: `TZ=Asia/Singapore` ORM 1791449260422 == raw 1791449260422. Also: raw `SUM(numeric)` returns a Decimal (`1.2345`). P2002 meta = `driverAdapterError.cause.constraint.index = "Item_email_key"`, no `target`. |
| P7 | Does `generated/prisma/client` export `Prisma.Decimal`, `Prisma.sql`, `Prisma.join`, `Prisma.DbNull`, `Prisma.JsonNull`, `Prisma.TransactionClient`, `Prisma.PrismaClientKnownRequestError`? || All exported: Decimal (internal/class.ts, commonInputTypes.ts); sql, join, DbNull, JsonNull, TransactionClient, PrismaClientKnownRequestError (internal/prismaNamespace.ts). |

---

### Task 0: Preflight

**Files:** none.

- [ ] **Step 1: Check the checkout**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git status -sb && git log --oneline -4
```

Expected: a clean tree on `chore/nathapp-4.1-prisma-7`, branched from `chore/nathapp-4.0.3` (PR #243). If #243 has merged, rebase first: `git fetch && git rebase origin/main`. If the tree is dirty or on another branch, STOP and ask the user.

- [ ] **Step 2: Start the test database and record the baseline**

```bash
cd apps/api && bun run test:db:up
bun run test 2>&1 | grep -E "^Tests:|^Test Suites:"
KODA_DB_TESTS=1 bun run test:integration 2>&1 | grep -E "^Tests:|^Test Suites:"
```

Expected (PR #243 state):
- unit: 386 suites passed, 4207 tests passed;
- integration+e2e: 189 suites passed, 2253 tests passed, 20 skipped.

Keep both lines for the PR description.

---

### Task 1: Probe Prisma 7 behaviour (throwaway, only the table is committed)

The answers decide details in Tasks 2, 3 and 5. Work in a temp directory, never inside the repo.

**Files:** this plan's **Probe results** table only.

- [ ] **Step 1: Build a scratch project**

```bash
P=${TMPDIR:-/tmp}/koda-prisma7-probe && rm -rf $P && mkdir -p $P/prisma && cd $P
cat > package.json <<'EOF'
{ "name": "koda-prisma7-probe", "private": true,
  "dependencies": { "@prisma/client": "^7.10.0", "@prisma/adapter-pg": "^7.10.0" },
  "devDependencies": { "prisma": "^7.10.0", "typescript": "^5.4.0" } }
EOF
cat > prisma/schema.prisma <<'EOF'
generator client {
  provider     = "prisma-client"
  output       = "../generated/prisma"
  moduleFormat = "cjs"
}
datasource db {
  provider = "postgresql"
}
model Item {
  id        String   @id @default(cuid())
  email     String   @unique
  amount    Decimal  @db.Decimal(12, 4)
  createdAt DateTime @default(now())
}
EOF
cat > prisma.config.ts <<'EOF'
import type { PrismaConfig } from 'prisma';
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
} satisfies PrismaConfig;
EOF
bun install && bunx prisma --version | head -3
```

Expected: `prisma 7.10.x`, `@prisma/client 7.10.x`.

- [ ] **Step 2: P1 and P7: generate with no DATABASE_URL, check the exports**

```bash
env -u DATABASE_URL bunx prisma generate; echo "P1 exit=$?"
for s in Decimal 'sql' 'join' DbNull JsonNull TransactionClient PrismaClientKnownRequestError; do
  printf "%s: " "$s"; grep -rl "export.*\b$s\b\|\b$s\b *[:=]" generated/prisma | head -1 || echo MISSING
done
```

Record P1, and P7 per name. If P1 fails, write down the error; Task 3 then uses the placeholder URL `postgresql://placeholder@localhost:5432/placeholder` instead of `''`. Re-run this step with the placeholder and confirm `exit=0`.

- [ ] **Step 3: P3: which query compiler the generated client loads**

```bash
grep -rhoE "query_compiler_[a-z]+_bg\.postgresql[a-zA-Z0-9.-]*" generated/prisma | sort -u
```

Record the file name(s).

- [ ] **Step 4: P4 and P6, plus the P2002 shape, against the compose test DB**

`DATABASE_URL` is the compose test database: copy the `DATABASE_URL` line from `apps/api/.env.test`.

```bash
export DATABASE_URL='<value of DATABASE_URL in apps/api/.env.test>'
cat > probe.ts <<'EOF'
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
const base = process.env.DATABASE_URL!;
async function main() {
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: base }) });
  await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS probe_s CASCADE');
  await admin.$executeRawUnsafe('CREATE SCHEMA probe_s');
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: base, options: '-c search_path=probe_s' }, { schema: 'probe_s' }),
  });
  await db.$executeRawUnsafe('CREATE TABLE "Item" ("id" text PRIMARY KEY, "email" text UNIQUE NOT NULL, "amount" numeric(12,4) NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT now())');
  const row = await db.item.create({ data: { email: 'a@x.test', amount: '1.2345' } });
  const where = await admin.$queryRawUnsafe<{ table_schema: string }[]>(`SELECT table_schema FROM information_schema.tables WHERE table_name = 'Item'`);
  console.log('P4 tables in:', where.map((r) => r.table_schema));
  const [raw] = await db.$queryRaw<{ createdAt: Date }[]>`SELECT "createdAt" FROM "Item" WHERE "id" = ${row.id}`;
  console.log('P6 orm', row.createdAt.getTime(), 'raw', raw.createdAt.getTime(), 'equal', row.createdAt.getTime() === raw.createdAt.getTime());
  try { await db.item.create({ data: { email: 'a@x.test', amount: '1' } }); } catch (e: any) { console.log('P2002 meta', JSON.stringify(e.meta)); }
  await admin.$executeRawUnsafe('DROP SCHEMA probe_s CASCADE');
  await db.$disconnect(); await admin.$disconnect();
}
main();
EOF
TZ=Asia/Singapore bun probe.ts
```

Expected:
- `P4 tables in: [ 'probe_s' ]`;
- `P6 ... equal true`;
- a P2002 `meta` whose `driverAdapterError.cause.constraint.index` is `"Item_email_key"`.

Record all three. If P4 shows `public`, `options: '-c search_path=...'` does not work: STOP and report to the user before Task 2. If P6 prints `equal false`, STOP and report too: koda's raw-SQL analytics read timestamps.

- [ ] **Step 5: P2 and P5: install behaviour**

```bash
cd $P
node -e "const f='package.json',p=require('./'+f);p.scripts={postinstall:'echo POSTINSTALL_RAN'};require('fs').writeFileSync(f,JSON.stringify(p,null,1))"
rm -rf node_modules && bun install 2>&1 | grep -c POSTINSTALL_RAN
rm -rf node_modules && bun install --production >/dev/null && { ls node_modules | grep -qx prisma && echo "P5 prisma installed" || echo "P5 prisma NOT installed"; }
```

Record P2 (a count ≥ 1 means the script ran) and P5.

- [ ] **Step 6: Commit the table**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git add docs/superpowers/plans/2026-10-08-nathapp-4-1-prisma-7.md
git commit -m "docs(plan): record Prisma 7 probe results"
```

---

### Task 2: `createPgAdapter`: one factory for every database adapter

This task adds only the adapter package and the factory. Nothing uses the factory yet, so the app still runs on Prisma 6 when the task ends.

**Files:**
- Create: `apps/api/src/prisma/pg-adapter.ts`
- Test: `apps/api/src/prisma/pg-adapter.spec.ts`
- Modify: `apps/api/package.json`, `bun.lock` (adds `@prisma/adapter-pg`)

**Interfaces:**
- Produces:
  - `pgAdapterConfig(databaseUrl: string): PgAdapterConfig`, where `interface PgAdapterConfig { connectionString: string; schema?: string }`;
  - `createPgAdapter(databaseUrl: string): PrismaPg`.

  Tasks 3 and 4 call these by exactly these names.

- [ ] **Step 1: Add the adapter package**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda/apps/api
bun add @prisma/adapter-pg@^7.10.0
grep -n '"@prisma/adapter-pg"' package.json
```

- [ ] **Step 2: Write the failing test**

`apps/api/src/prisma/pg-adapter.spec.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { createPgAdapter, pgAdapterConfig } from './pg-adapter';

describe('pgAdapterConfig', () => {
  it('leaves a URL without a schema parameter unchanged', () => {
    const url = 'postgresql://u:p@db:5432/koda';
    expect(pgAdapterConfig(url)).toEqual({ connectionString: new URL(url).toString(), schema: undefined });
  });

  it('moves the Prisma 6 ?schema= parameter out of the connection string', () => {
    const config = pgAdapterConfig('postgresql://u:p@db:5432/koda?schema=scratch_1&sslmode=disable');
    expect(config.schema).toBe('scratch_1');
    expect(new URL(config.connectionString).searchParams.has('schema')).toBe(false);
    expect(new URL(config.connectionString).searchParams.get('sslmode')).toBe('disable');
  });

  it('treats an empty ?schema= as no schema', () => {
    expect(pgAdapterConfig('postgresql://u:p@db:5432/koda?schema=').schema).toBeUndefined();
  });

  it('rejects a schema that is not a plain identifier (it is spliced into search_path)', () => {
    expect(() => pgAdapterConfig('postgresql://u:p@db:5432/koda?schema=a%3Bdrop')).toThrow(/schema/);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => pgAdapterConfig('not a url')).toThrow();
  });
});

describe('createPgAdapter', () => {
  it('builds a PrismaPg adapter for a plain URL', () => {
    expect(createPgAdapter('postgresql://u:p@db:5432/koda')).toBeInstanceOf(PrismaPg);
  });

  it('builds a PrismaPg adapter for a URL with a schema', () => {
    expect(createPgAdapter('postgresql://u:p@db:5432/koda?schema=scratch_1')).toBeInstanceOf(PrismaPg);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test -- src/prisma/pg-adapter.spec.ts`
Expected: FAIL, `Cannot find module './pg-adapter'`.

- [ ] **Step 4: Implement**

`apps/api/src/prisma/pg-adapter.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PgAdapterConfig {
  connectionString: string;
  schema?: string;
}

/**
 * Prisma 6 read the target schema from a `?schema=` URL parameter; adapter-pg ignores it. Take it
 * out of the URL so it can be applied as the adapter `schema` option plus the connection
 * `search_path` (the option alone qualifies only Prisma-generated SQL, not raw SQL).
 */
export function pgAdapterConfig(databaseUrl: string): PgAdapterConfig {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') || undefined;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`DATABASE_URL schema parameter is not a plain identifier: ${schema}`);
  }
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

/** The only place koda builds a database adapter; every PrismaClient takes one. */
export function createPgAdapter(databaseUrl: string): PrismaPg {
  const { connectionString, schema } = pgAdapterConfig(databaseUrl);
  if (schema === undefined) return new PrismaPg({ connectionString });
  return new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema });
}
```

- [ ] **Step 5: Run the test, then the unit suite**

```bash
bun run test -- src/prisma/pg-adapter.spec.ts
bun run type-check && bun run lint && bun run test 2>&1 | grep -E "^FAIL |^Tests:"
```

Expected: 7 new tests pass; the unit total is the Task 0 baseline + 7, no failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git add apps/api/src/prisma apps/api/package.json bun.lock
git commit -m "feat(api): createPgAdapter, the single pg driver-adapter factory for Prisma 7"
```

---

### Task 3: Switch to Prisma 7 and @nathapp 4.1.0

The generator switch empties `@prisma/client` of every model type, and Prisma 7's `PrismaClient` no longer accepts `datasources`. The import rewrite, the app module and every client construction (including jest's `globalSetup`, which ts-jest compiles even for unit runs) must therefore change in the same task. This is the large mechanical task; its steps are ordered so you can check progress after each one.

**Files:**
- Modify: `apps/api/package.json` (deps, `postinstall`, jest `coveragePathIgnorePatterns`), `bun.lock`
- Modify: `apps/api/prisma/schema.prisma:4-11`
- Create: `apps/api/prisma.config.ts`
- Modify: `.gitignore`, `apps/api/.eslintignore`, `apps/api/.eslintrc.cjs`
- Modify: every `apps/api/{src,test,prisma}/**/*.ts` that imports `@prisma/client` (codemod)
- Modify: `apps/api/src/app.module.ts:73-77` (+ `src/app.module.spec.ts` only if it asserts on `forRoot`)
- Create: `apps/api/test/helpers/test-prisma.ts`
- Modify: `apps/api/test/global-setup.ts:56-66`, `test/helpers/reset-db.ts:24-26`, `test/helpers/migration-schema.ts:43-49`
- Modify: the integration specs listed in Step 7, `apps/api/prisma/seed.ts:17`, `apps/api/prisma/seed-e2e.ts:10`
- Modify: `apps/web/playwright.config.ts:43`

**Interfaces:**
- Consumes: `createPgAdapter(databaseUrl: string): PrismaPg` (Task 2).
- Produces:
  - `apps/api/src/generated/prisma/client`, which exports `PrismaClient`, `Prisma` and every model type under the names `@prisma/client` used under Prisma 6;
  - `testDatabaseUrl(): string`;
  - `createTestPrismaClient(databaseUrl?: string): PrismaClient` from `test/helpers/test-prisma.ts`.

  Task 4 uses `createTestPrismaClient`.

- [ ] **Step 1: Bump dependencies**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda/apps/api
sed -i '' -E 's#("@nathapp/nestjs-[a-z]+"): "~4\.0\.3"#\1: "~4.1.0"#' package.json
bun add @prisma/client@^7.10.0
bun add -d prisma@^7.10.0
bunx prisma --version | head -3
grep -n '"@nathapp/nestjs\|"@prisma/\|"prisma"' package.json
```

Expected:
- nine `~4.1.0` lines;
- `@prisma/client`, `@prisma/adapter-pg` and `prisma` all at `^7.10.0`;
- the CLI prints `7.10.x`.

- [ ] **Step 2: Generator, config and generation on install**

In `apps/api/prisma/schema.prisma`, replace the `generator client` and `datasource db` blocks at the top with:

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}
```

Create `apps/api/prisma.config.ts`. It imports nothing at runtime: the type import is erased, so it also loads in the production image, where `prisma` is not installed. Use the placeholder URL instead of `''` if probe P1 required it.

```ts
import type { PrismaConfig } from 'prisma';

/**
 * Prisma 7 CLI config: schema, migrations and the datasource URL (moved out of schema.prisma).
 * It must not import runtime modules: the api image runs `prisma migrate deploy` without the
 * `prisma` package installed. `.env` is loaded by Bun, by jest's setup or by the container, never here.
 */
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
} satisfies PrismaConfig;
```

In `apps/api/package.json` scripts, add:

```json
"postinstall": "[ ! -f prisma/schema.prisma ] || prisma generate",
```

The guard covers the Docker `installer` stage and the runtime `bun install --production`. Neither has `prisma/schema.prisma`, so the script exits 0 there without calling `prisma`.

Then:

```bash
bun run db:generate && ls src/generated/prisma/client.ts
```

Expected: the file exists.

- [ ] **Step 3: Keep the generated client out of git, lint and coverage**

- Root `.gitignore`: under the existing `apps/cli/src/generated/` line, add `apps/api/src/generated/prisma/`.
- `apps/api/.eslintignore`: add a line `src/generated`.
- `apps/api/.eslintrc.cjs`: add to its `rules` object:

```js
    'no-restricted-imports': ['error', {
      paths: [{ name: '@prisma/client', message: 'Import from the generated client (src/generated/prisma/client) instead.' }],
    }],
```

  If `rules` already has a `no-restricted-imports` entry, merge the `paths` item into it rather than replacing it.

- `apps/api/package.json` jest block: add `"coveragePathIgnorePatterns": ["/node_modules/", "/src/generated/"]`.

- [ ] **Step 4: Rewrite the imports**

Save this codemod outside the repo as `$TMPDIR/rewrite-prisma-imports.cjs`:

```js
// Usage: node rewrite-prisma-imports.cjs <apps/api dir>
// Rewrites `from '@prisma/client'` and `require('@prisma/client')` to the generated client,
// relative to each file. Prints every file it changes.
const fs = require('fs');
const path = require('path');
const apiDir = path.resolve(process.argv[2]);
const target = path.join(apiDir, 'src/generated/prisma/client');
const roots = ['src', 'test', 'prisma', 'scripts'].map((d) => path.join(apiDir, d)).filter((d) => fs.existsSync(d));
const files = [];
(function walk(dirs) {
  for (const d of dirs) for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'generated') walk([p]); }
    else if (p.endsWith('.ts')) files.push(p);
  }
})(roots);
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let rel = path.relative(path.dirname(f), target).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const out = src
    .replace(/from '@prisma\/client';/g, `from '${rel}';`)
    .replace(/require\('@prisma\/client'\)/g, `require('${rel}')`);
  if (out !== src) { fs.writeFileSync(f, out); console.log(path.relative(apiDir, f)); }
}
```

Run it, then check what still names the old package:

```bash
node $TMPDIR/rewrite-prisma-imports.cjs . | wc -l
grep -rn "@prisma/client" src test prisma --include='*.ts' | grep -v "^src/generated/"
```

Expected:
- about 204 files changed;
- the grep prints only comment lines, in `src/tickets/state-machine/ticket-transition-domain-shapes.spec.ts` and `src/vcs/vcs-connection.service.spec.ts`. Leave those comments; they state a design rule.

- [ ] **Step 5: Wire the app module**

In `apps/api/src/app.module.ts`, replace:

```ts
    PrismaModule.forRoot({
      isGlobal: true,
      client: PrismaClient,
      transaction: true,
    }),
```

with:

```ts
    PrismaModule.forRootAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        client: PrismaClient,
        clientOptions: { adapter: createPgAdapter(config.getOrThrow<IDatabaseConfig>(DATABASE_CFG).url) },
        transaction: true,
      }),
    }),
```

Imports:
- add `ConfigService` to the existing `@nestjs/config` import;
- add `import { createPgAdapter } from './prisma/pg-adapter';`;
- add `import { DATABASE_CFG, IDatabaseConfig } from './config/database.config';`, or merge into an existing import of that file.

`forRootAsync` builds the adapter after `ConfigModule` has validated `DATABASE_URL`, not when the file is imported.

- [ ] **Step 6: Test client helper and the shared harness**

Create `apps/api/test/helpers/test-prisma.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPgAdapter } from '../../src/prisma/pg-adapter';

/** DATABASE_URL as exported by jest globalSetup for DB-mode runs. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: DB tests run with KODA_DB_TESTS=1 (globalSetup exports it)');
  return url;
}

/** A PrismaClient on the test database; Prisma 7 needs an adapter for every client. */
export function createTestPrismaClient(databaseUrl: string = testDatabaseUrl()): PrismaClient {
  return new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
}
```

`test/global-setup.ts`, in `prepareSchema`:
- `'bunx prisma db push --force-reset --skip-generate'` becomes `'bunx prisma db push --force-reset'`. Prisma 7 removed `--skip-generate`, and `db push` no longer generates.
- `new PrismaClient({ datasources: { db: { url: databaseUrl } } })` becomes `createTestPrismaClient(databaseUrl)`, with `import { createTestPrismaClient } from './helpers/test-prisma';`.
- Remove the now-unused `PrismaClient` import.

`test/helpers/reset-db.ts`: change the `new PrismaClient({ datasources: { db: { url: databaseUrl } } })` expression to `createTestPrismaClient(databaseUrl)` (import from `./test-prisma`).

`test/helpers/migration-schema.ts`:
- `new PrismaClient({ datasources: { db: { url: baseUrl } } })` becomes `createTestPrismaClient(baseUrl)`;
- `new PrismaClient({ datasources: { db: { url: url.toString() } } })` becomes `createTestPrismaClient(url.toString())`.

That URL still carries `?schema=<scratch>`; `createPgAdapter` turns it into the adapter option plus `search_path` (Review Focus 2). Keep the `PrismaClient` import there if the file's `ScratchSchema` interface still names the type.

- [ ] **Step 7: Rewrite the per-spec constructions and the seeds**

```bash
grep -rln "datasources:\|new PrismaClient()" test prisma --include='*.ts' | sort
```

In each listed file, apply these replacements (any whitespace or line breaks inside the braces):

| Before | After |
|---|---|
| `new PrismaClient()` | `createTestPrismaClient()` |
| `new PrismaClient({ datasources: { db: { url: X } } })` | `createTestPrismaClient(X)` |
| `clientOptions: { datasources: { db: { url: X } } }` | `clientOptions: { adapter: createPgAdapter(X) }` |

Imports, with the relative path depth matching the file:
- `import { createTestPrismaClient } from '../../helpers/test-prisma';`
- `import { createPgAdapter } from '../../../src/prisma/pg-adapter';`

Remove a `PrismaClient` import only where the file no longer uses it, including as a type.

Special cases:
- `test/integration/rag/rag-close-to-search.integration.spec.ts:68` and `test/integration/rag/incremental-graph-diff.integration.spec.ts:98` `require(...)` the generated client and then call `new PrismaClient(...)`. Give that call `{ adapter: createPgAdapter(process.env.DATABASE_URL!) }`, with a static import of `createPgAdapter`.
- `test/integration/outbox/outbox-migration.integration.spec.ts` builds `withSchema(baseUrl, SCHEMA)`. Keep that and pass the URL to `createTestPrismaClient`; the `?schema=` handling is `createPgAdapter`'s job.
- Seeds: `prisma/seed.ts:17` and `prisma/seed-e2e.ts:10` change `new PrismaClient()` to `new PrismaClient({ adapter: createPgAdapter(process.env.DATABASE_URL ?? '') })`, with `import { createPgAdapter } from '../src/prisma/pg-adapter';`. An unset URL fails at `new URL('')` with a clear error, which is the intended failure.

Check that nothing is left:

```bash
grep -rn "datasources:\|new PrismaClient()" src test prisma --include='*.ts' | grep -v "^src/generated/"
```

Expected: no output.

`apps/web/playwright.config.ts:43`: change `bunx prisma migrate reset --force --skip-seed --skip-generate` to `bunx prisma migrate reset --force`. Prisma 7 removed both flags, and `migrate reset` no longer seeds or generates. Keep the `&& bun prisma/seed-e2e.ts && bunx nest start` tail.

- [ ] **Step 8: Run everything**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda/apps/api
bun run type-check && bun run lint && bun run build
bun run test 2>&1 | grep -E "^FAIL |^Tests:|^Test Suites:"
KODA_DB_TESTS=1 bun run test:integration 2>&1 | grep -E "^FAIL |^Tests:|^Test Suites:"
```

Expected:
- type-check, lint and build exit 0;
- unit: the Task 2 total, no failures;
- integration+e2e: the Task 0 baseline (2253 passed / 20 skipped), no failures.

How to read failures:
- A type error on a `Prisma.<name>` or model type is a P7-type gap: the generated client exports that name differently. Import the name the generated client actually exports, and list each rename in the PR description.
- If `src/app.module.spec.ts` asserts on `forRoot`, change only that assertion to `forRootAsync`, keeping its intent (PrismaModule is imported globally).
- If the DB run refuses with a dangerous-AI-action consent message, STOP and ask the user to run `! cd apps/api && KODA_DB_TESTS=1 bun run test:integration` themselves.

Then the web e2e suite, which boots the api through the Playwright `webServer` command:

```bash
cd ../web && bun run test:e2e 2>&1 | tail -15
```

Expected: the same pass count as `main`. Resetting `koda_e2e` needs the user's consent text in `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` (koda trap from S4a): if it refuses, ask the user to run it.

- [ ] **Step 9: Commit, then check a fresh clone (Review Focus 5)**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git add .gitignore bun.lock apps/api apps/web/playwright.config.ts
git status -s | grep -q "src/generated" && echo "STOP: generated client is staged"
git commit -m "chore(api): Prisma 7 + @nathapp 4.1.0 (generated client, prisma.config.ts, pg adapter everywhere)"

D=$(mktemp -d) && git clone -q --branch chore/nathapp-4.1-prisma-7 "$PWD" $D/k
(cd $D/k && bun install >/dev/null 2>&1; ls apps/api/src/generated/prisma/client.ts && echo GENERATED_ON_INSTALL)
rm -rf $D
```

Expected: `GENERATED_ON_INSTALL`.

If it is missing, the workspace `postinstall` did not run. Then:
- In `turbo.json`, set `"dependsOn": ["^build", "db:generate"]` for `test`, `type-check` and `build`.
- In `apps/api/package.json`, change `"test"` to `"bun run db:generate && jest ..."`, keeping the existing jest arguments. Do the same for `"test:scoped"` and `"type-check"`, so nax's direct calls work.
- Commit this as a follow-up (`chore(api): generate the Prisma client before test and type-check`), re-run the clone check with `bun install && cd apps/api && bun run test`, and record which path you took in the PR description.

---

### Task 4: Unique-violation matching without `meta.target`

**Files:**
- Modify: `apps/api/src/common/utils/prisma-errors.ts`
- Test: `apps/api/src/common/utils/prisma-errors.spec.ts`
- Create: `apps/api/test/integration/db/unique-violation.integration.spec.ts`

**Interfaces:**
- Consumes:
  - `getUniqueConstraintTarget(error: unknown): string | string[] | undefined` from `@nathapp/nestjs-prisma` 4.1.0;
  - `createTestPrismaClient()` (Task 3).
- Produces: `isUniqueViolation(error: unknown, field: string): boolean`. The signature is unchanged; its callers are `auth.service.ts:63`, `projects/members/project-members.service.ts:52`, `agents.service.ts:125`, `common/utils/ticket-number-retry.ts:29` and `users/users-admin.service.ts:42`.

Background: Prisma's default index names contain every column, and koda's real names are `User_email_key`, `Agent_slug_key`, `Project_slug_key`, `ProjectMember_projectId_userId_key` and `Ticket_projectId_number_key`. A substring test therefore matches the same fields that `meta.target` used to.

- [ ] **Step 1: Write the failing unit tests**

Append inside the top-level `describe` of `apps/api/src/common/utils/prisma-errors.spec.ts`. Keep the existing `meta.target` cases. The file already imports `Prisma` (rewritten by Task 3) and `isUniqueViolation`:

```ts
  describe('driver-adapter shape (Prisma 7: no meta.target)', () => {
    const adapterError = (constraint: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: {
          modelName: 'User',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: { kind: 'UniqueConstraintViolation', originalCode: '23505', constraint },
          },
        },
      });

    it('matches the field inside the violated index name', () => {
      expect(isUniqueViolation(adapterError({ index: 'User_email_key' }), 'email')).toBe(true);
    });

    it('matches a column of a compound index name', () => {
      expect(isUniqueViolation(adapterError({ index: 'ProjectMember_projectId_userId_key' }), 'userId')).toBe(true);
      expect(isUniqueViolation(adapterError({ index: 'Ticket_projectId_number_key' }), 'number')).toBe(true);
    });

    it('matches a fields array', () => {
      expect(isUniqueViolation(adapterError({ fields: ['slug'] }), 'slug')).toBe(true);
    });

    it('does not match an index on another column', () => {
      expect(isUniqueViolation(adapterError({ index: 'Agent_slug_key' }), 'email')).toBe(false);
    });

    it('is false when the adapter names no constraint', () => {
      expect(isUniqueViolation(adapterError({}), 'email')).toBe(false);
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test -- src/common/utils/prisma-errors.spec.ts`
Expected: the three "matches" tests FAIL, because the current code reads only `meta.target`. The two negative tests pass.

- [ ] **Step 3: Implement**

`apps/api/src/common/utils/prisma-errors.ts`. Keep the generated-client `Prisma` import line exactly as Task 3 rewrote it, and replace the rest:

```ts
import { getUniqueConstraintTarget } from '@nathapp/nestjs-prisma';

/**
 * True for a Postgres unique violation (P2002) on an index covering `field`. Prisma 7 driver
 * adapters name the violated index (`User_email_key`) instead of setting `meta.target`; Prisma's
 * default index names contain every column, so one substring test covers both shapes.
 */
export function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = getUniqueConstraintTarget(error);
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === 'string') return target.includes(field);
  return false;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `bun run test -- src/common/utils/prisma-errors.spec.ts src/common/utils/ticket-number-retry.spec.ts src/auth/auth.service.spec.ts src/users/users-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the integration test on a real adapter error (Review Focus 1)**

`apps/api/test/integration/db/unique-violation.integration.spec.ts`:

```ts
/**
 * isUniqueViolation must recognise a real P2002 raised through the Prisma 7 pg adapter,
 * which reports the violated index name instead of meta.target.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/db/unique-violation.integration.spec.ts
 */
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { isUniqueViolation } from '../../../src/common/utils/prisma-errors';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('isUniqueViolation against a real P2002 (pg adapter)', () => {
  const email = 'unique-violation@koda.test';
  const prisma = createTestPrismaClient();

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('recognises a duplicate User.email and only that field', async () => {
    await prisma.user.create({ data: { email, passwordHash: 'x' } });
    const error = await prisma.user.create({ data: { email, passwordHash: 'x' } }).catch((e: unknown) => e);
    expect(isUniqueViolation(error, 'email')).toBe(true);
    expect(isUniqueViolation(error, 'slug')).toBe(false);
  });
});
```

`User` requires only `email` and `passwordHash`; every other column has a default or is optional.

- [ ] **Step 6: Run it**

Run: `bun run test:scoped test/integration/db/unique-violation.integration.spec.ts`
Expected: PASS (1 test). Check that it ran rather than skipped: the summary says `1 passed`, not `1 skipped`.

- [ ] **Step 7: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git add apps/api/src/common/utils/prisma-errors.ts apps/api/src/common/utils/prisma-errors.spec.ts apps/api/test/integration/db/unique-violation.integration.spec.ts
git commit -m "fix(api): match unique violations through the Prisma 7 adapter constraint name"
```

---

### Task 5: Docker image and npm audit

**Files:**
- Modify: `apps/api/Dockerfile` (builder `RUN` at lines 58-64; final stage at lines 74-104)
- Modify: root `package.json` (`overrides`), `bun.lock`

- [ ] **Step 1: Ship the compiled client; keep the PostgreSQL query compiler**

Builder stage: replace

```dockerfile
    bun run db:generate && \
    bun run build && \
    prisma_client_dir=$(find /app/node_modules/.bun -type d -path '*/node_modules/.prisma/client' | head -n 1) && \
    test -n "$prisma_client_dir" && \
    mkdir -p /tmp/prisma-generated && \
    cp -R "$prisma_client_dir" /tmp/prisma-generated/client
```

with

```dockerfile
    bun run db:generate && \
    bun run build
```

The generated client is TypeScript under `src/generated/prisma`, so `nest build` compiles it into `dist/`, which the final stage already copies.

Final stage:
- Delete the `RUN --mount=from=builder,source=/tmp/prisma-generated ...` block and its "Copy only Prisma generated runtime artifacts" comment.
- In the `bun install --production` block, replace the `find .../@prisma/client/runtime ... -delete` clause with this one, which keeps the PostgreSQL query compiler (probe P3) and deletes the other databases' compilers:

```dockerfile
    find /app/apps/runtime/node_modules/@prisma/client/runtime -type f \
      \( -name 'edge*' -o -name 'react-native*' -o -name 'index-browser*' -o -name '*.mjs' \
         -o \( -name 'query_compiler_*' ! -name '*postgresql*' \) \) \
      -delete
```

If P3 named only one build (`fast` or `small`), also delete the other build's PostgreSQL files: add `-o -name 'query_compiler_<unused>_bg.postgresql*'` inside the parentheses.

- [ ] **Step 2: Ship the Prisma config for in-container migrations**

After the two `COPY --from=builder ... prisma/schema.prisma` / `prisma/migrations` lines, add:

```dockerfile
COPY --from=builder /app/apps/${BUILD_APP}/prisma.config.ts ./prisma.config.ts
```

Add `/app/prisma.config.ts` to the comment above those lines.

- [ ] **Step 3: Audit overrides**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun audit 2>&1 | tail -8 > $TMPDIR/audit-before.txt; cat $TMPDIR/audit-before.txt
```

Add to the root `package.json` (Prisma 7.10 exact-pins vulnerable versions of both, transitively):

```json
"overrides": {
  "deepmerge-ts": "^8.0.2",
  "mysql2": "^3.24.5"
}
```

```bash
bun install && bun audit 2>&1 | tail -8
```

Expected: no high or critical advisory that `main` (PR #243 state) does not already have.

The README's third override, `"js-yaml@^3.13.1": "4.3.2"`, uses npm's version-qualified key. If `bun audit` still reports `js-yaml`, try `"js-yaml": "^4.3.2"`, and keep it only if `bun run build` and the api unit suite stay green. Otherwise leave it out and list the remaining advisory in the PR description.

- [ ] **Step 4: Build the image and smoke it (Review Focus 3 and 4)**

Build the api image without touching `~/koda-wk/.env`, mirroring the arguments of `~/koda-wk/scripts/build-images.sh`:

```bash
docker build -f apps/api/Dockerfile \
  --build-arg BUN_VERSION=1.4.2 --build-arg TURBO_VERSION=2.11.4 \
  --build-arg BUILD_APP=api --build-arg BUILD_APP_PACKAGE=@nathapp/koda-api \
  -t koda-api:prisma7-check .
```

If the build needs the `TURBO_TOKEN` secret mount, copy exactly how `build-images.sh` passes it.

Smoke against a throwaway Postgres. The api's environment comes from the koda-wk compose definition. Write it to a 600-mode temp file and delete it afterwards; never print it:

```bash
E=$(mktemp) && chmod 600 $E
docker compose -f ~/koda-wk/docker-compose.yml config --format json \
  | jq -r '.services.api.environment | to_entries[] | select(.key != "DATABASE_URL") | "\(.key)=\(.value)"' > $E
docker network create p7check
docker run -d --name p7pg --network p7check -e POSTGRES_PASSWORD=p -e POSTGRES_DB=koda postgres:16
sleep 6
docker run --rm --network p7check -e DATABASE_URL=postgresql://postgres:p@p7pg:5432/koda \
  koda-api:prisma7-check bunx --package prisma@7.10.0 prisma migrate deploy; echo "migrate exit=$?"
docker run -d --name p7api --network p7check --env-file $E -e DATABASE_URL=postgresql://postgres:p@p7pg:5432/koda koda-api:prisma7-check
sleep 20
docker exec p7api wget -qO- http://127.0.0.1:3100/api/health; echo
docker logs p7api 2>&1 | grep -iE "error|query_compiler|wasm|adapter" | head
docker rm -f p7api p7pg; docker network rm p7check; rm -f $E
```

Expected:
- `migrate exit=0`, with every migration applied;
- `/api/health` returns JSON with the database check up;
- no `query_compiler`/`wasm`/`adapter` errors in the logs.

Review Focus 3 and 4 both depend on this step. If either fails, fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/Dockerfile package.json bun.lock
git commit -m "build(api): Prisma 7 image (client compiled into dist, keep the pg query compiler, ship prisma.config.ts)"
```

---

### Task 6: Agent guidance, final check, PR

**Files:**
- Modify: `.nax/mono/apps/api/context.md` (line 29, line 208, one new bullet)
- Regenerate (never edit by hand): the `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `codex.md` files that `nax generate` rewrites

- [ ] **Step 1: Update the context source**

In `.nax/mono/apps/api/context.md`:
- Line 29: change ``- Prisma 6 via `@nathapp/nestjs-prisma` `` to ``- Prisma 7 via `@nathapp/nestjs-prisma` 4.1 (driver adapter `@prisma/adapter-pg`)``.
- Line 208: make the sentence read "Tests build the schema with `prisma db push --force-reset`" (Prisma 7 has no `--skip-generate`).
- Under "Important Domain Rules", add:

```markdown
- Prisma 7: import `PrismaClient`, `Prisma` and model types from the generated client
  (`src/generated/prisma/client`; gitignored, rebuilt by `bun run db:generate`), never from `@prisma/client`
  (ESLint blocks it). Build every client through `createPgAdapter(url)` (`src/prisma/pg-adapter.ts`); tests use
  `createTestPrismaClient()` (`test/helpers/test-prisma.ts`). The datasource URL lives in `prisma.config.ts`.
- Unique violations: driver adapters drop `meta.target`. Match fields with `isUniqueViolation` (backed by
  `getUniqueConstraintTarget`), never by reading `error.meta` yourself.
```

If Task 3, Step 9 took the fallback path, also add: ``- After a fresh install, run `bun run db:generate` before `bun run test` (the client is not generated on install).``

- [ ] **Step 2: Regenerate the agent files**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
nax generate && nax generate --all-packages
git status -s
```

Expected: the context source plus the regenerated agent files for `apps/api`. Commit them together:

```bash
git add .nax $(git status -s | awk '/(CLAUDE|AGENTS|GEMINI|codex)\.md$/ {print $2}')
git commit -m "docs(api): Prisma 7 agent guidance"
```

- [ ] **Step 3: Final verification**

```bash
cd apps/api
bun run type-check && bun run lint && bun run build && bun run test 2>&1 | grep -E "^Tests:"
KODA_DB_TESTS=1 bun run test:integration 2>&1 | grep -E "^Tests:|^Test Suites:"
cd ../.. && grep -rn "prisma-client-js\|runtime/library\|skip-generate\|skip-seed\|datasources:" apps --include='*.ts' --include='*.prisma' --include='*.json' --include='Dockerfile' | grep -v node_modules | grep -v "src/generated/"
```

Expected: all green, and the final grep prints nothing.

- [ ] **Step 4: Push and open the PR (ask the user before pushing)**

After the user's go:

```bash
git push -u origin chore/nathapp-4.1-prisma-7
```

Open the PR against `main`, or against `chore/nathapp-4.0.3` if #243 is still open, and say which in the body. Body:
- the probe results table;
- before/after test counts;
- the before/after audit;
- any `Prisma.*` renames from Task 3, Step 8;
- whether Task 3, Step 9 used the fallback;
- the koda-wk deploy steps (Task 7).

---

### Task 7: Deploy to koda-wk (after merge; user go at each step)

**Files:** none in the repo. `~/koda-wk/docker-compose.yml` changes on the host.

- [ ] **Step 1: Point the migrate service at Prisma 7**

With the user's go, change the `migrate` service command in `~/koda-wk/docker-compose.yml` from `["bunx", "--package", "prisma@6.19.2", "prisma", "migrate", "deploy"]` to `["bunx", "--package", "prisma@7.10.0", "prisma", "migrate", "deploy"]`.

- [ ] **Step 2: Build and deploy**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && git switch main && git pull --ff-only
MAIN=$(git rev-parse --short=8 HEAD)
~/koda-wk/scripts/build-images.sh "$MAIN"
~/koda-wk/deploy.sh
```

Expected: `Healthy: http://127.0.0.1:8030 (koda <sha8>)`. `deploy.sh` backs up the database first.

- [ ] **Step 3: Live smoke**

- Log in to the web UI.
- Create a ticket and move it through one transition.
- Register an email that already exists: expect 409.
- Open `/sandbox/fleet` and the notifications bell.
- Check the runner reconnected: in the postgres container, `select name, "lastSeenAt" from "Runner"` shows a fresh time.
- Check `docker compose logs api` has no `PrismaClient`, `adapter`, `query_compiler` or `wasm` errors.

- [ ] **Step 4: Record**

Append a §9.x entry to `projects/koda/koda-fleet-platform-design-2026-09-13.md` with the deployed sha, the backup name and the smoke results, and update the `koda-nathapp-4-upgrade` memory.
