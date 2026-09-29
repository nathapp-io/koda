# Fleet S1 Slice 1 — Protocol, Runner Identity, Repo Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the fleet foundation as one PR on `feat/fleet-s1-slice1-foundation`: a shared protocol package, the runner, enrollment, fleet-repo and activity tables, a `RUNNER` principal that can only reach runner routes, single-use enrollment, admin routes for runners, enrollments, repos and activity, and repo registration that proves the GitHub App or the GitLab token can reach the repo.

**Architecture:** A new `apps/api/src/fleet/` module group (`common/`, `activity/`, `runners/`, `repos/`, `git-broker/`). Runner keys carry a `kr_` prefix and are routed to a runner lookup inside the existing `CombinedAuthGuard`, which fails closed: a runner key only works on routes marked `@RunnerRoute()`, and those routes accept nothing else. Repo registration talks to GitHub and GitLab through a small fleet HTTP client (timeout, no redirects) and signs the GitHub App JWT with `node:crypto`; minted tokens are used once to read the repo and discarded. No jobs, sync or placement yet (slice 2).

**Tech Stack:** NestJS 11 + Fastify + Prisma 6.19 on PostgreSQL 16, `@nathapp/nestjs-*` 3.3.0 (auth, common, data, prisma, throttler), Jest + ts-jest + supertest, Bun 1.4.2 workspaces + Turborepo.

**Spec:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` (§1, §2, §2.1, §2.2, §3.1, §3.4 rows for runners/enrollments/repos/activity, §7.1 registration checks, §8 activity, §13 slice 1).

## Global Constraints

From the spec and the repo rules (`.nax/context.md`, `.nax/mono/apps/api/context.md`); every task includes them.

- API stays single-instance. Postgres only.
- **No Prisma enums** (repo rule; `schema.prisma:17-18`): enum-like columns are `String` with the allowed values in a comment, and the values live as `const` objects in `apps/api/src/common/enums.ts`. This deviates from spec §2, which drew Prisma enums; the repo rule wins.
- New tables may use native `Json` and `String[]`. `BigInt` is new to the schema: every response DTO maps it to `string`, and Swagger declares it `type: String` (spec §2).
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses with i18n prefixes, repository (interface + `Symbol` token in `domain/*.domain.ts`) → service → controller, `txManager.run` for multi-write work.
- User-facing strings: API i18n files `apps/api/src/i18n/{en,zh}/fleet.json` (both languages, same keys).
- Response DTO fields typed with string-literal unions, never a TS `enum` imported from a package (the swagger CLI plugin emits store paths; `apps/api/scripts/check-dist-requires.ts`).
- Contract changes regenerate `openapi.json` and the CLI client in the same PR (Task 12).
- All ten CI checks are required on `main`.
- Secrets never logged, never returned after creation, never stored in plain text: runner keys and enrollment tokens are stored as HMAC-SHA256 hashes under `API_KEY_SECRET` (the agent-key scheme, `agents.service.ts:83-91`).

Plan-level rules:

- Work on `feat/fleet-s1-slice1-foundation` in the main checkout (`repos/koda`), branched from `main` @ `a36adcc6` (spec merged, #155). Nothing else is in development in parallel.
- API specs: `cd apps/api && bun run test:scoped <paths>` (sets `KODA_DB_TESTS=1` for integration paths). Never two DB jest runs at once (each force-resets the test DB). Start the test DB once: `cd apps/api && bun run test:db:up`.
- ts-jest type-checks every spec. After any signature change run `cd apps/api && bunx tsc --noEmit -p tsconfig.json` and fix every broken spec in the same task.
- Integration specs log in several times; login is throttled 5/min. Copy the throttler reset from `test/integration/users/admin-users.integration.spec.ts:41-57` into any suite that logs in more than four times or calls `enroll` more than nine times.
- No emojis. Conventional commits, no attribution trailer.

## Plan decisions beyond the spec

| # | Decision | Why |
|:--|:--|:--|
| D1 | String columns + `common/enums.ts` constants instead of Prisma enums. | Repo rule; spec §2 drew Prisma enums. |
| D2 | Slice 1 creates only `Runner`, `RunnerEnrollment`, `FleetRepo`, `FleetActivity`. `FleetJob`, `FleetJobEvent`, `FleetCommand`, `FleetJobArtifact` and the partial unique index come in slice 2. | YAGNI (spec R1: tables in the phase that uses them). Also: tests build the DB with `prisma db push` (`test/global-setup.ts:32`), so slice 2 must add the partial index to global setup as well; noted there. |
| D3 | The API imports `@nathapp/fleet-protocol` with `import type` only, enforced by a source-guard spec. The supported protocol versions are an API-local constant pinned by a spec against the package constant. | The production image installs only the API's runtime deps and never copies `packages/` (`apps/api/Dockerfile` final stage), so a runtime import would break the image. Type imports are erased by `tsc`. |
| D4 | Runner isolation lives in `CombinedAuthGuard`, driven by `@RunnerRoute()` metadata, and fails closed (throws, never falls back to agent/JWT). Defence in depth: the CASL factory grants a runner nothing, and `actorForeignKeys` throws for a runner. | About 20 call sites treat "not a user" as an agent (auth map, 09-29); a runner must never reach them. |
| D5 | A disabled runner still authenticates (drain: it can finish jobs and receive cancels in slice 2); placement ignores it. Deleting a runner revokes its key. | Mirrors PAUSED agents. Delete is the kill switch. |
| D6 | Add `GET /fleet/runner/me` (runner identity). | Gives the daemon an auth check and lets slice 1 test the runner principal end to end before sync exists. |
| D7 | Enroll body also carries `bootId` and `labels`; stored labels = union of the enrollment preset and the runner's labels. | Spec §2 `Runner.bootId` is required; spec §11 puts labels in the runner config. |
| D8 | Repo-check failures are `422` with a fixed `reason` code; the GitHub App JWT is signed with `node:crypto` (no new dependency); a dedicated `FleetHttpClient` (fetch, `redirect: 'error'`, timeout) is used instead of the VCS `HttpClient` (no timeout, follows redirects) or `OutboundHttpClient` (POST-only, no body). | A token must never follow a redirect; a hung provider must not hang the request. |
| D9 | `GET /fleet/activity` is global-ADMIN only in slice 1. The project-member view (rows for their projects' jobs) arrives with jobs in slice 2. | No job rows exist yet. |
| D10 | Runner and repo delete have no active-job check in slice 1 (no jobs). Slice 2 adds the 409. | Same. |
| D11 (shipped) | A 13th repo-check reason `github_app_key_unreadable` (commit 55b8258b): a set-but-unreadable `GITHUB_APP_PRIVATE_KEY_FILE` or bad PEM is a 422, not a 500. Recorded after merge (#159). |

## Review Focus

1. **A runner key on a non-runner route**, for example `GET /api/projects` with `Authorization: Bearer kr_…`: must be 401, never an agent lookup, never a JWT fallback. And a user JWT or agent key on `/api/fleet/runner/me`: 401. Task 4 (unit) and Task 7 (integration).
2. **Two enrollments racing with one token**: exactly one runner is created, the other gets 401. And an enrollment that fails after consuming the token (duplicate runner name, 409) leaves the token usable. Task 7 (integration).
3. **Malformed or oversized capabilities from an untrusted runner** (not an object, 1 MiB, `protocols: ['ssh']`, `sandbox.available: 'yes'`): 400, nothing stored. Task 5.
4. **A provider API that redirects or hangs**: the request must not follow the redirect (the token would go to the new host) and must give up at `FLEET_HTTP_TIMEOUT_MS` with reason `provider_unreachable`. Task 9.
5. **Owner/name case**: registering `Nathapp-IO/Koda` when GitHub's canonical name is `nathapp-io/koda` stores the canonical form, and a second registration in any case is 409. Task 10.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `packages/fleet-protocol/{package.json,tsconfig.json,src/index.ts}` (new) | Protocol version constant and shared wire types | 1 |
| `apps/api/src/fleet/common/protocol.ts` (new) | API-local supported versions + type re-exports | 1 |
| `apps/api/src/fleet/common/protocol.spec.ts` (new) | Pins the local versions to the package; source guard for type-only imports | 1 |
| `apps/api/src/common/enums.ts` | `FleetProvider`, `FleetActorType` | 2 |
| `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260929120000_fleet_foundation/migration.sql` (new) | Four fleet tables | 2 |
| `apps/api/src/config/fleet.config.ts` (new), `env.validation.ts`, `config-bridge.module.ts`, `app.module.ts` | Fleet config | 3 |
| `apps/api/src/auth/principal/koda-principal.types.ts`, `actor-foreign-keys.ts` | `RunnerPrincipal` arm | 4 |
| `apps/api/src/auth/guards/runner-route.decorator.ts` (new) | `@RunnerRoute()` metadata | 4 |
| `apps/api/src/auth/guards/combined-auth.guard.ts`, `prisma-auth.repository.ts`, `domain/auth.domain.ts`, `casl/koda-casl-ability.factory.ts` | Runner key path, fail-closed isolation | 4 |
| `apps/api/src/fleet/common/fleet-keys.ts`, `capabilities.ts` (new) | Key/token generation and hashing; capability parser | 5 |
| `apps/api/src/fleet/activity/*` (new), `apps/api/src/fleet/fleet.module.ts` (new), `apps/api/src/i18n/{en,zh}/fleet.json` (new) | Activity log, module shell | 6 |
| `apps/api/src/fleet/runners/*` (new) | Enrollment tokens, enroll, runner admin, `/fleet/runner/me` | 7, 8 |
| `apps/api/src/fleet/git-broker/*` (new) | `FleetHttpClient`, `GitHubAppClient`, `GitLabAccessChecker` | 9 |
| `apps/api/src/fleet/repos/*` (new) | Repo registry | 10 |
| `apps/api/test/integration/fleet/*.integration.spec.ts` (new), `apps/api/test/helpers/fake-forge.ts` (new) | End-to-end over HTTP on PG | 7, 8, 10 |
| `openapi.json`, `.nax/mono/apps/api/context.md` | Contract, guidance | 11, 12 |

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Confirm the branch and base**

Run: `git -C repos/koda status -sb && git -C repos/koda log --oneline -1`
Expected: `## feat/fleet-s1-slice1-foundation` and `a36adcc6 docs(fleet): S1 dispatch design spec (#155)`.

- [ ] **Step 2: Start the test DB and record baselines**

```bash
cd apps/api && bun run test:db:up
bun run test 2>&1 | tail -5          # api unit
bunx tsc --noEmit -p tsconfig.json   # must be clean
```
Record the suite/test counts from the unit run in the PR description later ("Baseline").

---

### Task 1: `@nathapp/fleet-protocol` package, type-only in the API

**Files:**
- Create: `packages/fleet-protocol/package.json`, `packages/fleet-protocol/tsconfig.json`, `packages/fleet-protocol/src/index.ts`
- Modify: `apps/api/package.json` (devDependencies)
- Create: `apps/api/src/fleet/common/protocol.ts`, `apps/api/src/fleet/common/protocol.spec.ts`

**Interfaces:**
- Produces (package): `FLEET_PROTOCOL_VERSION: 1`; types `RunnerOs`, `RunnerArch`, `NaxProtocol`, `ProfileNeeds`, `RunnerCapabilities`, `EnrollRequest`, `EnrollResponse`, `RunnerIdentity`.
- Produces (API): `SUPPORTED_FLEET_PROTOCOL_VERSIONS: readonly number[]`, `isSupportedProtocolVersion(v: unknown): v is number`, and `export type { … }` of the package types.

- [ ] **Step 1: Create the package**

`packages/fleet-protocol/package.json`:
```json
{
  "name": "@nathapp/fleet-protocol",
  "version": "0.1.0",
  "private": true,
  "description": "Koda fleet runner <-> server protocol: version constant and wire types",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "type-check": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@nathapp/typescript-config": "workspace:*",
    "typescript": "5.8.3"
  }
}
```

`packages/fleet-protocol/tsconfig.json`:
```json
{
  "extends": "@nathapp/typescript-config/base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*"]
}
```

`packages/fleet-protocol/src/index.ts`:
```ts
/**
 * Koda fleet protocol (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md).
 * Shared by apps/api (type-only) and apps/runner. Bump FLEET_PROTOCOL_VERSION on any
 * incompatible wire change.
 */
export const FLEET_PROTOCOL_VERSION = 1 as const;

export type RunnerOs = 'darwin' | 'linux';
export type RunnerArch = 'arm64' | 'x64';
export type NaxProtocol = 'acp' | 'native';
export type RunnerExecutor = 'host';

export interface ProfileNeeds {
  protocol: NaxProtocol;
  providers: string[];
  sandbox: boolean;
}

export interface RunnerCapabilities {
  nax: { version: string; protocols: NaxProtocol[] };
  sandbox: { available: boolean; probedAt: string; error?: string };
  profiles: Record<string, ProfileNeeds>;
  credentials: Array<{ providerId: string; kind: string; expires?: string }>;
  tools: { git: boolean; gh: boolean; glab: boolean };
  executors: RunnerExecutor[];
}

export interface EnrollRequest {
  enrollmentToken: string;
  name: string;
  os: RunnerOs;
  arch: RunnerArch;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  labels: string[];
  capabilities: RunnerCapabilities;
}

export interface EnrollResponse {
  runnerId: string;
  apiKey: string;
}

export interface RunnerIdentity {
  id: string;
  name: string;
  labels: string[];
  capacity: number;
  enabled: boolean;
}
```

- [ ] **Step 2: Wire it into the API and install**

In `apps/api/package.json` add to `devDependencies` (next to `@nathapp/typescript-config`):
```json
    "@nathapp/fleet-protocol": "workspace:*",
