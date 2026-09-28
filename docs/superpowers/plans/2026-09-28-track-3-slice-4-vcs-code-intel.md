# Track 3 Slice 4 — VCS & Code-Intel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close review findings M9-M13, BUG-14 and the VCS LOWs, and wire the code-intel read routes into the project-role guard, as one PR on `feat/track3-vcs-code-intel`.

**Architecture:** Every `TicketLink.prState` write goes through one conditional repository update that never overwrites `merged`. Every VCS provider is built by one helper (`providerForConnection`) that derives the repository URL and API base from the connection's provider, which makes GitLab (polling + outbound) reachable. Issue polling pages through results ordered by update time, and each poll re-reads its connection and stores a cursor. Symbol ids include the project id. `ProjectMembershipGuard` can take the project slug from a query parameter, so the code-intel read routes use `@ProjectPermission`.

**Tech Stack:** NestJS 11 + Fastify, Prisma on PostgreSQL 16, Jest (ts-jest, type-checked specs), Commander CLI with a generated OpenAPI client, Nuxt 3 web.

**Spec:** `docs/superpowers/specs/2026-09-27-track-3-review-remediation-design.md`, section "Slice 4 — VCS & code-intel". Source findings: `docs/20260925-review-whole-repo.md` (M9-M13 table, VCS LOW bullets, BUG-14 row). The code-intel wiring comes from the Slice 3 plan (`docs/superpowers/plans/2026-09-27-track-3-slice-3-ticket-workflow.md`, "Read CodeIntel" note), ruled 2026-09-28: the guard reads the query slug.

## Global Constraints

Copied from the spec's Constraints section; every task's requirements include them.

- API stays single-instance. Postgres only. String-typed enum / JSON-as-String columns stay.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses, `registerAs` config, repository → service → controller, outbox `record()` inside `txManager.run`.
- TDD for every slice. DB-backed behavior gets integration tests on real Postgres (`KODA_DB_TESTS=1`).
- The production API runs on **Bun** (`start:prod-runtime`), dev on Node. Runtime-sensitive code (slice 2 outbound HTTP) is proven on Bun.
- Contract changes regenerate `openapi.json` and the CLI client in the same PR.
- All ten CI checks are required on `main`; each slice PR must be green, including `e2e` and `evaluate`.

Plan-level rules:

- Work on branch `feat/track3-vcs-code-intel` in the main checkout (`repos/koda`), not a worktree. It was branched from `main` @ `dcd4e17b`, after Slice 2b (#151).
- Slice 5 is in development at the same time in `repos/koda-slice5` (`feat/track3-rag-memory`). The two slices share no source files except `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/`, `openapi.json`, `apps/cli/src/generated/**`, and a small hunk of `ticket-transitions.service.ts`. Slice 5 edits line ~180; this slice edits lines ~207-275. Whichever slice merges second rebases, keeps both migrations, and runs `bun run generate` again.
- This branch's DB tests use the default `koda_test` database (`apps/api/.env.test`). Slice 5 uses `koda_slice5_test`. Both can run at the same time against the one test container.
- Run DB-gated specs with `cd apps/api && bun run test:scoped <paths>`. Never `bun run test:integration -- <path>`: it ignores the path and runs all ~100 DB suites.
- ts-jest type-checks every spec. A signature change fails every spec that still uses the old signature at compile time. After each interface change, run `cd apps/api && bunx tsc --noEmit -p tsconfig.json` to list the broken specs, and fix every one in the same task.
- Specs under `apps/api/test/integration/**` that do not touch a database still only run in DB mode, because the unit `test` script ignores any path containing `integration`. Include them in the scoped runs below.
- No emojis anywhere. Conventional commits (`fix:`, `feat:`, `test:`, `refactor:`, `docs:`), no attribution trailer.

## Review Focus

The five inputs the spec implies but its test list does not name, most likely to bite first. Each has a test in the task that owns the code.

1. **A TicketLink whose `prState` is NULL (a link created without a PR state) still accepts updates.** In SQL, `prState <> 'merged'` is NULL, not true, for a NULL row, so a naive conditional write would silently freeze every such link. Task 1's integration test writes to a NULL-state link.
2. **A pagination `next` link that points at another origin must not receive the token.** GitHub's `Link` header comes back from the server. Following it blindly would send `Authorization: Bearer <token>` to whatever host it names. Task 5 stops at an off-origin link and reports the fetch as capped.
3. **A repeated or empty `?projectSlug=` fails closed with 403.** Fastify parses `?projectSlug=a&projectSlug=b` into an array. The guard must not pick one element. Task 9's guard spec and HTTP spec cover it.
4. **A GitLab connection switched to `syncMode=webhook` by PATCH is refused, not only on create.** Task 4 tests both routes.
5. **`code_commit` outbox events recorded before this deploy have no `removedFiles`, and still index.** Pending rows written by the old push handler must not crash the new handler. Task 8 tests a legacy payload.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `apps/api/src/common/test-helpers/source-files.ts` (new) | List non-spec `.ts` files under a directory, for the source-guard specs | 1 |
| `apps/api/src/vcs/pr-state-write-sites.spec.ts` (new) | Guard: exactly the reviewed `ticketLink` update/upsert sites exist; only one writes `prState` | 1 |
| `apps/api/src/vcs/prisma-vcs.repository.ts` | Conditional `prState` write; externalVcsId dedup and create; cursor write | 1, 2, 6 |
| `apps/api/src/vcs/external-vcs-id.ts` (new) | `owner/repo#N` external id | 2 |
| `apps/api/test/helpers/migration-schema.ts` (new) | Apply committed migrations to a scratch schema | 2 |
| `apps/api/prisma/migrations/20260929090000_vcs_external_id_repo_qualified/` (new) | Backfill `externalVcsId` | 2 |
| `apps/api/src/vcs/provider-for-connection.ts` (new) | Build a provider, repo web URL and branch URL from a connection | 3 |
| `apps/api/src/vcs/factory.ts` | Host-agnostic repo path parse; GitLab API base; response headers; error bodies | 3, 4, 5 |
| `apps/api/src/vcs/providers/pagination.ts` (new) | Page size, page cap, `Link` / `X-Next-Page` parsing, cursor helper | 5 |
| `apps/api/src/vcs/webhook-secret.ts` (new) | Generate a webhook secret | 7 |
| `apps/api/src/code-intel/symbol-id.ts` (new) | Project-scoped symbol id | 8 |
| `apps/api/prisma/migrations/20260929090100_symbol_project_scoped_ids/` (new) | Delete derived symbol rows | 8 |
| `apps/api/src/projects/project-slug-from.decorator.ts` (new) | Tell the guard where a route's slug lives | 9 |

---

### Task 0: Branch, test database and baseline

**Files:** none changed.

- [ ] **Step 1: Confirm the branch and base**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
git status -sb
git log --oneline -1 main
git merge-base HEAD main
```

Expected: branch `feat/track3-vcs-code-intel`, clean tree, merge-base `dcd4e17b`.

- [ ] **Step 2: Start the test database**

```bash
cd apps/api && bun run test:db:up
```

Expected: the container reports healthy on port 5433.

- [ ] **Step 3: Record the baseline**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun run test 2>&1 | tail -15
cd apps/api && bun run test:scoped test/integration/vcs test/integration/code-intel test/integration/ast-index 2>&1 | tail -15
```

Expected: both green. Write the suite and test counts into the PR draft notes. If anything is red on the untouched branch, stop and report it: do not start Task 1 on a red baseline.

---

### Task 1: M12 — `merged` is terminal

**Files:**
- Create: `apps/api/src/common/test-helpers/source-files.ts`
- Create: `apps/api/src/vcs/pr-state-write-sites.spec.ts`
- Create: `apps/api/src/vcs/vcs-webhook.merged-terminal.spec.ts`
- Create: `apps/api/test/integration/vcs/pr-state-merged-terminal.integration.spec.ts`
- Modify: `apps/api/src/vcs/domain/vcs.repository.ts:83-84`
- Modify: `apps/api/src/vcs/prisma-vcs.repository.ts:275-290`
- Modify: `apps/api/src/vcs/vcs-webhook.service.ts:276-470`
- Modify: `apps/api/src/vcs/vcs-pr-sync.service.ts:89-138`
- Modify (delete dead writers): `apps/api/src/ticket-links/ticket-links.service.ts:105-136`, `apps/api/src/ticket-links/prisma-ticket-link.repository.ts:86-91`, `apps/api/src/tickets/prisma-tickets.repository.ts:350-359`
- Modify (spec mocks): every spec that references `updateTicketLinkPrState`, `updateLink`, `updateTicketLink(` or `updatePrStateFromWebhook`. List them with `grep -rln "updateTicketLinkPrState\|updateLink\b\|updateTicketLink\b\|updatePrStateFrom" apps/api/src apps/api/test`.

**Interfaces:**
- Produces: `IVcsRepository.updateTicketLinkWithPrState(id: string, prState: string): Promise<boolean>`. It resolves `true` when the row changed and `false` when the link was already `merged`. `updateTicketLinkPrState` is removed.
- Produces: `sourceFiles(dir: string): string[]` from `src/common/test-helpers/source-files.ts`, reused by Task 3.

Context: the inbound webhook handlers write `prState` unconditionally, so a late `opened`/`reopened`/`ready_for_review`/`converted_to_draft`/`closed` delivery with a fresh delivery id regresses a merged PR (review M12, PARTIAL). The sync path already treats `merged`/`closed` as terminal in code, and this task moves the `merged` rule into the one write. `closed` stays non-terminal for webhooks, because GitHub can reopen a closed PR. Three `prState` writers outside VCS have no production caller: `TicketLinksService.updatePrStateFromWebhook`, `TicketLinksService.updatePrStateFromIgnoredAction`, and `PrismaTicketsRepository.updateTicketLink`. The first two go through `PrismaTicketLinkRepository.updateLink`. They are deleted so the guard can allowlist exact sites.

- [ ] **Step 1: Write the source-file helper**

`apps/api/src/common/test-helpers/source-files.ts`:

```ts
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every non-spec TypeScript file under `dir`, recursively. Used by specs that
 * guard a codebase-wide rule (one write site, one construction path).
 */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}
```

- [ ] **Step 2: Write the failing write-site guard**

`apps/api/src/vcs/pr-state-write-sites.spec.ts`:

```ts
/**
 * M12: TicketLink.prState is written through exactly one conditional update,
 * PrismaVcsRepository.updateTicketLinkWithPrState, which never overwrites
 * `merged`. This spec fails when any other ticketLink update/upsert call
 * appears in src, so a reviewer must decide whether it may touch prState.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sourceFiles } from '../common/test-helpers/source-files';

const SRC_ROOT = join(__dirname, '..');
const WRITE_CALL = /\.ticketLink\.(update|updateMany|upsert)\(/g;

/** The call's argument text, from its opening paren to the matching close. */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

const sites = sourceFiles(SRC_ROOT).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(WRITE_CALL)].map((match) => ({
    site: `${relative(SRC_ROOT, file)}:${match[1]}`,
    args: callArguments(source, (match.index ?? 0) + match[0].length - 1),
  }));
});

describe('TicketLink prState write sites (M12)', () => {
  it('has exactly the reviewed ticketLink update/upsert call sites', () => {
    expect(sites.map((s) => s.site).sort()).toEqual([
      'vcs/prisma-vcs.repository.ts:updateMany',
      'vcs/prisma-vcs.repository.ts:upsert',
    ]);
  });

  it('writes prState only in the conditional updateMany', () => {
    expect(sites.filter((s) => s.args.includes('prState')).map((s) => s.site)).toEqual([
      'vcs/prisma-vcs.repository.ts:updateMany',
    ]);
  });

  it('the conditional updateMany skips merged rows but not NULL ones', () => {
    const update = sites.find((s) => s.site.endsWith(':updateMany'));
    expect(update?.args).toContain("prState: { not: 'merged' }");
    expect(update?.args).toContain('prState: null');
  });
});
```

- [ ] **Step 3: Write the failing webhook handler spec**

`apps/api/src/vcs/vcs-webhook.merged-terminal.spec.ts`:

```ts
/**
 * M12: a late pull_request delivery (fresh delivery id, so replay protection
 * lets it through) must not regress a merged link. The repository refuses the
 * write; the handler reports the delivery as ignored.
 */
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import type { IVcsRepository, TicketLinkData } from './domain/vcs.repository';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import type { VcsSyncService } from './vcs-sync.service';
import type { VcsPrSyncService } from './vcs-pr-sync.service';
import type { IVcsConfig } from '../config/vcs.config';

const connection = {
  id: 'conn-1',
  projectId: 'proj-1',
  provider: 'github',
  repoOwner: 'acme',
  repoName: 'widgets',
  encryptedToken: 'enc',
  syncMode: 'webhook',
  allowedAuthors: '[]',
  pollingIntervalMs: 600000,
  webhookSecret: 'secret',
  isActive: true,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: { id: 'proj-1', key: 'ACME', slug: 'acme' },
} as VcsConnectionWithProjectDomain;

function link(prState: string | null): TicketLinkData {
  return {
    id: 'link-1',
    ticketId: 'ticket-1',
    prNumber: 7,
    prState,
    url: 'https://github.com/acme/widgets/pull/7',
    externalRef: 'acme/widgets#7',
    ticket: { id: 'ticket-1', status: 'VERIFY_FIX', projectId: 'proj-1', number: 1, externalVcsId: null },
  };
}

function payload(action: string, pr: Partial<NonNullable<GitHubWebhookPayload['pull_request']>> = {}): GitHubWebhookPayload {
  return {
    action,
    pull_request: {
      number: 7,
      title: 'PR',
      body: null,
      user: { login: 'dev' },
      html_url: 'https://github.com/acme/widgets/pull/7',
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      merged_by: null,
      base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
      head: { ref: 'feat', repo: { full_name: 'acme/widgets' } },
      ...pr,
    },
  };
}

describe('VcsWebhookService — merged is terminal (M12)', () => {
  let repo: { findTicketLinkByPrNumber: jest.Mock; updateTicketLinkWithPrState: jest.Mock };
  let prSync: { handleMergedPrAutoTransition: jest.Mock };
  let service: VcsWebhookService;

  beforeEach(() => {
    repo = { findTicketLinkByPrNumber: jest.fn(), updateTicketLinkWithPrState: jest.fn() };
    prSync = { handleMergedPrAutoTransition: jest.fn().mockResolvedValue(undefined) };
    service = new VcsWebhookService(
      repo as unknown as IVcsRepository,
      {} as VcsSyncService,
      prSync as unknown as VcsPrSyncService,
      { encryptionKey: undefined, defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com' } as IVcsConfig,
    );
  });

  afterEach(() => service.onModuleDestroy());

  it.each([
    ['opened', {}, 'open'],
    ['closed', { state: 'closed' }, 'closed'],
    ['ready_for_review', {}, 'open'],
    ['reopened', {}, 'open'],
    ['converted_to_draft', { draft: true }, 'draft'],
  ])('a late %s delivery on a merged link is ignored', async (action, pr, attempted) => {
    repo.findTicketLinkByPrNumber.mockResolvedValue(link('merged'));
    repo.updateTicketLinkWithPrState.mockResolvedValue(false);

    const result = await service.handleWebhook(connection, 'pull_request', payload(action, pr));

    expect(repo.updateTicketLinkWithPrState).toHaveBeenCalledWith('link-1', attempted);
    expect(result).toEqual({ success: true, ignored: true, reason: 'PR is already merged' });
  });

  it('a duplicate merged delivery neither re-runs the transition nor rewrites the link', async () => {
    repo.findTicketLinkByPrNumber.mockResolvedValue(link('merged'));

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(prSync.handleMergedPrAutoTransition).not.toHaveBeenCalled();
    expect(repo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, ignored: true, reason: 'PR is already merged' });
  });

  it('an open link still moves to merged', async () => {
    repo.findTicketLinkByPrNumber.mockResolvedValue(link('open'));
    repo.updateTicketLinkWithPrState.mockResolvedValue(true);

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(prSync.handleMergedPrAutoTransition).toHaveBeenCalledTimes(1);
    expect(repo.updateTicketLinkWithPrState).toHaveBeenCalledWith('link-1', 'merged');
    expect(result).toEqual({ success: true, ignored: false });
  });
});
```

- [ ] **Step 4: Write the failing Postgres integration spec**

`apps/api/test/integration/vcs/pr-state-merged-terminal.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4 (M12): the conditional prState write on real Postgres.
 * `merged` never changes; NULL and non-terminal states still update.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/pr-state-merged-terminal.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaVcsRepository.updateTicketLinkWithPrState (M12)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let ticketId: string;
  let counter = 0;

  const makeLink = async (prState: string | null) =>
    prisma.ticketLink.create({
      data: {
        ticketId,
        url: `https://github.com/acme/widgets/pull/${++counter}`,
        provider: 'github',
        linkType: 'pr',
        prNumber: counter,
        prState,
        prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);

    const project = await prisma.project.create({ data: { name: 'Merged', slug: 'merged', key: 'MRG' } });
    const ticket = await prisma.ticket.create({
      data: { projectId: project.id, number: 1, type: 'TASK', title: 'T' },
    });
    ticketId = ticket.id;
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  it.each(['open', 'draft', 'closed'])('refuses to move a merged link to %s', async (next) => {
    const merged = await makeLink('merged');

    await expect(repo.updateTicketLinkWithPrState(merged.id, next)).resolves.toBe(false);

    const row = await prisma.ticketLink.findUniqueOrThrow({ where: { id: merged.id } });
    expect(row.prState).toBe('merged');
    expect(row.prUpdatedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('writes a link whose prState is NULL', async () => {
    const bare = await makeLink(null);

    await expect(repo.updateTicketLinkWithPrState(bare.id, 'open')).resolves.toBe(true);

    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: bare.id } })).prState).toBe('open');
  });

  it('moves open to merged, then refuses to move it back', async () => {
    const open = await makeLink('open');

    await expect(repo.updateTicketLinkWithPrState(open.id, 'merged')).resolves.toBe(true);
    await expect(repo.updateTicketLinkWithPrState(open.id, 'open')).resolves.toBe(false);

    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: open.id } })).prState).toBe('merged');
  });

  it('a closed link can be reopened (closed is not terminal for webhooks)', async () => {
    const closed = await makeLink('closed');

    await expect(repo.updateTicketLinkWithPrState(closed.id, 'open')).resolves.toBe(true);
  });
});
```

- [ ] **Step 5: Run the new specs to see them fail**

```bash
cd apps/api
bunx jest src/vcs/pr-state-write-sites.spec.ts src/vcs/vcs-webhook.merged-terminal.spec.ts
bun run test:scoped test/integration/vcs/pr-state-merged-terminal.integration.spec.ts
```

Expected: the guard fails because the site list also contains `ticket-links/prisma-ticket-link.repository.ts:update`, `tickets/prisma-tickets.repository.ts:update` and `vcs/prisma-vcs.repository.ts:update`, with no `updateMany`. The webhook spec fails because a late delivery returns `ignored: false`. The integration spec fails because the method resolves `undefined`, not a boolean.

- [ ] **Step 6: Make the repository write conditional**

In `apps/api/src/vcs/domain/vcs.repository.ts`, replace the two TicketLink write declarations (lines 83-84) with:

```ts
  /**
   * M12: the only TicketLink.prState write. `merged` is terminal: a link already
   * merged is left unchanged. Resolves true when the row changed.
   */
  updateTicketLinkWithPrState(id: string, prState: string): Promise<boolean>;
```

In `apps/api/src/vcs/prisma-vcs.repository.ts`, replace `updateTicketLinkPrState` and `updateTicketLinkWithPrState` (lines 275-290) with:

```ts
  /**
   * M12: the only TicketLink.prState write. A late or replayed event (fresh
   * delivery id, so replay protection lets it through) must not regress a merged
   * PR, so the write skips rows already `merged`. NULL is matched explicitly:
   * `prState <> 'merged'` alone is NULL, not true, for a NULL row.
   */
  async updateTicketLinkWithPrState(id: string, prState: string): Promise<boolean> {
    const { count } = await this.db.ticketLink.updateMany({
      where: { id, OR: [{ prState: null }, { prState: { not: 'merged' } }] },
      data: { prState, prUpdatedAt: new Date() },
    });
    return count === 1;
  }
```

- [ ] **Step 7: Route the webhook handlers through the result**

In `apps/api/src/vcs/vcs-webhook.service.ts`, add a static result inside the class, next to `MAX_DEDUP_ENTRIES`:

```ts
  // M12: a merged link never changes; late deliveries for it are acknowledged, not applied.
  private static readonly ALREADY_MERGED: WebhookHandleResult = {
    success: true,
    ignored: true,
    reason: 'PR is already merged',
  };
```

In each of `handlePullRequestOpened`, `handlePullRequestClosed`, `handlePullRequestReadyForReview`, `handlePullRequestReopened` and `handlePullRequestConvertedToDraft`, replace the bare write `await this.vcsRepo.updateTicketLinkWithPrState(ticketLink.id, <STATE>);` with the guarded form. Keep each handler's own `<STATE>` expression: `newPrState`, `'closed'`, `'open'`, `'open'`, `'draft'`.

```ts
    if (!(await this.vcsRepo.updateTicketLinkWithPrState(ticketLink.id, newPrState))) {
      return VcsWebhookService.ALREADY_MERGED;
    }
```

In `handlePullRequestMerged`, add this directly after the `if (!ticketLink) { ... }` block, before `handleMergedPrAutoTransition`:

```ts
    // A duplicate merged delivery must not re-run the transition.
    if (ticketLink.prState === 'merged') {
      return VcsWebhookService.ALREADY_MERGED;
    }
```

Leave its later `await this.vcsRepo.updateTicketLinkWithPrState(ticketLink.id, 'merged');` as it is: the row was not merged a moment ago.

- [ ] **Step 8: Route PR sync through the one write**

In `apps/api/src/vcs/vcs-pr-sync.service.ts`, replace the in-loop write and the 404 write:

```ts
            // Always update prState regardless of transition outcome
            if (await this.vcsRepo.updateTicketLinkWithPrState(link.id, newPrState)) {
              updated++;
            }
```

```ts
        if (error instanceof NotFoundAppException) {
          // 404: mark as closed
          if (await this.vcsRepo.updateTicketLinkWithPrState(link.id, 'closed')) {
            updated++;
          }
        } else {
```

- [ ] **Step 9: Delete the dead prState writers**

- `apps/api/src/ticket-links/ticket-links.service.ts`: delete `updatePrStateFromWebhook` and `updatePrStateFromIgnoredAction`, including their JSDoc (lines 105-136).
- `apps/api/src/ticket-links/prisma-ticket-link.repository.ts`: delete `updateLink` (lines 86-91).
- `apps/api/src/tickets/prisma-tickets.repository.ts`: delete `updateTicketLink` (lines 350-359).
- In specs, drop the `updateLink: jest.fn()` / `updateTicketLink: jest.fn()` mock entries. Rename every `updateTicketLinkPrState` mock or assertion to `updateTicketLinkWithPrState`. A mocked `updateTicketLinkWithPrState` that must report a write resolves `true`, so write `mockResolvedValue(true)`, not `undefined`.

- [ ] **Step 10: Type-check and run the tests**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs src/ticket-links src/tickets
bun run test:scoped test/integration/vcs
```

Expected: tsc clean. All green, including the three new specs. Any spec still failing is a mock using the removed method: fix it as in Step 9.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "fix(vcs): merged PR state is terminal on every write path (M12)"
```

---

### Task 2: M11 — repo-qualified external ids and deleted-row dedup

**Files:**
- Create: `apps/api/src/vcs/external-vcs-id.ts`, `apps/api/src/vcs/external-vcs-id.spec.ts`
- Create: `apps/api/test/helpers/migration-schema.ts`
- Create: `apps/api/prisma/migrations/20260929090000_vcs_external_id_repo_qualified/migration.sql`
- Create: `apps/api/test/integration/vcs/vcs-external-id.integration.spec.ts`
- Create: `apps/api/test/integration/vcs/vcs-external-id-migration.integration.spec.ts`
- Modify: `apps/api/src/vcs/domain/vcs.repository.ts:77-78`
- Modify: `apps/api/src/vcs/prisma-vcs.repository.ts:153-204`
- Modify: `apps/api/src/vcs/vcs-sync.service.ts:26-53,111-113`
- Modify callers of `syncIssue`: `vcs-polling.service.ts:136`, `vcs-webhook.service.ts` (`handleIssueOpened`), `vcs.controller.ts:216`
- Modify: every spec calling `syncIssue(`, `createTicketFromIssue` or `findExistingTicketByExternalId` (tsc lists them)

**Interfaces:**
- Produces: `interface VcsRepoRef { repoOwner: string; repoName: string }` and `externalVcsIdFor(repo: VcsRepoRef, issueNumber: number): string` → `'owner/repo#N'`.
- Produces: `VcsSyncService.syncIssue(project: { id: string }, issue: VcsIssue, syncMode: 'manual' | 'polling' | 'webhook', repo: VcsRepoRef): Promise<SyncIssueResult>`. Any `VcsConnectionDomain` satisfies `VcsRepoRef`.
- Produces: `IVcsRepository.createTicketFromIssue(project: { id: string }, issue: {...}, externalVcsId: string)`.
- Produces: `scratchSchemaBefore(baseUrl, schema, target)`, `applyMigration(db, migration)` from `test/helpers/migration-schema.ts`, reused by Task 8.

Context: `findExistingTicketByExternalId` filters `deletedAt: null`, so a deleted imported ticket is re-imported on every sync. Its JSDoc says the opposite. Imports store a bare issue number, even though the schema comment says `owner/repo#123`. The migration rewrites bare numbers using the project's single `VcsConnection` (`projectId` is `@unique` on it).

- [ ] **Step 1: Write the failing unit spec**

`apps/api/src/vcs/external-vcs-id.spec.ts`:

```ts
import { externalVcsIdFor } from './external-vcs-id';

describe('externalVcsIdFor (M11)', () => {
  it('qualifies the issue number with the repository', () => {
    expect(externalVcsIdFor({ repoOwner: 'acme', repoName: 'widgets' }, 42)).toBe('acme/widgets#42');
  });

  it('keeps a GitLab subgroup path as the owner', () => {
    expect(externalVcsIdFor({ repoOwner: 'group/sub', repoName: 'app' }, 3)).toBe('group/sub/app#3');
  });
});
```

Add to `apps/api/src/vcs/vcs-sync.service.spec.ts` a spec that pins the new call shape:

```ts
  describe('M11: repo-qualified external ids', () => {
    it('dedups and creates with owner/repo#N', async () => {
      const repo = {
        findExistingTicketByExternalId: jest.fn().mockResolvedValue(null),
        createTicketFromIssue: jest.fn().mockResolvedValue({ id: 't1', number: 1, title: 'Issue' }),
      };
      const service = new VcsSyncService(repo as unknown as IVcsRepository);
      const issue = { number: 5, title: 'Issue', body: null, authorLogin: 'a', url: 'u', labels: [], createdAt: new Date() };

      await service.syncIssue({ id: 'p1' }, issue, 'polling', { repoOwner: 'acme', repoName: 'widgets' });

      expect(repo.findExistingTicketByExternalId).toHaveBeenCalledWith('p1', 'acme/widgets#5');
      expect(repo.createTicketFromIssue).toHaveBeenCalledWith({ id: 'p1' }, issue, 'acme/widgets#5');
    });
  });
```

Import `IVcsRepository` from `./domain/vcs.repository` if the spec does not already.

- [ ] **Step 2: Write the shared migration-schema helper**

`apps/api/test/helpers/migration-schema.ts`:

```ts
/**
 * Apply the committed migrations to a throwaway Postgres schema, so a data
 * migration can be tested against rows written by the schema that preceded it.
 * The main test schema is created by `prisma db push` and never runs migrations.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

export const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');

/** Migration SQL → statements. Comment lines are dropped; no statement may contain a literal ';'. */
export function migrationStatements(migration: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Every committed migration that sorts before `target`, oldest first. */
export function migrationsBefore(target: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{14}_/.test(name) && name < target)
    .sort();
}

export async function applyMigration(db: PrismaClient, migration: string): Promise<void> {
  for (const statement of migrationStatements(migration)) {
    await db.$executeRawUnsafe(statement);
  }
}

export interface ScratchSchema {
  db: PrismaClient;
  drop: () => Promise<void>;
}

/** A fresh schema holding every migration before `target` (target not applied). */
export async function scratchSchemaBefore(baseUrl: string, schema: string, target: string): Promise<ScratchSchema> {
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);

  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  for (const migration of migrationsBefore(target)) {
    await applyMigration(db, migration);
  }

  return {
    db,
    drop: async () => {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    },
  };
}
```

- [ ] **Step 3: Write the failing migration spec**

`apps/api/test/integration/vcs/vcs-external-id-migration.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4 (M11): the backfill rewrites bare issue numbers to
 * owner/repo#N using the project's VCS connection.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-external-id-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20260929090000_vcs_external_id_repo_qualified';

describeIntegration('externalVcsId repo-qualify migration (M11)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'vcs_external_id_migration', TARGET);
    const { db } = scratch;
    await db.$executeRawUnsafe(`
      INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES
        ('p1', 'Linked', 'linked', 'LNK', CURRENT_TIMESTAMP),
        ('p2', 'Bare', 'bare', 'BAR', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "VcsConnection" ("id", "projectId", "provider", "repoOwner", "repoName", "encryptedToken", "updatedAt")
      VALUES ('c1', 'p1', 'github', 'acme', 'widgets', 'enc', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Ticket" ("id", "projectId", "number", "type", "title", "externalVcsId", "updatedAt") VALUES
        ('t-bare',      'p1', 1, 'TASK', 'a', '12',              CURRENT_TIMESTAMP),
        ('t-qualified', 'p1', 2, 'TASK', 'b', 'acme/widgets#3',  CURRENT_TIMESTAMP),
        ('t-null',      'p1', 3, 'TASK', 'c', NULL,              CURRENT_TIMESTAMP),
        ('t-odd',       'p1', 4, 'TASK', 'd', 'not-a-number',    CURRENT_TIMESTAMP),
        ('t-orphan',    'p2', 1, 'TASK', 'e', '7',               CURRENT_TIMESTAMP)
    `);
    await applyMigration(db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it.each([
    ['t-bare', 'acme/widgets#12'],
    ['t-qualified', 'acme/widgets#3'],
    ['t-null', null],
    ['t-odd', 'not-a-number'],
    ['t-orphan', '7'],
  ])('%s ends as %s', async (id, expected) => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ externalVcsId: string | null }>>(
      `SELECT "externalVcsId" FROM "Ticket" WHERE "id" = '${id}'`,
    );
    expect(rows[0].externalVcsId).toBe(expected);
  });
});
```

- [ ] **Step 4: Write the failing repository spec**

`apps/api/test/integration/vcs/vcs-external-id.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4 (M11): dedup includes soft-deleted tickets, and imports store
 * the id they are given.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-external-id.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaVcsRepository external ids (M11)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let projectId: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);
    projectId = (await prisma.project.create({ data: { name: 'Ext', slug: 'ext', key: 'EXT' } })).id;
    await prisma.ticket.create({
      data: {
        projectId,
        number: 1,
        type: 'TASK',
        title: 'Deleted import',
        externalVcsId: 'acme/widgets#5',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  it('finds a soft-deleted imported ticket, so it is never re-imported', async () => {
    const found = await repo.findExistingTicketByExternalId(projectId, 'acme/widgets#5');
    expect(found?.number).toBe(1);
  });

  it('does not match the same issue number from another repository', async () => {
    await expect(repo.findExistingTicketByExternalId(projectId, 'acme/other#5')).resolves.toBeNull();
  });

  it('stores the external id it is given', async () => {
    const issue = { number: 9, title: 'New', body: null, authorLogin: 'a', url: 'https://x/9', labels: [], createdAt: new Date() };
    const created = await repo.createTicketFromIssue({ id: projectId }, issue, 'acme/widgets#9');

    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.externalVcsId).toBe('acme/widgets#9');
    expect(row.number).toBe(2);
  });
});
```

- [ ] **Step 5: Run the specs to see them fail**

```bash
cd apps/api
bunx jest src/vcs/external-vcs-id.spec.ts src/vcs/vcs-sync.service.spec.ts
bun run test:scoped test/integration/vcs/vcs-external-id.integration.spec.ts test/integration/vcs/vcs-external-id-migration.integration.spec.ts
```

Expected: FAIL. The module is missing. The deleted-row lookup returns null. The migration directory does not exist.

- [ ] **Step 6: Implement**

`apps/api/src/vcs/external-vcs-id.ts`:

```ts
/** The repository a VCS connection points at. */
export interface VcsRepoRef {
  repoOwner: string;
  repoName: string;
}

/**
 * M11: the external id stored on a ticket imported from a VCS issue. Qualified
 * as `owner/repo#N`, so issue numbers from two repositories never collide.
 */
export function externalVcsIdFor(repo: VcsRepoRef, issueNumber: number): string {
  return `${repo.repoOwner}/${repo.repoName}#${issueNumber}`;
}
```

`apps/api/src/vcs/domain/vcs.repository.ts`, the `createTicketFromIssue` declaration:

```ts
  createTicketFromIssue(
    project: { id: string },
    issue: { number: number; title: string; body: string | null },
    externalVcsId: string,
  ): Promise<CreateTicketFromIssueResult>;
```

`apps/api/src/vcs/prisma-vcs.repository.ts`: in `findExistingTicketByExternalId`, change the `where` to `{ projectId, externalVcsId }` and the JSDoc to "Includes soft-deleted tickets, so a deleted import is never re-imported (M11)." In `createTicketFromIssue`, add the `externalVcsId: string` parameter and write `externalVcsId,` instead of `` externalVcsId: `${issue.number}`, ``.

`apps/api/src/vcs/vcs-sync.service.ts`:

```ts
  async syncIssue(
    project: { id: string },
    issue: VcsIssue,
    syncMode: 'manual' | 'polling' | 'webhook',
    repo: VcsRepoRef,
  ): Promise<SyncIssueResult> {
    const externalVcsId = externalVcsIdFor(repo, issue.number);

    // Dedup includes soft-deleted tickets (M11): a deleted import stays deleted.
    const existingTicket = await this.vcsRepo.findExistingTicketByExternalId(project.id, externalVcsId);

    if (existingTicket) {
      return {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };
    }

    const result = await this.vcsRepo.createTicketFromIssue(project, issue, externalVcsId);
```

Keep the rest of the method. Import `{ externalVcsIdFor, VcsRepoRef }` from `./external-vcs-id`. In `fullSync`, call `this.syncIssue(project, issue, 'manual', connection)`.

Callers:
- `vcs-polling.service.ts`: `this.syncService.syncIssue(connection.project, issue, 'polling', connection)`
- `vcs-webhook.service.ts` (`handleIssueOpened`): `this.syncService.syncIssue(connection.project, issue, 'webhook', connection)`
- `vcs.controller.ts` (`syncIssue`): `this.syncService.syncIssue(project, issue, 'manual', connection)`

`apps/api/prisma/migrations/20260929090000_vcs_external_id_repo_qualified/migration.sql`:

```sql
-- Track 3 Slice 4 (M11): tickets imported from VCS issues store a repo-qualified
-- externalVcsId (owner/repo#N). Backfill bare issue numbers from the project's
-- single VcsConnection. Rows in projects without a connection stay unchanged.
UPDATE "Ticket" AS t
SET "externalVcsId" = c."repoOwner" || '/' || c."repoName" || '#' || t."externalVcsId"
FROM "VcsConnection" AS c
WHERE c."projectId" = t."projectId"
  AND t."externalVcsId" ~ '^[0-9]+$';
```

- [ ] **Step 7: Fix the specs tsc reports and run everything touched**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs
bun run test:scoped test/integration/vcs test/integration/tickets/ticket-number-allocation.integration.spec.ts
```

Existing specs that assert `findExistingTicketByExternalId` was called with `'<n>'`, or check an `externalVcsId` of `'<n>'`, now expect `'owner/repo#<n>'` built from their fixture connection. Update them to that value and nothing else. Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test apps/api/prisma/migrations
git commit -m "fix(vcs): repo-qualified external ids and deleted-row dedup on import (M11)"
```

---

### Task 3: One provider construction path (BUG-14 groundwork)

**Files:**
- Create: `apps/api/src/vcs/provider-for-connection.ts`, `apps/api/src/vcs/provider-for-connection.spec.ts`
- Create: `apps/api/src/vcs/provider-construction-sites.spec.ts`
- Modify: `apps/api/src/vcs/factory.ts` (config type, `parseRepoPath`, `createVcsProvider`)
- Modify: `apps/api/src/vcs/providers/gitlab.provider.ts:76-94,285-293`
- Modify: `apps/api/src/config/vcs.config.ts`, `apps/api/src/common/test-helpers/global-stubs.module.ts:71`, repo-root `.env.example:38`
- Modify the eight call sites: `vcs-polling.service.ts:116-120`, `vcs-sync.service.ts:98-102`, `vcs-pr-sync.service.ts:64-68`, `vcs.controller.ts:206-210`, `vcs-connection.service.ts:201-206`, `vcs-link-extractor.service.ts:44-68,97`, `tickets/state-machine/ticket-transitions.service.ts:231-257`, `code-intel/code-commit-outbox-handler.ts:58-64`

**Interfaces:**
- Consumes: `sourceFiles` (Task 1).
- Produces, in `provider-for-connection.ts`:
  - `interface VcsRepoTarget { provider: string; repoOwner: string; repoName: string }`
  - `type VcsApiUrls = Partial<Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>>`
  - `repoWebUrl(target: VcsRepoTarget, urls?: VcsApiUrls): string`
  - `branchWebUrl(target: VcsRepoTarget, branch: string, urls?: VcsApiUrls): string`
  - `providerForConnection(target: VcsRepoTarget, token: string, urls?: VcsApiUrls, httpClient?: HttpClient): IVcsProvider`
- Produces: `parseRepoPath(providerType: string, repoUrl: string | undefined): { repoOwner: string; repoName: string } | null` exported from `factory.ts`. Task 4 uses it.
- Produces: `IVcsConfig.gitlabApiUrl: string` (env `VCS_GITLAB_API_URL`, default `https://gitlab.com/api/v4`).
- Produces: `GitLabProvider` constructor gains a fifth argument `apiBaseUrl?: string`.

Context: all eight call sites build `repoUrl` as `` `https://github.com/${owner}/${name}` `` and pass it to `createVcsProvider`. The factory's GitLab branch only matches `gitlab.com`, so a GitLab connection could never be built. Four sites also drop `githubApiUrl`, so GHES breaks there. `GitLabProvider` hard-codes `https://gitlab.com/api/v4` and a `gitlab.com` commit URL. The link extractor and auto-PR also hard-code the `github.com` branch URL and the link provider string `'github'`.

- [ ] **Step 1: Write the failing helper spec**

`apps/api/src/vcs/provider-for-connection.spec.ts`:

```ts
import { branchWebUrl, providerForConnection, repoWebUrl } from './provider-for-connection';
import { parseRepoPath, HttpClient } from './factory';

function recordingClient(data: unknown = { default_branch: 'main' }): HttpClient & { get: jest.Mock } {
  return { get: jest.fn().mockResolvedValue({ data }), post: jest.fn() } as HttpClient & { get: jest.Mock };
}

describe('repoWebUrl / branchWebUrl (BUG-14)', () => {
  it.each([
    [{ provider: 'github', repoOwner: 'o', repoName: 'r' }, {}, 'https://github.com/o/r'],
    [{ provider: 'github', repoOwner: 'o', repoName: 'r' }, { githubApiUrl: 'https://api.github.com/' }, 'https://github.com/o/r'],
    [{ provider: 'github', repoOwner: 'o', repoName: 'r' }, { githubApiUrl: 'https://ghe.corp/api/v3' }, 'https://ghe.corp/o/r'],
    [{ provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'r' }, {}, 'https://gitlab.com/grp/sub/r'],
    [{ provider: 'gitlab', repoOwner: 'grp', repoName: 'r' }, { gitlabApiUrl: 'https://git.corp/api/v4/' }, 'https://git.corp/grp/r'],
  ])('%j with %j → %s', (target, urls, expected) => {
    expect(repoWebUrl(target, urls)).toBe(expected);
  });

  it('uses the provider branch route', () => {
    expect(branchWebUrl({ provider: 'github', repoOwner: 'o', repoName: 'r' }, 'feat/x')).toBe('https://github.com/o/r/tree/feat/x');
    expect(branchWebUrl({ provider: 'gitlab', repoOwner: 'g', repoName: 'r' }, 'feat/x')).toBe('https://gitlab.com/g/r/-/tree/feat/x');
  });
});

describe('providerForConnection (BUG-14)', () => {
  it('builds a self-hosted GitLab provider against the configured API base', async () => {
    const http = recordingClient();
    const provider = providerForConnection(
      { provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'app' },
      'tok',
      { gitlabApiUrl: 'https://git.corp/api/v4' },
      http,
    );

    await provider.getDefaultBranch();

    expect(http.get.mock.calls[0][0]).toBe('https://git.corp/api/v4/projects/grp%2Fsub%2Fapp');
  });

  it('builds a GHES provider against the configured API base', async () => {
    const http = recordingClient();
    const provider = providerForConnection(
      { provider: 'github', repoOwner: 'o', repoName: 'r' },
      'tok',
      { githubApiUrl: 'https://ghe.corp/api/v3' },
      http,
    );

    await provider.getDefaultBranch();

    expect(http.get.mock.calls[0][0]).toBe('https://ghe.corp/api/v3/repos/o/r');
  });

  it('links GitLab commits on the self-hosted web host', async () => {
    const http = recordingClient([{ id: 'abc', message: 'm', author_name: 'a', author_email: 'e', authored_date: '2026-09-28T00:00:00Z' }]);
    const provider = providerForConnection(
      { provider: 'gitlab', repoOwner: 'grp', repoName: 'r' },
      'tok',
      { gitlabApiUrl: 'https://git.corp/api/v4' },
      http,
    );

    const [commit] = await provider.listPrCommits(3);

    expect(commit.url).toBe('https://git.corp/grp/r/-/commit/abc');
  });
});

describe('parseRepoPath', () => {
  it.each([
    ['github', 'https://github.com/o/r', { repoOwner: 'o', repoName: 'r' }],
    ['github', 'https://github.com/o/r.git', { repoOwner: 'o', repoName: 'r' }],
    ['github', 'github.com/o/r', { repoOwner: 'o', repoName: 'r' }],
    ['github', 'https://ghe.corp/o/r/tree/main', { repoOwner: 'o', repoName: 'r' }],
    ['gitlab', 'https://gitlab.com/a/b/c', { repoOwner: 'a/b', repoName: 'c' }],
    ['gitlab', 'https://git.corp/a/b/-/tree/main', { repoOwner: 'a', repoName: 'b' }],
    ['github', 'https://github.com/only', null],
    ['gitlab', 'https://gitlab.com/solo', null],
    ['github', 'not a url at all', null],
    ['github', undefined, null],
  ])('%s %s', (provider, url, expected) => {
    expect(parseRepoPath(provider, url)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Write the failing construction-site guard**

`apps/api/src/vcs/provider-construction-sites.spec.ts`:

```ts
/**
 * BUG-14: every VCS provider is built by providerForConnection, which derives
 * the repository URL and API base from the connection's provider. A direct
 * createVcsProvider call, or a hard-coded github.com repository URL, would send
 * a GitLab connection to GitHub.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sourceFiles } from '../common/test-helpers/source-files';

const SRC_ROOT = join(__dirname, '..');
const ALLOWED_FACTORY_CALLERS = new Set(['vcs/factory.ts', 'vcs/provider-for-connection.ts']);

const files = sourceFiles(SRC_ROOT).map((file) => ({
  path: relative(SRC_ROOT, file),
  source: readFileSync(file, 'utf8'),
}));

describe('VCS provider construction sites (BUG-14)', () => {
  it('only the factory and providerForConnection call createVcsProvider', () => {
    const offenders = files
      .filter((f) => /createVcsProvider\(/.test(f.source) && !ALLOWED_FACTORY_CALLERS.has(f.path))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no source builds a github.com repository URL from a connection', () => {
    const offenders = files.filter((f) => /github\.com\/\$\{/.test(f.source)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run both to see them fail**

```bash
cd apps/api && bunx jest src/vcs/provider-for-connection.spec.ts src/vcs/provider-construction-sites.spec.ts
```

Expected: FAIL. The helper module is missing. The guard lists the eight call sites and the four `github.com/${` literals.

- [ ] **Step 4: Add the GitLab API URL to config**

`apps/api/src/config/vcs.config.ts`: add `gitlabApiUrl: string;` to `IVcsConfig`, this property to `VcsConfigSchema`:

```ts
  @IsOptional()
  @IsString()
  VCS_GITLAB_API_URL: string;
```

and this line to the returned object:

```ts
    gitlabApiUrl: process.env['VCS_GITLAB_API_URL'] ?? 'https://gitlab.com/api/v4',
```

`apps/api/src/common/test-helpers/global-stubs.module.ts:71`: add `gitlabApiUrl: 'https://gitlab.com/api/v4',` beside `githubApiUrl`.

Repo-root `.env.example`, after the `# GITHUB_API_URL=...` line:

```bash
# VCS_GITLAB_API_URL=https://gitlab.com/api/v4
```

- [ ] **Step 5: Make the factory host-agnostic**

In `apps/api/src/vcs/factory.ts`, add to `VcsProviderConfig` after `githubApiUrl`:

```ts
  /** GitLab API base URL (self-hosted support); defaults to https://gitlab.com/api/v4 */
  gitlabApiUrl?: string;
```

Add this exported function above `createVcsProvider`:

```ts
/**
 * Owner and name from a repository web URL on any host (GHES, self-hosted
 * GitLab). GitHub takes the first two path segments. GitLab takes every segment
 * before the last as the (sub)group path, stopping at a `/-/` route.
 */
export function parseRepoPath(
  providerType: string,
  repoUrl: string | undefined,
): { repoOwner: string; repoName: string } | null {
  if (!repoUrl) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl) ? repoUrl : `https://${repoUrl}`;
  let segments: string[];
  try {
    segments = new URL(withScheme).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }

  if (providerType.toLowerCase() === 'gitlab') {
    const routeStart = segments.indexOf('-');
    const path = routeStart === -1 ? segments : segments.slice(0, routeStart);
    if (path.length < 2) return null;
    return { repoOwner: path.slice(0, -1).join('/'), repoName: path[path.length - 1].replace(/\.git$/, '') };
  }

  if (segments.length < 2) return null;
  return { repoOwner: segments[0], repoName: segments[1].replace(/\.git$/, '') };
}
```

Replace the body of `createVcsProvider` after its first `if (!providerType ...)` check with:

```ts
  const type = providerType.toLowerCase();
  if (type !== 'github' && type !== 'gitlab') {
    throw new ValidationAppException({}, 'vcs');
  }

  const repo = parseRepoPath(type, config.repoUrl);
  if (!repo) {
    throw new ValidationAppException({}, 'vcs');
  }

  const httpClient = config.httpClient ?? createDefaultHttpClient();
  return type === 'github'
    ? new GitHubProvider(repo.repoOwner, repo.repoName, config.token, httpClient, config.githubApiUrl)
    : new GitLabProvider(repo.repoOwner, repo.repoName, config.token, httpClient, config.gitlabApiUrl);
```

- [ ] **Step 6: Give GitLabProvider an API base**

In `apps/api/src/vcs/providers/gitlab.provider.ts`, replace the constructor and `baseUrl` getter (lines 76-90):

```ts
export class GitLabProvider implements IVcsProvider {
  private readonly projectId: string;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;

  constructor(
    private readonly repoOwner: string,
    private readonly repoName: string,
    private readonly token: string,
    private readonly httpClient: HttpClient,
    apiBaseUrl?: string,
  ) {
    this.projectId = encodeURIComponent(`${repoOwner}/${repoName}`);
    // BUG-14: self-hosted GitLab sets VCS_GITLAB_API_URL; default to gitlab.com.
    this.apiBaseUrl = (apiBaseUrl ?? 'https://gitlab.com/api/v4').replace(/\/+$/, '');
    this.webBaseUrl = this.apiBaseUrl.replace(/\/api\/v4$/, '');
  }

  private get baseUrl(): string {
    return `${this.apiBaseUrl}/projects/${this.projectId}`;
  }
```

Update the class JSDoc to "GitLab VCS provider implementation (GitLab API v4, gitlab.com or self-hosted)". In `mapGitLabCommitToVcsCommit`:

```ts
      url: `${this.webBaseUrl}/${this.repoOwner}/${this.repoName}/-/commit/${gitLabCommit.id}`,
```

- [ ] **Step 7: Write the helper**

`apps/api/src/vcs/provider-for-connection.ts`:

```ts
import { createVcsProvider, HttpClient } from './factory';
import type { IVcsProvider } from './vcs-provider';
import type { IVcsConfig } from '../config/vcs.config';

/** What a provider needs from a VCS connection. */
export interface VcsRepoTarget {
  provider: string;
  repoOwner: string;
  repoName: string;
}

export type VcsApiUrls = Partial<Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>>;

const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';

const isGitLab = (target: VcsRepoTarget): boolean => target.provider.toLowerCase() === 'gitlab';
const trimSlashes = (url: string): string => url.replace(/\/+$/, '');

function webBaseUrl(target: VcsRepoTarget, urls: VcsApiUrls): string {
  if (isGitLab(target)) {
    return trimSlashes(urls.gitlabApiUrl ?? DEFAULT_GITLAB_API_URL).replace(/\/api\/v4$/, '');
  }
  const api = trimSlashes(urls.githubApiUrl ?? DEFAULT_GITHUB_API_URL);
  return api === DEFAULT_GITHUB_API_URL ? 'https://github.com' : api.replace(/\/api\/v3$/, '');
}

/** The repository's web URL on the connection's host (GitHub, GHES, GitLab, self-hosted GitLab). */
export function repoWebUrl(target: VcsRepoTarget, urls: VcsApiUrls = {}): string {
  return `${webBaseUrl(target, urls)}/${target.repoOwner}/${target.repoName}`;
}

/** A branch's web URL, using the provider's route (`/tree/` or `/-/tree/`). */
export function branchWebUrl(target: VcsRepoTarget, branch: string, urls: VcsApiUrls = {}): string {
  const route = isGitLab(target) ? '/-/tree/' : '/tree/';
  return `${repoWebUrl(target, urls)}${route}${branch}`;
}

/**
 * BUG-14: the one way to build a VCS provider for a connection. The repository
 * URL and API base follow the connection's provider, so a GitLab connection
 * never reaches GitHub.
 */
export function providerForConnection(
  target: VcsRepoTarget,
  token: string,
  urls: VcsApiUrls = {},
  httpClient?: HttpClient,
): IVcsProvider {
  return createVcsProvider(target.provider, {
    provider: target.provider,
    token,
    repoUrl: repoWebUrl(target, urls),
    githubApiUrl: urls.githubApiUrl,
    gitlabApiUrl: urls.gitlabApiUrl,
    ...(httpClient ? { httpClient } : {}),
  });
}
```

- [ ] **Step 8: Move the eight call sites onto the helper**

Import `providerForConnection` (and `branchWebUrl` where used) from the module's relative path. Remove imports of `createVcsProvider` and `VcsProviderConfig` that become unused.

1. `vcs-polling.service.ts` `poll`: `const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);`
2. `vcs-sync.service.ts`: give the constructor `@Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig` as its last parameter (import `Optional`, `VCS_CFG`, `IVcsConfig`). In `fullSync`: `const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);`
3. `vcs-pr-sync.service.ts`: add `@Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig` as the last constructor parameter. Then `const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);`
4. `vcs.controller.ts` `syncIssue`: `const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);`
5. `vcs-connection.service.ts` `testConnection`: `const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);`
6. `vcs-link-extractor.service.ts`:

```ts
    const provider = providerForConnection(
      connection,
      decryptToken(connection.encryptedToken, encryptionKey),
      this.vcsConfig,
    );
```

```ts
    const branchUrl = branchWebUrl(connection, branchName, this.vcsConfig);

    // Upsert branch link
    await this.upsertTicketLink(ticket.id, branchUrl, connection.provider, 'branch', branchName);
```

and in the commit loop: `await this.upsertTicketLink(ticket.id, commit.url, connection.provider, 'commit', commit.message, commit.date);`

7. `tickets/state-machine/ticket-transitions.service.ts` `createPrForTicket`: delete the `repoUrl` const, then:

```ts
        const provider = providerForConnection(connection, token, this.vcsConfig);
```

and in `createTicketLink`: `provider: connection.provider,`.

8. `code-intel/code-commit-outbox-handler.ts`: replace the `providerConfig` block and `createVcsProvider` call with:

```ts
    const provider = providerForConnection(connection, token, this.vcsConfig);
```

- [ ] **Step 9: Fix the specs tsc and jest report, then run**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs src/code-intel src/tickets
bun run test:scoped test/integration/vcs test/integration/ast-index
```

Specs that `jest.mock('./factory')` keep working: the helper calls the mocked `createVcsProvider`. An assertion on the exact `createVcsProvider` config object may now fail on the extra `githubApiUrl`/`gitlabApiUrl` keys. Undefined keys are ignored by `toHaveBeenCalledWith`, so only fixtures that configure a URL change. Update such an assertion to the new object and nothing else. A factory spec that expected a GitLab URL to be rejected for provider `github` now parses: change it to assert that `parseRepoPath('github', <non-repo URL>)` returns null. Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src apps/api/test .env.example
git commit -m "refactor(vcs): build every provider from its connection (BUG-14 groundwork)"
```

---

### Task 4: GitLab reachable end to end (BUG-14, polling + outbound)

**Files:**
- Modify: `apps/api/src/vcs/dto/create-vcs-connection.dto.ts`
- Modify: `apps/api/src/vcs/vcs-connection.service.ts` (`create`, `update`, `parseRepoUrl`)
- Modify: `apps/api/src/vcs/factory.ts` (`createDefaultHttpClient` error bodies)
- Modify: `apps/api/src/vcs/providers/gitlab.provider.ts:176-185`
- Modify: `apps/api/src/i18n/en/vcs.json`, `apps/api/src/i18n/zh/vcs.json`
- Create: `apps/api/src/vcs/vcs-connection.gitlab.spec.ts`, `apps/api/src/vcs/providers/gitlab.provider.outbound.spec.ts`
- Modify: `apps/api/src/vcs/dto/vcs-connection.dto.spec.ts`
- Modify: `openapi.json` (regenerated)

**Interfaces:**
- Consumes: `parseRepoPath` (Task 3).
- Produces: `VcsProviderType.GITLAB = 'gitlab'`. `CreateVcsConnectionDto.syncMode?: VcsSyncModeType`, validated by `@IsEnum` (the VCS LOW).
- Produces: a GitLab connection with `syncMode=webhook` is refused with `ValidationAppException({}, 'vcs.gitlabWebhook')` on create and on update. The HTTP status is 400.
- Produces: the default HTTP client's errors carry `response: { status, data }`, where `data` is the parsed JSON body or `undefined`.

Context: the create DTO enum is GitHub-only, so GitLab is unreachable (BUG-14 PARTIAL). GitLab inbound webhooks are out of scope (ruling 09-27), so webhook mode is refused for GitLab. After Slice 2b the inbound route already answers every delivery for a non-`webhook` connection with `200 { ignored: true }`. The GitLab provider detects "branch already exists" from the error message, but the default client's message is only `HTTP 400`. Auto-MR creation therefore fails whenever the branch exists.

- [ ] **Step 1: Write the failing specs**

In `apps/api/src/vcs/dto/vcs-connection.dto.spec.ts`, add (reuse the file's existing `validate`/`plainToInstance` imports):

```ts
  describe('Slice 4: provider and syncMode enums', () => {
    const base = { repoOwner: 'o', repoName: 'r', token: 't' };

    it('accepts gitlab', async () => {
      const errors = await validate(plainToInstance(CreateVcsConnectionDto, { ...base, provider: 'gitlab' }));
      expect(errors).toHaveLength(0);
    });

    it('rejects an unknown provider', async () => {
      const errors = await validate(plainToInstance(CreateVcsConnectionDto, { ...base, provider: 'bitbucket' }));
      expect(errors.map((e) => e.property)).toContain('provider');
    });

    it('rejects an unknown syncMode on create', async () => {
      const errors = await validate(plainToInstance(CreateVcsConnectionDto, { ...base, provider: 'github', syncMode: 'hourly' }));
      expect(errors.map((e) => e.property)).toContain('syncMode');
    });
  });
```

`apps/api/src/vcs/vcs-connection.gitlab.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsProviderType, VcsSyncModeType } from './dto/create-vcs-connection.dto';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsPollingService } from './vcs-polling.service';
import type { IVcsConfig } from '../config/vcs.config';