```
Run from the repo root: `bun install`. Expected: `bun.lock` changes; `apps/api/node_modules/@nathapp/fleet-protocol` is a symlink to `packages/fleet-protocol`.

- [ ] **Step 3: Write the failing spec**

`apps/api/src/fleet/common/protocol.spec.ts`:
```ts
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import { SUPPORTED_FLEET_PROTOCOL_VERSIONS, isSupportedProtocolVersion } from './protocol';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('fleet protocol', () => {
  it('supports the package protocol version', () => {
    expect(SUPPORTED_FLEET_PROTOCOL_VERSIONS).toContain(FLEET_PROTOCOL_VERSION);
  });

  it.each([
    [1, true],
    [0, false],
    [2, false],
    ['1', false],
    [1.5, false],
    [undefined, false],
  ])('isSupportedProtocolVersion(%p) is %p', (value, expected) => {
    expect(isSupportedProtocolVersion(value)).toBe(expected);
  });

  // The production image never ships packages/ (apps/api/Dockerfile final stage),
  // so production code may only use erased type imports from the package.
  it('production code imports @nathapp/fleet-protocol with `import type` only', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /^\s*(import|export)\s+(?!type\b)[^;]*from\s+['"]@nathapp\/fleet-protocol['"]/m.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/common/protocol.spec.ts`
Expected: FAIL, cannot find module `./protocol`.

- [ ] **Step 5: Implement**

`apps/api/src/fleet/common/protocol.ts`:
```ts
export type {
  EnrollRequest,
  EnrollResponse,
  NaxProtocol,
  ProfileNeeds,
  RunnerArch,
  RunnerCapabilities,
  RunnerExecutor,
  RunnerIdentity,
  RunnerOs,
} from '@nathapp/fleet-protocol';

/**
 * Protocol versions this API accepts. Kept local (not imported from the package at
 * runtime) because the production image does not ship workspace packages; the spec
 * pins it to FLEET_PROTOCOL_VERSION.
 */
export const SUPPORTED_FLEET_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1]);

export function isSupportedProtocolVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_FLEET_PROTOCOL_VERSIONS.includes(value);
}
```

- [ ] **Step 6: Run the spec and the type check**

Run: `cd apps/api && bun run test:scoped src/fleet/common/protocol.spec.ts && bunx tsc --noEmit -p tsconfig.json && cd ../../packages/fleet-protocol && bun run type-check`
Expected: 8 passed; both type checks clean.

- [ ] **Step 7: Commit**

```bash
git add packages/fleet-protocol apps/api/package.json bun.lock apps/api/src/fleet/common/protocol.ts apps/api/src/fleet/common/protocol.spec.ts
git commit -m "feat(fleet): fleet-protocol package, type-only in the API"
```

---

### Task 2: Enum constants, schema, migration

**Files:**
- Modify: `apps/api/src/common/enums.ts`
- Modify: `apps/api/prisma/schema.prisma` (new models after `MemoryQueryMetric`; `fleetRepos` on `Project`)
- Create: `apps/api/prisma/migrations/20260929120000_fleet_foundation/migration.sql` (generated)
- Test: `apps/api/test/integration/fleet/fleet-schema.integration.spec.ts`

**Interfaces:**
- Produces: `FleetProvider = { GITHUB: 'github', GITLAB: 'gitlab' }`, `FleetActorType = { USER, RUNNER, SYSTEM }` with matching literal types; Prisma models `Runner`, `RunnerEnrollment`, `FleetRepo`, `FleetActivity` (field names below are used verbatim by every later task).

- [ ] **Step 1: Add the enum constants**

Append to `apps/api/src/common/enums.ts`:
```ts
/** Fleet S1: forge of a registered fleet repo (same spelling as VcsConnection.provider). */
export const FleetProvider = {
  GITHUB: 'github',
  GITLAB: 'gitlab',
} as const;
export type FleetProvider = (typeof FleetProvider)[keyof typeof FleetProvider];

/** Fleet S1: who performed a FleetActivity action. */
export const FleetActorType = {
  USER: 'USER',
  RUNNER: 'RUNNER',
  SYSTEM: 'SYSTEM',
} as const;
export type FleetActorType = (typeof FleetActorType)[keyof typeof FleetActorType];
```

- [ ] **Step 2: Add the models**

In `apps/api/prisma/schema.prisma`, add `fleetRepos FleetRepo[]` to the relation list of `model Project` (after `webhookDeliveries WebhookDelivery[]`), then append:
```prisma
// Fleet S1 (docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md §2).
// Slice 1 tables only; jobs, events, commands and artifacts arrive in slice 2.

model Runner {
  id              String   @id @default(cuid())
  name            String   @unique
  apiKeyHash      String   @unique // HMAC-SHA256 of the kr_ key under API_KEY_SECRET
  os              String   // darwin | linux
  arch            String   // arm64 | x64
  labels          String[]
  capacity        Int      @default(1)
  capabilities    Json     // RunnerCapabilities (packages/fleet-protocol)
  daemonVersion   String
  protocolVersion Int
  bootId          String
  enabled         Boolean  @default(true)
  lastSeenAt      DateTime
  createdById     String   // User.id who issued the enrollment token
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model RunnerEnrollment {
  id          String    @id @default(cuid())
  tokenHash   String    @unique // HMAC-SHA256 of the ke_ token under API_KEY_SECRET
  labels      String[]
  expiresAt   DateTime
  usedAt      DateTime?
  runnerId    String?
  createdById String
  createdAt   DateTime  @default(now())

  @@index([createdAt])
}

model FleetRepo {
  id                   String   @id @default(cuid())
  projectId            String
  provider             String   // github | gitlab
  owner                String   // canonical, as returned by the provider
  name                 String   // canonical, as returned by the provider
  defaultBranch        String
  githubInstallationId BigInt?
  createdById          String
  createdAt            DateTime @default(now())

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([provider, owner, name])
  @@index([projectId])
}

model FleetActivity {
  id                String   @id @default(cuid())
  actorType         String   // USER | RUNNER | SYSTEM
  actorId           String
  action            String
  entityType        String   // runner | enrollment | repo (job from slice 2)
  entityId          String
  jobId             String?
  responsibleUserId String?
  payload           Json
  createdAt         DateTime @default(now())

  @@index([entityType, entityId])
  @@index([jobId])
  @@index([createdAt])
}
```

- [ ] **Step 3: Generate the migration from the schema diff**

```bash
cd apps/api
OLD_SCHEMA="$(mktemp)"; git show a36adcc6:apps/api/prisma/schema.prisma > "$OLD_SCHEMA"
mkdir -p prisma/migrations/20260929120000_fleet_foundation
bunx prisma migrate diff --from-schema-datamodel "$OLD_SCHEMA" --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20260929120000_fleet_foundation/migration.sql
bunx prisma validate && bunx prisma generate
```
Open the SQL and check it contains exactly: `CREATE TABLE "Runner"`, `"RunnerEnrollment"`, `"FleetRepo"`, `"FleetActivity"`; `"labels" TEXT[]`; `"capabilities" JSONB NOT NULL`; `"githubInstallationId" BIGINT`; unique indexes `Runner_name_key`, `Runner_apiKeyHash_key`, `RunnerEnrollment_tokenHash_key`, `FleetRepo_provider_owner_name_key`; the `FleetRepo_projectId_fkey` foreign key with `ON DELETE CASCADE`; nothing touching existing tables. Prepend one comment line: `-- Fleet S1 slice 1: runner, enrollment, fleet repo and activity tables.`

- [ ] **Step 4: Write the failing schema spec**

`apps/api/test/integration/fleet/fleet-schema.integration.spec.ts`:
```ts
/**
 * Fleet S1 slice 1 — the four fleet tables exist with their constraints (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schema.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet schema (PG)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const runnerData = (name: string, apiKeyHash: string) => ({
    name,
    apiKeyHash,
    os: 'linux',
    arch: 'x64',
    labels: ['linux', 'gpu'],
    capabilities: { nax: { version: '0.83.0', protocols: ['native'] } },
    daemonVersion: '0.1.0',
    protocolVersion: 1,
    bootId: 'boot-1',
    lastSeenAt: new Date(),
    createdById: 'user-1',
  });

  it('stores labels as an array and capabilities as JSON', async () => {
    const r = await prisma.runner.create({ data: runnerData('r1', 'h1') });
    expect(r.labels).toEqual(['linux', 'gpu']);
    expect(r.capabilities).toEqual({ nax: { version: '0.83.0', protocols: ['native'] } });
    expect(r.capacity).toBe(1);
    expect(r.enabled).toBe(true);
  });

  it('rejects a duplicate runner name and a duplicate key hash', async () => {
    await expect(prisma.runner.create({ data: runnerData('r1', 'h2') })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.runner.create({ data: runnerData('r2', 'h1') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps a BigInt installation id and cascades repos with their project', async () => {
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: {
        projectId: project.id, provider: 'github', owner: 'acme', name: 'app',
        defaultBranch: 'main', githubInstallationId: BigInt('9007199254740993'), createdById: 'user-1',
      },
    });
    expect(repo.githubInstallationId).toBe(BigInt('9007199254740993'));
    await expect(
      prisma.fleetRepo.create({
        data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: 'u' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.project.delete({ where: { id: project.id } });
    expect(await prisma.fleetRepo.count()).toBe(0);
  });
});
```

- [ ] **Step 5: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-schema.integration.spec.ts`
Expected: 3 passed (global setup pushes the new schema). If it fails with "table does not exist", `prisma generate` was not run.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/enums.ts apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260929120000_fleet_foundation apps/api/test/integration/fleet/fleet-schema.integration.spec.ts
git commit -m "feat(fleet): runner, enrollment, fleet repo and activity tables"
```

---

### Task 3: Fleet config

**Files:**
- Create: `apps/api/src/config/fleet.config.ts`, `apps/api/src/config/fleet.config.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts`, `apps/api/src/config/config-bridge.module.ts`, `apps/api/src/app.module.ts:54` (load array), `apps/api/src/common/test-helpers/global-stubs.module.ts` (add a `FLEET_CFG` stub next to the `AUTH_CFG` one at lines 47/100)

**Interfaces:**
- Produces: `FLEET_CFG = 'fleet'`, `IFleetConfig { githubAppId: string | undefined; githubAppPrivateKeyFile: string | undefined; githubAppSlug: string | undefined; enrollmentTtlSec: number; httpTimeoutMs: number }`, `fleetConfig` (registerAs), `isGitHubAppConfigured(cfg: IFleetConfig): boolean`.

- [ ] **Step 1: Write the failing spec**

`apps/api/src/config/fleet.config.spec.ts`:
```ts
import { fleetConfig, isGitHubAppConfigured } from './fleet.config';
import { validate } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'b', API_KEY_SECRET: 'c',
};

describe('fleet config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults the enrollment TTL to 24h and the HTTP timeout to 10s', () => {
    delete process.env.FLEET_ENROLLMENT_TTL_SEC;
    delete process.env.FLEET_HTTP_TIMEOUT_MS;
    const cfg = fleetConfig();
    expect(cfg.enrollmentTtlSec).toBe(86_400);
    expect(cfg.httpTimeoutMs).toBe(10_000);
  });

  it('is GitHub-App-configured only when id, key file and slug are all set', () => {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = '/k.pem';
    delete process.env.GITHUB_APP_SLUG;
    expect(isGitHubAppConfigured(fleetConfig())).toBe(false);
    process.env.GITHUB_APP_SLUG = 'koda-fleet';
    expect(isGitHubAppConfigured(fleetConfig())).toBe(true);
  });

  it.each([
    ['GITHUB_APP_ID', 'abc'],
    ['FLEET_ENROLLMENT_TTL_SEC', '30'],
    ['FLEET_HTTP_TIMEOUT_MS', '0'],
  ])('refuses boot on a bad %s', (key, value) => {
    expect(() => validate({ ...BASE, [key]: value })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts`
Expected: FAIL, cannot find module `./fleet.config`.

- [ ] **Step 3: Implement the config**

`apps/api/src/config/fleet.config.ts`:
```ts
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export const FLEET_CFG = 'fleet';

export interface IFleetConfig {
  githubAppId: string | undefined;
  githubAppPrivateKeyFile: string | undefined;
  githubAppSlug: string | undefined;
  enrollmentTtlSec: number;
  httpTimeoutMs: number;
}

export class FleetConfigSchema {
  @IsOptional() @IsString() GITHUB_APP_ID: string;
  @IsOptional() @IsString() GITHUB_APP_PRIVATE_KEY_FILE: string;
  @IsOptional() @IsString() GITHUB_APP_SLUG: string;
  @IsOptional() @IsString() FLEET_ENROLLMENT_TTL_SEC: string;
  @IsOptional() @IsString() FLEET_HTTP_TIMEOUT_MS: string;
}

export const fleetConfig = registerAs(FLEET_CFG, (): IFleetConfig => {
  validateUtil(process.env, FleetConfigSchema);
  return {
    githubAppId: process.env['GITHUB_APP_ID'] || undefined,
    githubAppPrivateKeyFile: process.env['GITHUB_APP_PRIVATE_KEY_FILE'] || undefined,
    githubAppSlug: process.env['GITHUB_APP_SLUG'] || undefined,
    enrollmentTtlSec: Number.parseInt(process.env['FLEET_ENROLLMENT_TTL_SEC'] ?? '86400', 10),
    httpTimeoutMs: Number.parseInt(process.env['FLEET_HTTP_TIMEOUT_MS'] ?? '10000', 10),
  };
});

export function isGitHubAppConfigured(cfg: IFleetConfig): boolean {
  return Boolean(cfg.githubAppId && cfg.githubAppPrivateKeyFile && cfg.githubAppSlug);
}
```

In `env.validation.ts`, add inside `Joi.object({ … })` after `WEBHOOK_ALLOWED_HOSTS`:
```ts
  // Fleet S1: GitHub App used to broker runner git access (spec §7.1).
  GITHUB_APP_ID: Joi.string().pattern(/^\d+$/).optional(),
  GITHUB_APP_PRIVATE_KEY_FILE: Joi.string().optional(),
  GITHUB_APP_SLUG: Joi.string().pattern(/^[a-z0-9-]+$/).optional(),
  FLEET_ENROLLMENT_TTL_SEC: Joi.number().integer().min(60).max(604_800).optional(),
  FLEET_HTTP_TIMEOUT_MS: Joi.number().integer().min(1000).max(60_000).optional(),
```

In `config-bridge.module.ts`, import `{ FLEET_CFG, IFleetConfig }` and add a provider in the same shape as `VCS_CFG` (lines 40-48):
```ts
    {
      provide: FLEET_CFG,
      useFactory: (cs: ConfigService) => {
        const cfg = cs.get<IFleetConfig>('fleet');
        if (!cfg) throw new Error('ConfigBridgeModule: fleet config not loaded — ensure fleetConfig is in ConfigModule.forRoot load array');
        return cfg;
      },
      inject: [ConfigService],
    },
```
and add `FLEET_CFG` to its `exports`. In `app.module.ts:54` add `fleetConfig` to the `load` array (import from `./config/fleet.config`). In `global-stubs.module.ts`, add a `{ provide: FLEET_CFG, useValue: { githubAppId: undefined, githubAppPrivateKeyFile: undefined, githubAppSlug: undefined, enrollmentTtlSec: 86400, httpTimeoutMs: 10000 } }` provider and export it, following the `AUTH_CFG` entry.

- [ ] **Step 4: Run the specs**

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts src/app.module.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass, type check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config apps/api/src/app.module.ts apps/api/src/common/test-helpers/global-stubs.module.ts
git commit -m "feat(fleet): fleet config (GitHub App, enrollment TTL, HTTP timeout)"
```

---

### Task 4: `RunnerPrincipal` and fail-closed runner route isolation

**Files:**
- Modify: `apps/api/src/auth/principal/koda-principal.types.ts`
- Modify: `apps/api/src/auth/principal/actor-foreign-keys.ts`
- Create: `apps/api/src/auth/guards/runner-route.decorator.ts`
- Modify: `apps/api/src/auth/domain/auth.domain.ts`, `apps/api/src/auth/prisma-auth.repository.ts`
- Modify: `apps/api/src/auth/guards/combined-auth.guard.ts`
- Modify: `apps/api/src/auth/casl/koda-casl-ability.factory.ts:34-39`
- Test: `apps/api/src/auth/guards/combined-auth.guard.spec.ts`, `apps/api/src/auth/principal/actor-foreign-keys.spec.ts` (create if missing), `apps/api/src/auth/casl/koda-casl-ability.factory.spec.ts`
- Create: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`

**Interfaces:**
- Produces: `RunnerPrincipal { actorType: 'runner'; id; name; runnerName; labels: readonly string[]; enabled: boolean; blacklisted; revoked; authorities: [] }`; `KodaPrincipal = UserPrincipal | AgentPrincipal | RunnerPrincipal`; `isRunnerPrincipal()`; `RUNNER_KEY_PREFIX = 'kr_'`; `RUNNER_ROUTE_KEY`; `RunnerRoute()`; `RunnerDomain { id; name; labels: string[]; enabled: boolean }`; `PrismaAuthRepository.findRunnerByKeyHash(hash): Promise<RunnerDomain | null>`; `toRunnerPrincipal(r: RunnerDomain): RunnerPrincipal`; `actorKind(principal: KodaPrincipal): 'user' | 'agent'` (throws for a runner).

Also modify (runner audit, spec §1 "audit every exhaustive match"): `apps/api/src/comments/comments.service.ts:88,131-132`, `apps/api/src/tickets/tickets.service.ts:57`, `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:98,124`. These use plain `isUserPrincipal(p) ? 'user' : 'agent'` ternaries, which `tsc` cannot flag, so a runner would silently be recorded as an agent. `memory.controller.ts:35` already rejects anything that is neither user nor agent, and `memory.controller.ts:18` returns `null` for it; both stay as they are.

Rules this task enforces (spec §1, plan D4, D5):

| Request | Result |
|:--|:--|
| `@Public()` route | allowed, unchanged |
| `kr_` key on a `@RunnerRoute()` route, runner exists | allowed, `request.user` = runner principal (enabled or disabled) |
| `kr_` key on a `@RunnerRoute()` route, unknown key | 401 `fleet.runnerAuth` |
| `kr_` key on any other route | 401 `fleet.runnerAuth`, no agent lookup, no JWT fallback |
| anything else on a `@RunnerRoute()` route (JWT, agent key, no header) | 401 `fleet.runnerAuth` |
| anything else on other routes | existing behaviour (agent key, then JWT) |
| `API_KEY_SECRET` unset and a `kr_` key | 401 (fail closed) |

- [ ] **Step 1: Write the failing guard specs**

In `combined-auth.guard.spec.ts`:
1. Change `makeReflector` so it can answer per metadata key:
```ts
function makeReflector(isPublic = false, isRunnerRoute = false): jest.Mocked<Reflector> {
  return {
    getAllAndOverride: jest.fn((key: string) => (key === IS_PUBLIC_KEY ? isPublic : key === RUNNER_ROUTE_KEY ? isRunnerRoute : undefined)),
  } as unknown as jest.Mocked<Reflector>;
}
```
2. Add `findRunnerByKeyHash` to `makeAuthRepo`:
```ts
function makeAuthRepo(agent: unknown = null, runner: unknown = null): jest.Mocked<PrismaAuthRepository> {
  return {
    findAgentByKeyHash: jest.fn().mockResolvedValue(agent),
    findRunnerByKeyHash: jest.fn().mockResolvedValue(runner),
  } as unknown as jest.Mocked<PrismaAuthRepository>;
}
```
3. Import `RUNNER_ROUTE_KEY` from `./runner-route.decorator` and `AuthException` from `@nathapp/nestjs-common`. Add an `afterEach(() => jest.restoreAllMocks())` so the prototype spy does not leak.
4. Add the block:
```ts
describe('runner keys (fleet)', () => {
  const runnerRow = { id: 'run-1', name: 'mac-1', labels: ['darwin'], enabled: true };
  const superSpy = (guard: CombinedAuthGuard) =>
    jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate').mockResolvedValue(true);

  it('authenticates a kr_ key on a runner route and sets the runner principal', async () => {
    const repo = makeAuthRepo(null, runnerRow);
    const guard = new CombinedAuthGuard(makeReflector(false, true), repo, makeConfig(), makeAgentAuthProvider());
    const jwt = superSpy(guard);
    const request = buildRequest('Bearer kr_' + 'a'.repeat(64));

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(request['user']).toEqual(expect.objectContaining({ actorType: 'runner', id: 'run-1', runnerName: 'mac-1', enabled: true }));
    expect(repo.findAgentByKeyHash).not.toHaveBeenCalled();
    expect(jwt).not.toHaveBeenCalled();
  });

  it('keeps a disabled runner authenticated (drain) and marks it', async () => {
    const guard = new CombinedAuthGuard(makeReflector(false, true), makeAuthRepo(null, { ...runnerRow, enabled: false }), makeConfig(), makeAgentAuthProvider());
    const request = buildRequest('Bearer kr_' + 'b'.repeat(64));
    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(request['user']).toEqual(expect.objectContaining({ enabled: false, blacklisted: false }));
  });

  it('rejects an unknown kr_ key on a runner route with 401', async () => {
    const guard = new CombinedAuthGuard(makeReflector(false, true), makeAuthRepo(null, null), makeConfig(), makeAgentAuthProvider());
    await expect(guard.canActivate(buildContext(buildRequest('Bearer kr_nope')))).rejects.toBeInstanceOf(AuthException);
  });

  it('rejects a kr_ key on a non-runner route without an agent lookup or JWT fallback', async () => {
    const repo = makeAuthRepo({ id: 'agent-1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'x' }, runnerRow);
    const guard = new CombinedAuthGuard(makeReflector(false, false), repo, makeConfig(), makeAgentAuthProvider());
    const jwt = superSpy(guard);
    await expect(guard.canActivate(buildContext(buildRequest('Bearer kr_' + 'c'.repeat(64))))).rejects.toBeInstanceOf(AuthException);
    expect(repo.findAgentByKeyHash).not.toHaveBeenCalled();
    expect(repo.findRunnerByKeyHash).not.toHaveBeenCalled();
    expect(jwt).not.toHaveBeenCalled();
  });

  it.each([
    ['a JWT', 'Bearer aaa.bbb.ccc'],
    ['an agent key', 'Bearer ' + 'd'.repeat(64)],
    ['no credentials', ''],
  ])('rejects %s on a runner route with 401', async (_label, header) => {
    const repo = makeAuthRepo({ id: 'agent-1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'x' }, runnerRow);
    const guard = new CombinedAuthGuard(makeReflector(false, true), repo, makeConfig(), makeAgentAuthProvider());
    const jwt = superSpy(guard);
    await expect(guard.canActivate(buildContext(buildRequest(header)))).rejects.toBeInstanceOf(AuthException);
    expect(repo.findAgentByKeyHash).not.toHaveBeenCalled();
    expect(jwt).not.toHaveBeenCalled();
  });

  it('fails closed on a kr_ key when API_KEY_SECRET is not configured', async () => {
    const guard = new CombinedAuthGuard(makeReflector(false, true), makeAuthRepo(null, runnerRow), makeConfig(''), makeAgentAuthProvider());
    await expect(guard.canActivate(buildContext(buildRequest('Bearer kr_' + 'e'.repeat(64))))).rejects.toBeInstanceOf(AuthException);
  });

  it('still allows public routes marked as runner routes (enroll)', async () => {
    const guard = new CombinedAuthGuard(makeReflector(true, true), makeAuthRepo(), makeConfig(), makeAgentAuthProvider());
    await expect(guard.canActivate(buildContext(buildRequest('')))).resolves.toBe(true);
  });
});
```

`actor-foreign-keys.spec.ts` (add, or create with these imports):
```ts
import { actorForeignKeys } from './actor-foreign-keys';
import { actorKind } from './koda-principal.types';
import type { RunnerPrincipal } from './koda-principal.types';

it('refuses to derive ticket/comment actor columns for a runner', () => {
  const runner = { actorType: 'runner', id: 'r1', name: 'r', runnerName: 'r', labels: [], enabled: true, blacklisted: false, revoked: false, authorities: [] } as RunnerPrincipal;
  expect(() => actorForeignKeys(runner, 'createdBy')).toThrow('runner principals cannot author domain records');
});

it('actorKind maps users and agents and refuses runners', () => {
  const runner = { actorType: 'runner', id: 'r1', name: 'r', runnerName: 'r', labels: [], enabled: true, blacklisted: false, revoked: false, authorities: [] } as RunnerPrincipal;
  expect(actorKind({ actorType: 'user' } as never)).toBe('user');
  expect(actorKind({ actorType: 'agent' } as never)).toBe('agent');
  expect(() => actorKind(runner)).toThrow('runner principals cannot author domain records');
});
```

In `koda-casl-ability.factory.spec.ts` add:
```ts
it('grants a runner principal no permissions', async () => {
  const runner = { actorType: 'runner', id: 'r1', name: 'r', runnerName: 'r', labels: [], enabled: true, blacklisted: false, revoked: false, authorities: [] };
  await expect(factory.getPermissions(runner as never)).resolves.toEqual([]);
});
```
(Use the factory instance the existing spec builds; name it as that spec does.)

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && bun run test:scoped src/auth/guards/combined-auth.guard.spec.ts src/auth/principal src/auth/casl`
Expected: FAIL (missing `RUNNER_ROUTE_KEY`, `findRunnerByKeyHash`, runner behaviour).

- [ ] **Step 3: Implement the principal, decorator and repository lookup**

`koda-principal.types.ts`, add after `AgentPrincipal`:
```ts
export interface RunnerPrincipal extends IPrincipal {
  actorType: 'runner';
  id: string;
  readonly sub?: string;
  runnerName: string;
  labels: readonly string[];
  /** Disabled runners still authenticate so they can drain; placement ignores them. */
  enabled: boolean;
}

export type KodaPrincipal = UserPrincipal | AgentPrincipal | RunnerPrincipal;
```
(replace the old `KodaPrincipal` line) and add:
```ts
export const isRunnerPrincipal = (principal: KodaPrincipal): principal is RunnerPrincipal =>
  principal.actorType === 'runner';
```

Also add to `koda-principal.types.ts`:
```ts
/** Binary actor kind for ticket/comment events. Runners never author domain records. */
export function actorKind(principal: KodaPrincipal): 'user' | 'agent' {
  if (principal.actorType === 'runner') throw new Error('runner principals cannot author domain records');
  return principal.actorType;
}
```
and replace the ternaries at the audit sites:
- `comments.service.ts:88`, `tickets.service.ts:57`, `ticket-transitions.service.ts:98` and `:124`: `const actorType = isUserPrincipal(principal) ? 'user' : 'agent';` becomes `const actorType = actorKind(principal);`
- `comments.service.ts:131-132`: replace the two `authorUserId` / `authorAgentId` lines with `...actorForeignKeys(principal, 'authoredBy'),` (same values; it already imports nothing for this, so add `import { actorForeignKeys } from '../auth/principal/actor-foreign-keys';`).
Remove any `isUserPrincipal` import that becomes unused.

`actor-foreign-keys.ts`, first lines of the implementation signature body:
```ts
  if (principal.actorType === 'runner') {
    throw new Error('runner principals cannot author domain records');
  }
```

`apps/api/src/auth/guards/runner-route.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

/** Runner API keys start with this prefix; agent keys are 64 bare hex characters. */
export const RUNNER_KEY_PREFIX = 'kr_';
export const RUNNER_ROUTE_KEY = 'koda:fleetRunnerRoute';

/**
 * Marks a controller or handler as a fleet runner route. CombinedAuthGuard then
 * accepts only runner keys there, and refuses runner keys everywhere else.
 */
export const RunnerRoute = () => SetMetadata(RUNNER_ROUTE_KEY, true);
```

`auth/domain/auth.domain.ts`, add:
```ts
export interface RunnerDomain {
  id: string;
  name: string;
  labels: string[];
  enabled: boolean;
}
```

`prisma-auth.repository.ts`, add after `findAgentByKeyHash` (import `RunnerDomain`):
```ts
  async findRunnerByKeyHash(keyHash: string): Promise<RunnerDomain | null> {
    const m = await this.db.runner.findUnique({
      where: { apiKeyHash: keyHash },
      select: { id: true, name: true, labels: true, enabled: true },
    });
    return m ?? null;
  }
```

- [ ] **Step 4: Implement the guard**

In `combined-auth.guard.ts`, add imports:
```ts
import { AuthException } from '@nathapp/nestjs-common';
import { RUNNER_KEY_PREFIX, RUNNER_ROUTE_KEY } from './runner-route.decorator';
import type { RunnerDomain } from '../domain/auth.domain';
import type { RunnerPrincipal } from '../principal/koda-principal.types';
```
Replace `canActivate` lines 22-31 (up to the API-key `try`) so the runner branch runs first and outside the swallowing `try/catch`:
```ts
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const clazz = context.getClass();

    const isPublic = this.myReflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, clazz]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    this.combinedLogger.debug(`canActivate: handler=${handler.name}, class=${clazz.name}`);

    // Fleet runner isolation (spec §1): fail closed in both directions, never fall back.
    const isRunnerRoute = this.myReflector.getAllAndOverride<boolean>(RUNNER_ROUTE_KEY, [handler, clazz]) === true;
    const bearer = this.bearerToken(request);
    if (bearer.startsWith(RUNNER_KEY_PREFIX)) {
      if (!isRunnerRoute) throw new AuthException({}, 'fleet.runnerAuth');
      request['user'] = await this.authenticateRunner(bearer);
      return true;
    }
    if (isRunnerRoute) throw new AuthException({}, 'fleet.runnerAuth');
```
(the rest of `canActivate`, from `// Try API Key first`, is unchanged). Add the helpers and reuse `bearerToken` inside `tryApiKey`: replace its lines 62-70 (the request declaration plus the header parsing) with the three lines below. Keep the `request` declaration: line 90 (`request['user'] = …`) still uses it.
```ts
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const rawKey = this.bearerToken(request);
    if (!rawKey) return false;
```
Helpers:
```ts
  private bearerToken(request: Record<string, unknown>): string {
    const headers = request['headers'] as Record<string, string | string[]> | undefined;
    const value = headers?.['authorization'];
    const header = Array.isArray(value) ? value[0] : (value ?? '');
    return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  }

  private async authenticateRunner(rawKey: string): Promise<RunnerPrincipal> {
    const secret = this.authConfig.apiKeySecret;
    if (!secret) {
      this.combinedLogger.error('auth.apiKeySecret not configured');
      throw new AuthException({}, 'fleet.runnerAuth');
    }
    const keyHash = createHmac('sha256', secret).update(rawKey).digest('hex');
    const runner = await this.authRepo.findRunnerByKeyHash(keyHash);
    if (!runner) throw new AuthException({}, 'fleet.runnerAuth');
    return toRunnerPrincipal(runner);
  }
```
and the exported mapper at the bottom of the file:
```ts
export function toRunnerPrincipal(runner: RunnerDomain): RunnerPrincipal {
  return {
    actorType: 'runner',
    id: runner.id,
    name: runner.name,
    runnerName: runner.name,
    labels: runner.labels,
    enabled: runner.enabled,
    blacklisted: false,
    revoked: false,
    authorities: [],
  };
}
```

- [ ] **Step 5: CASL: runners get nothing**

`koda-casl-ability.factory.ts`, import `isRunnerPrincipal` and make `getPermissions`:
```ts
  async getPermissions(principal: KodaPrincipal): Promise<CaslPermission[]> {
    if (isRunnerPrincipal(principal)) return [];
    if (isUserPrincipal(principal)) {
      return this.userPermissions(principal);
    }
    return this.agentPermissions(principal);
  }
```

- [ ] **Step 6: i18n**

`apps/api/src/i18n/en/fleet.json`:
```json
{
  "runnerAuth": { "40000": "Runner authentication failed" },
  "enroll": { "40000": "Enrollment token is invalid, already used or expired" },
  "protocol": { "426": "Unsupported runner protocol version {version}; supported: {supported}" },
  "capabilities": { "-2": "Invalid runner capabilities: {reason}" },
  "runners": { "404": "Runner not found", "409": "A runner with this name already exists" },
  "repos": { "404": "Fleet repository not found", "409": "This repository is already registered" },
  "repoCheck": { "422": "Repository check failed: {reason}" }
}
```
`apps/api/src/i18n/zh/fleet.json`:
```json
{
  "runnerAuth": { "40000": "运行器认证失败" },
  "enroll": { "40000": "注册令牌无效、已使用或已过期" },
  "protocol": { "426": "不支持的运行器协议版本 {version}；支持的版本：{supported}" },
  "capabilities": { "-2": "运行器能力信息无效：{reason}" },
  "runners": { "404": "未找到运行器", "409": "已存在同名运行器" },
  "repos": { "404": "未找到舰队仓库", "409": "该仓库已注册" },
  "repoCheck": { "422": "仓库检查失败：{reason}" }
}
```

- [ ] **Step 7: Run the specs and the type check**

Run: `cd apps/api && bun run test:scoped src/auth src/comments src/tickets && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass (the comment and ticket specs prove the audit edits kept behaviour). If the type check flags an exhaustive `switch` on `actorType`, add a `case 'runner':` that throws `ForbiddenAppException` (the auth map found none, but ts is the authority).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/auth apps/api/src/comments apps/api/src/tickets apps/api/src/i18n/en/fleet.json apps/api/src/i18n/zh/fleet.json
git commit -m "feat(fleet): runner principal with fail-closed runner route isolation"
```

---

### Task 5: Key generation and the capability parser

**Files:**
- Create: `apps/api/src/fleet/common/fleet-keys.ts`, `apps/api/src/fleet/common/fleet-keys.spec.ts`
- Create: `apps/api/src/fleet/common/capabilities.ts`, `apps/api/src/fleet/common/capabilities.spec.ts`

**Interfaces:**
- Consumes: `RUNNER_KEY_PREFIX` (Task 4), `RunnerCapabilities` type (Task 1).
- Produces: `ENROLLMENT_TOKEN_PREFIX = 'ke_'`; `hashSecret(secret: string, raw: string): string`; `generateRunnerKey(secret: string): { raw: string; hash: string }`; `generateEnrollmentToken(secret: string): { raw: string; hash: string }`; `MAX_CAPABILITIES_BYTES = 65_536`; `parseCapabilities(raw: unknown): RunnerCapabilities` (throws `ValidationAppException({ reason }, 'fleet.capabilities')`).

- [ ] **Step 1: Write the failing specs**

`fleet-keys.spec.ts`:
```ts
import { createHmac } from 'crypto';
import { ENROLLMENT_TOKEN_PREFIX, generateEnrollmentToken, generateRunnerKey, hashSecret } from './fleet-keys';
import { RUNNER_KEY_PREFIX } from '../../auth/guards/runner-route.decorator';

describe('fleet keys', () => {
  it('generates a kr_ key of 64 hex chars and its HMAC hash', () => {
    const { raw, hash } = generateRunnerKey('s3cret');
    expect(raw).toMatch(new RegExp(`^${RUNNER_KEY_PREFIX}[0-9a-f]{64}$`));
    expect(hash).toBe(createHmac('sha256', 's3cret').update(raw).digest('hex'));
  });

  it('generates a ke_ enrollment token distinct from runner keys', () => {
    const a = generateEnrollmentToken('s3cret');
    const b = generateEnrollmentToken('s3cret');
    expect(a.raw.startsWith(ENROLLMENT_TOKEN_PREFIX)).toBe(true);
    expect(a.raw).not.toBe(b.raw);
    expect(hashSecret('s3cret', a.raw)).toBe(a.hash);
  });

  it('refuses to generate without a secret', () => {
    expect(() => generateRunnerKey('')).toThrow('API_KEY_SECRET is not configured');
  });
});
```

`capabilities.spec.ts`:
```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseCapabilities } from './capabilities';

const valid = {
  nax: { version: '0.83.0', protocols: ['native', 'acp'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: { native: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [{ providerId: 'deepseek', kind: 'api-key' }],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
};

describe('parseCapabilities', () => {
  it('accepts a valid report and returns a clean copy', () => {
    const parsed = parseCapabilities({ ...valid, extra: 'dropped' });
    expect(parsed).toEqual(valid);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['unknown protocol', { ...valid, nax: { version: '1', protocols: ['ssh'] } }],
    ['string sandbox flag', { ...valid, sandbox: { available: 'yes', probedAt: 'x' } }],
    ['bad profile', { ...valid, profiles: { p: { protocol: 'native', providers: 'deepseek', sandbox: true } } }],
    ['credential with a key field', { ...valid, credentials: [{ providerId: 'x', kind: 'api-key', key: 'sk-1' }] }],
    ['unknown executor', { ...valid, executors: ['vm'] }],
    ['missing tools', { ...valid, tools: undefined }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCapabilities(raw)).toThrow(ValidationAppException);
  });

  it('rejects a report larger than 64 KiB', () => {
    const profiles: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i += 1) profiles[`p${i}`] = { protocol: 'native', providers: ['x'.repeat(30)], sandbox: true };
    expect(() => parseCapabilities({ ...valid, profiles })).toThrow(ValidationAppException);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && bun run test:scoped src/fleet/common`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`fleet-keys.ts`:
```ts
import { createHmac, randomBytes } from 'crypto';
import { RUNNER_KEY_PREFIX } from '../../auth/guards/runner-route.decorator';

export const ENROLLMENT_TOKEN_PREFIX = 'ke_';

/** Same scheme as agent keys (agents.service.ts): HMAC-SHA256 under API_KEY_SECRET. */
export function hashSecret(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function generate(prefix: string, secret: string): { raw: string; hash: string } {
  if (!secret) throw new Error('API_KEY_SECRET is not configured');
  const raw = `${prefix}${randomBytes(32).toString('hex')}`;
  return { raw, hash: hashSecret(secret, raw) };
}

export const generateRunnerKey = (secret: string) => generate(RUNNER_KEY_PREFIX, secret);
export const generateEnrollmentToken = (secret: string) => generate(ENROLLMENT_TOKEN_PREFIX, secret);
```

`capabilities.ts`:
```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { NaxProtocol, ProfileNeeds, RunnerCapabilities } from './protocol';

export const MAX_CAPABILITIES_BYTES = 65_536;
const PROTOCOLS: readonly NaxProtocol[] = ['acp', 'native'];
const EXECUTORS = ['host'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.capabilities');
}

function parseProfile(name: string, v: unknown): ProfileNeeds {
  if (!isObj(v) || !PROTOCOLS.includes(v.protocol as NaxProtocol) || !isStrArray(v.providers) || !isBool(v.sandbox)) {
    fail(`profile ${name}`);
  }
  return { protocol: v.protocol as NaxProtocol, providers: [...(v.providers as string[])], sandbox: v.sandbox as boolean };
}

/** Validates a runner's self-reported capabilities (untrusted input, spec §2.1) and returns a clean copy. */
export function parseCapabilities(raw: unknown): RunnerCapabilities {
  if (!isObj(raw)) fail('not an object');
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CAPABILITIES_BYTES) fail('too large');
  const { nax, sandbox, profiles, credentials, tools, executors } = raw;

  if (!isObj(nax) || !isStr(nax.version) || !Array.isArray(nax.protocols) || !nax.protocols.every((p) => PROTOCOLS.includes(p))) fail('nax');
  if (!isObj(sandbox) || !isBool(sandbox.available) || !isStr(sandbox.probedAt) || (sandbox.error !== undefined && typeof sandbox.error !== 'string')) fail('sandbox');
  if (!isObj(profiles)) fail('profiles');
  if (!Array.isArray(credentials)) fail('credentials');
  if (!isObj(tools) || !isBool(tools.git) || !isBool(tools.gh) || !isBool(tools.glab)) fail('tools');
  if (!Array.isArray(executors) || !executors.every((e) => (EXECUTORS as readonly unknown[]).includes(e))) fail('executors');

  const parsedCredentials = credentials.map((c, i) => {
    if (!isObj(c) || !isStr(c.providerId) || !isStr(c.kind) || (c.expires !== undefined && !isStr(c.expires))) fail(`credential ${i}`);
    const allowed = new Set(['providerId', 'kind', 'expires']);
    if (Object.keys(c).some((k) => !allowed.has(k))) fail(`credential ${i} has unexpected fields`);
    return { providerId: c.providerId as string, kind: c.kind as string, ...(c.expires ? { expires: c.expires as string } : {}) };
  });

  return {
    nax: { version: nax.version as string, protocols: [...(nax.protocols as NaxProtocol[])] },
    sandbox: {
      available: sandbox.available as boolean,
      probedAt: sandbox.probedAt as string,
      ...(sandbox.error !== undefined ? { error: sandbox.error as string } : {}),
    },
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, v]) => [name, parseProfile(name, v)])),
    credentials: parsedCredentials,
    tools: { git: tools.git as boolean, gh: tools.gh as boolean, glab: tools.glab as boolean },
    executors: [...(executors as Array<'host'>)],
  };
}
```

- [ ] **Step 4: Run the specs**

Run: `cd apps/api && bun run test:scoped src/fleet/common`
Expected: all pass. (A credential carrying any field other than `providerId`, `kind`, `expires` is rejected, so a runner can never ship key material into koda.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/common
git commit -m "feat(fleet): runner key/token generation and capability parser"
```

---

### Task 6: Activity log and the fleet module shell

**Files:**
- Create: `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts`, `prisma-fleet-activity.repository.ts`, `fleet-activity.service.ts`, `fleet-activity.service.spec.ts`, `fleet-activity.controller.ts`, `dto/list-fleet-activity.query.ts`, `dto/fleet-activity.dto.ts`, `fleet-activity.module.ts`
- Create: `apps/api/src/fleet/fleet.module.ts`, `apps/api/src/fleet/fleet.module.spec.ts`
- Modify: `apps/api/src/app.module.ts` (imports: add `FleetModule` after `MonitoringModule`)

**Interfaces:**
- Consumes: `FleetActorType` (Task 2).
- Produces: `FLEET_ACTIVITY_REPOSITORY`; `FleetActivityEntry { actorType: FleetActorType; actorId: string; action: string; entityType: 'runner' | 'enrollment' | 'repo'; entityId: string; jobId?: string | null; responsibleUserId?: string | null; payload?: Record<string, unknown> }`; `FleetActivityService.record(entry): Promise<void>` (joins the caller's `txManager.run` transaction automatically, because the Prisma client is transaction-scoped inside `run`); `FleetActivityService.list(filters: { entityType?; entityId?; actorId? }, page: IPageOption): Promise<IPageResult<FleetActivityDto>>`; `FleetActivityModule` exporting `FleetActivityService`; `FleetModule`.

Action names used by later tasks: `enrollment.created`, `runner.enrolled`, `runner.updated`, `runner.deleted`, `repo.created`, `repo.deleted`.

- [ ] **Step 1: Write the failing service spec**

`fleet-activity.service.spec.ts`:
```ts
import { FleetActivityService } from './fleet-activity.service';

describe('FleetActivityService', () => {
  const repo = { create: jest.fn(), findPage: jest.fn() };
  const service = new FleetActivityService(repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('records an entry with defaults for optional fields', async () => {
    await service.record({ actorType: 'USER', actorId: 'u1', action: 'runner.deleted', entityType: 'runner', entityId: 'r1' });
    expect(repo.create).toHaveBeenCalledWith({
      actorType: 'USER', actorId: 'u1', action: 'runner.deleted', entityType: 'runner', entityId: 'r1',
      jobId: null, responsibleUserId: null, payload: {},
    });
  });

  it('never stores secret-looking payload keys', async () => {
    await expect(
      service.record({ actorType: 'USER', actorId: 'u1', action: 'enrollment.created', entityType: 'enrollment', entityId: 'e1', payload: { token: 'ke_x' } }),
    ).rejects.toThrow('activity payload must not contain secrets');
  });

  it('maps a page of rows to DTOs with ISO timestamps', async () => {
    const createdAt = new Date('2026-09-30T00:00:00.000Z');
    repo.findPage.mockResolvedValue({
      total: 1, current: 1, size: 20, hasNext: false, hasPrev: false,
      records: [{ id: 'a1', actorType: 'USER', actorId: 'u1', action: 'repo.created', entityType: 'repo', entityId: 'fr1', jobId: null, responsibleUserId: null, payload: {}, createdAt }],
    });
    const page = await service.list({}, { current: 1, size: 20 });
    expect(page.records[0]).toEqual(expect.objectContaining({ id: 'a1', createdAt: '2026-09-30T00:00:00.000Z' }));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/activity`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement domain, repository, service**

`domain/fleet-activity.domain.ts`:
```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetActorType } from '../../../common/enums';

export const FLEET_ACTIVITY_REPOSITORY = Symbol('FLEET_ACTIVITY_REPOSITORY');

export type FleetEntityType = 'runner' | 'enrollment' | 'repo';

export interface FleetActivityEntry {
  actorType: FleetActorType;
  actorId: string;
  action: string;
  entityType: FleetEntityType;
  entityId: string;
  jobId?: string | null;
  responsibleUserId?: string | null;
  payload?: Record<string, unknown>;
}

export interface FleetActivityRecord {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  jobId: string | null;
  responsibleUserId: string | null;
  payload: unknown;
  createdAt: Date;
}

export interface FleetActivityFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
}

export interface IFleetActivityRepository {
  create(row: Required<Omit<FleetActivityEntry, 'payload'>> & { payload: Record<string, unknown> }): Promise<void>;
  findPage(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityRecord>>;
}
```

`prisma-fleet-activity.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetActivityFilters, FleetActivityRecord, IFleetActivityRepository } from './domain/fleet-activity.domain';

@Injectable()
export class PrismaFleetActivityRepository implements IFleetActivityRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run, so records commit with the caller's writes. */
  private get db() {
    return this.prisma.client;
  }

  async create(row: Parameters<IFleetActivityRepository['create']>[0]): Promise<void> {
    await this.db.fleetActivity.create({ data: { ...row, payload: row.payload as Prisma.InputJsonValue } });
  }

  async findPage(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityRecord>> {
    const where: Prisma.FleetActivityWhereInput = {
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
    };
    const rows = await Paginate(this.db.fleetActivity, page, { where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((m: FleetActivityRecord) => m);
  }
}
```

`dto/fleet-activity.dto.ts`:
```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetActivityRecord } from '../domain/fleet-activity.domain';

export class FleetActivityDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: ['USER', 'RUNNER', 'SYSTEM'] }) declare actorType: 'USER' | 'RUNNER' | 'SYSTEM';
  @ApiProperty() declare actorId: string;
  @ApiProperty() declare action: string;
  @ApiProperty() declare entityType: string;
  @ApiProperty() declare entityId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare jobId: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) declare responsibleUserId: string | null;
  @ApiProperty({ type: Object }) declare payload: Record<string, unknown>;
  @ApiProperty() declare createdAt: string;

  static from(r: FleetActivityRecord): FleetActivityDto {
    return Object.assign(new FleetActivityDto(), {
      id: r.id,
      actorType: r.actorType as FleetActivityDto['actorType'],
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      jobId: r.jobId,
      responsibleUserId: r.responsibleUserId,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    });
  }
}
```

`fleet-activity.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import {
  FLEET_ACTIVITY_REPOSITORY,
  FleetActivityEntry,
  FleetActivityFilters,
  IFleetActivityRepository,
} from './domain/fleet-activity.domain';
import { FleetActivityDto } from './dto/fleet-activity.dto';

const SECRET_KEY = /token|secret|key|password|credential/i;

@Injectable()
export class FleetActivityService {
  constructor(@Inject(FLEET_ACTIVITY_REPOSITORY) private readonly repo: IFleetActivityRepository) {}

  /** Call inside the mutating txManager.run so the row commits or rolls back with it (spec §8). */
  async record(entry: FleetActivityEntry): Promise<void> {
    const payload = entry.payload ?? {};
    if (Object.keys(payload).some((k) => SECRET_KEY.test(k))) {
      throw new Error('activity payload must not contain secrets');
    }
    await this.repo.create({
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      jobId: entry.jobId ?? null,
      responsibleUserId: entry.responsibleUserId ?? null,
      payload,
    });
  }

  async list(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetActivityDto.from);
  }
}
```

- [ ] **Step 4: Controller, query DTO, modules**

`dto/list-fleet-activity.query.ts`:
```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

export class ListFleetActivityQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: ['runner', 'enrollment', 'repo'] })
  @IsOptional() @IsIn(['runner', 'enrollment', 'repo'])
  entityType?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64)
  actorId?: string;
}
```

`fleet-activity.controller.ts`:
```ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { FleetActivityService } from './fleet-activity.service';
import { ListFleetActivityQuery } from './dto/list-fleet-activity.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/activity')
export class FleetActivityController {
  constructor(private readonly activity: FleetActivityService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List fleet activity (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of FleetActivityDto: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 403, description: 'Global admin role required' })
  async list(@Query() rawQuery: ListFleetActivityQuery) {
    const { current, size, entityType, entityId, actorId } = parseQuery(ListFleetActivityQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.activity.list({ entityType, entityId, actorId }, { current, size })));
  }
}
```

`fleet-activity.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityController } from './fleet-activity.controller';
import { FleetActivityService } from './fleet-activity.service';
import { PrismaFleetActivityRepository } from './prisma-fleet-activity.repository';
import { FLEET_ACTIVITY_REPOSITORY } from './domain/fleet-activity.domain';

@Module({
  imports: [PrismaModule],
  controllers: [FleetActivityController],
  providers: [
    PrismaFleetActivityRepository,
    { provide: FLEET_ACTIVITY_REPOSITORY, useExisting: PrismaFleetActivityRepository },
    FleetActivityService,
  ],
  exports: [FleetActivityService],
})
export class FleetActivityModule {}
```

`apps/api/src/fleet/fleet.module.ts` (later tasks add `RunnersModule`, `FleetReposModule`):
```ts
import { Module } from '@nestjs/common';
import { FleetActivityModule } from './activity/fleet-activity.module';

/** Fleet S1 (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md). */
@Module({
  imports: [FleetActivityModule],
})
export class FleetModule {}
```
Add `FleetModule` to `app.module.ts` imports after `MonitoringModule`.

`fleet.module.spec.ts` — copy the `FakeGlobalsModule` from `src/users/users.module.spec.ts:13-27` verbatim, then:
```ts
describe('FleetModule', () => {
  it('compiles with its providers resolvable', async () => {
    const module = await Test.createTestingModule({ imports: [FakeGlobalsModule, FleetModule] }).compile();
    expect(module.get(FleetActivityService)).toBeDefined();
  });
});
```
(later tasks extend this `it` with their services).

- [ ] **Step 5: Run the specs**

Run: `cd apps/api && bun run test:scoped src/fleet src/app.module.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet apps/api/src/app.module.ts
git commit -m "feat(fleet): activity log and fleet module"
```

---

### Task 7: Enrollment tokens, runner enroll, `/fleet/runner/me`

**Files:**
- Create: `apps/api/src/fleet/runners/domain/runner.domain.ts`, `prisma-runner.repository.ts`, `enrollment.service.ts`, `enrollment.service.spec.ts`, `enrollments.controller.ts`, `runner-api.controller.ts`, `runners.module.ts`, `protocol-version.exception.ts`
- Create: `apps/api/src/fleet/runners/dto/{create-enrollment.dto.ts,enrollment.dto.ts,enroll.dto.ts,list-enrollments.query.ts,runner.dto.ts}`
- Modify: `apps/api/src/fleet/fleet.module.ts`, `apps/api/src/fleet/fleet.module.spec.ts`
- Test: `apps/api/test/integration/fleet/runner-enrollment.integration.spec.ts`

**Interfaces:**
- Consumes: `generateEnrollmentToken`, `generateRunnerKey`, `hashSecret` (Task 5); `parseCapabilities` (Task 5); `isSupportedProtocolVersion`, `SUPPORTED_FLEET_PROTOCOL_VERSIONS` (Task 1); `FleetActivityService.record` (Task 6); `RunnerRoute` (Task 4); `AUTH_CFG`, `FLEET_CFG`.
- Produces: `RUNNER_REPOSITORY`, `IRunnerRepository` (below); `RunnerRecord`; `EnrollmentService.create(actorId, labels)`, `.list(page)`, `.enroll(body: EnrollDto)`; `RunnerDto.from(r: RunnerRecord)`; routes `POST/GET /fleet/enrollments`, `POST /fleet/runner/enroll` (public), `GET /fleet/runner/me`.

Enroll rules (spec §3.1, D7): protocol version first (426 when unsupported, before the token is touched); capabilities parsed (400); then one transaction: consume the token with `updateMany … where usedAt IS NULL AND expiresAt > now` (count must be 1, else 401), create the runner (duplicate name → 409 and the whole transaction rolls back, so the token stays usable), link `runnerId`, record `runner.enrolled` with `responsibleUserId` = token issuer.

- [ ] **Step 1: Write the failing service spec**

`enrollment.service.spec.ts`:
```ts
import { AuthException } from '@nathapp/nestjs-common';
import { EnrollmentService } from './enrollment.service';
import { ProtocolVersionException } from './protocol-version.exception';