const KEY = 'ab'.repeat(32);
const config = {
  encryptionKey: KEY,
  defaultPollingIntervalMs: 600000,
  githubApiUrl: 'https://api.github.com',
  gitlabApiUrl: 'https://gitlab.com/api/v4',
} as IVcsConfig;

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', projectId: 'p1', provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'app',
    encryptedToken: 'enc', syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: 600000,
    webhookSecret: 's'.repeat(32), isActive: true, lastSyncedAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

describe('VcsConnectionService — GitLab (BUG-14)', () => {
  let repo: Record<string, jest.Mock>;
  let service: VcsConnectionService;

  beforeEach(() => {
    repo = {
      findProjectById: jest.fn().mockResolvedValue({ id: 'p1' }),
      findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
      createVcsConnection: jest.fn().mockImplementation(async (data) => connectionRow(data)),
      updateVcsConnection: jest.fn().mockImplementation(async (_id, data) => connectionRow(data)),
    };
    const polling = { refreshConnectionSchedule: jest.fn().mockResolvedValue(undefined) };
    service = new VcsConnectionService(repo as unknown as IVcsRepository, config, polling as unknown as VcsPollingService);
  });

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('vcs.gitlabWebhook');
  };

  it('creates a polling GitLab connection from a self-hosted subgroup URL', async () => {
    await service.create('p1', KEY, {
      provider: VcsProviderType.GITLAB,
      repoOwner: 'ignored',
      repoName: 'ignored',
      repoUrl: 'https://git.corp/grp/sub/app.git',
      token: 'glpat-x',
      syncMode: VcsSyncModeType.POLLING,
    });

    expect(repo.createVcsConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'app', syncMode: 'polling' }),
    );
  });

  it('refuses webhook mode for a new GitLab connection', async () => {
    await refusal(service.create('p1', KEY, {
      provider: VcsProviderType.GITLAB, repoOwner: 'g', repoName: 'r', token: 't', syncMode: VcsSyncModeType.WEBHOOK,
    }));
    expect(repo.createVcsConnection).not.toHaveBeenCalled();
  });

  it('refuses switching an existing GitLab connection to webhook mode', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(connectionRow());

    await refusal(service.update('p1', KEY, { syncMode: VcsSyncModeType.WEBHOOK }));
    expect(repo.updateVcsConnection).not.toHaveBeenCalled();
  });
});
```

`apps/api/src/vcs/providers/gitlab.provider.outbound.spec.ts`:

```ts
/**
 * BUG-14 outbound: auto-MR creation proceeds when the branch already exists.
 * GitLab reports that as HTTP 400 with {"message":"Branch already exists"},
 * which the default HTTP client must surface on the error.
 */
import { createVcsProvider } from '../factory';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GitLabProvider.createPullRequest with the default HTTP client', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => fetchSpy.mockRestore());

  it('creates the MR when the branch already exists', async () => {
    fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { default_branch: 'main' }))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'Branch already exists' }))
      .mockResolvedValueOnce(jsonResponse(201, { iid: 4, web_url: 'https://gitlab.com/g/r/-/merge_requests/4', state: 'opened', draft: true }));
    const provider = createVcsProvider('gitlab', { provider: 'gitlab', token: 't', repoUrl: 'https://gitlab.com/g/r' });

    const mr = await provider.createPullRequest({ title: 'T', body: 'B', branchName: 'feat' });

    expect(mr.number).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('still fails on any other 400', async () => {
    fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { default_branch: 'main' }))
      .mockResolvedValueOnce(jsonResponse(400, { message: 'Invalid branch name' }));
    const provider = createVcsProvider('gitlab', { provider: 'gitlab', token: 't', repoUrl: 'https://gitlab.com/g/r' });

    await expect(provider.createPullRequest({ title: 'T', body: 'B', branchName: 'bad..name' })).rejects.toThrow('HTTP 400');
  });
});
```

- [ ] **Step 2: Run to see them fail**

```bash
cd apps/api && bunx jest src/vcs/dto/vcs-connection.dto.spec.ts src/vcs/vcs-connection.gitlab.spec.ts src/vcs/providers/gitlab.provider.outbound.spec.ts
```

Expected: FAIL. `gitlab` is rejected by the enum, the service parses only `github.com` URLs, and the MR test throws `HTTP 400`.

- [ ] **Step 3: Implement the DTO and service rules**

`create-vcs-connection.dto.ts`:

```ts
export enum VcsProviderType {
  GITHUB = 'github',
  GITLAB = 'gitlab',
}
```

```ts
  @IsOptional()
  @IsEnum(VcsSyncModeType)
  syncMode?: VcsSyncModeType;
```

In `vcs-connection.service.ts`:

- Replace `parseRepoUrl` with a call to the factory helper: `const parsed = parseRepoPath(dto.provider, dto.repoUrl);`. Delete the private `parseRepoUrl` method. Import `parseRepoPath` from `./factory`.
- In `create`, directly after `const syncMode = dto.syncMode ?? 'off';`, add `this.assertSyncModeSupported(dto.provider, syncMode);`.
- In `update`, directly after the not-found check, add:

```ts
    if (dto.syncMode) {
      this.assertSyncModeSupported(connection.provider, dto.syncMode);
    }