const caps = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const body = {
  enrollmentToken: 'ke_abc', name: 'mac-1', os: 'darwin', arch: 'arm64', daemonVersion: '0.1.0',
  protocolVersion: 1, bootId: 'boot-1', labels: ['darwin', 'fast'], capabilities: caps,
};

describe('EnrollmentService', () => {
  const repo = {
    createEnrollment: jest.fn(), findEnrollmentPage: jest.fn(), consumeEnrollment: jest.fn(),
    createRunner: jest.fn(), linkEnrollment: jest.fn(),
  };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const service = new EnrollmentService(
    repo as never, activity as never, tx as never,
    { apiKeySecret: 's3cret' } as never, { enrollmentTtlSec: 3600 } as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('issues a ke_ token once, stores only its hash, and records activity', async () => {
    repo.createEnrollment.mockImplementation(async (d) => ({ id: 'e1', labels: d.labels, expiresAt: d.expiresAt, usedAt: null, runnerId: null, createdById: 'u1', createdAt: new Date() }));
    const created = await service.create('u1', ['gpu', 'gpu', 'linux']);
    expect(created.token).toMatch(/^ke_[0-9a-f]{64}$/);
    expect(created.labels).toEqual(['gpu', 'linux']);
    const stored = repo.createEnrollment.mock.calls[0][0];
    expect(stored.tokenHash).not.toContain(created.token);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'enrollment.created', entityId: 'e1', payload: { labels: ['gpu', 'linux'] } }));
  });

  it('rejects an unsupported protocol version before touching the token', async () => {
    await expect(service.enroll({ ...body, protocolVersion: 2 } as never)).rejects.toBeInstanceOf(ProtocolVersionException);
    expect(repo.consumeEnrollment).not.toHaveBeenCalled();
  });

  it('rejects a used, expired or unknown token with 401', async () => {
    repo.consumeEnrollment.mockResolvedValue(null);
    await expect(service.enroll(body as never)).rejects.toBeInstanceOf(AuthException);
    expect(repo.createRunner).not.toHaveBeenCalled();
  });

  it('creates the runner with merged labels and returns a kr_ key once', async () => {
    repo.consumeEnrollment.mockResolvedValue({ id: 'e1', labels: ['gpu', 'darwin'], createdById: 'u1' });
    repo.createRunner.mockImplementation(async (d) => ({ id: 'r1', ...d }));
    const result = await service.enroll(body as never);
    expect(result.apiKey).toMatch(/^kr_[0-9a-f]{64}$/);
    expect(result.runnerId).toBe('r1');
    const data = repo.createRunner.mock.calls[0][0];
    expect(data.labels).toEqual(['darwin', 'fast', 'gpu']);
    expect(data.apiKeyHash).not.toContain(result.apiKey);
    expect(repo.linkEnrollment).toHaveBeenCalledWith('e1', 'r1');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'RUNNER', actorId: 'r1', action: 'runner.enrolled', responsibleUserId: 'u1' }));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/runners`
Expected: FAIL, modules not found.

- [ ] **Step 3: Domain and repository**

`domain/runner.domain.ts`:
```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { RunnerCapabilities } from '../../common/protocol';

export const RUNNER_REPOSITORY = Symbol('RUNNER_REPOSITORY');

export interface EnrollmentRecord {
  id: string;
  labels: string[];
  expiresAt: Date;
  usedAt: Date | null;
  runnerId: string | null;
  createdById: string;
  createdAt: Date;
}