```

- Add the private method:

```ts
  /**
   * BUG-14: GitLab is polling + outbound only. Inbound GitLab webhooks are out of
   * scope (Track 3 ruling 2026-09-27), so webhook mode is refused up front
   * rather than accepted and then ignored on every delivery.
   */
  private assertSyncModeSupported(provider: string, syncMode: string): void {
    if (provider.toLowerCase() === 'gitlab' && syncMode === 'webhook') {
      throw new ValidationAppException({}, 'vcs.gitlabWebhook');
    }
  }
```

Also delete `apps/api/src/i18n/{en,zh}/vcs.json` → `errors.gitlabNotSupported` only if `grep -rn gitlabNotSupported apps` shows no reader. Add this top-level key to both files, English:

```json
  "gitlabWebhook": {
    "-2": "GitLab connections support polling only: webhook sync is not available for GitLab"
  }
```

and Chinese:

```json
  "gitlabWebhook": {
    "-2": "GitLab 连接仅支持轮询同步，不支持 Webhook 同步"
  }
```

- [ ] **Step 4: Carry error bodies on the default HTTP client**

In `apps/api/src/vcs/factory.ts`, add above `createDefaultHttpClient`:

```ts
/** An HTTP error that keeps the status and the parsed JSON body (GitLab reports conflicts in the body). */
async function httpError(response: Response): Promise<Error> {
  const data: unknown = await response.json().catch(() => undefined);
  const error = new Error(`HTTP ${response.status}`);
  (error as unknown as Record<string, unknown>).response = { status: response.status, data };
  return error;
}
```

In both `get` and `post`, replace the three-line `if (!response.ok) { ... }` block with:

```ts
      if (!response.ok) {
        throw await httpError(response);
      }
```

In `gitlab.provider.ts` `createPullRequest`, replace the branch-exists test:

```ts
      const errorObj = error as Record<string, unknown>;
      const response = errorObj?.response as { status?: number; data?: unknown } | undefined;
      const message = typeof errorObj?.message === 'string' ? errorObj.message : '';
      const body = response?.data === undefined ? '' : JSON.stringify(response.data);
      if (response?.status === 400 && /already exists/i.test(`${message} ${body}`)) {
        // Branch already exists, proceed to MR creation
      } else {
        throw error;
      }
```

- [ ] **Step 5: Run, then regenerate the contract**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs
bun run test:scoped test/integration/vcs
cd ../.. && bun run generate
git diff --stat openapi.json
```

Expected: green. The `openapi.json` diff shows `CreateVcsConnectionDto.provider` enum `["github","gitlab"]` and a `syncMode` enum. If `test/integration/vcs/i18n-keys.integration.spec.ts` or `vcs-i18n.integration.spec.ts` checks key parity, it passes because both locales gained the same key.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src openapi.json
git commit -m "feat(vcs): GitLab connections for polling and outbound MRs (BUG-14)"
```

---

### Task 5: M10 — paginated issue fetch with a cursor

**Files:**
- Create: `apps/api/src/vcs/providers/pagination.ts`, `apps/api/src/vcs/providers/pagination.spec.ts`
- Create: `apps/api/src/vcs/providers/github.provider.pagination.spec.ts`, `apps/api/src/vcs/providers/gitlab.provider.pagination.spec.ts`
- Modify: `apps/api/src/vcs/types.ts` (add `IssueFetchResult`)
- Modify: `apps/api/src/vcs/vcs-provider.ts:7-11`
- Modify: `apps/api/src/vcs/factory.ts` (`HttpClient.get` response headers)
- Modify: `apps/api/src/vcs/providers/github.provider.ts:9-20,103-128`
- Modify: `apps/api/src/vcs/providers/gitlab.provider.ts:9-19,96-114`
- Modify: `apps/api/src/vcs/vcs-sync.service.ts` (`fullSync`), `apps/api/src/vcs/vcs-polling.service.ts` (`poll`)
- Modify: every spec that mocks `fetchIssues` or implements `IVcsProvider` (tsc lists them)

**Interfaces:**
- Produces: `interface IssueFetchResult { issues: VcsIssue[]; cursor: Date | null; capped: boolean }` in `types.ts`.
  - `cursor` is the newest `updated_at` among every item fetched, including PRs from GitHub's issues endpoint, or `null` when nothing came back.
  - `capped` is true when more pages remained after `MAX_ISSUE_PAGES`, or when pagination stopped at an off-origin link.
- Produces: `IVcsProvider.fetchIssues(since?: Date): Promise<IssueFetchResult>`.
- Produces: `HttpClient.get(...)` resolves `{ data: unknown; headers?: Record<string, string> }`, with lower-cased header names.
- Produces from `pagination.ts`: `ISSUES_PER_PAGE = 100`, `MAX_ISSUE_PAGES = 10`, `nextLinkUrl(header?: string): string | null`, `nextPageNumber(header?: string): number | null`, `laterOf(current: Date | null, iso?: string | null): Date | null`, `sameOrigin(url: string, base: string): boolean`.

Context: GitHub returns 30 items per page by default and nothing follows `Link`. With `sort=created&direction=asc` and a stale `since`, every poll re-fetches the same oldest 30 issues, and later issues starve (M10, understated). GitHub's `since` filters on update time, so the order must also be by update time: `sort=updated&direction=asc`. Only then does "resume from the newest `updated_at` seen" pick up exactly where a capped poll stopped. GitLab uses `order_by=updated_at&sort=asc`, `updated_after`, and the `X-Next-Page` header.

- [ ] **Step 1: Write the failing helper spec**

`apps/api/src/vcs/providers/pagination.spec.ts`:

```ts
import { laterOf, nextLinkUrl, nextPageNumber, sameOrigin } from './pagination';

describe('pagination helpers (M10)', () => {
  it('reads rel="next" from a Link header', () => {
    const header = '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=9>; rel="last"';
    expect(nextLinkUrl(header)).toBe('https://api.github.com/repos/o/r/issues?page=2');
  });

  it('returns null without a next link', () => {
    expect(nextLinkUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLinkUrl(undefined)).toBeNull();
  });

  it.each([['3', 3], ['', null], [undefined, null], ['0', null], ['abc', null]])('X-Next-Page %j → %j', (header, expected) => {
    expect(nextPageNumber(header)).toBe(expected);
  });

  it('keeps the later of two timestamps and ignores bad input', () => {
    const a = new Date('2026-09-01T00:00:00Z');
    expect(laterOf(null, '2026-09-01T00:00:00Z')).toEqual(a);
    expect(laterOf(a, '2026-08-01T00:00:00Z')).toBe(a);
    expect(laterOf(a, '2026-10-01T00:00:00Z')).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(laterOf(a, 'garbage')).toBe(a);
    expect(laterOf(a, undefined)).toBe(a);
  });

  it('compares origins', () => {
    expect(sameOrigin('https://api.github.com/x?page=2', 'https://api.github.com')).toBe(true);
    expect(sameOrigin('https://evil.example/x', 'https://api.github.com')).toBe(false);
    expect(sameOrigin('not a url', 'https://api.github.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing provider specs**

`apps/api/src/vcs/providers/github.provider.pagination.spec.ts`:

```ts
import { GitHubProvider } from './github.provider';
import type { HttpClient } from '../factory';

const API = 'https://api.github.com';

function issue(number: number, updatedAt: string, isPr = false) {
  return {
    number,
    title: `#${number}`,
    body: null,
    user: { login: 'dev' },
    html_url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
    ...(isPr ? { pull_request: {} } : {}),
  };
}

function page(items: unknown[], next?: string) {
  return { data: items, headers: next ? { link: `<${next}>; rel="next"` } : {} };
}

describe('GitHubProvider.fetchIssues pagination (M10)', () => {
  let get: jest.Mock;
  let provider: GitHubProvider;

  beforeEach(() => {
    get = jest.fn();
    provider = new GitHubProvider('o', 'r', 'tok', { get, post: jest.fn() } as unknown as HttpClient, API);
  });

  it('asks for 100 per page in update order, since the cursor', async () => {
    get.mockResolvedValueOnce(page([]));

    await provider.fetchIssues(new Date('2026-09-01T00:00:00Z'));

    expect(get).toHaveBeenCalledWith(`${API}/repos/o/r/issues`, {
      headers: { Authorization: 'Bearer tok' },
      params: { state: 'open', sort: 'updated', direction: 'asc', per_page: 100, since: '2026-09-01T00:00:00.000Z' },
    });
  });

  it('follows next links, drops PRs, and takes the cursor from every item', async () => {
    get
      .mockResolvedValueOnce(page([issue(1, '2026-09-01T00:00:00Z'), issue(2, '2026-09-02T00:00:00Z', true)], `${API}/repos/o/r/issues?page=2`))
      .mockResolvedValueOnce(page([issue(3, '2026-09-03T00:00:00Z', true)]));

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenNthCalledWith(2, `${API}/repos/o/r/issues?page=2`, { headers: { Authorization: 'Bearer tok' }, params: undefined });
    expect(result.issues.map((i) => i.number)).toEqual([1]);
    expect(result.cursor).toEqual(new Date('2026-09-03T00:00:00Z'));
    expect(result.capped).toBe(false);
  });

  it('stops after 10 pages and reports the fetch as capped', async () => {
    get.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get('page') ?? '1');
      return page([issue(n, `2026-09-${String(n).padStart(2, '0')}T00:00:00Z`)], `${API}/repos/o/r/issues?page=${n + 1}`);
    });

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenCalledTimes(10);
    expect(result.capped).toBe(true);
    expect(result.cursor).toEqual(new Date('2026-09-10T00:00:00Z'));
  });

  it('never sends the token to another origin', async () => {
    get.mockResolvedValueOnce(page([issue(1, '2026-09-01T00:00:00Z')], 'https://evil.example/steal'));

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.capped).toBe(true);
    expect(result.issues).toHaveLength(1);
  });

  it('reports a null cursor when nothing came back', async () => {
    get.mockResolvedValueOnce(page([]));
    await expect(provider.fetchIssues()).resolves.toEqual({ issues: [], cursor: null, capped: false });
  });
});
```

`apps/api/src/vcs/providers/gitlab.provider.pagination.spec.ts`:

```ts
import { GitLabProvider } from './gitlab.provider';
import type { HttpClient } from '../factory';

function issue(iid: number, updatedAt: string) {
  return {
    iid,
    title: `#${iid}`,
    description: null,
    author: { username: 'dev' },
    web_url: `https://gitlab.com/g/r/-/issues/${iid}`,
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
  };
}

describe('GitLabProvider.fetchIssues pagination (M10)', () => {
  let get: jest.Mock;
  let provider: GitLabProvider;

  beforeEach(() => {
    get = jest.fn();
    provider = new GitLabProvider('g', 'r', 'tok', { get, post: jest.fn() } as unknown as HttpClient);
  });

  it('pages with X-Next-Page in update order, since the cursor', async () => {
    get
      .mockResolvedValueOnce({ data: [issue(1, '2026-09-01T00:00:00Z')], headers: { 'x-next-page': '2' } })
      .mockResolvedValueOnce({ data: [issue(2, '2026-09-02T00:00:00Z')], headers: { 'x-next-page': '' } });

    const result = await provider.fetchIssues(new Date('2026-08-01T00:00:00Z'));

    const base = { state: 'opened', order_by: 'updated_at', sort: 'asc', per_page: 100, updated_after: '2026-08-01T00:00:00.000Z' };
    expect(get).toHaveBeenNthCalledWith(1, 'https://gitlab.com/api/v4/projects/g%2Fr/issues', { headers: { 'PRIVATE-TOKEN': 'tok' }, params: { ...base, page: 1 } });
    expect(get).toHaveBeenNthCalledWith(2, 'https://gitlab.com/api/v4/projects/g%2Fr/issues', { headers: { 'PRIVATE-TOKEN': 'tok' }, params: { ...base, page: 2 } });
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(result.cursor).toEqual(new Date('2026-09-02T00:00:00Z'));
    expect(result.capped).toBe(false);
  });

  it('stops after 10 pages and reports the fetch as capped', async () => {
    get.mockImplementation(async (_url: string, config: { params: { page: number } }) => ({
      data: [issue(config.params.page, '2026-09-01T00:00:00Z')],
      headers: { 'x-next-page': String(config.params.page + 1) },
    }));

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenCalledTimes(10);
    expect(result.capped).toBe(true);
  });
});
```

- [ ] **Step 3: Run to see them fail**

```bash
cd apps/api && bunx jest src/vcs/providers
```

Expected: FAIL. `./pagination` is missing and `fetchIssues` returns an array.

- [ ] **Step 4: Implement the helpers and types**

`apps/api/src/vcs/providers/pagination.ts`:

```ts
/** M10: GitHub's default page is 30 items; ask for the maximum. */
export const ISSUES_PER_PAGE = 100;

/** M10: pages fetched per poll. A capped poll resumes from its cursor on the next tick. */
export const MAX_ISSUE_PAGES = 10;