export interface RunnerRecord {
  id: string;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  capacity: number;
  capabilities: unknown;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  enabled: boolean;
  lastSeenAt: Date;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewRunner {
  name: string;
  apiKeyHash: string;
  os: string;
  arch: string;
  labels: string[];
  capabilities: RunnerCapabilities;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  lastSeenAt: Date;
  createdById: string;
}

export interface RunnerPatch {
  enabled?: boolean;
  labels?: string[];
  capacity?: number;
}

export interface IRunnerRepository {
  createEnrollment(data: { tokenHash: string; labels: string[]; expiresAt: Date; createdById: string }): Promise<EnrollmentRecord>;
  findEnrollmentPage(page: IPageOption): Promise<IPageResult<EnrollmentRecord>>;
  /** Atomically marks an unused, unexpired token used; null when none matched. */
  consumeEnrollment(tokenHash: string, now: Date): Promise<Pick<EnrollmentRecord, 'id' | 'labels' | 'createdById'> | null>;
  linkEnrollment(enrollmentId: string, runnerId: string): Promise<void>;
  /** Throws ConflictAppException(fleet.runners) on a duplicate name. */
  createRunner(data: NewRunner): Promise<RunnerRecord>;
  findRunnerById(id: string): Promise<RunnerRecord | null>;
  findRunnerPage(page: IPageOption): Promise<IPageResult<RunnerRecord>>;
  updateRunner(id: string, patch: RunnerPatch): Promise<RunnerRecord>;
  deleteRunner(id: string): Promise<void>;
}
```

`prisma-runner.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { EnrollmentRecord, IRunnerRepository, NewRunner, RunnerPatch, RunnerRecord } from './domain/runner.domain';

const RUNNER_SELECT = {
  id: true, name: true, os: true, arch: true, labels: true, capacity: true, capabilities: true,
  daemonVersion: true, protocolVersion: true, bootId: true, enabled: true, lastSeenAt: true,
  createdById: true, createdAt: true, updatedAt: true,
} as const; // never selects apiKeyHash

@Injectable()
export class PrismaRunnerRepository implements IRunnerRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  createEnrollment(data: { tokenHash: string; labels: string[]; expiresAt: Date; createdById: string }): Promise<EnrollmentRecord> {
    return this.db.runnerEnrollment.create({
      data,
      select: { id: true, labels: true, expiresAt: true, usedAt: true, runnerId: true, createdById: true, createdAt: true },
    });
  }

  async findEnrollmentPage(page: IPageOption): Promise<IPageResult<EnrollmentRecord>> {
    const rows = await Paginate(this.db.runnerEnrollment, page, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, labels: true, expiresAt: true, usedAt: true, runnerId: true, createdById: true, createdAt: true },
    });
    return rows.remap((m: EnrollmentRecord) => m);
  }

  async consumeEnrollment(tokenHash: string, now: Date) {
    const { count } = await this.db.runnerEnrollment.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return null;
    return this.db.runnerEnrollment.findUnique({ where: { tokenHash }, select: { id: true, labels: true, createdById: true } });
  }

  async linkEnrollment(enrollmentId: string, runnerId: string): Promise<void> {
    await this.db.runnerEnrollment.update({ where: { id: enrollmentId }, data: { runnerId } });
  }

  async createRunner(data: NewRunner): Promise<RunnerRecord> {
    try {
      return await this.db.runner.create({
        data: { ...data, capabilities: data.capabilities as unknown as Prisma.InputJsonValue },
        select: RUNNER_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictAppException({}, 'fleet.runners');
      }
      throw error;
    }
  }

  findRunnerById(id: string): Promise<RunnerRecord | null> {
    return this.db.runner.findUnique({ where: { id }, select: RUNNER_SELECT });
  }

  async findRunnerPage(page: IPageOption): Promise<IPageResult<RunnerRecord>> {
    const rows = await Paginate(this.db.runner, page, { orderBy: [{ name: 'asc' }, { id: 'asc' }], select: RUNNER_SELECT });
    return rows.remap((m: RunnerRecord) => m);
  }

  updateRunner(id: string, patch: RunnerPatch): Promise<RunnerRecord> {
    return this.db.runner.update({ where: { id }, data: patch, select: RUNNER_SELECT });
  }

  async deleteRunner(id: string): Promise<void> {
    await this.db.runner.delete({ where: { id } });
  }
}
```
Note for the implementer: confirm `Paginate(delegate, page, { select })` passes `select` through (`@nathapp/nestjs-prisma` `Paginate` forwards its third argument to `findMany`). If it does not, map the full row in `remap` and drop `apiKeyHash` there; the DTO in Step 5 never exposes it either way.

- [ ] **Step 4: Exception, service**

`protocol-version.exception.ts`:
```ts
import { AppException } from '@nathapp/nestjs-common';
import { SUPPORTED_FLEET_PROTOCOL_VERSIONS } from '../common/protocol';

/** 426 Upgrade Required: the runner speaks a protocol version this API does not (spec §1). */
export class ProtocolVersionException extends AppException {
  constructor(version: unknown) {
    super(426, { version: String(version), supported: SUPPORTED_FLEET_PROTOCOL_VERSIONS.join(', ') }, 'fleet.protocol', 426);
  }
}
```

`enrollment.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { AUTH_CFG, IAuthConfig } from '../../config/auth.config';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { remapPage } from '../../common/dto/koda-page.query';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { parseCapabilities } from '../common/capabilities';
import { generateEnrollmentToken, generateRunnerKey, hashSecret } from '../common/fleet-keys';
import { isSupportedProtocolVersion } from '../common/protocol';
import { IRunnerRepository, RUNNER_REPOSITORY } from './domain/runner.domain';
import { EnrollDto } from './dto/enroll.dto';
import { EnrollmentCreatedDto, EnrollmentDto } from './dto/enrollment.dto';
import { ProtocolVersionException } from './protocol-version.exception';

const uniqueSorted = (labels: string[]) => [...new Set(labels)].sort();

@Injectable()
export class EnrollmentService {
  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: IRunnerRepository,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
  ) {}

  async create(actorId: string, labels: string[]): Promise<EnrollmentCreatedDto> {
    const { raw, hash } = generateEnrollmentToken(this.authConfig.apiKeySecret ?? '');
    const cleanLabels = uniqueSorted(labels);
    const expiresAt = new Date(Date.now() + this.fleetConfig.enrollmentTtlSec * 1000);
    const enrollment = await this.txManager.run(async () => {
      const row = await this.repo.createEnrollment({ tokenHash: hash, labels: cleanLabels, expiresAt, createdById: actorId });
      await this.activity.record({ actorType: 'USER', actorId, action: 'enrollment.created', entityType: 'enrollment', entityId: row.id, payload: { labels: cleanLabels } });
      return row;
    });
    return EnrollmentCreatedDto.from(enrollment, raw);
  }

  async list(page: IPageOption): Promise<IPageResult<EnrollmentDto>> {
    return remapPage(await this.repo.findEnrollmentPage(page), EnrollmentDto.from);
  }

  async enroll(body: EnrollDto): Promise<{ runnerId: string; apiKey: string }> {
    if (!isSupportedProtocolVersion(body.protocolVersion)) throw new ProtocolVersionException(body.protocolVersion);
    const capabilities = parseCapabilities(body.capabilities);
    const secret = this.authConfig.apiKeySecret ?? '';
    const tokenHash = hashSecret(secret, body.enrollmentToken);
    const { raw: apiKey, hash: apiKeyHash } = generateRunnerKey(secret);
    const now = new Date();

    const runner = await this.txManager.run(async () => {
      const enrollment = await this.repo.consumeEnrollment(tokenHash, now);
      if (!enrollment) throw new AuthException({}, 'fleet.enroll');
      const created = await this.repo.createRunner({
        name: body.name,
        apiKeyHash,
        os: body.os,
        arch: body.arch,
        labels: uniqueSorted([...enrollment.labels, ...body.labels]),
        capabilities,
        daemonVersion: body.daemonVersion,
        protocolVersion: body.protocolVersion,
        bootId: body.bootId,
        lastSeenAt: now,
        createdById: enrollment.createdById,
      });
      await this.repo.linkEnrollment(enrollment.id, created.id);
      await this.activity.record({
        actorType: 'RUNNER', actorId: created.id, action: 'runner.enrolled', entityType: 'runner', entityId: created.id,
        responsibleUserId: enrollment.createdById, payload: { name: created.name, labels: created.labels, enrollmentId: enrollment.id },
      });
      return created;
    });
    return { runnerId: runner.id, apiKey };
  }
}
```

- [ ] **Step 5: DTOs**

`dto/create-enrollment.dto.ts`:
```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, Matches } from 'class-validator';

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export class CreateEnrollmentDto {
  @ApiPropertyOptional({ type: [String], description: 'Labels preset on the runner that enrolls with this token' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(LABEL_PATTERN, { each: true })
  labels?: string[];
}
```

`dto/enrollment.dto.ts`:
```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EnrollmentRecord } from '../domain/runner.domain';

export class EnrollmentDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare expiresAt: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare usedAt: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) declare runnerId: string | null;
  @ApiProperty() declare createdById: string;
  @ApiProperty() declare createdAt: string;

  static from(r: EnrollmentRecord): EnrollmentDto {
    return Object.assign(new EnrollmentDto(), {
      id: r.id, labels: r.labels, expiresAt: r.expiresAt.toISOString(), usedAt: r.usedAt?.toISOString() ?? null,
      runnerId: r.runnerId, createdById: r.createdById, createdAt: r.createdAt.toISOString(),
    });
  }
}

export class EnrollmentCreatedDto extends EnrollmentDto {
  @ApiProperty({ description: 'Shown once; koda stores only its hash' }) declare token: string;

  static from(r: EnrollmentRecord, token?: string): EnrollmentCreatedDto {
    return Object.assign(new EnrollmentCreatedDto(), EnrollmentDto.from(r), { token });
  }
}
```

`dto/enroll.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsObject, IsString, Matches, MaxLength } from 'class-validator';
import { LABEL_PATTERN } from './create-enrollment.dto';

export class EnrollDto {
  @ApiProperty() @IsString() @MaxLength(200) declare enrollmentToken: string;
  @ApiProperty({ description: 'Unique runner name' }) @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) @IsIn(['darwin', 'linux']) declare os: 'darwin' | 'linux';
  @ApiProperty({ enum: ['arm64', 'x64'] }) @IsIn(['arm64', 'x64']) declare arch: 'arm64' | 'x64';
  @ApiProperty() @IsString() @MaxLength(40) declare daemonVersion: string;
  @ApiProperty() @IsInt() declare protocolVersion: number;
  @ApiProperty() @IsString() @MaxLength(64) declare bootId: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(20) @Matches(LABEL_PATTERN, { each: true }) declare labels: string[];
  @ApiProperty({ type: Object, description: 'RunnerCapabilities (spec §2.1), validated by parseCapabilities' })
  @IsObject() declare capabilities: Record<string, unknown>;
}
```

`dto/list-enrollments.query.ts`:
```ts
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

export class ListEnrollmentsQuery extends KodaPageQuery {}
```

`dto/runner.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger';
import type { RunnerRecord } from '../domain/runner.domain';

export class RunnerDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) declare os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) declare arch: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare capacity: number;
  @ApiProperty({ type: Object }) declare capabilities: Record<string, unknown>;
  @ApiProperty() declare daemonVersion: string;
  @ApiProperty() declare protocolVersion: number;
  @ApiProperty() declare enabled: boolean;
  @ApiProperty() declare lastSeenAt: string;
  @ApiProperty() declare createdAt: string;

  static from(r: RunnerRecord): RunnerDto {
    return Object.assign(new RunnerDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, capacity: r.capacity,
      capabilities: (r.capabilities ?? {}) as Record<string, unknown>, daemonVersion: r.daemonVersion,
      protocolVersion: r.protocolVersion, enabled: r.enabled, lastSeenAt: r.lastSeenAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    });
  }
}
```

- [ ] **Step 6: Controllers and module**

`enrollments.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { EnrollmentCreatedDto } from './dto/enrollment.dto';
import { ListEnrollmentsQuery } from './dto/list-enrollments.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Issue a single-use runner enrollment token (global admin); the token is shown once' })
  @ApiResponse({ status: 201, type: EnrollmentCreatedDto })
  async create(@Body() dto: CreateEnrollmentDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.enrollments.create(principal.id, dto.labels ?? []));
  }

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List enrollment tokens (global admin); tokens are never returned' })
  @ApiResponse({ status: 200, description: 'Page of EnrollmentDto' })
  async list(@Query() rawQuery: ListEnrollmentsQuery) {
    const { current, size } = parseQuery(ListEnrollmentsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.enrollments.list({ current, size })));
  }
}
```

`runner-api.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, Public } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { EnrollmentService } from './enrollment.service';
import { EnrollDto } from './dto/enroll.dto';

/** Runner-facing routes (spec §3). Only runner keys work here (CombinedAuthGuard). */
@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner')
export class RunnerApiController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post('enroll')
  @HttpCode(201)
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Enroll a runner with a single-use token; returns its API key once' })
  @ApiResponse({ status: 201, description: '{ runnerId, apiKey }' })
  @ApiResponse({ status: 401, description: 'Token invalid, used or expired' })
  @ApiResponse({ status: 409, description: 'Runner name taken; the token stays usable' })
  @ApiResponse({ status: 426, description: 'Unsupported protocol version' })
  async enroll(@Body() dto: EnrollDto) {
    return JsonResponse.Ok(await this.enrollments.enroll(dto));
  }

  @Get('me')
  @ApiOperation({ summary: "The calling runner's identity" })
  @ApiResponse({ status: 200, description: '{ id, name, labels, enabled }' })
  async me(@Principal() runner: RunnerPrincipal) {
    return JsonResponse.Ok({ id: runner.id, name: runner.runnerName, labels: runner.labels, enabled: runner.enabled });
  }
}
```

`runners.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { EnrollmentsController } from './enrollments.controller';
import { RunnerApiController } from './runner-api.controller';
import { EnrollmentService } from './enrollment.service';
import { PrismaRunnerRepository } from './prisma-runner.repository';
import { RUNNER_REPOSITORY } from './domain/runner.domain';

@Module({
  imports: [PrismaModule, FleetActivityModule],
  controllers: [EnrollmentsController, RunnerApiController],
  providers: [PrismaRunnerRepository, { provide: RUNNER_REPOSITORY, useExisting: PrismaRunnerRepository }, EnrollmentService],
  exports: [RUNNER_REPOSITORY],
})
export class RunnersModule {}
```
Add `RunnersModule` to `FleetModule.imports`; extend `fleet.module.spec.ts` with `expect(module.get(EnrollmentService)).toBeDefined();` and add `AUTH_CFG`/`FLEET_CFG` value stubs to its `FakeGlobalsModule` (same values as `global-stubs.module.ts`).

- [ ] **Step 7: Run the unit specs**

Run: `cd apps/api && bun run test:scoped src/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass.

- [ ] **Step 8: Write the integration spec**

`apps/api/test/integration/fleet/runner-enrollment.integration.spec.ts`:
```ts
/**
 * Fleet S1 slice 1 — enrollment and runner route isolation over HTTP on PG.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-enrollment.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { DefaultThrottlerGuard } from '@nathapp/nestjs-throttler';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const capabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const enrollBody = (token: string, name: string) => ({
  enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: '0.1.0',
  protocolVersion: 1, bootId: 'boot-1', labels: ['linux'], capabilities,
});

describeIntegration('fleet enrollment (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let admin: string;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newToken = async (labels: string[] = []) =>
    data<{ id: string; token: string }>(await request(server).post('/api/fleet/enrollments').set(auth(admin)).send({ labels }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    admin = data<{ accessToken: string }>(root).accessToken;
  });

  beforeEach(() => {
    // Copied from test/integration/users/admin-users.integration.spec.ts:41-57 (enroll is throttled 10/min).
    const guard = app.get(DefaultThrottlerGuard);
    const storageService = (guard as unknown as {
      storageService: {
        storage: Map<string, unknown>;
        timeoutIds?: Map<string, NodeJS.Timeout[]>;
        hitExpirations?: Map<string, unknown>;
      };
    }).storageService;
    storageService.timeoutIds?.forEach((timeouts) => timeouts.forEach(clearTimeout));
    storageService.timeoutIds?.clear();
    storageService.hitExpirations?.clear();
    storageService.storage.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('enrolls once; the key works on /fleet/runner/me and nowhere else', async () => {
    const { token } = await newToken(['gpu']);
    const enrolled = data<{ runnerId: string; apiKey: string }>(
      await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-1')).expect(201),
    );
    expect(enrolled.apiKey).toMatch(/^kr_/);

    const me = data<{ id: string; labels: string[] }>(await request(server).get('/api/fleet/runner/me').set(auth(enrolled.apiKey)).expect(200));
    expect(me).toEqual({ id: enrolled.runnerId, name: 'box-1', labels: ['gpu', 'linux'], enabled: true });

    await request(server).get('/api/projects').set(auth(enrolled.apiKey)).expect(401);
    await request(server).get('/api/fleet/runners').set(auth(enrolled.apiKey)).expect(401);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-2')).expect(401);
  });

  it('refuses user JWTs and missing credentials on runner routes', async () => {
    await request(server).get('/api/fleet/runner/me').set(auth(admin)).expect(401);
    await request(server).get('/api/fleet/runner/me').expect(401);
  });

  it('lets exactly one of two racing enrollments win', async () => {
    const { token } = await newToken();
    const results = await Promise.all([
      request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'race-a')),
      request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'race-b')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
  });

  it('keeps the token usable when enrollment fails on a duplicate name', async () => {
    const { token } = await newToken();
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-1')).expect(409);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-3')).expect(201);
  });

  it('answers 426 for an unsupported protocol and 400 for bad capabilities, leaving the token unused', async () => {
    const { token } = await newToken();
    await request(server).post('/api/fleet/runner/enroll').send({ ...enrollBody(token, 'box-4'), protocolVersion: 99 }).expect(426);
    await request(server).post('/api/fleet/runner/enroll').send({ ...enrollBody(token, 'box-4'), capabilities: { nax: 'x' } }).expect(400);
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-4')).expect(201);
  });

  it('rejects an expired token', async () => {
    const { id, token } = await newToken();
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    await prisma.runnerEnrollment.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(server).post('/api/fleet/runner/enroll').send(enrollBody(token, 'box-5')).expect(401);
  });

  it('never returns token hashes in the enrollment list, and logs activity', async () => {
    const list = data<{ records: Array<Record<string, unknown>> }>(await request(server).get('/api/fleet/enrollments').set(auth(admin)).expect(200));
    expect(list.records.length).toBeGreaterThan(0);
    for (const row of list.records) {
      expect(row).not.toHaveProperty('tokenHash');
      expect(row).not.toHaveProperty('token');
    }
    const activity = data<{ records: Array<{ action: string }> }>(await request(server).get('/api/fleet/activity').set(auth(admin)).expect(200));
    expect(activity.records.map((a) => a.action)).toEqual(expect.arrayContaining(['enrollment.created', 'runner.enrolled']));
  });
});
```