/** The rel="next" URL from a GitHub `Link` header, or null. */
export function nextLinkUrl(linkHeader: string | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

/** GitLab's `X-Next-Page` header as a page number; empty or invalid means no next page. */
export function nextPageNumber(header: string | undefined): number | null {
  const page = Number.parseInt(header ?? '', 10);
  return Number.isInteger(page) && page > 0 ? page : null;
}

/** The later of `current` and the ISO timestamp `iso`; unparseable input keeps `current`. */
export function laterOf(current: Date | null, iso: string | null | undefined): Date | null {
  if (!iso) return current;
  const candidate = new Date(iso);
  if (Number.isNaN(candidate.getTime())) return current;
  return !current || candidate > current ? candidate : current;
}

/** Whether `url` is on the same origin as `base`. A pagination link that is not never receives the token. */
export function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
```

`apps/api/src/vcs/types.ts`, after `VcsIssue`:

```ts
/**
 * M10: one poll's worth of issues. `cursor` is the newest update time among
 * every item fetched (null when none); `capped` means more remained.
 */
export interface IssueFetchResult {
  issues: VcsIssue[];
  cursor: Date | null;
  capped: boolean;
}
```

`apps/api/src/vcs/vcs-provider.ts`:

```ts
  /**
   * Fetch open issues in update order, paginated up to MAX_ISSUE_PAGES.
   * @param since Optional - only issues updated at or after this time
   */
  fetchIssues(since?: Date): Promise<IssueFetchResult>;
```

(import `IssueFetchResult` from `./types`).

`apps/api/src/vcs/factory.ts`: change the `HttpClient.get` return type to `Promise<{ data: unknown; headers?: Record<string, string> }>`. In the default client's `get`, return the headers:

```ts
      const data = await response.json();
      return { data, headers: Object.fromEntries(response.headers.entries()) };
```

- [ ] **Step 5: Implement the GitHub fetch**

In `github.provider.ts`, add `updated_at: string;` to `GitHubIssueResponse`. Import `{ ISSUES_PER_PAGE, MAX_ISSUE_PAGES, laterOf, nextLinkUrl, sameOrigin }` from `./pagination` and `IssueFetchResult` from `../types`. Replace `fetchIssues`:

```ts
  async fetchIssues(since?: Date): Promise<IssueFetchResult> {
    const headers = { Authorization: `Bearer ${this.token}` };
    const issues: VcsIssue[] = [];
    let cursor: Date | null = null;
    let url: string | null = `${this.apiBaseUrl}/repos/${this.repoOwner}/${this.repoName}/issues`;
    // The next link already carries the query, so params go on the first request only.
    let params: Record<string, unknown> | undefined = {
      state: 'open',
      sort: 'updated',
      direction: 'asc',
      per_page: ISSUES_PER_PAGE,
      ...(since ? { since: since.toISOString() } : {}),
    };

    for (let pages = 0; url && pages < MAX_ISSUE_PAGES; pages++) {
      const response = await this.httpClient.get(url, { headers, params });
      for (const item of response.data as GitHubIssueResponse[]) {
        // PRs come back from the issues endpoint: they advance the cursor but are not issues.
        cursor = laterOf(cursor, item.updated_at);
        if (!item.pull_request) issues.push(this.mapGitHubIssueToVcsIssue(item));
      }
      url = nextLinkUrl(response.headers?.['link']);
      params = undefined;
      if (url && !sameOrigin(url, this.apiBaseUrl)) {
        // Never follow a link that would carry the token to another host.
        return { issues, cursor, capped: true };
      }
    }

    return { issues, cursor, capped: url !== null };
  }
```

- [ ] **Step 6: Implement the GitLab fetch**

In `gitlab.provider.ts`, add `updated_at: string;` to `GitLabIssueResponse`. Import `{ ISSUES_PER_PAGE, MAX_ISSUE_PAGES, laterOf, nextPageNumber }` and `IssueFetchResult`. Replace `fetchIssues`:

```ts
  async fetchIssues(since?: Date): Promise<IssueFetchResult> {
    const baseParams: Record<string, unknown> = {
      state: 'opened',
      order_by: 'updated_at',
      sort: 'asc',
      per_page: ISSUES_PER_PAGE,
      ...(since ? { updated_after: since.toISOString() } : {}),
    };
    const issues: VcsIssue[] = [];
    let cursor: Date | null = null;
    let page: number | null = 1;

    for (let pages = 0; page !== null && pages < MAX_ISSUE_PAGES; pages++) {
      const response = await this.httpClient.get(`${this.baseUrl}/issues`, {
        headers: this.authHeaders,
        params: { ...baseParams, page },
      });
      for (const item of response.data as GitLabIssueResponse[]) {
        cursor = laterOf(cursor, item.updated_at);
        issues.push(this.mapGitLabIssueToVcsIssue(item));
      }
      page = nextPageNumber(response.headers?.['x-next-page']);
    }

    return { issues, cursor, capped: page !== null };
  }
```

- [ ] **Step 7: Update the two consumers**

`vcs-sync.service.ts` `fullSync`: `const { issues } = await provider.fetchIssues();` (keep the variable name `issues` used below).

`vcs-polling.service.ts` `poll`: `const { issues } = await provider.fetchIssues(connection.lastSyncedAt ?? undefined);`. Task 6 replaces this with the cursor-aware version.

- [ ] **Step 8: Fix the specs, then run**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs src/code-intel
bun run test:scoped test/integration/vcs
```

tsc does NOT find every broken mock here: specs that stub the provider through `(createVcsProvider as jest.Mock).mockReturnValue({ fetchIssues: ... })` are untyped, so only the jest run exposes them (for example `vcs-sync.service.spec.ts`, `code-commit-outbox-handler.spec.ts`, `vcs.controller.spec.ts`, `vcs-pr-sync.service.spec.ts`, `vcs-link-extractor.service.spec.ts`, `test/integration/vcs/vcs-manual-sync.spec.ts`). Also run `grep -rn "fetchIssues" apps/api/src apps/api/test | grep -v "providers/"` and check every hit. Every `fetchIssues: jest.fn().mockResolvedValue([...])` becomes `mockResolvedValue({ issues: [...], cursor: null, capped: false })`. Every `MockVcsProvider implements IVcsProvider` returns that shape. The provider integration specs (`github.provider.integration.spec.ts`, `gitlab.provider.integration.spec.ts`) that asserted the old query params (`sort: 'created'`, `order_by: 'created_at'`, `created_after`) now assert the new ones from Steps 5-6. Their mocked `get` needs no `headers`, because a missing header ends pagination. Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "fix(vcs): paginate issue fetches in update order with a cursor (M10)"
```

---

### Task 6: M10 — polling re-reads its connection and stores the cursor

**Files:**
- Create: `apps/api/src/vcs/vcs-polling.tick.spec.ts`
- Modify: `apps/api/src/vcs/vcs-polling.service.ts:57-187`
- Modify: `apps/api/src/vcs/domain/vcs.repository.ts:101`, `apps/api/src/vcs/prisma-vcs.repository.ts:130-135`
- Modify: specs asserting `updateVcsConnectionLastSynced` (tsc lists them)

**Interfaces:**
- Consumes: `IssueFetchResult`, `MAX_ISSUE_PAGES`, `ISSUES_PER_PAGE` (Task 5); `providerForConnection` (Task 3).
- Produces: `IVcsRepository.updateVcsConnectionLastSynced(connectionId: string, syncedAt: Date): Promise<void>`.
- `schedulePolling(connection)` keeps its signature, so existing callers and specs keep working.

Context: the interval closure captures the connection object at schedule time. Every tick polls with the stale token, `lastSyncedAt` and mode until a restart, and keeps running after the connection is deleted (M10). The `catch` awaits a sync-log write with no guard, so a DB error there is an unhandled rejection that can crash the process (VCS LOW). `lastSyncedAt` is set to "now", which skips anything a capped poll did not reach.

- [ ] **Step 1: Write the failing spec**

`apps/api/src/vcs/vcs-polling.tick.spec.ts`:

```ts
/**
 * M10: each polling tick re-reads its connection by id, stops when the
 * connection is gone/inactive/not polling, stores the fetch cursor as
 * lastSyncedAt, and logs a capped fetch. A failing sync-log write never
 * escapes as an unhandled rejection (VCS LOW).
 */
import { SchedulerRegistry } from '@nestjs/schedule';
import { VcsPollingService } from './vcs-polling.service';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import type { VcsSyncService } from './vcs-sync.service';
import type { VcsPrSyncService } from './vcs-pr-sync.service';
import type { IVcsConfig } from '../config/vcs.config';

jest.mock('./factory', () => ({ createVcsProvider: jest.fn() }));
jest.mock('../common/utils/encryption.util', () => ({ decryptToken: jest.fn().mockReturnValue('plain') }));

import { createVcsProvider } from './factory';

const INTERVAL = 60_000;

function connection(overrides: Partial<VcsConnectionWithProjectDomain> = {}): VcsConnectionWithProjectDomain {
  return {
    id: 'conn-1', projectId: 'proj-1', provider: 'github', repoOwner: 'o', repoName: 'r',
    encryptedToken: 'enc', syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: INTERVAL,
    webhookSecret: null, lastSyncedAt: null, isActive: true, createdAt: new Date(), updatedAt: new Date(),
    project: { id: 'proj-1', key: 'P', slug: 'p' },
    ...overrides,
  };
}

describe('VcsPollingService tick (M10)', () => {
  let repo: Record<string, jest.Mock>;
  let registry: { addInterval: jest.Mock; deleteInterval: jest.Mock };
  let fetchIssues: jest.Mock;
  let service: VcsPollingService;
  let unhandled: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    fetchIssues = jest.fn().mockResolvedValue({ issues: [], cursor: null, capped: false });
    (createVcsProvider as jest.Mock).mockReturnValue({ fetchIssues });
    repo = {
      findVcsConnectionById: jest.fn(),
      updateVcsConnectionLastSynced: jest.fn().mockResolvedValue(undefined),
      createVcsSyncLog: jest.fn().mockResolvedValue({}),
    };
    registry = { addInterval: jest.fn(), deleteInterval: jest.fn() };
    const sync = { filterByAllowedAuthors: jest.fn((issues) => issues), syncIssue: jest.fn() };
    const prSync = { syncPrStatus: jest.fn().mockResolvedValue({ updated: 0, skipped: 0 }) };
    service = new VcsPollingService(
      repo as unknown as IVcsRepository,
      registry as unknown as SchedulerRegistry,
      sync as unknown as VcsSyncService,
      prSync as unknown as VcsPrSyncService,
      { encryptionKey: 'ab'.repeat(32), defaultPollingIntervalMs: INTERVAL, githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as IVcsConfig,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    process.off('unhandledRejection', unhandled);
  });

  const tick = () => jest.advanceTimersByTimeAsync(INTERVAL);

  it('polls with the connection as it is now, not as it was scheduled', async () => {
    const cursor = new Date('2026-09-20T00:00:00Z');
    repo.findVcsConnectionById.mockResolvedValue(connection({ lastSyncedAt: cursor }));
    service.schedulePolling(connection());

    await tick();

    expect(repo.findVcsConnectionById).toHaveBeenCalledWith('conn-1');
    expect(fetchIssues).toHaveBeenCalledWith(cursor);
  });

  it.each([
    ['deleted', null],
    ['inactive', connection({ isActive: false })],
    ['switched to webhook', connection({ syncMode: 'webhook' })],
  ])('unschedules itself when the connection is %s', async (_label, current) => {
    repo.findVcsConnectionById.mockResolvedValue(current);
    service.schedulePolling(connection());

    await tick();

    expect(registry.deleteInterval).toHaveBeenLastCalledWith('vcs-polling-conn-1');
    expect(fetchIssues).not.toHaveBeenCalled();
  });

  it('stores the newest update seen as lastSyncedAt', async () => {
    const cursor = new Date('2026-09-21T10:00:00Z');
    repo.findVcsConnectionById.mockResolvedValue(connection());
    fetchIssues.mockResolvedValue({ issues: [], cursor, capped: false });
    service.schedulePolling(connection());

    await tick();

    expect(repo.updateVcsConnectionLastSynced).toHaveBeenCalledWith('conn-1', cursor);
    expect(repo.createVcsSyncLog).toHaveBeenCalledWith(expect.not.objectContaining({ errorMessage: expect.anything() }));
  });

  it('keeps the old cursor when nothing came back', async () => {
    repo.findVcsConnectionById.mockResolvedValue(connection());
    service.schedulePolling(connection());

    await tick();

    expect(repo.updateVcsConnectionLastSynced).not.toHaveBeenCalled();
  });

  it('writes a warning to the sync log when the fetch was capped', async () => {
    repo.findVcsConnectionById.mockResolvedValue(connection());
    fetchIssues.mockResolvedValue({ issues: [], cursor: new Date('2026-09-21T10:00:00Z'), capped: true });
    service.schedulePolling(connection());

    await tick();

    expect(repo.createVcsSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining('capped at 10 pages') }),
    );
  });

  it('survives a failed poll whose sync-log write also fails', async () => {
    repo.findVcsConnectionById.mockResolvedValue(connection());
    fetchIssues.mockRejectedValue(new Error('GitHub down'));
    repo.createVcsSyncLog.mockRejectedValue(new Error('DB down'));
    service.schedulePolling(connection());

    await tick();
    await tick();

    expect(repo.createVcsSyncLog).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('survives a failed re-read', async () => {
    repo.findVcsConnectionById.mockRejectedValue(new Error('DB down'));
    service.schedulePolling(connection());

    await tick();

    expect(unhandled).not.toHaveBeenCalled();
  });
});
```

If `jest.advanceTimersByTimeAsync` is not available in the installed Jest (it is in 29.5+), use `jest.advanceTimersByTime(INTERVAL)` followed by `await new Promise(jest.requireActual('timers').setImmediate)` a few times.

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/api && bunx jest src/vcs/vcs-polling.tick.spec.ts
```

Expected: FAIL. The tick polls the captured object, never unschedules, and writes `lastSyncedAt` without a date.

- [ ] **Step 3: Implement the cursor write**

`domain/vcs.repository.ts`: `updateVcsConnectionLastSynced(connectionId: string, syncedAt: Date): Promise<void>;`

`prisma-vcs.repository.ts`:

```ts
  /** M10: the poll cursor, the newest issue update seen (never "now"). */
  async updateVcsConnectionLastSynced(connectionId: string, syncedAt: Date): Promise<void> {
    await this.db.vcsConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: syncedAt },
    });
  }
```

- [ ] **Step 4: Implement the tick and the guarded poll**

In `vcs-polling.service.ts`, import `{ ISSUES_PER_PAGE, MAX_ISSUE_PAGES }` from `./providers/pagination`. Add a module-level helper:

```ts
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');
```

In `schedulePolling`, replace the `setInterval` block:

```ts
    // M10: each tick re-reads the connection, so it polls with the current token,
    // cursor and mode, and stops once the connection is gone.
    const interval = setInterval(() => {
      void this.tick(connection.id);
    }, connection.pollingIntervalMs);
```

Add:

```ts
  /** One polling tick. Never rejects: an interval callback has no caller to catch it. */
  private async tick(connectionId: string): Promise<void> {
    try {
      const connection = await this.vcsRepo.findVcsConnectionById(connectionId);
      if (!connection || !connection.isActive || connection.syncMode !== 'polling') {
        this.unschedulePolling(connectionId);
        return;
      }
      await this.poll(connection);
    } catch (error) {
      this.logger.error(`Polling tick failed for connection ${connectionId}: ${messageOf(error)}`);
    }
  }
```

Replace the body of `poll` from the provider creation down to the sync-log write, and the whole `catch`:

```ts
      const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);

      const { issues, cursor, capped } = await provider.fetchIssues(connection.lastSyncedAt ?? undefined);

      // Filter by allowed authors
      const filteredIssues = this.syncService.filterByAllowedAuthors(issues, connection.allowedAuthors);

      let issuesSynced = 0;
      let issuesSkipped = 0;

      for (const issue of filteredIssues) {
        const result = await this.syncService.syncIssue(connection.project, issue, 'polling', connection);
        if (result.action === 'created') {
          issuesSynced++;
        } else {
          issuesSkipped++;
        }
      }

      // M10: resume from the newest issue update seen, not from "now", so a capped
      // poll picks up where it stopped. Nothing seen keeps the old cursor.
      if (cursor) {
        await this.vcsRepo.updateVcsConnectionLastSynced(connection.id, cursor);
      }

      await this.vcsRepo.createVcsSyncLog({
        vcsConnectionId: connection.id,
        syncType: 'polling',
        issuesSynced,
        issuesSkipped,
        ...(capped ? { errorMessage: cappedWarning(cursor) } : {}),
        startedAt: startTime,
        completedAt: new Date(),
      });
```

Keep the debug log and the PR-sync call that follow. Then replace the `catch`:

```ts
    } catch (error) {
      const errorMessage = messageOf(error);
      this.logger.error(`Polling failed for connection ${connection.id}: ${errorMessage}`);
      // VCS LOW: the error-path log write is guarded too; an interval callback
      // that rejects is an unhandled rejection. lastSyncedAt is not moved, so
      // the next tick retries from the same cursor.
      try {
        await this.vcsRepo.createVcsSyncLog({
          vcsConnectionId: connection.id,
          syncType: 'polling',
          issuesSynced: 0,
          issuesSkipped: 0,
          errorMessage,
          startedAt: startTime,
          completedAt: new Date(),
        });
      } catch (logError) {
        this.logger.error(`Failed to write the polling sync log for connection ${connection.id}: ${messageOf(logError)}`);
      }
    }
```

Add the warning builder at module level:

```ts
/** Sync-log warning for a fetch that hit MAX_ISSUE_PAGES. */
function cappedWarning(cursor: Date | null): string {
  const from = cursor ? cursor.toISOString() : 'the previous cursor';
  return `Issue fetch capped at ${MAX_ISSUE_PAGES} pages of ${ISSUES_PER_PAGE}; the next poll resumes from ${from}`;
}
```

- [ ] **Step 5: Fix the specs, then run**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs
bun run test:scoped test/integration/vcs
```

Assertions of `updateVcsConnectionLastSynced` called with only the id now take a second `expect.any(Date)` argument, or the exact cursor the fixture returns. Specs that drove a poll through `(service as any).poll(conn)` still work. Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "fix(vcs): polling re-reads its connection and resumes from the issue cursor (M10)"
```

---

### Task 7: M9 — webhook secret shown once, rotate endpoint, enveloped VCS responses

**Files:**
- Create: `apps/api/src/vcs/webhook-secret.ts`
- Create: `apps/api/src/vcs/vcs-connection.webhook-secret.spec.ts`
- Create: `apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts`
- Modify: `apps/api/src/vcs/dto/vcs-connection-response.dto.ts`
- Modify: `apps/api/src/vcs/dto/update-vcs-connection.dto.ts:23-26`
- Modify: `apps/api/src/vcs/vcs-connection.service.ts` (`create`, `update`, new `rotateWebhookSecret`)
- Modify: `apps/api/src/vcs/vcs.controller.ts` (every route returns `JsonResponse.Ok`; new rotate route)
- Modify: `apps/api/src/vcs/vcs.controller.spec.ts`, `apps/api/test/integration/vcs/vcs-controller.spec.ts`, `apps/api/test/integration/vcs/vcs-manual-sync.spec.ts` (response shape)
- Modify: `openapi.json` (regenerated)

**Interfaces:**
- Produces: `generateWebhookSecret(): string` (32 hex chars).
- Produces DTOs:
  - `VcsConnectionCreatedResponseDto extends VcsConnectionResponseDto { webhookSecret: string }`
  - `VcsConnectionUpdatedResponseDto extends VcsConnectionResponseDto { webhookSecret?: string }`
  - `WebhookSecretResponseDto { webhookSecret: string }`
- Produces: `VcsConnectionService.rotateWebhookSecret(projectId: string): Promise<WebhookSecretResponseDto>`.
- Produces route `POST /projects/:slug/vcs/webhook-secret/rotate` → 200 `JsonResponse.Ok({ webhookSecret })`. Operation id `VcsController_rotateWebhookSecret`, so the CLI gets `vcsControllerRotateWebhookSecret`.
- Every `VcsController` route now returns `JsonResponse.Ok(...)`. The web client passes envelopes through `useApi`. The CLI's `unwrap` requires one: today the raw DTO makes `koda vcs connect/status/test/sync` throw `exception.-1`.

Context: the secret is generated on create but never returned, and `dto.webhookSecret` on update is ignored, so webhook mode cannot be configured (M9). The update path can also generate a secret for a legacy row switching to webhook mode. That secret is returned once too, so it is not a second never-seen secret. The rotate route is project ADMIN or global ADMIN. `ProjectMembershipGuard` + `@ProjectRoles('ADMIN')` gives exactly that for users. The guard lets agents through `@ProjectRoles`, so the handler refuses agents: they never hold webhook secrets.

- [ ] **Step 1: Write the failing service spec**

`apps/api/src/vcs/vcs-connection.webhook-secret.spec.ts`:

```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsProviderType, VcsSyncModeType } from './dto/create-vcs-connection.dto';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsPollingService } from './vcs-polling.service';
import type { IVcsConfig } from '../config/vcs.config';

const KEY = 'ab'.repeat(32);
const HEX_32 = /^[0-9a-f]{32}$/;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', projectId: 'p1', provider: 'github', repoOwner: 'o', repoName: 'r', encryptedToken: 'enc',
    syncMode: 'off', allowedAuthors: '[]', pollingIntervalMs: 600000, webhookSecret: 'old'.padEnd(32, '0'),
    isActive: true, lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

describe('VcsConnectionService webhook secret (M9)', () => {
  let repo: Record<string, jest.Mock>;
  let service: VcsConnectionService;

  beforeEach(() => {
    repo = {
      findProjectById: jest.fn().mockResolvedValue({ id: 'p1' }),
      findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
      createVcsConnection: jest.fn().mockImplementation(async (data) => row(data)),
      updateVcsConnection: jest.fn().mockImplementation(async (_p, data) => row(data)),
    };
    service = new VcsConnectionService(
      repo as unknown as IVcsRepository,
      { encryptionKey: KEY, defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as IVcsConfig,
      { refreshConnectionSchedule: jest.fn() } as unknown as VcsPollingService,
    );
  });

  it('create returns the stored secret once', async () => {
    const created = await service.create('p1', KEY, { provider: VcsProviderType.GITHUB, repoOwner: 'o', repoName: 'r', token: 't' });

    const stored = repo.createVcsConnection.mock.calls[0][0].webhookSecret;
    expect(created.webhookSecret).toMatch(HEX_32);
    expect(created.webhookSecret).toBe(stored);
    expect(created.webhookSecretConfigured).toBe(true);
  });

  it('reads never include the secret', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(row());
    const read = await service.findByProject('p1');
    expect(read).not.toHaveProperty('webhookSecret');
  });

  it('update returns a secret only when it generated one for a legacy row', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(row({ webhookSecret: null }));
    const enabled = await service.update('p1', KEY, { syncMode: VcsSyncModeType.WEBHOOK });
    expect(enabled.webhookSecret).toMatch(HEX_32);

    repo.findVcsConnectionByProjectId.mockResolvedValue(row());
    const plain = await service.update('p1', KEY, { syncMode: VcsSyncModeType.POLLING });
    expect(plain).not.toHaveProperty('webhookSecret');
  });

  it('rotate stores and returns a new secret', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(row());

    const { webhookSecret } = await service.rotateWebhookSecret('p1');

    expect(webhookSecret).toMatch(HEX_32);
    expect(webhookSecret).not.toBe(row().webhookSecret);
    expect(repo.updateVcsConnection).toHaveBeenCalledWith('p1', { webhookSecret });
  });

  it('rotate 404s without a connection', async () => {
    await expect(service.rotateWebhookSecret('p1')).rejects.toBeInstanceOf(NotFoundAppException);
  });
});
```

- [ ] **Step 2: Write the failing HTTP spec**

`apps/api/test/integration/vcs/vcs-webhook-secret.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4 (M9): the webhook secret is shown on create and on rotate,
 * never on read. Rotation is project ADMIN or global ADMIN; DEVELOPER, VIEWER,
 * non-members and agents are refused.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-webhook-secret.integration.spec.ts
 */
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const HEX_32 = /^[0-9a-f]{32}$/;
const ROTATE = '/api/projects/hooks/vcs/webhook-secret/rotate';

describeIntegration('VCS webhook secret (M9)', () => {
  jest.setTimeout(60000);
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  let createdSecret: string;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Hooks', slug: 'hooks', key: 'HOOK' }).expect(201);
    for (const [who, role] of [['padmin', 'ADMIN'], ['pdev', 'DEVELOPER'], ['pviewer', 'VIEWER']]) {
      await request(server).post('/api/projects/hooks/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Hook Agent', slug: 'hook-agent', roles: ['DEVELOPER'] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

    const created = await request(server).post('/api/projects/hooks/vcs').set(auth('root'))
      .send({ provider: 'github', repoOwner: 'acme', repoName: 'widgets', token: 'ghp_test', syncMode: 'webhook' })
      .expect(201);
    createdSecret = data<{ webhookSecret: string }>(created).webhookSecret;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    if (previousKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousKey;
  });

  const storedSecret = async () =>
    (await prisma.vcsConnection.findFirstOrThrow({ where: { project: { slug: 'hooks' } } })).webhookSecret;

  it('create returned the stored secret', async () => {
    expect(createdSecret).toMatch(HEX_32);
    expect(await storedSecret()).toBe(createdSecret);
  });

  it('a read never returns the secret', async () => {
    const res = await request(server).get('/api/projects/hooks/vcs').set(auth('root')).expect(200);
    const body = data<Record<string, unknown>>(res);
    expect(body).not.toHaveProperty('webhookSecret');
    expect(body.webhookSecretConfigured).toBe(true);
  });

  it.each(['padmin', 'root'])('%s rotates and gets the new secret once', async (who) => {
    const before = await storedSecret();
    const res = await request(server).post(ROTATE).set(auth(who)).expect(200);
    const { webhookSecret } = data<{ webhookSecret: string }>(res);
    expect(webhookSecret).toMatch(HEX_32);
    expect(webhookSecret).not.toBe(before);
    expect(await storedSecret()).toBe(webhookSecret);
  });

  it.each(['pdev', 'pviewer', 'outsider', 'agent'])('%s cannot rotate', async (who) => {
    const before = await storedSecret();
    await request(server).post(ROTATE).set(auth(who)).expect(403);
    expect(await storedSecret()).toBe(before);
  });
});
```

- [ ] **Step 3: Run to see them fail**

```bash
cd apps/api
bunx jest src/vcs/vcs-connection.webhook-secret.spec.ts
bun run test:scoped test/integration/vcs/vcs-webhook-secret.integration.spec.ts
```

Expected: FAIL. `webhookSecret` is undefined on create, `rotateWebhookSecret` is missing, and the HTTP responses are not enveloped (`data()` fails on `ret`).

- [ ] **Step 4: Implement the secret and DTOs**

`apps/api/src/vcs/webhook-secret.ts`:

```ts
import { randomBytes } from 'crypto';

/** M9: a new inbound-webhook signing secret (32 hex chars, 128 bits). */
export function generateWebhookSecret(): string {
  return randomBytes(16).toString('hex');
}
```

Append to `dto/vcs-connection-response.dto.ts`:

```ts
/** M9: the create response carries the generated webhook secret, once. */
export class VcsConnectionCreatedResponseDto extends VcsConnectionResponseDto {
  webhookSecret: string;
}

/** M9: set only when this update generated a secret (a legacy row switching to webhook mode). */
export class VcsConnectionUpdatedResponseDto extends VcsConnectionResponseDto {
  webhookSecret?: string;
}

/** M9: a rotated webhook secret, returned once. */
export class WebhookSecretResponseDto {
  webhookSecret: string;
}
```

`dto/update-vcs-connection.dto.ts`: delete the `webhookSecret` property and its three decorators. Remove `MinLength` from the import if nothing else uses it. The i18n key `common.validation.webhookSecretMinLength` stays: `webhook.dto.ts` and `update-project.dto.ts` still use it.

- [ ] **Step 5: Implement the service**

In `vcs-connection.service.ts`, replace `randomBytes` with `generateWebhookSecret` from `./webhook-secret`, and import the new DTOs.

`create` (return type `Promise<VcsConnectionCreatedResponseDto>`):

```ts
    // Keep a secret in every mode so late webhook deliveries can be
    // authenticated before the controller acknowledges them as ignored.
    const webhookSecret = generateWebhookSecret();
    const connection = await this.vcsRepo.createVcsConnection({
      projectId,
      provider: dto.provider.toLowerCase(),
      repoOwner,
      repoName,
      encryptedToken,
      syncMode,
      allowedAuthors: JSON.stringify(dto.allowedAuthors ?? []),
      pollingIntervalMs,
      webhookSecret,
      isActive: true,
    });

    await this.vcsPollingService.refreshConnectionSchedule(connection.id);

    // M9: besides a rotation, the only time the secret leaves the server.
    return { ...this.mapToResponseDto(connection), webhookSecret };
```

`update` (return type `Promise<VcsConnectionUpdatedResponseDto>`): replace the secret-generation block and the final return:

```ts
    // Generate a secret when enabling webhooks on a legacy row, and keep it
    // when switching away so senders can sign in-flight deliveries while sync
    // is off or polling. A generated secret is returned once (M9).
    const generatedSecret = dto.syncMode === 'webhook' && !connection.webhookSecret
      ? generateWebhookSecret()
      : undefined;
    if (generatedSecret) {
      updateData.webhookSecret = generatedSecret;
    }
```

```ts
    const updated = await this.vcsRepo.updateVcsConnection(projectId, updateData);

    await this.vcsPollingService.refreshConnectionSchedule(updated.id);

    const response = this.mapToResponseDto(updated);
    return generatedSecret ? { ...response, webhookSecret: generatedSecret } : response;
```

New method after `delete`:

```ts
  /**
   * M9: replace the inbound webhook secret and return the new one, once.
   * Deliveries signed with the old secret are rejected from now on.
   */
  async rotateWebhookSecret(projectId: string): Promise<WebhookSecretResponseDto> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    const webhookSecret = generateWebhookSecret();
    await this.vcsRepo.updateVcsConnection(projectId, { webhookSecret });
    return { webhookSecret };
  }
```

Update the `mapToResponseDto` JSDoc: "excludes encryptedToken and webhookSecret: the secret leaves the server only in the create/update/rotate responses that produced it (M9)".

- [ ] **Step 6: Implement the controller**

In `vcs.controller.ts`:

- Import `JsonResponse` and `ForbiddenAppException` from `@nathapp/nestjs-common`, `UseGuards` from `@nestjs/common`, `ProjectMembershipGuard` from `../projects/project-membership.guard`, `ProjectRoles` from `../projects/project-roles.decorator`, `CurrentProject` from `../projects/current-project.decorator`, `ProjectContext` from `../projects/project-context`, `isUserPrincipal` from `../auth/principal/koda-principal.types`, and the three new DTOs.
- Wrap every route's return value in `JsonResponse.Ok(...)`: `createConnection`, `getConnection`, `updateConnection`, `testConnection`, `syncIssue`, `syncAll`, `syncPr`. For example: `return JsonResponse.Ok(await this.vcsService.create(project.id, encryptionKey, dto));`. `deleteConnection` stays 204 with no body. Drop the explicit `Promise<...Dto>` return annotations the wrapper makes wrong. Add `type:` to the existing `@ApiResponse` success entries where missing, e.g. `@ApiResponse({ status: 201, type: VcsConnectionCreatedResponseDto })` on create.
- Add the route after `testConnection`:

```ts
  /**
   * POST /projects/:slug/vcs/webhook-secret/rotate
   * M9: project ADMIN or global ADMIN. Agents never hold VCS webhook secrets:
   * ProjectRoles lets agents through, so the handler refuses them.
   */
  @Post('/webhook-secret/rotate')
  @UseGuards(ProjectMembershipGuard)
  @ProjectRoles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the VCS webhook secret and return the new secret once' })
  @ApiResponse({ status: 200, type: WebhookSecretResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project ADMIN or global ADMIN required' })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  async rotateWebhookSecret(
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ) {
    if (!isUserPrincipal(principal)) {
      throw new ForbiddenAppException({}, 'projects');
    }
    return JsonResponse.Ok(await this.vcsService.rotateWebhookSecret(ctx.project.id));
  }
```

`VcsModule` already imports `ProjectsModule`, which re-exports `ProjectAccessModule`, so the guard and `KodaCaslAbilityFactory` resolve without a module change.

- [ ] **Step 7: Fix the specs, run, regenerate**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs
bun run test:scoped test/integration/vcs
cd ../.. && bun run generate
git diff --stat openapi.json
```

Controller specs that compared a handler's result to the DTO now compare to `JsonResponse.Ok(dto)`, or read `.data`, following how `code-intel.controller.spec.ts` asserts `JsonResponse.Ok`. Specs that sent `webhookSecret` in an update DTO drop it. Expected: green. `openapi.json` gains the rotate operation and the three schemas, and `UpdateVcsConnectionDto` loses `webhookSecret`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test openapi.json
git commit -m "fix(vcs): return the webhook secret once and add secret rotation (M9)"
```

---

### Task 8: M13 — project-scoped symbol ids and removed-file cleanup

**Files:**
- Create: `apps/api/src/code-intel/symbol-id.ts`
- Create: `apps/api/prisma/migrations/20260929090100_symbol_project_scoped_ids/migration.sql`
- Create: `apps/api/src/code-intel/ast-index.project-scope.spec.ts`, `apps/api/src/code-intel/code-commit-outbox-handler.removed-files.spec.ts`
- Create: `apps/api/test/integration/code-intel/symbol-project-scope.integration.spec.ts`, `apps/api/test/integration/code-intel/symbol-id-migration.integration.spec.ts`
- Modify: `apps/api/src/code-intel/ast-index.service.ts:48-125`
- Modify: `apps/api/src/code-intel/prisma-code-intel.repository.ts:84-102`
- Modify: `apps/api/src/code-intel/code-commit-outbox-handler.ts`
- Modify: `apps/api/src/vcs/vcs-webhook.service.ts` (`handlePush`, `eventPayload`)
- Modify: `apps/api/prisma/schema.prisma:459` (comment only)
- Modify: specs asserting the old id shape (`grep -rn "::" apps/api/src/code-intel/*.spec.ts apps/api/test/unit apps/api/test/integration/ast-index apps/api/test/e2e/ast-index.e2e.spec.ts`)

**Interfaces:**
- Consumes: `scratchSchemaBefore`, `applyMigration` (Task 2).
- Produces: `symbolFullId(projectId: string, repoId: string, file: string, localId: string): string` → `` `${projectId}:${repoId}:${file}::${localId}` ``.
- Produces: `AstIndexService.removeFiles(projectId: string, repoId: string, files: string[]): Promise<void>`.
- Produces: `code_commit` payload field `removedFiles?: string[]`. It is absent on events recorded before this change.

Context: `Symbol.id` is `{repoId}:{file}::{name}` with no project. Two projects on the same repo overwrite each other's rows, and the upsert rewrites `projectId` (M13). The spec rules that the migration deletes all symbol rows instead of rewriting ids inside the caller/callee JSON. Symbols are derived data, rebuilt on the next index. `SymbolStore.deleteByFile` is unused, so symbols of deleted or renamed files live forever (VCS LOW). GitHub push payloads list a rename as `removed` + `added`. A re-indexed file also replaces its symbols, so a function deleted from a surviving file does not linger either.

- [ ] **Step 1: Write the failing unit specs**

`apps/api/src/code-intel/ast-index.project-scope.spec.ts`:

```ts
import { AstIndexService } from './ast-index.service';
import type { CodeGraphService } from './code-graph.service';
import type { SymbolStore, SymbolData } from './symbol-store';
import type { ITransactionManager } from '@nathapp/nestjs-data';

describe('AstIndexService project-scoped ids (M13)', () => {
  let store: { upsertSymbol: jest.Mock; deleteByFile: jest.Mock };
  let service: AstIndexService;
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    store = {
      upsertSymbol: jest.fn(async (s: SymbolData) => { calls.push(`upsert:${s.file}`); return s; }),
      deleteByFile: jest.fn(async (_p: string, _r: string, file: string) => { calls.push(`delete:${file}`); }),
    };
    const graph = {
      parseSourceFile: jest.fn((path: string) => ({ path })),
      extractSymbols: jest.fn(({ path }: { path: string }) => [
        { name: 'alpha', kind: 'function', file: path, startLine: 1, endLine: 2, callers: [], callees: [], symbolId: '' },
      ]),
      resolveRelationships: jest.fn(),
    };
    const tx = { run: <T>(fn: () => Promise<T>) => fn() } as unknown as ITransactionManager;
    service = new AstIndexService(graph as unknown as CodeGraphService, store as unknown as SymbolStore, tx);
  });

  it('puts the project id in the symbol id', async () => {
    await service.indexCommit('acme/widgets', 'c1', [{ path: 'src/a.ts', content: 'x' }], 'proj-1');

    const saved = store.upsertSymbol.mock.calls[0][0] as SymbolData;
    expect(saved.id).toBe('proj-1:acme/widgets:src/a.ts::alpha');
    expect(saved.symbolId).toBe(saved.id);
    expect(saved.projectId).toBe('proj-1');
  });

  it('replaces a re-indexed file: its old symbols are deleted before the new ones are written', async () => {
    await service.indexCommit('acme/widgets', 'c1', [{ path: 'src/a.ts', content: 'x' }], 'proj-1');

    expect(calls).toEqual(['delete:src/a.ts', 'upsert:src/a.ts']);
  });

  it('removeFiles deletes each file\'s symbols in the project', async () => {
    await service.removeFiles('proj-1', 'acme/widgets', ['src/gone.ts', 'src/old-name.ts']);

    expect(store.deleteByFile.mock.calls).toEqual([
      ['proj-1', 'acme/widgets', 'src/gone.ts'],
      ['proj-1', 'acme/widgets', 'src/old-name.ts'],
    ]);
  });
});
```

`apps/api/src/code-intel/code-commit-outbox-handler.removed-files.spec.ts`:

```ts
jest.mock('../vcs/factory', () => ({ createVcsProvider: jest.fn() }));
jest.mock('../common/utils/encryption.util', () => ({ decryptToken: jest.fn().mockReturnValue('plain') }));

import { createVcsProvider } from '../vcs/factory';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import type { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import type { AstIndexService } from './ast-index.service';
import type { IVcsConfig } from '../config/vcs.config';

describe('CodeCommitOutboxHandler removed files (VCS LOW)', () => {
  let ast: { indexCommit: jest.Mock; removeFiles: jest.Mock };
  let fetchCommitFiles: jest.Mock;
  let handler: CodeCommitOutboxHandler;

  beforeEach(() => {
    ast = { indexCommit: jest.fn(), removeFiles: jest.fn() };
    fetchCommitFiles = jest.fn().mockResolvedValue([{ path: 'src/new.ts', content: 'x' }]);
    (createVcsProvider as jest.Mock).mockReturnValue({ fetchCommitFiles });
    const repo = {
      findVcsConnectionByProjectId: jest.fn().mockResolvedValue({ provider: 'github', repoOwner: 'acme', repoName: 'widgets', encryptedToken: 'enc' }),
    };
    handler = new CodeCommitOutboxHandler(
      repo as unknown as PrismaCodeIntelRepository,
      ast as unknown as AstIndexService,
      { encryptionKey: 'ab'.repeat(32), githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4', defaultPollingIntervalMs: 1 } as IVcsConfig,
    );
  });

  it('drops symbols of removed files and fetches only the rest', async () => {
    await handler.process({
      repoId: 'acme/widgets', commitHash: 'c1', ref: 'refs/heads/main', projectId: 'p1',
      changedFiles: ['src/new.ts', 'src/gone.ts'], removedFiles: ['src/gone.ts'],
    });

    expect(ast.removeFiles).toHaveBeenCalledWith('p1', 'acme/widgets', ['src/gone.ts']);
    expect(fetchCommitFiles).toHaveBeenCalledWith('acme/widgets', 'c1', ['src/new.ts']);
    expect(ast.indexCommit).toHaveBeenCalledWith('acme/widgets', 'c1', [{ path: 'src/new.ts', content: 'x' }], 'p1');
  });

  it('only removes when every changed file was deleted', async () => {
    await handler.process({
      repoId: 'acme/widgets', commitHash: 'c2', ref: 'refs/heads/main', projectId: 'p1',
      changedFiles: ['src/gone.ts'], removedFiles: ['src/gone.ts'],
    });

    expect(ast.removeFiles).toHaveBeenCalledTimes(1);
    expect(fetchCommitFiles).not.toHaveBeenCalled();
  });

  it('indexes a legacy event recorded without removedFiles', async () => {
    await handler.process({
      repoId: 'acme/widgets', commitHash: 'c3', ref: 'refs/heads/main', projectId: 'p1',
      changedFiles: ['src/new.ts'],
    });

    expect(ast.removeFiles).not.toHaveBeenCalled();
    expect(fetchCommitFiles).toHaveBeenCalledWith('acme/widgets', 'c3', ['src/new.ts']);
  });
});
```

Add to the push-handler section of `apps/api/src/vcs/vcs-webhook.service.spec.ts`, following that file's existing push test setup: a commit with `removed: ['src/gone.ts']` records an outbox payload with `removedFiles: ['src/gone.ts']`, and `changedFiles` still includes `'src/gone.ts'`.

- [ ] **Step 2: Write the failing integration specs**

`apps/api/test/integration/code-intel/symbol-project-scope.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4 (M13): two projects indexing the same repository keep their
 * own symbols; a re-upsert never moves a row to another project.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/symbol-project-scope.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaCodeIntelRepository } from '../../../src/code-intel/prisma-code-intel.repository';
import { symbolFullId } from '../../../src/code-intel/symbol-id';
import type { SymbolData } from '../../../src/code-intel/symbol-store';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('Symbol ids are project-scoped (M13)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaCodeIntelRepository;
  let p1: string;
  let p2: string;

  const symbol = (projectId: string, name: string, startLine = 1): SymbolData => {
    const id = symbolFullId(projectId, 'acme/widgets', 'src/a.ts', 'alpha');
    return {
      id, symbolId: id, projectId, repoId: 'acme/widgets', commitHash: 'c1', name, kind: 'function',
      file: 'src/a.ts', startLine, endLine: startLine + 1, callers: [], callees: [],
    };
  };

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: DATABASE_URL } } } });
    await prismaService.onModuleInit();
    prisma = prismaService.client;
    repo = new PrismaCodeIntelRepository(prismaService);
    p1 = (await prisma.project.create({ data: { name: 'One', slug: 'one', key: 'ONE' } })).id;
    p2 = (await prisma.project.create({ data: { name: 'Two', slug: 'two', key: 'TWO' } })).id;
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  it('keeps both projects\' copies of the same repo symbol', async () => {
    await repo.upsertSymbol(symbol(p1, 'alpha'));
    await repo.upsertSymbol(symbol(p2, 'alpha'));

    const rows = await prisma.symbol.findMany({ where: { name: 'alpha' }, orderBy: { projectId: 'asc' } });
    expect(rows.map((r) => r.projectId).sort()).toEqual([p1, p2].sort());
  });

  it('a re-index updates in place and never moves the row to another project', async () => {
    await repo.upsertSymbol(symbol(p1, 'alpha', 40));

    const row = await prisma.symbol.findUniqueOrThrow({
      where: { projectId_symbolId: { projectId: p1, symbolId: symbolFullId(p1, 'acme/widgets', 'src/a.ts', 'alpha') } },
    });
    expect(row.startLine).toBe(40);
    expect(row.projectId).toBe(p1);
    expect(await prisma.symbol.count({ where: { projectId: p2 } })).toBe(1);
  });
});
```

`apps/api/test/integration/code-intel/symbol-id-migration.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4 (M13): the migration deletes every symbol row (derived data,
 * rebuilt on the next index) rather than rewriting ids inside the caller/callee JSON.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/symbol-id-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20260929090100_symbol_project_scoped_ids';

describeIntegration('symbol id migration (M13)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'symbol_id_migration', TARGET);
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', CURRENT_TIMESTAMP)`,
    );
    await scratch.db.$executeRawUnsafe(`
      INSERT INTO "Symbol" ("id", "symbolId", "projectId", "repoId", "commitHash", "name", "kind", "file", "startLine", "endLine", "updatedAt")
      VALUES ('acme/widgets:src/a.ts::alpha', 'acme/widgets:src/a.ts::alpha', 'p1', 'acme/widgets', 'c1', 'alpha', 'function', 'src/a.ts', 1, 2, CURRENT_TIMESTAMP)
    `);
    await applyMigration(scratch.db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('leaves no legacy symbol rows', async () => {
    const [{ count }] = await scratch.db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*)::bigint AS count FROM "Symbol"`);
    expect(Number(count)).toBe(0);
  });
});
```

- [ ] **Step 3: Run to see them fail**

```bash
cd apps/api
bunx jest src/code-intel/ast-index.project-scope.spec.ts src/code-intel/code-commit-outbox-handler.removed-files.spec.ts
bun run test:scoped test/integration/code-intel/symbol-project-scope.integration.spec.ts test/integration/code-intel/symbol-id-migration.integration.spec.ts
```

Expected: FAIL. The id lacks the project, there is no `deleteByFile` call or `removeFiles` method, `symbol-id` is missing, and the migration directory is missing.

- [ ] **Step 4: Implement ids and the repository upsert**

`apps/api/src/code-intel/symbol-id.ts`:

```ts
/**
 * M13: a symbol's stored id. The project comes first, so two projects indexing
 * the same repository never share (and overwrite) a row.
 */
export function symbolFullId(projectId: string, repoId: string, file: string, localId: string): string {
  return `${projectId}:${repoId}:${file}::${localId}`;
}
```

`prisma-code-intel.repository.ts` `upsertSymbol`:

```ts
  /**
   * M13: keyed on (projectId, symbolId). `id`, `symbolId` and `projectId` are
   * written on create only, so an update can never move a row to another project.
   */
  async upsertSymbol(symbol: SymbolData): Promise<SymbolData> {
    const create = {
      ...symbol,
      callers: symbol.callers as unknown as string[],
      callees: symbol.callees as unknown as string[],
    };
    const update = {
      repoId: symbol.repoId,
      commitHash: symbol.commitHash,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      signature: symbol.signature,
      callers: symbol.callers as unknown as string[],
      callees: symbol.callees as unknown as string[],
      docComment: symbol.docComment,
    };

    const result = await this.prisma.client.symbol.upsert({
      where: { projectId_symbolId: { projectId: symbol.projectId, symbolId: symbol.symbolId } },
      create: create as Parameters<typeof this.prisma.client.symbol.upsert>[0]['create'],
      update: update as Parameters<typeof this.prisma.client.symbol.upsert>[0]['update'],
    });

    return {
      ...result,
      callers: (result.callers as unknown as string[]) || [],
      callees: (result.callees as unknown as string[]) || [],
    } as SymbolData;
  }
```

- [ ] **Step 5: Implement indexing and removal**

In `ast-index.service.ts`, import `symbolFullId` from `./symbol-id`. In `indexCommit`, add `const parsedFiles: string[] = [];` beside `allExtractedSymbols`, and `parsedFiles.push(file.path);` next to `filesIndexed++`. Replace the transaction block:

```ts
    await this.txManager.run(async () => {
      // A re-indexed file is replaced, not merged: symbols its new version no
      // longer declares must not survive.
      for (const file of parsedFiles) {
        await this.symbolStore.deleteByFile(projectId, repoId, file);
      }

      for (const sym of allExtractedSymbols) {
        const fullId = symbolFullId(projectId, repoId, sym.file, sym.symbolId);

        const symbolData: SymbolData = {
          id: fullId,
          symbolId: fullId,
          projectId,
          repoId,
          commitHash,
          name: sym.name,
          kind: sym.kind,
          file: sym.file,
          startLine: sym.startLine,
          endLine: sym.endLine,
          signature: sym.signature,
          callers: sym.callers.map((callerId) => {
            const caller = allExtractedSymbols.find((candidate) => candidate.symbolId === callerId);
            return symbolFullId(projectId, repoId, caller?.file ?? sym.file, callerId);
          }),
          callees: sym.callees.map((calleeId) => {
            const callee = allExtractedSymbols.find((candidate) => candidate.symbolId === calleeId);
            return symbolFullId(projectId, repoId, callee?.file ?? sym.file, calleeId);
          }),
          docComment: sym.docComment,
        };

        await this.symbolStore.upsertSymbol(symbolData);
        symbolsIndexed++;
      }
    });
```

Add after `indexCommit`:

```ts
  /** Drop the symbols of files a commit deleted (renames arrive as removed + added). */
  async removeFiles(projectId: string, repoId: string, files: string[]): Promise<void> {
    await this.txManager.run(async () => {
      for (const file of files) {
        await this.symbolStore.deleteByFile(projectId, repoId, file);
      }
    });
  }
```

`code-commit-outbox-handler.ts`: add to `CodeCommitPayload`:

```ts
  /** Files the commit deleted. Absent on events recorded before Track 3 Slice 4. */
  removedFiles?: string[];
```

After the `changedFiles` empty check and log line, before the connection lookup:

```ts
    // VCS LOW: deleted or renamed-away files lose their symbols; they are not fetched.
    const removedFiles = p.removedFiles ?? [];
    if (removedFiles.length > 0) {
      await this.astIndexService.removeFiles(p.projectId, p.repoId, removedFiles);
    }
    const removed = new Set(removedFiles);
    const filesToIndex = p.changedFiles.filter((file) => !removed.has(file));
    if (filesToIndex.length === 0) {
      return;
    }
```

Pass `filesToIndex` instead of `p.changedFiles` to `fetchCommitFiles`.

`vcs-webhook.service.ts` `handlePush`, in `eventPayload`:

```ts
      const eventPayload = {
        repoId,
        commitHash,
        ref,
        changedFiles,
        removedFiles: commit.removed ?? [],
        projectId: connection.projectId,
        webhookOnly: true,
      };
```

`apps/api/prisma/migrations/20260929090100_symbol_project_scoped_ids/migration.sql`:

```sql
-- Track 3 Slice 4 (M13): symbol ids now start with the project id. Symbols are
-- derived data rebuilt on the next index, so the old rows are deleted instead of
-- rewriting ids embedded in the callers/callees JSON arrays.
DELETE FROM "Symbol";
```

`schema.prisma:459` comment: `id String @id // {projectId}:{repoId}:{filePath}::{SymbolName}`. The comment changes, not the schema, so no `prisma migrate` diff results. Confirm with `cd apps/api && bunx prisma validate`.

- [ ] **Step 6: Fix the specs, then run**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/code-intel src/vcs
bun run test:scoped test/integration/code-intel test/integration/ast-index test/e2e/ast-index.e2e.spec.ts
```

Specs that asserted `repoId:file::name` ids now expect the `projectId:` prefix. Mocks of `SymbolStore` gain `deleteByFile: jest.fn()`. Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test apps/api/prisma
git commit -m "fix(code-intel): project-scoped symbol ids and cleanup of removed files (M13)"
```

---

### Task 9: Code-intel routes behind the project-role guard

**Files:**
- Create: `apps/api/src/projects/project-slug-from.decorator.ts`
- Create: `apps/api/test/integration/code-intel/code-intel-project-roles.integration.spec.ts`
- Modify: `apps/api/src/projects/project-context.ts:14-18`
- Modify: `apps/api/src/projects/project-membership.guard.ts:34-55`
- Modify: `apps/api/src/projects/project-membership.guard.spec.ts` (new nested describe)
- Modify: `apps/api/src/code-intel/code-intel.controller.ts:74-151`
- Modify: `apps/api/src/projects/projects.controller.ts:123-165`
- Modify: `apps/api/src/code-intel/code-intel.controller.spec.ts`, `apps/api/test/integration/ast-index/code-intel-controller-permissions.integration.spec.ts`, `apps/api/src/projects/projects.controller.spec.ts` (impact route)
- Modify: `openapi.json` (regenerated; paths unchanged)

**Interfaces:**
- Consumes: `ProjectMembershipGuard`, `@ProjectPermission`, `@CurrentProject`, `ProjectContext` (Slice 3).
- Produces: `ProjectSlugFrom(source: 'query', key: string)` and `PROJECT_SLUG_FROM_KEY`. The guard uses `params.slug` if present. Otherwise, on a route marked `@ProjectSlugFrom('query', key)`, it uses `query[key]` when that is a non-empty string. A missing, empty or repeated value is no slug, and a `@ProjectPermission` route with no slug fails closed with 403.
- `ProjectScopedRequest` gains `query?: Record<string, unknown>`.

Context: the code-intel read routes take the project from `?projectSlug=`, so `ProjectMembershipGuard` never ran on them. They stayed on the global `@RequiredPermission([READ, 'CodeIntel'])`, which a global MEMBER lacks. Project ADMIN/DEVELOPER users therefore got 403, although the #144 matrix grants them READ CodeIntel and denies VIEWER (Slice 3 follow-up; ruled 2026-09-28: the guard reads the query slug). `GET projects/:slug/codeintel/impact` has the same global check and moves too. `POST /code-intel/index` (`MANAGE AstIndex`, global ADMIN and DEVELOPER agents only) is unchanged. Behavior change for the PR body: a missing `projectSlug` now gets 403 from the guard instead of 400 from DTO validation, because guards run before pipes.

- [ ] **Step 1: Write the failing guard spec**

In `apps/api/src/projects/project-membership.guard.spec.ts`, add imports:

```ts
import { ProjectSlugFrom } from './project-slug-from.decorator';
```

and, at the top-level stub section:

```ts
/** Controller stub for the code-intel read routes: slug in `?projectSlug=` (Slice 4). */
class CodeIntelRoutesStub {
  @ProjectSlugFrom('query', 'projectSlug')
  @ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])
  searchSymbols(): string { return 'ok'; }

  @ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])
  withoutSlugSource(): string { return 'ok'; }

  plainRoute(): string { return 'ok'; }
}
const intel = new CodeIntelRoutesStub();
```

Then, inside the outer `describe('ProjectMembershipGuard (US-001)', ...)`, after the `#144/#145` describe block, add:

```ts
  describe('ProjectMembershipGuard - query slug (Track 3 Slice 4)', () => {
    let guardWithCasl: ProjectMembershipGuard;

    beforeEach(() => {
      guardWithCasl = new ProjectMembershipGuard(access, new Reflector(), new KodaCaslAbilityFactory());
      membershipRepo.findBySlug.mockResolvedValue({ id: 'p1', slug: 'team', deletedAt: null });
    });

    const run = (query: Record<string, unknown>, handler = intel.searchSymbols, user: KodaPrincipal = memberUser) => {
      const req: Record<string, unknown> = { params: {}, query, user };
      return { req, result: guardWithCasl.canActivate(makeExecutionContext(req, handler, CodeIntelRoutesStub)) };
    };

    it('resolves the project from the opted-in query key and admits a DEVELOPER', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const { req, result } = run({ projectSlug: 'team' });
      await expect(result).resolves.toBe(true);
      expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'team' }, role: 'DEVELOPER' });
    });

    it('refuses a VIEWER (no READ CodeIntel)', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('VIEWER');
      await expect(run({ projectSlug: 'team' }).result).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('refuses a non-member', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue(null);
      await expect(run({ projectSlug: 'team' }).result).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it.each([
      ['missing', {}],
      ['empty', { projectSlug: '' }],
      ['repeated', { projectSlug: ['team', 'other'] }],
    ])('fails closed on a %s projectSlug without looking the project up', async (_label, query) => {
      await expect(run(query).result).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('ignores the query on routes that did not opt in', async () => {
      await expect(run({ projectSlug: 'team' }, intel.withoutSlugSource).result).rejects.toBeInstanceOf(ForbiddenAppException);
      await expect(run({ projectSlug: 'team' }, intel.plainRoute).result).resolves.toBe(true);
      expect(membershipRepo.findBySlug).not.toHaveBeenCalled();
    });

    it('prefers params.slug over the query', async () => {
      membershipRepo.findMembershipRole.mockResolvedValue('DEVELOPER');
      const req: Record<string, unknown> = { params: { slug: 'team' }, query: { projectSlug: 'elsewhere' }, user: memberUser };
      await expect(guardWithCasl.canActivate(makeExecutionContext(req, intel.searchSymbols, CodeIntelRoutesStub))).resolves.toBe(true);
      expect(membershipRepo.findBySlug).toHaveBeenCalledWith('team');
    });
  });
```

If `findBySlug` is called with more arguments than the slug, change the last assertion to `expect(membershipRepo.findBySlug.mock.calls[0][0]).toBe('team')`.

- [ ] **Step 2: Write the failing HTTP spec**

`apps/api/test/integration/code-intel/code-intel-project-roles.integration.spec.ts`:

```ts
/**
 * Track 3 Slice 4: the code-intel read routes and the impact route are
 * project-role gated (#144 matrix: ADMIN and DEVELOPER read CodeIntel, VIEWER
 * does not). The code-intel routes take the slug from ?projectSlug=.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/code-intel/code-intel-project-roles.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('code-intel project-role gate (Slice 4)', () => {
  jest.setTimeout(60000);
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};
  let symbolId: string;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const get = (who: string, url: string) => request(server).get(url).set(auth(who));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Intel', slug: 'intel', key: 'INT' }).expect(201);
    for (const [who, role] of [['padmin', 'ADMIN'], ['pdev', 'DEVELOPER'], ['pviewer', 'VIEWER']]) {
      await request(server).post('/api/projects/intel/members').set(auth('root')).send({ email: `${who}@koda.test`, role }).expect(201);
    }
    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Intel Agent', slug: 'intel-agent', roles: [] }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;

    await request(server).post('/api/code-intel/index').set(auth('root')).send({
      repoId: 'acme/widgets',
      commitHash: 'c1',
      projectSlug: 'intel',
      files: [{ path: 'src/a.ts', content: 'export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }' }],
    }).expect(201);

    const search = await get('root', '/api/code-intel/symbols?projectSlug=intel&q=alpha').expect(200);
    symbolId = data<{ items: Array<{ id: string }> }>(search).items[0].id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const enc = () => encodeURIComponent(symbolId);
  const routes = () => [
    '/api/code-intel/symbols?projectSlug=intel',
    `/api/code-intel/symbols/${enc()}?projectSlug=intel`,
    `/api/code-intel/symbols/${enc()}/callers?projectSlug=intel`,
    `/api/code-intel/symbols/${enc()}/callees?projectSlug=intel`,
    '/api/projects/intel/codeintel/impact?repoId=acme%2Fwidgets&commitHash=c1&changedFiles=src%2Fa.ts',
  ];

  it('stores the project in the symbol id', () => {
    expect(symbolId).toMatch(/^[^:]+:acme\/widgets:src\/a\.ts::alpha$/);
  });

  it.each(['padmin', 'pdev', 'agent', 'root'])('%s reads every code-intel route', async (who) => {
    for (const url of routes()) {
      const res = await get(who, url);
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
    }
  });

  it.each(['pviewer', 'outsider'])('%s is refused on every code-intel route', async (who) => {
    for (const url of routes()) {
      const res = await get(who, url);
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
    }
  });

  it.each([
    ['missing', '/api/code-intel/symbols'],
    ['empty', '/api/code-intel/symbols?projectSlug='],
    ['repeated', '/api/code-intel/symbols?projectSlug=intel&projectSlug=intel'],
  ])('a %s projectSlug fails closed', async (_label, url) => {
    await get('pdev', url).expect(403);
  });
});
```

If `/api/agents` rejects `roles: []`, use `roles: ['TRIAGER']`. Every agent has READ CodeIntel.

- [ ] **Step 3: Run to see them fail**

```bash
cd apps/api
bunx jest src/projects/project-membership.guard.spec.ts
bun run test:scoped test/integration/code-intel/code-intel-project-roles.integration.spec.ts
```

Expected: FAIL. The decorator module is missing, `pdev`/`padmin` get 403, and a missing slug gets 400.

- [ ] **Step 4: Implement the decorator and guard**

`apps/api/src/projects/project-slug-from.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

/**
 * Track 3 Slice 4: where ProjectMembershipGuard finds the project slug on a
 * route that carries it outside `:slug`. The code-intel read routes take
 * `?projectSlug=`; without this the guard never runs on them.
 */
export const PROJECT_SLUG_FROM_KEY = 'koda:projectSlugFrom';

export interface ProjectSlugSource {
  source: 'query';
  key: string;
}

export const ProjectSlugFrom = (source: 'query', key: string) =>
  SetMetadata<string, ProjectSlugSource>(PROJECT_SLUG_FROM_KEY, { source, key });
```

`project-context.ts`, `ProjectScopedRequest`:

```ts
export interface ProjectScopedRequest {
  params?: { slug?: string };
  query?: Record<string, unknown>;
  user?: KodaPrincipal;
  projectContext?: ProjectContext;
}
```

`project-membership.guard.ts`: import `{ PROJECT_SLUG_FROM_KEY, ProjectSlugSource }`. Replace `const slug = req.params?.slug;` with `const slug = this.resolveSlug(ctx, req);`, and add:

```ts
  /**
   * `params.slug`, else the query key a route opted into with @ProjectSlugFrom.
   * A missing, empty or repeated (array) query value is no slug, so a
   * @ProjectPermission route fails closed instead of guessing.
   */
  private resolveSlug(ctx: ExecutionContext, req: ProjectScopedRequest): string | undefined {
    if (req.params?.slug) return req.params.slug;
    const from = this.reflector.getAllAndOverride<ProjectSlugSource | undefined>(PROJECT_SLUG_FROM_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!from) return undefined;
    const value = req.query?.[from.key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
```

Update the class JSDoc flow step 1 to "No slug (`params.slug`, or the @ProjectSlugFrom query key): ...".

- [ ] **Step 5: Move the routes**

`code-intel.controller.ts`: import `UseGuards`, `ProjectMembershipGuard`, `ProjectPermission`, `ProjectSlugFrom`, `CurrentProject`, `ProjectContext`. For each of `searchSymbols`, `getSymbol`, `getCallers` and `getCallees`:

- replace `@RequiredPermission([CaslPermissionAction.READ, 'CodeIntel'])` with:

```ts
  @UseGuards(ProjectMembershipGuard)
  @ProjectSlugFrom('query', 'projectSlug')
  @ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])
```

- drop the `@Query('projectSlug') projectSlug` and `@Principal() principal` parameters, add `@CurrentProject() ctx: ProjectContext`, delete the `resolveProject`/`checkProjectMembership` lines, and use `ctx.project.id`;
- keep `@ApiQuery({ name: 'projectSlug', required: true })` on the three `:symbolId` routes, so `openapi.json` still documents the parameter. Do not add it to `searchSymbols`: its `SearchSymbolsQueryDto` already documents `projectSlug`, and a second `@ApiQuery` would duplicate the parameter.

`searchSymbols` becomes:

```ts
  async searchSymbols(
    @Query() query: SearchSymbolsQueryDto,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const { q, file, page = 1, limit: rawLimit = 20 } = query;
    const MAX_LIMIT = 100;
    const limit = Math.min(rawLimit, MAX_LIMIT);

    const { items, total } = await this.astIndexService.searchSymbols(ctx.project.id, { q, file, page, limit });
    return JsonResponse.Ok({ items, total });
  }
```

`indexCommit` is unchanged and keeps `resolveProject` and `checkProjectMembership`.

`projects.controller.ts` `getChangeImpact`: replace `@RequiredPermission([KodaAction.READ as CaslPermissionAction, 'CodeIntel'])` with `@UseGuards(ProjectMembershipGuard)` and `@ProjectPermission([CaslPermissionAction.READ, 'CodeIntel'])`. Replace the `@Param('slug')` and `@Principal()` parameters with `@CurrentProject() ctx: ProjectContext`. Delete the `findBySlug`/`assertProjectMembership` lines and pass `projectId: ctx.project.id`. Remove imports lint reports unused.

- [ ] **Step 6: Fix the specs, run, regenerate**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/projects src/code-intel
bun run test:scoped test/integration/code-intel test/integration/ast-index test/integration/projects test/e2e/ast-index.e2e.spec.ts
bun run lint
cd ../.. && bun run generate
git diff openapi.json | head -60
```

`code-intel.controller.spec.ts` handler calls now pass a `ProjectContext` (`{ project: { id: 'proj-1', slug: 's' }, role: 'ADMIN' }`) instead of a slug and principal. The not-found and forbidden cases move to the guard spec above, so delete them here. `code-intel-controller-permissions.integration.spec.ts` asserts `PROJECT_PERMISSION_KEY` metadata `{ permission: ['read', 'CodeIntel'], exemptAgents: false }` on the four read handlers instead of `@RequiredPermission`. Keep its `indexCommit` MANAGE AstIndex assertion. Expected: green. The `openapi.json` diff is small: the code-intel operations lose their `principal`-derived noise, if any, and paths are unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test openapi.json
git commit -m "fix(code-intel): project-role gate on code-intel reads via the query slug"
```

---

### Task 10: Remaining VCS LOWs — link extraction PR number, SLO window

**Files:**
- Modify: `apps/api/src/vcs/vcs-link-extractor.service.ts:36-62`
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:266-273`
- Modify: `apps/api/src/monitoring/prisma-monitoring.repository.ts:45-58`
- Modify: `apps/api/src/monitoring/slo-dashboard.controller.ts:24-26`
- Create: `apps/api/src/vcs/vcs-link-extractor.pr-number.spec.ts`, `apps/api/src/monitoring/prisma-monitoring.repository.spec.ts`
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts`, the SLO controller spec if one exists (`ls apps/api/src/monitoring`)

**Interfaces:**
- Produces: `VcsLinkExtractorService.extractLinksFromPr(project, ticket, connection, encryptionKey, branchName: string, prNumber: number)`. `prNumber` is now required.
- Produces: `PrismaMonitoringRepository.findQueryMetrics(timeWindow)` returns at most `QUERY_METRICS_LIMIT = 10_000` rows, newest first. `GET /admin/slos` defaults to the last 24 h.

Context: after auto-PR creation, `extractLinksFromPr` is called without a PR number and falls back to "trailing digits of `externalVcsId`". That is `null` for these tickets, so the call becomes `getPullRequestStatus(0)` → `/pulls/0`, which 404s. It would be wrong even when set: an issue number is not a PR number (VCS LOW). `syncMode` `@IsEnum` shipped in Task 4, the poll-catch guard in Task 6, and `deleteByFile` in Task 8. The SLO dashboard loads every metric row in the window (VCS LOW).

- [ ] **Step 1: Write the failing specs**

`apps/api/src/vcs/vcs-link-extractor.pr-number.spec.ts`:

```ts
jest.mock('./factory', () => ({ createVcsProvider: jest.fn() }));
jest.mock('../common/utils/encryption.util', () => ({ decryptToken: jest.fn().mockReturnValue('plain') }));

import { createVcsProvider } from './factory';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import type { PrismaVcsRepository } from './prisma-vcs.repository';
import type { VcsConnectionDomain } from './domain/vcs.domain';

describe('VcsLinkExtractorService PR number (VCS LOW)', () => {
  it('asks the provider for the PR it was given, never /pulls/0', async () => {
    const getPullRequestStatus = jest.fn().mockResolvedValue({ number: 12 });
    (createVcsProvider as jest.Mock).mockReturnValue({ getPullRequestStatus, listPrCommits: jest.fn().mockResolvedValue([]) });
    const service = new VcsLinkExtractorService({ upsertTicketLink: jest.fn() } as unknown as PrismaVcsRepository);

    await service.extractLinksFromPr(
      { id: 'p1', key: 'P' },
      { id: 't1', number: 3, externalVcsId: 'acme/widgets#99' },
      { provider: 'github', repoOwner: 'acme', repoName: 'widgets', encryptedToken: 'enc' } as VcsConnectionDomain,
      'ab'.repeat(32),
      'feat/p-3',
      12,
    );

    expect(getPullRequestStatus).toHaveBeenCalledWith(12);
  });
});
```

In `ticket-transitions.service.spec.ts`, in the existing auto-PR test that asserts `extractLinksFromPr` is called, assert the sixth argument equals the created PR's number (the `number` the `createPullRequest` mock resolves).

`apps/api/src/monitoring/prisma-monitoring.repository.spec.ts`:

```ts
import { PrismaMonitoringRepository, QUERY_METRICS_LIMIT } from './prisma-monitoring.repository';

describe('PrismaMonitoringRepository.findQueryMetrics (VCS LOW)', () => {
  it('bounds the rows it loads, newest first', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repo = new PrismaMonitoringRepository({ client: { memoryQueryMetric: { findMany } } } as never);
    const window = { from: new Date('2026-09-27T00:00:00Z'), to: new Date('2026-09-28T00:00:00Z') };

    await repo.findQueryMetrics(window);

    expect(QUERY_METRICS_LIMIT).toBe(10_000);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { createdAt: { gte: window.from, lte: window.to } },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    }));
  });
});
```

If the repository's constructor argument differs (check line ~10 of the file), pass the matching stub. Add to the SLO controller spec, or create `slo-dashboard.controller.spec.ts` if none exists: with no `from`/`to`, `getSloMetrics` is called with a window whose `to - from` is 24 h. Use `jest.useFakeTimers().setSystemTime(...)` to pin now.

- [ ] **Step 2: Run to see them fail**

```bash
cd apps/api && bunx jest src/vcs/vcs-link-extractor.pr-number.spec.ts src/monitoring src/tickets/state-machine/ticket-transitions.service.spec.ts
```

Expected: FAIL. The PR number is 99, from the externalVcsId fallback. `QUERY_METRICS_LIMIT` is missing. The default window is 7 days.

- [ ] **Step 3: Implement**

`vcs-link-extractor.service.ts`: make `prNumber: number` required, delete the externalVcsId fallback block (the comment and lines 51-59), and call `provider.getPullRequestStatus(prNumber)`.

`ticket-transitions.service.ts`, in the `.then` that calls `extractLinksFromPr`: the PR is in scope in the preceding `.then((pr) => ...)`. Thread it through by returning it from the activity step, or capture `pr.number` in a `let createdPrNumber` assigned in the `createTicketLink` step. Then pass it:

```ts
            return vcsLinkExtractor.extractLinksFromPr(
              project,
              { id: ticket.id, number: ticket.number, externalVcsId: null },
              connection,
              encryptionKey,
              branchName,
              createdPrNumber,
            );
```

Other callers (`vcs-pr-sync.service.ts`, `vcs-webhook.service.ts` synchronize) already pass a number.

`prisma-monitoring.repository.ts`:

```ts
/** VCS LOW: the SLO dashboard aggregates at most this many metric rows (newest first). */
export const QUERY_METRICS_LIMIT = 10_000;
```

and in `findQueryMetrics` add `orderBy: { createdAt: 'desc' }, take: QUERY_METRICS_LIMIT,`.

`slo-dashboard.controller.ts`: default `from` becomes `new Date(now.getTime() - 24 * 60 * 60 * 1000)`. Update the `@ApiOperation` summary to "Get SLO dashboard metrics (default: the last 24 hours)".

- [ ] **Step 4: Run**

```bash
cd apps/api
bunx tsc --noEmit -p tsconfig.json
bunx jest src/vcs src/monitoring src/tickets
bun run test:scoped test/integration/vcs
```

Expected: green. Integration specs that called `extractLinksFromPr` with five arguments pass a PR number now.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "fix(vcs): link extraction uses the created PR number; bound the SLO window"
```

---

### Task 11: CLI — secret on connect, `vcs rotate-secret`, GitLab provider

**Files:**
- Modify: `apps/cli/src/commands/vcs.ts`, `apps/cli/src/commands/vcs-messages.ts`
- Modify: `apps/cli/src/commands/vcs.spec.ts`
- Generated (gitignored, not committed): `apps/cli/src/generated/**` via `bun run generate`

**Interfaces:**
- Consumes: the generated `vcsControllerRotateWebhookSecret({ path: { slug } })` (Task 7), and the enveloped VCS responses.
- Produces: `koda vcs connect` prints the secret once. `koda vcs update` prints it when the API generated one. New `koda vcs rotate-secret [--project <slug>] [--json]`.

Context: the spec says the CLI `vcs` prints the secret. Slice 6 moves `--token` off argv, so this task does not touch token input.

- [ ] **Step 1: Regenerate the client**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda && bun run generate
grep -n "vcsControllerRotateWebhookSecret" apps/cli/src/generated/*.ts | head -3
```

Expected: the function exists.

- [ ] **Step 2: Write the failing CLI tests**

In `apps/cli/src/commands/vcs.spec.ts`, add `vcsControllerRotateWebhookSecret: jest.fn(),` and `vcsControllerUpdateConnection` (if absent) to the `jest.mock('../generated', ...)` factory, and import them. Add:

```ts
  describe('Slice 4: webhook secret output', () => {
    it('connect prints the webhook secret once', async () => {
      mockData.projectSlug = 'my-project';
      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { provider: 'github', repoOwner: 'o', repoName: 'r', syncMode: 'webhook', webhookSecret: 'a'.repeat(32) },
      });
      const connect = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'connect');

      await connect?.parseAsync(['node', 'test', '--provider', 'github', '--owner', 'o', '--repo', 'r', '--token', 'ghp_1234567890']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('a'.repeat(32)));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('shown once'));
    });

    it('rotate-secret prints the new secret', async () => {
      mockData.projectSlug = 'my-project';
      (vcsControllerRotateWebhookSecret as jest.Mock).mockResolvedValue({ ret: 0, data: { webhookSecret: 'b'.repeat(32) } });
      const rotate = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'rotate-secret');

      await rotate?.parseAsync(['node', 'test']);

      expect(vcsControllerRotateWebhookSecret).toHaveBeenCalledWith({ path: { slug: 'my-project' } });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('b'.repeat(32)));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('rotate-secret --json prints the payload', async () => {
      mockData.projectSlug = 'my-project';
      (vcsControllerRotateWebhookSecret as jest.Mock).mockResolvedValue({ ret: 0, data: { webhookSecret: 'c'.repeat(32) } });
      const rotate = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'rotate-secret');

      await rotate?.parseAsync(['node', 'test', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ webhookSecret: 'c'.repeat(32) }, null, 2));
    });

    it('update prints a secret the API generated', async () => {
      mockData.projectSlug = 'my-project';
      (vcsControllerUpdateConnection as jest.Mock).mockResolvedValue({ ret: 0, data: { syncMode: 'webhook', webhookSecret: 'd'.repeat(32) } });
      const update = program.commands.find((c) => c.name() === 'vcs')?.commands.find((c) => c.name() === 'update');

      await update?.parseAsync(['node', 'test', '--sync-mode', 'webhook']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('d'.repeat(32)));
    });
  });
```

- [ ] **Step 3: Run to see them fail**

```bash
cd apps/cli && bunx jest src/commands/vcs.spec.ts
```

Expected: FAIL. No secret line, no `rotate-secret` command.

- [ ] **Step 4: Implement**

`vcs-messages.ts`, add:

```ts
  WEBHOOK_SECRET_ONCE: (secret: string) =>
    `\nWebhook secret (shown once, store it now; use it to sign GitHub webhook deliveries): ${secret}`,
  WEBHOOK_SECRET_ROTATED: (projectSlug: string, secret: string) =>
    `Webhook secret rotated for project ${projectSlug}. New secret (shown once): ${secret}`,
```

and change `MISSING_REQUIRED_OPTIONS` to name the providers: `'Missing required options: --provider (github|gitlab), --owner, --repo, --token'`.

`vcs.ts`:
- Import `vcsControllerRotateWebhookSecret`.
- `connect`: option text `'VCS provider (github or gitlab)'`. In the non-JSON branch after `table(...)`:

```ts
          if (typeof data.webhookSecret === 'string') {
            console.log(VCS_MESSAGES.WEBHOOK_SECRET_ONCE(data.webhookSecret));
          }
```

- `update`: keep the response and print a generated secret:

```ts
        const response = await vcsControllerUpdateConnection({
          body: requestBody,
          path: { slug: ctx.projectSlug },
        });
        const data = unwrap<ConnectionRecord>(response);

        console.log(VCS_MESSAGES.SETTINGS_UPDATED(ctx.projectSlug));
        if (typeof data.webhookSecret === 'string') {
          console.log(VCS_MESSAGES.WEBHOOK_SECRET_ONCE(data.webhookSecret));
        }
```

- New command, after `test`:

```ts
  vcs
    .command('rotate-secret')
    .description('Rotate the webhook secret (project ADMIN or global ADMIN); prints the new secret once')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });

        const response = await vcsControllerRotateWebhookSecret({ path: { slug: ctx.projectSlug } });
        const data = unwrap<{ webhookSecret: string }>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(VCS_MESSAGES.WEBHOOK_SECRET_ROTATED(ctx.projectSlug, data.webhookSecret));
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
```

Existing `update` tests that mocked `vcsControllerUpdateConnection` with `undefined` now need `{ ret: 0, data: {} }`, because `unwrap` throws on a missing envelope.

- [ ] **Step 5: Run the CLI gates**

```bash
cd apps/cli && bun run test && bun run type-check && bun run lint
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands
git commit -m "feat(cli): print the VCS webhook secret once and add vcs rotate-secret"
```

---

### Task 12: Web — GitLab option, secret shown once, rotate button

**Files:**
- Modify: `apps/web/pages/[project]/settings.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Create: `apps/web/tests/pages/settings-vcs-webhook-secret.spec.ts`

**Interfaces:**
- Consumes: `POST /projects/:slug/vcs` → `webhookSecret`. `PATCH` → optional `webhookSecret`. `POST /projects/:slug/vcs/webhook-secret/rotate` → `{ webhookSecret }` (Task 7). `useApi` unwraps the envelope.

Context: the spec requires the web project settings VCS section to show the secret once, with a copy button. GitLab is polling-only, so the form disables the webhook option for it. The API refuses the combination anyway (Task 4).

- [ ] **Step 1: Write the failing source spec**

`apps/web/tests/pages/settings-vcs-webhook-secret.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const source = readFileSync(join(webDir, 'pages', '[project]', 'settings.vue'), 'utf-8')
const en = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'en.json'), 'utf-8'))
const zh = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'zh.json'), 'utf-8'))

describe('Track 3 Slice 4: VCS settings', () => {
  test('offers GitLab as a provider', () => {
    expect(source).toContain('<SelectItem value="gitlab">')
  })

  test('disables webhook sync for GitLab', () => {
    expect(source).toMatch(/value="webhook"[^>]*:disabled="values\.provider === 'gitlab'"/)
  })

  test('shows the returned webhook secret with a copy button', () => {
    expect(source).toContain('data-testid="webhook-secret"')
    expect(source).toContain('navigator.clipboard.writeText')
    expect(source).toContain('webhookSecret')
  })

  test('rotates the secret through the API', () => {
    expect(source).toContain('/vcs/webhook-secret/rotate')
  })

  test.each([
    'form.providerGitlab', 'form.gitlabPollingOnly',
    'secret.title', 'secret.onceNotice', 'secret.copy', 'secret.copied', 'secret.copyFailed', 'secret.rotate', 'secret.rotateConfirm',
  ])('en and zh both define vcs.%s', (key) => {
    const read = (locale: Record<string, unknown>) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale.vcs)
    expect(typeof read(en)).toBe('string')
    expect(typeof read(zh)).toBe('string')
  })
})
```

- [ ] **Step 2: Run to see it fail**

```bash
cd apps/web && bunx jest tests/pages/settings-vcs-webhook-secret.spec.ts
```

Expected: FAIL on every test.

- [ ] **Step 3: Implement the page**

In `settings.vue` `<script setup>`:

```ts
interface VcsConnectionWithSecret extends VcsConnection {
  webhookSecret?: string
}
```

Change the `useForm` destructure to `const { handleSubmit, setValues, isSubmitting, values } = useForm({ ... })`.

Add, after `onSubmit`'s declarations area:

```ts
// M9: the API returns the webhook secret only on create, on a legacy row
// switching to webhook mode, and on rotation. Show it until the page reloads.
const revealedSecret = ref<string | null>(null)

function revealSecret(secret: string | undefined) {
  if (secret) revealedSecret.value = secret
}

async function copySecret() {
  if (!revealedSecret.value) return
  try {
    await navigator.clipboard.writeText(revealedSecret.value)
    toast.success(t('vcs.secret.copied'))
  } catch {
    toast.error(t('vcs.secret.copyFailed'))
  }
}

const rotatingSecret = ref(false)
async function rotateSecret() {
  if (!window.confirm(t('vcs.secret.rotateConfirm'))) return
  rotatingSecret.value = true
  try {
    const result = await $api.post<{ webhookSecret: string }>(`/projects/${slug}/vcs/webhook-secret/rotate`)
    revealSecret(result.webhookSecret)
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    rotatingSecret.value = false
  }
}
```

In `onSubmit`, replace the `if (existingConnection.value) { patch } else { post }` block with:

```ts
    const saved = existingConnection.value
      ? await $api.patch<VcsConnectionWithSecret>(`/projects/${slug}/vcs`, payload)
      : await $api.post<VcsConnectionWithSecret>(`/projects/${slug}/vcs`, payload)
    revealSecret(saved?.webhookSecret)
```

In `disconnect`, after the success toast, add `revealedSecret.value = null`.

Template changes:
- Provider `SelectContent`: after the GitHub item add `<SelectItem value="gitlab">{{ t('vcs.form.providerGitlab') }}</SelectItem>`.
- Webhook radio: `<RadioGroupItem value="webhook" :disabled="values.provider === 'gitlab'" />`. After the `RadioGroup` closing tag, before `<FormMessage />`, add `<p v-if="values.provider === 'gitlab'" class="text-xs text-muted-foreground">{{ t('vcs.form.gitlabPollingOnly') }}</p>`.
- In the actions `div`, before the Disconnect button:

```vue
              <Button
                v-if="existingConnection"
                type="button"
                variant="outline"
                :disabled="rotatingSecret"
                @click="rotateSecret"
              >
                {{ rotatingSecret ? t('common.loading') : t('vcs.secret.rotate') }}
              </Button>
```

- After the closing `</form>` of the VCS form, inside the same bordered `div`:

```vue
          <div
            v-if="revealedSecret"
            data-testid="webhook-secret"
            class="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 space-y-2"
          >
            <p class="text-sm font-medium">{{ t('vcs.secret.title') }}</p>
            <p class="text-xs text-muted-foreground">{{ t('vcs.secret.onceNotice') }}</p>
            <div class="flex items-center gap-2">
              <code class="flex-1 break-all rounded bg-muted px-2 py-1 text-sm">{{ revealedSecret }}</code>
              <Button type="button" variant="outline" size="sm" @click="copySecret">
                {{ t('vcs.secret.copy') }}
              </Button>
            </div>
          </div>
```

- [ ] **Step 4: Add the i18n keys**

`en.json`, under `vcs.form`: `"providerGitlab": "GitLab"` and `"gitlabPollingOnly": "GitLab connections support polling only; webhook sync is not available."`. Under `vcs`, a new `secret` object:

```json
    "secret": {
      "title": "Webhook secret",
      "onceNotice": "Copy this secret now. It will not be shown again.",
      "copy": "Copy",
      "copied": "Secret copied",
      "copyFailed": "Could not copy the secret",
      "rotate": "Rotate webhook secret",
      "rotateConfirm": "Rotate the webhook secret? Deliveries signed with the old secret will be rejected."
    }
```

`zh.json`, same keys: `"providerGitlab": "GitLab"`, `"gitlabPollingOnly": "GitLab 连接仅支持轮询同步，不支持 Webhook 同步。"`, and:

```json
    "secret": {
      "title": "Webhook 密钥",
      "onceNotice": "请立即复制此密钥，之后将不再显示。",
      "copy": "复制",
      "copied": "密钥已复制",
      "copyFailed": "无法复制密钥",
      "rotate": "轮换 Webhook 密钥",
      "rotateConfirm": "确定轮换 Webhook 密钥吗？使用旧密钥签名的投递将被拒绝。"
    }
```

- [ ] **Step 5: Run the web gates**

```bash
cd apps/web && bunx jest tests/pages && bun run type-check && bun run lint && bun run build
```

Expected: green, including the existing `settings-vcs-tab.spec.ts` and `vcs-integration-settings` source tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): GitLab provider, one-time webhook secret and rotation in VCS settings"
```

---

### Task 13: Whole-slice verification, GitLab manual check, PR

**Files:** none new, except a scratch script outside the repo.

- [ ] **Step 1: Full local gates**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda
bun run generate && git status --short openapi.json
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:scoped test/integration/vcs test/integration/code-intel test/integration/ast-index test/integration/projects test/integration/tickets test/integration/openapi-spec test/e2e/ast-index.e2e.spec.ts
```

Expected: the second `generate` leaves `openapi.json` unchanged, and every gate is green. Compare the test counts with the Task 0 baseline: they only grow. Full local e2e hits the known login-throttle 429 cascade (not caused by this slice), and CI is the authority for the complete e2e job.

- [ ] **Step 2: Confirm every spec requirement has a commit**

Walk the spec's Slice 4 section and tick each item against the log:

| Spec item | Task |
|:--|:--|
| M9 secret once, rotate route, `webhookSecret` off the update DTO, web copy, CLI print | 7, 11, 12 |
| M10 `per_page=100`, `Link`, 10-page cap + sync-log warning, `lastSyncedAt` = max `updated_at`, re-read + unschedule, guarded poll catch | 5, 6 |
| M11 deleted-row dedup, `owner/repo#N`, backfill migration | 2 |
| M12 one conditional write, every handler + PR sync routed, bypass test | 1 |
| M13 `projectId` in the id, upsert on `projectId_symbolId`, symbol wipe migration | 8 |
| VCS LOWs: extractLinks PR number, `syncMode` `@IsEnum`, SLO 24 h + 10 000, `deleteByFile` | 10, 4, 10, 8 |
| BUG-14: DTO enum, `VCS_GITLAB_API_URL`, host-agnostic parser, `X-Next-Page` + cap, webhook → 400, mocked-HTTP tests | 3, 4, 5 |
| Integration (Postgres): both migrations | 2, 8 |
| Code-intel route wiring (Slice 3 follow-up) | 9 |

- [ ] **Step 3: GitLab manual check (human step)**

The spec asks for a manual check against a real gitlab.com project, recorded in the PR. It needs a GitLab personal access token with `read_api` and a project you own. Ask the user to run it, or to provide a token and project. Never paste a token into the transcript or the PR. Write this script to the session scratchpad, not the repo:

```ts
// gitlab-manual-check.ts: run from apps/api with
//   GITLAB_TOKEN=... GITLAB_PROJECT=group/project bun gitlab-manual-check.ts
import { providerForConnection } from './src/vcs/provider-for-connection';

const [repoOwner, repoName] = [
  process.env.GITLAB_PROJECT!.split('/').slice(0, -1).join('/'),
  process.env.GITLAB_PROJECT!.split('/').pop()!,
];
const provider = providerForConnection({ provider: 'gitlab', repoOwner, repoName }, process.env.GITLAB_TOKEN!, {
  gitlabApiUrl: process.env.VCS_GITLAB_API_URL ?? 'https://gitlab.com/api/v4',
});

(async () => {
  console.log('testConnection', await provider.testConnection());
  console.log('defaultBranch', await provider.getDefaultBranch());
  const { issues, cursor, capped } = await provider.fetchIssues();
  console.log('issues', issues.length, 'cursor', cursor?.toISOString(), 'capped', capped);
})();
```

Record in the PR body: the date, `testConnection ok`, the issue count, and whether the fetch was capped. Leave out the project name if it is private.

- [ ] **Step 4: Review before push**

Dispatch a whole-branch review (`superpowers:requesting-code-review`, or the code-reviewer agent) on `git diff main...HEAD`, with this plan and the spec section as context. Fix Critical/Important findings with tests, re-run Step 1, and commit.

- [ ] **Step 5: Check Slice 5's migrations**

```bash
git fetch -q origin
ls ../koda-slice5/apps/api/prisma/migrations 2>/dev/null | tail -3
git ls-tree --name-only origin/main apps/api/prisma/migrations/ | tail -3
```

Slice 5 adds `20260928120000_graph_node_vector_stale`. It sorts before this slice's `20260929090000` and `20260929090100`, which is the intended order. If Slice 5 has merged, rebase onto `origin/main` now, re-run `bun run generate`, and re-run Step 1. If any Slice 5 migration sorts after `20260929090100`, stop and tell the user before pushing.

- [ ] **Step 6: Push and open the PR (ask first)**

Ask the user before pushing. Then:

```bash
git push -u origin feat/track3-vcs-code-intel
gh pr create --base main --title "fix(track3-slice4): VCS & code-intel remediation (M9-M13, BUG-14, VCS LOWs)" --body-file <scratchpad>/pr-body.md
```

The PR body must include:

- **What / Why / How** per finding, citing the spec section and the review doc.
- **Breaking changes:**
  - every `/projects/:slug/vcs*` response is now a `JsonResponse` envelope. This fixes `koda vcs`, whose `unwrap` rejected the raw DTOs. The web passes envelopes through.
  - `UpdateVcsConnectionDto.webhookSecret` removed (it was ignored).
  - create returns `webhookSecret` once.
  - `CreateVcsConnectionDto.syncMode` is enum-validated.
  - GitHub issues are fetched in `updated` order.
  - code-intel reads are project-role gated: VIEWER 403, a missing/empty/repeated `projectSlug` 403 (was 400).
  - `GET /admin/slos` defaults to 24 h.
- **Migrations:** `externalVcsId` backfill (bare numbers → `owner/repo#N` for projects with a connection), and `DELETE FROM "Symbol"`. Symbols are rebuilt on the next push or `POST /code-intel/index`.
- **Manual GitLab check** result (Step 3).
- **Rebase note:** Slice 5 (`feat/track3-rag-memory`) shares `schema.prisma`, migrations, `openapi.json`, and the generated CLI. The second PR to merge rebases and runs `bun run generate`.
- **Out of scope:** GitLab inbound webhooks, `listPrCommits` pagination, the CLI token-in-argv change (Slice 6), and the #145 LOW half (Slice 6).

- [ ] **Step 7: After CI is green, report back**

Report the PR URL, CI status of all ten required checks, and any skipped item with its reason. Do not merge without the user's go-ahead.