- [ ] **Step 9: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/runner-enrollment.integration.spec.ts`
Expected: 7 passed. If the race test sees `[201, 201]`, the token consumption is not a single conditional update inside the transaction; fix the repository, not the test.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/runner-enrollment.integration.spec.ts
git commit -m "feat(fleet): single-use runner enrollment and runner identity route"
```

---

### Task 8: Runner admin routes

**Files:**
- Create: `apps/api/src/fleet/runners/runners.service.ts`, `runners.service.spec.ts`, `runners.controller.ts`, `dto/update-runner.dto.ts`, `dto/list-runners.query.ts`
- Modify: `apps/api/src/fleet/runners/runners.module.ts`
- Test: `apps/api/test/integration/fleet/runner-admin.integration.spec.ts`

**Interfaces:**
- Consumes: `IRunnerRepository` (Task 7), `RunnerDto` (Task 7), `FleetActivityService` (Task 6).
- Produces: `RunnersService.list(page)`, `.get(id)`, `.update(actorId, id, patch: RunnerPatch)`, `.remove(actorId, id)`; routes `GET /fleet/runners`, `GET/PATCH/DELETE /fleet/runners/:id` (global ADMIN).

- [ ] **Step 1: Write the failing service spec**

`runners.service.spec.ts`:
```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { RunnersService } from './runners.service';

const row = (over = {}) => ({
  id: 'r1', name: 'box', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, capabilities: {},
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', enabled: true, lastSeenAt: new Date(0),
  createdById: 'u1', createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('RunnersService', () => {
  const repo = { findRunnerById: jest.fn(), findRunnerPage: jest.fn(), updateRunner: jest.fn(), deleteRunner: jest.fn() };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const service = new RunnersService(repo as never, activity as never, tx as never);

  beforeEach(() => jest.clearAllMocks());

  it('404s an unknown runner', async () => {
    repo.findRunnerById.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('updates enabled/labels/capacity and records the change', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    repo.updateRunner.mockResolvedValue(row({ enabled: false, labels: ['a', 'b'], capacity: 2 }));
    const dto = await service.update('u9', 'r1', { enabled: false, labels: ['b', 'a', 'a'], capacity: 2 });
    expect(repo.updateRunner).toHaveBeenCalledWith('r1', { enabled: false, labels: ['a', 'b'], capacity: 2 });
    expect(dto.enabled).toBe(false);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'u9', action: 'runner.updated', entityId: 'r1', payload: { enabled: false, labels: ['a', 'b'], capacity: 2 } }));
  });

  it('deletes and records', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    await service.remove('u9', 'r1');
    expect(repo.deleteRunner).toHaveBeenCalledWith('r1');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'runner.deleted', entityId: 'r1', payload: { name: 'box' } }));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/runners/runners.service.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement service, DTOs, controller**

`runners.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { IRunnerRepository, RUNNER_REPOSITORY, RunnerPatch } from './domain/runner.domain';
import { RunnerDto } from './dto/runner.dto';

@Injectable()
export class RunnersService {
  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: IRunnerRepository,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async list(page: IPageOption): Promise<IPageResult<RunnerDto>> {
    return remapPage(await this.repo.findRunnerPage(page), RunnerDto.from);
  }

  async get(id: string): Promise<RunnerDto> {
    const runner = await this.repo.findRunnerById(id);
    if (!runner) throw new NotFoundAppException({}, 'fleet.runners');
    return RunnerDto.from(runner);
  }

  async update(actorId: string, id: string, patch: RunnerPatch): Promise<RunnerDto> {
    const clean: RunnerPatch = {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.labels !== undefined ? { labels: [...new Set(patch.labels)].sort() } : {}),
      ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
    };
    return this.txManager.run(async () => {
      if (!(await this.repo.findRunnerById(id))) throw new NotFoundAppException({}, 'fleet.runners');
      const updated = await this.repo.updateRunner(id, clean);
      await this.activity.record({ actorType: 'USER', actorId, action: 'runner.updated', entityType: 'runner', entityId: id, payload: { ...clean } });
      return RunnerDto.from(updated);
    });
  }

  /** Deleting revokes the runner's key (plan D5). Slice 2 adds the active-job 409. */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      const runner = await this.repo.findRunnerById(id);
      if (!runner) throw new NotFoundAppException({}, 'fleet.runners');
      await this.repo.deleteRunner(id);
      await this.activity.record({ actorType: 'USER', actorId, action: 'runner.deleted', entityType: 'runner', entityId: id, payload: { name: runner.name } });
    });
  }
}
```

`dto/update-runner.dto.ts`:
```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { LABEL_PATTERN } from './create-enrollment.dto';

export class UpdateRunnerDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(LABEL_PATTERN, { each: true })
  labels?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 16 }) @IsOptional() @IsInt() @Min(1) @Max(16) capacity?: number;
}
```

`dto/list-runners.query.ts`:
```ts
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

export class ListRunnersQuery extends KodaPageQuery {}
```

`runners.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { RunnersService } from './runners.service';
import { RunnerDto } from './dto/runner.dto';
import { UpdateRunnerDto } from './dto/update-runner.dto';
import { ListRunnersQuery } from './dto/list-runners.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/runners')
export class RunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List runners (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of RunnerDto' })
  async list(@Query() rawQuery: ListRunnersQuery) {
    const { current, size } = parseQuery(ListRunnersQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.runners.list({ current, size })));
  }

  @Get(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Get a runner (global admin)' })
  @ApiResponse({ status: 200, type: RunnerDto })
  async get(@Param('id') id: string) {
    return JsonResponse.Ok(await this.runners.get(id));
  }

  @Patch(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Enable/disable a runner or change its labels or capacity (global admin)' })
  @ApiResponse({ status: 200, type: RunnerDto })
  async update(@Param('id') id: string, @Body() dto: UpdateRunnerDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.runners.update(principal.id, id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: "Delete a runner; revokes its key (global admin)" })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.runners.remove(principal.id, id);
  }
}
```
Register `RunnersController` and `RunnersService` in `RunnersModule`; add `expect(module.get(RunnersService)).toBeDefined();` to `fleet.module.spec.ts`.

- [ ] **Step 4: Run the unit specs**

Run: `cd apps/api && bun run test:scoped src/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass.

- [ ] **Step 5: Integration spec**

`apps/api/test/integration/fleet/runner-admin.integration.spec.ts` — boot, register root, and create a MEMBER user exactly as `project-members.integration.spec.ts:24-40` does (register root, `POST /api/admin/users` with `role: 'MEMBER'`, `loginToken`). Enroll one runner with the helpers from Task 7's `runner-enrollment.integration.spec.ts` (copy `capabilities`, `enrollBody`, and the throttler reset). Tests:
```ts
  it('lists and reads runners without exposing key hashes', async () => {
    const page = data<{ records: Array<Record<string, unknown>> }>(await request(server).get('/api/fleet/runners').set(auth(admin)).expect(200));
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).not.toHaveProperty('apiKeyHash');
    await request(server).get(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).expect(200);
    await request(server).get('/api/fleet/runners/nope').set(auth(admin)).expect(404);
  });

  it('forbids a non-admin user', async () => {
    await request(server).get('/api/fleet/runners').set(auth(member)).expect(403);
    await request(server).post('/api/fleet/enrollments').set(auth(member)).send({}).expect(403);
  });

  it('keeps a disabled runner authenticated (drain)', async () => {
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ enabled: false }).expect(200);
    const me = data<{ enabled: boolean }>(await request(server).get('/api/fleet/runner/me').set(auth(runner.apiKey)).expect(200));
    expect(me.enabled).toBe(false);
  });

  it('validates the patch', async () => {
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ capacity: 0 }).expect(400);
    await request(server).patch(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).send({ labels: ['Bad Label'] }).expect(400);
  });

  it('revokes the key on delete', async () => {
    await request(server).delete(`/api/fleet/runners/${runner.runnerId}`).set(auth(admin)).expect(204);
    await request(server).get('/api/fleet/runner/me').set(auth(runner.apiKey)).expect(401);
  });
```
(`runner` is `{ runnerId, apiKey }` from the enrollment in `beforeAll`; `member` is the MEMBER user's token.)

- [ ] **Step 6: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/runner-admin.integration.spec.ts`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/runners apps/api/src/fleet/fleet.module.spec.ts apps/api/test/integration/fleet/runner-admin.integration.spec.ts
git commit -m "feat(fleet): runner admin routes (list, get, enable/disable, delete)"
```

---

### Task 9: Forge access checkers (`FleetHttpClient`, `GitHubAppClient`, `GitLabAccessChecker`)

**Files:**
- Create: `apps/api/src/fleet/git-broker/fleet-http-client.ts`, `fleet-http-client.spec.ts`
- Create: `apps/api/src/fleet/git-broker/github-app-client.ts`, `github-app-client.spec.ts`
- Create: `apps/api/src/fleet/git-broker/gitlab-access-checker.ts`, `gitlab-access-checker.spec.ts`
- Create: `apps/api/src/fleet/git-broker/repo-check.exception.ts`, `apps/api/src/fleet/git-broker/git-broker.module.ts`
- Create: `apps/api/test/helpers/fake-forge.ts`

**Interfaces:**
- Consumes: `FLEET_CFG` (Task 3), `VCS_CFG` (`githubApiUrl`, `gitlabApiUrl`, `encryptionKey`).
- Produces:
  - `RepoCheckReason = 'github_app_not_configured' | 'app_not_installed' | 'app_permissions_insufficient' | 'repo_not_found' | 'provider_unreachable' | 'provider_error' | 'vcs_connection_missing' | 'vcs_connection_mismatch' | 'vcs_encryption_key_missing' | 'gitlab_token_invalid' | 'gitlab_access_insufficient' | 'gitlab_scope_missing'`; `RepoCheckException(reason)` (422, prefix `fleet.repoCheck`).
  - `FleetHttpClient.request(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: unknown }>` — throws `RepoCheckException('provider_unreachable')` on network error, timeout or redirect.
  - `CanonicalRepo { owner: string; name: string; defaultBranch: string }`.
  - `GitHubAppClient.verifyRepo(owner, name): Promise<CanonicalRepo & { installationId: bigint }>`; `GitHubAppClient.createAppJwt(now?: Date): string` (public for tests and slice 2 minting).
  - `GitLabAccessChecker.verifyRepo(owner, name, token): Promise<CanonicalRepo>`.
  - Test helper `startFakeForge(): Promise<FakeForge>` with `url`, `routes: Map<string, (req) => { status; body; headers? }>`, `requests: Array<{ method; path; headers; body }>`, `close()`.

Registration flow (spec §7.1, plan D8):

GitHub, with the App JWT: `GET /repos/{owner}/{name}/installation` (404 → `app_not_installed`); then `POST /app/installations/{id}/access_tokens` with `{ repositories: [name], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }` (422 → `app_permissions_insufficient`); then, with that token, `GET /repos/{owner}/{name}` for `owner.login`, `name`, `default_branch`. The minted token is dropped.

GitLab, with `PRIVATE-TOKEN`: `GET /personal_access_tokens/self` (401/403/404 → `gitlab_token_invalid`; no `write_repository` in `scopes` → `gitlab_scope_missing`); then `GET /projects/{urlencoded owner/name}` (404 → `repo_not_found`; max of `permissions.project_access.access_level` and `permissions.group_access.access_level` below 30 → `gitlab_access_insufficient`); canonical owner/name from `path_with_namespace` (last segment = name, rest = owner), `default_branch`.

Every other non-2xx → `provider_error`. Error bodies from providers are never echoed to the client.

- [ ] **Step 1: The fake forge helper**

`apps/api/test/helpers/fake-forge.ts`:
```ts
import { createServer, IncomingMessage, Server } from 'http';
import type { AddressInfo } from 'net';

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}
export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
export interface FakeForge {
  url: string;
  routes: Map<string, (req: FakeRequest) => FakeReply>;
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** Local stand-in for the GitHub / GitLab REST APIs. Routes are keyed "METHOD /path". */
export async function startFakeForge(): Promise<FakeForge> {
  const routes = new Map<string, (req: FakeRequest) => FakeReply>();
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0];
      const fake: FakeRequest = { method: req.method ?? 'GET', path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(fake);
      const handler = routes.get(`${fake.method} ${path}`);
      const reply = handler ? handler(fake) : { status: 404, body: { message: 'Not Found' } };
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    routes,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Write the failing unit specs**

`fleet-http-client.spec.ts`:
```ts
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

describe('FleetHttpClient', () => {
  let forge: FakeForge;
  const client = new FleetHttpClient({ httpTimeoutMs: 1000 } as never);

  beforeAll(async () => {
    forge = await startFakeForge();
  });
  afterAll(() => forge.close());

  it('returns status and parsed body', async () => {
    forge.routes.set('GET /ok', () => ({ status: 200, body: { a: 1 } }));
    await expect(client.request('GET', `${forge.url}/ok`, {})).resolves.toEqual({ status: 200, body: { a: 1 } });
  });

  it('returns non-2xx without throwing', async () => {
    await expect(client.request('GET', `${forge.url}/missing`, {})).resolves.toEqual(expect.objectContaining({ status: 404 }));
  });

  it('refuses to follow a redirect (the token must not travel)', async () => {
    forge.routes.set('GET /moved', () => ({ status: 302, headers: { location: `${forge.url}/ok` } }));
    await expect(client.request('GET', `${forge.url}/moved`, { Authorization: 'Bearer t' })).rejects.toMatchObject({ reason: 'provider_unreachable' });
    expect(forge.requests.filter((r) => r.path === '/ok' && r.headers.authorization)).toHaveLength(0);
  });

  it('gives up at the configured timeout', async () => {
    forge.routes.set('GET /slow', () => ({ status: 200, body: {}, delayMs: 3000 }));
    const started = Date.now();
    await expect(client.request('GET', `${forge.url}/slow`, {})).rejects.toBeInstanceOf(RepoCheckException);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
```

`github-app-client.spec.ts`:
```ts
import { createVerify, generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubAppClient } from './github-app-client';
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

describe('GitHubAppClient', () => {
  let forge: FakeForge;
  let client: GitHubAppClient;
  const fleetCfg = { githubAppId: '4242', githubAppPrivateKeyFile: keyFile, githubAppSlug: 'koda-fleet', httpTimeoutMs: 2000 };

  beforeAll(async () => {
    forge = await startFakeForge();
    client = new GitHubAppClient(fleetCfg as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never));
  });
  afterAll(() => forge.close());
  beforeEach(() => {
    forge.routes.clear();
    forge.requests.length = 0;
  });

  it('signs an RS256 App JWT with iss = app id and a <= 10 min lifetime', () => {
    const jwt = client.createAppJwt(new Date('2026-09-30T00:00:00Z'));
    const [h, p, s] = jwt.split('.');
    expect(b64json(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = b64json(p);
    expect(payload.iss).toBe('4242');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('returns the canonical repo and installation id, minting a repo-scoped token', async () => {
    forge.routes.set('GET /repos/Acme/App/installation', () => ({ status: 200, body: { id: 77 } }));
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_x', expires_at: '2026-09-30T01:00:00Z' } }));
    forge.routes.set('GET /repos/Acme/App', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));

    await expect(client.verifyRepo('Acme', 'App')).resolves.toEqual({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
    const mint = forge.requests.find((r) => r.path === '/app/installations/77/access_tokens');
    expect(mint?.body).toEqual({ repositories: ['App'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
    expect(forge.requests.find((r) => r.path === '/repos/Acme/App')?.headers.authorization).toBe('Bearer ghs_x');
  });

  it.each([
    ['GET /repos/o/r/installation', 404, 'app_not_installed'],
    ['GET /repos/o/r/installation', 500, 'provider_error'],
  ])('maps %s -> %s to %s', async (route, status, reason) => {
    forge.routes.set(route, () => ({ status, body: { message: 'secret provider detail' } }));
    await expect(client.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: reason });
  });

  it('maps a refused permission set to app_permissions_insufficient', async () => {
    forge.routes.set('GET /repos/o/r/installation', () => ({ status: 200, body: { id: 1 } }));
    forge.routes.set('POST /app/installations/1/access_tokens', () => ({ status: 422, body: {} }));
    await expect(client.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: 'app_permissions_insufficient' });
  });

  it('reports github_app_not_configured when the key file is unset', async () => {
    const bare = new GitHubAppClient({ ...fleetCfg, githubAppPrivateKeyFile: undefined } as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never));
    await expect(bare.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: 'github_app_not_configured' });
  });
});
```

`gitlab-access-checker.spec.ts`:
```ts
import { GitLabAccessChecker } from './gitlab-access-checker';
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

describe('GitLabAccessChecker', () => {
  let forge: FakeForge;
  let checker: GitLabAccessChecker;
  const project = (access: number | null, group: number | null = null) => ({
    status: 200,
    body: {
      path_with_namespace: 'group/sub/app', default_branch: 'main',
      permissions: { project_access: access === null ? null : { access_level: access }, group_access: group === null ? null : { access_level: group } },
    },
  });

  beforeAll(async () => {
    forge = await startFakeForge();
    checker = new GitLabAccessChecker({ gitlabApiUrl: `${forge.url}/api/v4` } as never, new FleetHttpClient({ httpTimeoutMs: 2000 } as never));
  });
  afterAll(() => forge.close());
  beforeEach(() => forge.routes.clear());

  const scopes = (s: string[]) => forge.routes.set('GET /api/v4/personal_access_tokens/self', () => ({ status: 200, body: { scopes: s } }));
  const PROJECT = `GET /api/v4/projects/${encodeURIComponent('Group/Sub/App')}`;

  it('accepts Developer access with write_repository and returns the canonical path', async () => {
    scopes(['read_api', 'write_repository']);
    forge.routes.set(PROJECT, () => project(30));
    await expect(checker.verifyRepo('Group/Sub', 'App', 'glpat')).resolves.toEqual({ owner: 'group/sub', name: 'app', defaultBranch: 'main' });
  });

  it('uses group access when it is the higher level', async () => {
    scopes(['write_repository']);
    forge.routes.set(PROJECT, () => project(10, 40));
    await expect(checker.verifyRepo('Group/Sub', 'App', 'glpat')).resolves.toEqual(expect.objectContaining({ name: 'app' }));
  });

  it.each([
    ['a token without write_repository', () => { scopes(['read_api']); forge.routes.set(PROJECT, () => project(40)); }, 'gitlab_scope_missing'],
    ['Reporter access', () => { scopes(['write_repository']); forge.routes.set(PROJECT, () => project(20)); }, 'gitlab_access_insufficient'],
    ['an invalid token', () => { forge.routes.set('GET /api/v4/personal_access_tokens/self', () => ({ status: 401, body: {} })); }, 'gitlab_token_invalid'],
    ['a missing project', () => { scopes(['write_repository']); }, 'repo_not_found'],
  ])('rejects %s', async (_label, arrange, reason) => {
    arrange();
    await expect(checker.verifyRepo('Group/Sub', 'App', 'glpat')).rejects.toMatchObject({ reason: reason });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd apps/api && bun run test:scoped src/fleet/git-broker`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`repo-check.exception.ts`:
```ts
import { AppException } from '@nathapp/nestjs-common';

export type RepoCheckReason =
  | 'github_app_not_configured'
  | 'app_not_installed'
  | 'app_permissions_insufficient'
  | 'repo_not_found'
  | 'provider_unreachable'
  | 'provider_error'
  | 'vcs_connection_missing'
  | 'vcs_connection_mismatch'
  | 'vcs_encryption_key_missing'
  | 'gitlab_token_invalid'
  | 'gitlab_access_insufficient'
  | 'gitlab_scope_missing';

/** 422: the forge refused or could not confirm runner git access (spec §7.1). */
export class RepoCheckException extends AppException {
  constructor(readonly reason: RepoCheckReason) {
    super(422, { reason }, 'fleet.repoCheck', 422);
  }
}
```

`fleet-http-client.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { RepoCheckException } from './repo-check.exception';

/**
 * Minimal forge HTTP client: bounded by FLEET_HTTP_TIMEOUT_MS and never follows a
 * redirect, so a bearer token cannot be forwarded to another host (plan D8).
 */
@Injectable()
export class FleetHttpClient {
  constructor(@Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'httpTimeoutMs'>) {}

  async request(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'koda-fleet', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new RepoCheckException('provider_unreachable');
    }
    if (response.status >= 300 && response.status < 400) throw new RepoCheckException('provider_unreachable');
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }
}
```
(`redirect: 'manual'` plus the 3xx check is used instead of `redirect: 'error'` because Bun and Node differ on how `'error'` surfaces; both return the 3xx response under `'manual'`.)

`github-app-client.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { FLEET_CFG, IFleetConfig, isGitHubAppConfigured } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';

export interface CanonicalRepo {
  owner: string;
  name: string;
  defaultBranch: string;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

@Injectable()
export class GitHubAppClient {
  private privateKey: string | undefined;

  constructor(
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl'>,
    private readonly http: FleetHttpClient,
  ) {}

  private get api(): string {
    return this.vcsConfig.githubApiUrl.replace(/\/+$/, '');
  }

  private headers(bearer: string): Record<string, string> {
    return { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  }

  /** RS256 App JWT: iat 60s in the past for clock skew, 9 min lifetime (GitHub max is 10). */
  createAppJwt(now: Date = new Date()): string {
    if (!isGitHubAppConfigured(this.fleetConfig)) throw new RepoCheckException('github_app_not_configured');
    this.privateKey ??= readFileSync(this.fleetConfig.githubAppPrivateKeyFile as string, 'utf8');
    const iat = Math.floor(now.getTime() / 1000) - 60;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: this.fleetConfig.githubAppId }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  async verifyRepo(owner: string, name: string): Promise<CanonicalRepo & { installationId: bigint }> {
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const appJwt = this.createAppJwt();

    const installation = await this.http.request('GET', `${this.api}${repoPath}/installation`, this.headers(appJwt));
    if (installation.status === 404) throw new RepoCheckException('app_not_installed');
    if (installation.status !== 200) throw new RepoCheckException('provider_error');
    const installationId = obj(installation.body).id;
    if (typeof installationId !== 'number') throw new RepoCheckException('provider_error');

    const minted = await this.http.request('POST', `${this.api}/app/installations/${installationId}/access_tokens`, this.headers(appJwt), {
      repositories: [name],
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    if (minted.status === 422 || minted.status === 403) throw new RepoCheckException('app_permissions_insufficient');
    if (minted.status !== 201) throw new RepoCheckException('provider_error');
    const token = obj(minted.body).token;
    if (typeof token !== 'string') throw new RepoCheckException('provider_error');

    const repo = await this.http.request('GET', `${this.api}${repoPath}`, this.headers(token));
    if (repo.status === 404) throw new RepoCheckException('repo_not_found');
    if (repo.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(repo.body);
    const login = obj(body.owner).login;
    if (typeof login !== 'string' || typeof body.name !== 'string' || typeof body.default_branch !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { owner: login, name: body.name, defaultBranch: body.default_branch, installationId: BigInt(installationId) };
  }
}
```

`gitlab-access-checker.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { FleetHttpClient } from './fleet-http-client';
import type { CanonicalRepo } from './github-app-client';
import { RepoCheckException } from './repo-check.exception';

const DEVELOPER = 30;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const level = (v: unknown): number => {
  const n = obj(v).access_level;
  return typeof n === 'number' ? n : 0;
};

@Injectable()
export class GitLabAccessChecker {
  constructor(
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'gitlabApiUrl'>,
    private readonly http: FleetHttpClient,
  ) {}

  async verifyRepo(owner: string, name: string, token: string): Promise<CanonicalRepo> {
    const api = this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '');
    const headers = { 'private-token': token };

    const self = await this.http.request('GET', `${api}/personal_access_tokens/self`, headers);
    if ([401, 403, 404].includes(self.status)) throw new RepoCheckException('gitlab_token_invalid');
    if (self.status !== 200) throw new RepoCheckException('provider_error');
    const scopes = obj(self.body).scopes;
    if (!Array.isArray(scopes) || !scopes.includes('write_repository')) throw new RepoCheckException('gitlab_scope_missing');

    const project = await this.http.request('GET', `${api}/projects/${encodeURIComponent(`${owner}/${name}`)}`, headers);
    if (project.status === 404) throw new RepoCheckException('repo_not_found');
    if (project.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(project.body);
    const permissions = obj(body.permissions);
    if (Math.max(level(permissions.project_access), level(permissions.group_access)) < DEVELOPER) {
      throw new RepoCheckException('gitlab_access_insufficient');
    }
    const path = body.path_with_namespace;
    if (typeof path !== 'string' || typeof body.default_branch !== 'string' || !path.includes('/')) {
      throw new RepoCheckException('provider_error');
    }
    const cut = path.lastIndexOf('/');
    return { owner: path.slice(0, cut), name: path.slice(cut + 1), defaultBranch: body.default_branch };
  }
}
```

`git-broker.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { FleetHttpClient } from './fleet-http-client';
import { GitHubAppClient } from './github-app-client';
import { GitLabAccessChecker } from './gitlab-access-checker';

/** Forge access for fleet (spec §7). Slice 2 adds per-job token minting here. */
@Module({
  providers: [FleetHttpClient, GitHubAppClient, GitLabAccessChecker],
  exports: [GitHubAppClient, GitLabAccessChecker],
})
export class GitBrokerModule {}
```

- [ ] **Step 5: Run the specs**

Run: `cd apps/api && bun run test:scoped src/fleet/git-broker && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass. The redirect test asserts the token never reached `/ok`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/git-broker apps/api/test/helpers/fake-forge.ts
git commit -m "feat(fleet): GitHub App and GitLab repo access checks"
```

---

### Task 10: Repo registry

**Files:**
- Create: `apps/api/src/fleet/repos/domain/fleet-repo.domain.ts`, `prisma-fleet-repo.repository.ts`, `fleet-repos.service.ts`, `fleet-repos.service.spec.ts`, `fleet-repos.controller.ts`, `project-fleet-repos.controller.ts`, `fleet-repos.module.ts`
- Create: `apps/api/src/fleet/repos/dto/{create-fleet-repo.dto.ts,fleet-repo.dto.ts,list-fleet-repos.query.ts}`
- Modify: `apps/api/src/fleet/fleet.module.ts`, `fleet.module.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts`

**Interfaces:**
- Consumes: `GitHubAppClient.verifyRepo`, `GitLabAccessChecker.verifyRepo`, `RepoCheckException` (Task 9); `FleetActivityService` (Task 6); `VCS_REPOSITORY` / `IVcsRepository.findVcsConnectionByProjectId` and `decryptToken` (existing); `ProjectMembershipGuard`, `CurrentProject`, `ProjectAccessModule` (existing).
- Produces: `FLEET_REPO_REPOSITORY`; `FleetReposService.create(actorId, dto)`, `.list(filters: { projectId? }, page)`, `.remove(actorId, id)`; `FleetRepoDto` (`githubInstallationId: string | null`); routes `GET/POST /fleet/repos`, `DELETE /fleet/repos/:id` (global ADMIN), `GET /projects/:slug/fleet/repos` (project member).

Create rules: project must exist and not be soft-deleted (404 `projects`); GitHub → `GitHubAppClient.verifyRepo`; GitLab → the project's `VcsConnection` must exist (`vcs_connection_missing`), have provider `gitlab` and match owner/name case-insensitively (`vcs_connection_mismatch`, one GitLab fleet repo per project, spec §7.1), `VCS_ENCRYPTION_KEY` set (`vcs_encryption_key_missing`), then `GitLabAccessChecker.verifyRepo` with the decrypted token. Store the **canonical** owner/name returned by the forge; duplicate → 409 `fleet.repos`. Record `repo.created`. The forge checks run before the transaction (no DB transaction held open across HTTP).

- [ ] **Step 1: Write the failing service spec**

`fleet-repos.service.spec.ts`:
```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { encryptToken } from '../../common/utils/encryption.util';
import { FleetReposService } from './fleet-repos.service';
import { RepoCheckException } from '../git-broker/repo-check.exception';

const KEY = 'a'.repeat(64);

describe('FleetReposService', () => {
  const repo = { findProject: jest.fn(), create: jest.fn(), findById: jest.fn(), findPage: jest.fn(), delete: jest.fn() };
  const vcsRepo = { findVcsConnectionByProjectId: jest.fn() };
  const github = { verifyRepo: jest.fn() };
  const gitlab = { verifyRepo: jest.fn() };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const make = (encryptionKey: string | undefined = KEY) =>
    new FleetReposService(repo as never, vcsRepo as never, github as never, gitlab as never, activity as never, tx as never, { encryptionKey } as never);

  const created = (over = {}) => ({
    id: 'fr1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk',
    githubInstallationId: BigInt(77), createdById: 'u1', createdAt: new Date(0), ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repo.findProject.mockResolvedValue({ id: 'p1', slug: 'p' });
  });

  it('registers a GitHub repo under its canonical name and serialises the BigInt as a string', async () => {
    github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
    repo.create.mockResolvedValue(created());
    const dto = await make().create('u1', { projectSlug: 'p', provider: 'github', owner: 'Acme', name: 'App' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) }));
    expect(dto.githubInstallationId).toBe('77');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.created', entityId: 'fr1' }));
  });

  it('404s an unknown project before calling the forge', async () => {
    repo.findProject.mockResolvedValue(null);
    await expect(make().create('u1', { projectSlug: 'x', provider: 'github', owner: 'a', name: 'b' })).rejects.toBeInstanceOf(NotFoundAppException);
    expect(github.verifyRepo).not.toHaveBeenCalled();
  });

  it('requires a matching GitLab VcsConnection and decrypts its token', async () => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'Group', repoName: 'App', encryptedToken: encryptToken('glpat-1', KEY) });
    gitlab.verifyRepo.mockResolvedValue({ owner: 'group', name: 'app', defaultBranch: 'main' });
    repo.create.mockResolvedValue(created({ provider: 'gitlab', owner: 'group', githubInstallationId: null }));
    await make().create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' });
    expect(gitlab.verifyRepo).toHaveBeenCalledWith('group', 'app', 'glpat-1');
  });

  it.each([
    ['no connection', null, 'vcs_connection_missing'],
    ['a GitHub connection', { provider: 'github', repoOwner: 'group', repoName: 'app', encryptedToken: 'x' }, 'vcs_connection_mismatch'],
    ['another repo', { provider: 'gitlab', repoOwner: 'group', repoName: 'other', encryptedToken: 'x' }, 'vcs_connection_mismatch'],
  ])('rejects GitLab registration with %s', async (_label, connection, reason) => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue(connection);
    await expect(make().create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' })).rejects.toMatchObject({ reason: reason });
  });

  it('rejects GitLab registration without VCS_ENCRYPTION_KEY', async () => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'group', repoName: 'app', encryptedToken: 'x' });
    await expect(make(undefined).create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' })).rejects.toMatchObject({ reason: 'vcs_encryption_key_missing' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && bun run test:scoped src/fleet/repos`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement domain, repository, DTOs**

`domain/fleet-repo.domain.ts`:
```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const FLEET_REPO_REPOSITORY = Symbol('FLEET_REPO_REPOSITORY');

export interface FleetRepoRecord {
  id: string;
  projectId: string;
  provider: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: bigint | null;
  createdById: string;
  createdAt: Date;
}

export interface IFleetRepoRepository {
  findProject(slug: string): Promise<{ id: string; slug: string } | null>;
  /** Throws ConflictAppException(fleet.repos) on a duplicate (provider, owner, name). */
  create(data: Omit<FleetRepoRecord, 'id' | 'createdAt'>): Promise<FleetRepoRecord>;
  findById(id: string): Promise<FleetRepoRecord | null>;
  findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>>;
  delete(id: string): Promise<void>;
}
```

`prisma-fleet-repo.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { FleetRepoRecord, IFleetRepoRepository } from './domain/fleet-repo.domain';

@Injectable()
export class PrismaFleetRepoRepository implements IFleetRepoRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findProject(slug: string) {
    return this.db.project.findFirst({ where: { slug, deletedAt: null }, select: { id: true, slug: true } });
  }

  async create(data: Omit<FleetRepoRecord, 'id' | 'createdAt'>): Promise<FleetRepoRecord> {
    try {
      return await this.db.fleetRepo.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictAppException({}, 'fleet.repos');
      }
      throw error;
    }
  }

  findById(id: string) {
    return this.db.fleetRepo.findUnique({ where: { id } });
  }

  async findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>> {
    const where: Prisma.FleetRepoWhereInput = filters.projectId ? { projectId: filters.projectId } : {};
    const rows = await Paginate(this.db.fleetRepo, page, { where, orderBy: [{ owner: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    return rows.remap((m: FleetRepoRecord) => m);
  }

  async delete(id: string): Promise<void> {
    await this.db.fleetRepo.delete({ where: { id } });
  }
}
```

`dto/create-fleet-repo.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

export class CreateFleetRepoDto {
  @ApiProperty() @IsString() @MaxLength(100) declare projectSlug: string;
  @ApiProperty({ enum: ['github', 'gitlab'] }) @IsIn(['github', 'gitlab']) declare provider: 'github' | 'gitlab';
  @ApiProperty({ description: 'Owner or namespace (GitLab: group/subgroup)' })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/) declare owner: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9._-]{1,100}$/) declare name: string;
}
```

`dto/fleet-repo.dto.ts`:
```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetRepoRecord } from '../domain/fleet-repo.domain';

export class FleetRepoDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty({ enum: ['github', 'gitlab'] }) declare provider: 'github' | 'gitlab';
  @ApiProperty() declare owner: string;
  @ApiProperty() declare name: string;
  @ApiProperty() declare defaultBranch: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'GitHub App installation id (BigInt as string)' })
  declare githubInstallationId: string | null;
  @ApiProperty() declare createdAt: string;

  static from(r: FleetRepoRecord): FleetRepoDto {
    return Object.assign(new FleetRepoDto(), {
      id: r.id, projectId: r.projectId, provider: r.provider as FleetRepoDto['provider'], owner: r.owner, name: r.name,
      defaultBranch: r.defaultBranch, githubInstallationId: r.githubInstallationId === null ? null : r.githubInstallationId.toString(),
      createdAt: r.createdAt.toISOString(),
    });
  }
}
```

`dto/list-fleet-repos.query.ts`:
```ts
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

export class ListFleetReposQuery extends KodaPageQuery {}
```

- [ ] **Step 4: Service**

`fleet-repos.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { decryptToken } from '../../common/utils/encryption.util';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { VCS_REPOSITORY } from '../../vcs/domain/vcs.repository';
import type { IVcsRepository } from '../../vcs/domain/vcs.repository';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FLEET_REPO_REPOSITORY, IFleetRepoRepository } from './domain/fleet-repo.domain';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';

@Injectable()
export class FleetReposService {
  constructor(
    @Inject(FLEET_REPO_REPOSITORY) private readonly repo: IFleetRepoRepository,
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: Pick<IVcsRepository, 'findVcsConnectionByProjectId'>,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'encryptionKey'>,
  ) {}

  async create(actorId: string, dto: CreateFleetRepoDto): Promise<FleetRepoDto> {
    const project = await this.repo.findProject(dto.projectSlug);
    if (!project) throw new NotFoundAppException({}, 'projects');

    // Forge checks run before the transaction: no DB transaction is held across HTTP.
    const verified = dto.provider === 'github'
      ? await this.github.verifyRepo(dto.owner, dto.name)
      : { ...(await this.verifyGitLab(project.id, dto.owner, dto.name)), installationId: null };

    return this.txManager.run(async () => {
      const row = await this.repo.create({
        projectId: project.id,
        provider: dto.provider,
        owner: verified.owner,
        name: verified.name,
        defaultBranch: verified.defaultBranch,
        githubInstallationId: verified.installationId,
        createdById: actorId,
      });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.created', entityType: 'repo', entityId: row.id,
        payload: { projectId: project.id, provider: row.provider, owner: row.owner, name: row.name },
      });
      return FleetRepoDto.from(row);
    });
  }

  private async verifyGitLab(projectId: string, owner: string, name: string) {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);
    if (!connection) throw new RepoCheckException('vcs_connection_missing');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (connection.provider !== 'gitlab' || !same(connection.repoOwner, owner) || !same(connection.repoName, name)) {
      throw new RepoCheckException('vcs_connection_mismatch');
    }
    if (!this.vcsConfig.encryptionKey) throw new RepoCheckException('vcs_encryption_key_missing');
    let token: string;
    try {
      token = decryptToken(connection.encryptedToken, this.vcsConfig.encryptionKey);
    } catch {
      throw new RepoCheckException('gitlab_token_invalid');
    }
    return this.gitlab.verifyRepo(owner, name, token);
  }

  async list(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetRepoDto.from);
  }

  /** Slice 2 adds the active-job 409 (plan D10). */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      await this.repo.delete(id);
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.deleted', entityType: 'repo', entityId: id,
        payload: { provider: row.provider, owner: row.owner, name: row.name },
      });
    });
  }
}
```
If `vcs/domain/vcs.repository.ts` names the interface differently, use its exported name; the method `findVcsConnectionByProjectId(projectId)` returning `{ provider, repoOwner, repoName, encryptedToken } | null` exists (`prisma-vcs.repository.ts:91-94`).

- [ ] **Step 5: Controllers and module**

`fleet-repos.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetReposService } from './fleet-repos.service';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/repos')
export class FleetReposController {
  constructor(private readonly repos: FleetReposService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List fleet repos (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of FleetRepoDto' })
  async list(@Query() rawQuery: ListFleetReposQuery) {
    const { current, size } = parseQuery(ListFleetReposQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.repos.list({}, { current, size })));
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Register a repo for fleet dispatch after proving koda can broker git access (global admin)' })
  @ApiResponse({ status: 201, type: FleetRepoDto })
  @ApiResponse({ status: 409, description: 'Already registered' })
  @ApiResponse({ status: 422, description: 'Forge check failed: { reason }' })
  async create(@Body() dto: CreateFleetRepoDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.repos.create(principal.id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Unregister a fleet repo (global admin)' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.repos.remove(principal.id, id);
  }
}
```

`project-fleet-repos.controller.ts`:
```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { FleetReposService } from './fleet-repos.service';
import { ListFleetReposQuery } from './dto/list-fleet-repos.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('projects/:slug/fleet/repos')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetReposController {
  constructor(private readonly repos: FleetReposService) {}

  @Get()
  @ApiOperation({ summary: "The project's fleet repos (project member)" })
  @ApiResponse({ status: 200, description: 'Page of FleetRepoDto' })
  async list(@Query() rawQuery: ListFleetReposQuery, @CurrentProject() project: ProjectContext) {
    const { current, size } = parseQuery(ListFleetReposQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.repos.list({ projectId: project.project.id }, { current, size })));
  }
}
```

`fleet-repos.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { VcsModule } from '../../vcs/vcs.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetReposController } from './fleet-repos.controller';
import { ProjectFleetReposController } from './project-fleet-repos.controller';
import { FleetReposService } from './fleet-repos.service';
import { PrismaFleetRepoRepository } from './prisma-fleet-repo.repository';
import { FLEET_REPO_REPOSITORY } from './domain/fleet-repo.domain';

@Module({
  imports: [PrismaModule, ProjectAccessModule, VcsModule, FleetActivityModule, GitBrokerModule],
  controllers: [FleetReposController, ProjectFleetReposController],
  providers: [PrismaFleetRepoRepository, { provide: FLEET_REPO_REPOSITORY, useExisting: PrismaFleetRepoRepository }, FleetReposService],
  exports: [FLEET_REPO_REPOSITORY],
})
export class FleetReposModule {}
```
`VcsModule` does not export `VCS_REPOSITORY` today (its `exports` list only services): add `VCS_REPOSITORY` to `VcsModule.exports` in `apps/api/src/vcs/vcs.module.ts` rather than re-providing the Prisma VCS repository here. Add `FleetReposModule` to `FleetModule.imports` and `expect(module.get(FleetReposService)).toBeDefined();` to `fleet.module.spec.ts` (stub `VCS_CFG` in its `FakeGlobalsModule` if needed).

- [ ] **Step 6: Run the unit specs**

Run: `cd apps/api && bun run test:scoped src/fleet src/vcs/vcs.module.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: all pass (skip `src/vcs/vcs.module.spec.ts` if it does not exist).

- [ ] **Step 7: Integration spec against a fake forge**

`apps/api/test/integration/fleet/fleet-repos.integration.spec.ts`:
```ts
/**
 * Fleet S1 slice 1 — repo registration end to end, GitHub and GitLab faked locally (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-repos.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import { encryptToken } from '../../../src/common/utils/encryption.util';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENC_KEY = 'b'.repeat(64);
const ENV_KEYS = ['GITHUB_API_URL', 'VCS_GITLAB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG', 'VCS_ENCRYPTION_KEY'] as const;

describeIntegration('fleet repos (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let forge: FakeForge;
  let admin: string;
  let member: string;
  const saved: Record<string, string | undefined> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      GITHUB_API_URL: forge.url, VCS_GITLAB_API_URL: `${forge.url}/api/v4`, GITHUB_APP_ID: '4242',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet', VCS_ENCRYPTION_KEY: ENC_KEY,
    });

    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    admin = data<{ accessToken: string }>(
      await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
    ).accessToken;
    await request(server).post('/api/projects').set(auth(admin)).send({ name: 'Web', slug: 'web', key: 'WEB' }).expect(201);
    await request(server).post('/api/projects').set(auth(admin)).send({ name: 'Ops', slug: 'ops', key: 'OPS' }).expect(201);
    await request(server).post('/api/admin/users').set(auth(admin)).send({ email: 'm@koda.test', name: 'm', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    member = await loginToken(server, 'm@koda.test');
    await request(server).post('/api/projects/web/members').set(auth(admin)).send({ email: 'm@koda.test', role: 'VIEWER' }).expect(201);

    forge.routes.set('GET /repos/Acme/App/installation', () => ({ status: 200, body: { id: 77 } }));
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_1' } }));
    forge.routes.set('GET /repos/Acme/App', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));
    forge.routes.set('GET /repos/acme/app/installation', () => ({ status: 200, body: { id: 77 } }));
    forge.routes.set('GET /repos/acme/app', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));
  });

  afterAll(async () => {
    await app.close();
    await forge.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('registers a GitHub repo under its canonical name; a second registration in any case is 409', async () => {
    const repo = data<{ owner: string; name: string; defaultBranch: string; githubInstallationId: string }>(
      await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'Acme', name: 'App' }).expect(201),
    );
    expect(repo).toEqual(expect.objectContaining({ owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: '77' }));
    await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' }).expect(409);
  });

  it('answers 422 with a reason when the App is not installed, and never echoes provider bodies', async () => {
    forge.routes.set('GET /repos/other/thing/installation', () => ({ status: 404, body: { message: 'provider-internal-detail' } }));
    const res = await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'other', name: 'thing' }).expect(422);
    expect(JSON.stringify(res.body)).toContain('app_not_installed');
    expect(JSON.stringify(res.body)).not.toContain('provider-internal-detail');
  });

  it('registers the GitLab repo bound to the project VcsConnection only', async () => {
    const prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    const ops = await prisma.project.findUniqueOrThrow({ where: { slug: 'ops' } });
    await prisma.vcsConnection.create({
      data: { projectId: ops.id, provider: 'gitlab', repoOwner: 'infra', repoName: 'deploy', encryptedToken: encryptToken('glpat-9', ENC_KEY) },
    });
    forge.routes.set('GET /api/v4/personal_access_tokens/self', (req) =>
      req.headers['private-token'] === 'glpat-9' ? { status: 200, body: { scopes: ['write_repository'] } } : { status: 401, body: {} });
    forge.routes.set(`GET /api/v4/projects/${encodeURIComponent('infra/deploy')}`, () => ({
      status: 200, body: { path_with_namespace: 'infra/deploy', default_branch: 'main', permissions: { project_access: { access_level: 40 }, group_access: null } },
    }));

    await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'ops', provider: 'gitlab', owner: 'infra', name: 'other' }).expect(422);
    await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'ops', provider: 'gitlab', owner: 'infra', name: 'deploy' }).expect(201);
  });

  it('shows project repos to members only, and admin routes to admins only', async () => {
    const page = data<{ records: Array<{ name: string }> }>(await request(server).get('/api/projects/web/fleet/repos').set(auth(member)).expect(200));
    expect(page.records.map((r) => r.name)).toEqual(['app']);
    await request(server).get('/api/projects/ops/fleet/repos').set(auth(member)).expect(403);
    await request(server).get('/api/fleet/repos').set(auth(member)).expect(403);
    await request(server).post('/api/fleet/repos').set(auth(member)).send({ projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' }).expect(403);
  });

  it('deletes a repo and records the activity', async () => {
    const all = data<{ records: Array<{ id: string; name: string }> }>(await request(server).get('/api/fleet/repos').set(auth(admin)).expect(200));
    const target = all.records.find((r) => r.name === 'app');
    await request(server).delete(`/api/fleet/repos/${target?.id}`).set(auth(admin)).expect(204);
    const activity = data<{ records: Array<{ action: string }> }>(await request(server).get('/api/fleet/activity?entityType=repo').set(auth(admin)).expect(200));
    expect(activity.records.map((a) => a.action)).toEqual(expect.arrayContaining(['repo.created', 'repo.deleted']));
  });
});
```
The member is a project VIEWER on `web` only. If the project member route's non-member status is 404 rather than 403 in this codebase (`ProjectMembershipGuard` returns 403 for non-members per `project-membership.guard.ts:50-52`), keep 403.

- [ ] **Step 8: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-repos.integration.spec.ts`
Expected: 5 passed.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet apps/api/src/vcs/vcs.module.ts apps/api/test/integration/fleet/fleet-repos.integration.spec.ts
git commit -m "feat(fleet): repo registry with forge access checks"
```

---

### Task 11: OpenAPI and CLI client

**Files:**
- Modify: `openapi.json` (generated), `apps/cli/src/generated/**` (generated, gitignored)
- Modify: `apps/api/test/integration/openapi-spec/*` only if an existing spec enumerates tags or paths and now fails.

- [ ] **Step 1: Regenerate**

Run from the repo root: `bun run generate`
Expected: `openapi.json` gains the `fleet` and `fleet-runner` tags and these paths: `/api/fleet/activity`, `/api/fleet/enrollments`, `/api/fleet/runner/enroll`, `/api/fleet/runner/me`, `/api/fleet/runners`, `/api/fleet/runners/{id}`, `/api/fleet/repos`, `/api/fleet/repos/{id}`, `/api/projects/{slug}/fleet/repos`. `bun scripts/check-dist-requires.ts` (part of `apps/api` build) reports no store paths.

- [ ] **Step 2: Check the contract**

```bash
jq -r '.paths | keys[] | select(test("fleet"))' openapi.json
jq '.components.schemas.FleetRepoDto.properties.githubInstallationId' openapi.json
```
Expected: the nine paths above; `githubInstallationId` is `type: string`, nullable.

- [ ] **Step 3: CLI still builds**

Run: `cd apps/cli && bunx tsc --noEmit && bunx jest`
Expected: clean and green (no CLI commands are added in this slice; slice 4 adds `koda fleet …`).

- [ ] **Step 4: Commit**

```bash
git add openapi.json
git commit -m "chore(fleet): regenerate openapi for slice 1 routes"
```

---

### Task 12: Guidance, full gates, PR

**Files:**
- Modify: `.nax/mono/apps/api/context.md` (then `nax generate` + `nax generate --all-packages` to refresh the agent files, per the repo rule)

- [ ] **Step 1: Document the fleet rules for future agents**

Add a `## Fleet` section to `.nax/mono/apps/api/context.md`:
```markdown
## Fleet (S1)

- Spec: `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`. Code under `src/fleet/`.
- Runner keys start with `kr_` and work only on `@RunnerRoute()` routes; `CombinedAuthGuard` fails closed in both directions. Never add a runner route without `@RunnerRoute()`, and never let a runner principal reach a ticket, comment or project route.
- `apps/api` may import `@nathapp/fleet-protocol` with `import type` only (the production image does not ship workspace packages); `src/fleet/common/protocol.spec.ts` enforces it.
- Runner capabilities are untrusted input: always pass them through `parseCapabilities`.
- Forge HTTP goes through `FleetHttpClient` (timeout, no redirects). Minted git tokens are never stored or logged.
- `FleetActivityService.record` runs inside the mutating `txManager.run`; payloads must not carry secrets.
```
Run `nax generate` and `nax generate --all-packages` from the repo root (local tool, not a billed run). Expected: `apps/api/AGENTS.md` / `CLAUDE.md` updated, no other drift.

- [ ] **Step 2: Full gates**

```bash
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:integration && cd ../..
bun run generate && git diff --exit-code openapi.json
```
Expected: all green; `openapi.json` unchanged by the second generate. Record api/web/cli unit counts and the integration count against the Task 0 baseline.

- [ ] **Step 3: Security self-check**

```bash
git diff --name-only a36adcc6 -- apps/api/src | grep -v '\.spec\.ts$' | xargs grep -nE "console\.log|apiKeyHash|tokenHash"
```
Expected: `apiKeyHash`/`tokenHash` appear only in the schema-facing repository code and key generation, never in a DTO, log call or activity payload. No `console.log`.

- [ ] **Step 4: Code review before push**

Dispatch a code reviewer (the repo's standing rule: review before push) over `git diff a36adcc6...HEAD`, focused on the Review Focus list and the guard. Fix CRITICAL/HIGH findings before pushing.

- [ ] **Step 5: Commit, push, PR (only after the user approves pushing and opening the PR)**

```bash
git add .nax/mono/apps/api/context.md apps/api/AGENTS.md apps/api/CLAUDE.md AGENTS.md CLAUDE.md
git commit -m "docs(fleet): api context for fleet runner isolation and protocol imports"
git push -u origin feat/fleet-s1-slice1-foundation
gh pr create --base main --title "feat(fleet): S1 slice 1 — protocol, runner identity, repo registry" --body-file <(cat <<'EOF'
## Summary
Fleet S1 slice 1 (spec `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`, plan `docs/superpowers/plans/2026-09-29-fleet-s1-slice-1-foundation.md`).

- `packages/fleet-protocol`: protocol version + wire types; the API uses it type-only.
- Tables: Runner, RunnerEnrollment, FleetRepo, FleetActivity.
- RUNNER principal: `kr_` keys, `@RunnerRoute()`, fail-closed isolation in CombinedAuthGuard; CASL grants runners nothing.
- Single-use enrollment (`POST /fleet/runner/enroll`), `GET /fleet/runner/me`, admin routes for enrollments, runners, repos, activity.
- Repo registration proves access: GitHub App installation + repo-scoped token (JWT signed with node:crypto), GitLab token scope + Developer access; 422 with a reason code.

## Plan decisions beyond the spec
D1-D10 in the plan (notably: no Prisma enums per repo rule; job tables deferred to slice 2; disabled runners still authenticate, delete revokes).

## Tests
Baseline vs final counts (api unit, api integration, web, cli).

## Out of scope
Jobs, sync, placement, token minting per job (slice 2); apps/runner (slice 3); web and CLI (slice 4).
EOF
)
```
Expected: PR opened; all ten required checks green.

---

## Self-review (done while writing)

- **Spec coverage (slice 1 of §13):** protocol package (Task 1); models + migration (Task 2, jobs deferred per D2); RUNNER principal + enrollment (Tasks 4, 7); repo registry with broker registration checks (Tasks 9, 10); FleetActivity (Task 6). §2.2 permissions: admin routes use `@RequiredPermission('ADMIN')`, project repos use the membership guard. §3.4 rows in scope: runners, enrollments, repos, project repos, activity. §3.1 enroll: 426, single use, shown once. §7.1 registration checks for both forges, secrets never stored or logged.
- **Deferred with a named owner:** job tables and the partial index (slice 2, plus global-setup index), active-job 409 on delete (slice 2), project-member activity view (slice 2), per-job token minting (slice 2), `koda fleet` CLI and web pages (slice 4).
- **Type consistency:** `RunnerRecord`, `RunnerPatch`, `IRunnerRepository` (Task 7) are used unchanged by Task 8; `CanonicalRepo`, `RepoCheckException`, `verifyRepo` signatures (Task 9) match Task 10's calls; `FleetActivityEntry.entityType` union covers every action in Tasks 7, 8, 10.
- **Review Focus:** each line has a test in its owning task (1: Task 4 unit + Task 7 integration; 2: Task 7 integration; 3: Task 5; 4: Task 9 `fleet-http-client.spec.ts`; 5: Task 10 integration + unit).
