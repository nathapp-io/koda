# Fleet C9 Slice 1b — Fleet PR Links, PR-State Refresher, Repo-Scoped Matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fleet job's PR appears on each linked ticket as an ordinary `pr` link, its state is kept current by a fleet-side refresher (no `VcsConnection` needed), and its merge moves an IN_PROGRESS ticket to VERIFY_FIX exactly once. The project's `VcsConnection` webhook and poll stop matching PR links of other repos.

**Architecture:** VCS lookups match `TicketLink` rows by the connection's `externalRef` (`owner/repo#N`) through one pure predicate. The merged-PR step is extracted into `VcsPrSyncService.applyMergedPr`, which writes `merged` first and transitions only for the writer that won, so the VCS poll, the webhook and the fleet refresher can all see one merge safely. The fleet tickets module (from slice 1a) gains PR-link upserts (on terminal and after bundle-ingest corrections) and a `FleetPrStateRefresher` that reads PR state through the `koda-fleet` GitHub App or the project's GitLab token.

**Tech Stack:** NestJS 11 + Prisma (PostgreSQL 16), Jest, `FakeForge` (local HTTP stand-in for GitHub/GitLab), openapi-ts generated CLI client.

**Spec:** `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md` (§3.3, §3.4, §3.5, §3.6, §6, §7 slice 1b; D455-D458). Slice 1a (`docs/superpowers/plans/2026-10-06-fleet-c9-slice-1a-ticket-links.md`, merged #228 `63961a23`) already shipped the schema (`TicketLink.source`, `TicketLink.jobId`, `FleetJobTicket`), so **this slice has no migration**.

## Global Constraints

- No migration: `TicketLink.source` (default `vcs`) and `TicketLink.jobId` already exist (slice 1a).
- M12 stays true: `TicketLink.prState` changes only through `PrismaVcsRepository.updateTicketLinkWithPrState`. A new fleet link is inserted with `prState: 'open'`; pointing an existing link at a job is an `updateMany` that sets `jobId` only. The tripwire `apps/api/src/vcs/pr-state-write-sites.spec.ts` is updated to list the new site.
- Ticket effects run after commit, best-effort per ticket, and never throw (D451).
- PR link (D455): upsert on `(ticketId, url)`; an existing link keeps its `source` and gains `jobId`; the URL must name the job's own `FleetRepo` (`prNumberFor`); also called after ingest corrections fill `resultPrUrl`.
- Refresher (D456): `FLEET_PR_REFRESH_MS`, default `600000`, minimum `60000` (boot refuses lower), independent of `VcsConnection`.
- Merge step (D457): conditional `merged` write first; transition (VERIFY_FIX + FIX_REPORT comment + `VCS_PR_MERGED` activity) only when that write returned `'updated'` and the ticket is IN_PROGRESS.
- Matching (D458): webhook and poll match `externalRef = '<repoOwner>/<repoName>#N'` case-insensitively (and the number equals `prNumber`); a row with `externalRef = null` matches by number only when `source = 'vcs'`.
- Never log tokens or full forge responses.
- Generated files under `apps/cli/src/generated/` are never hand-edited; `bun run generate` must leave no diff after Task 6.
- No emojis in code, comments or docs.

### Plan decisions (not in the spec; flag in review if you disagree)

- **P1** `GitHubAppClient.getPullRequest(token, owner, name, number)` takes a token, not the installation id the spec names, so the refresher mints one repo-scoped installation token per repo per pass instead of one per PR. GitLab mirrors it: `GitLabAccessChecker.getMergeRequest(token, owner, name, iid)`.
- **P2** `externalRef` matching runs in TypeScript over the rows already narrowed by project and PR number, not as SQL `ILIKE`/`startsWith`: repo names often contain `_`, which is a LIKE wildcard.
- **P3** The refresher timer starts only when `FLEET_SWEEP_ENABLED` is on (the existing in-process background switch, off under `NODE_ENV=test`), like `FleetSweeper`.
- **P4** When a PR URL is already linked on a ticket, the upsert points the row at the **latest** job that produced it (`jobId` overwritten).
- **P5** One refresher pass reads at most 500 links, least recently refreshed (`prUpdatedAt`) first.
- **P6** `VcsPrSyncService.handleMergedPrAutoTransition` stays public as the transition half; `applyMergedPr` wraps it. This keeps the 50+ existing assertions on it valid.

## Review Focus

- **A fleet PR on another repo with the same number as a PR on the connection's repo:** the webhook and the poll leave it alone; only the connection's own link changes. Pinned in Task 1 (integration).
- **Two paths see one merge** (VCS poll or webhook, and the fleet refresher, when the fleet repo is the connection repo): one VERIFY_FIX, one FIX_REPORT comment. Pinned in Task 2 (integration, concurrent `applyMergedPr`) and Task 5 (integration, refresher racing the VCS path).
- **A PR that was deleted, or a repo whose App access was revoked:** the PR (404) becomes `closed`; a repo whose token cannot be minted is skipped and the other repos are still refreshed. Pinned in Task 5.
- **The PR URL arrives late** (job ended before the finish-audit bundle was ingested): the link appears after ingest fills `resultPrUrl`. Pinned in Task 4 (`bundle-ingest.pr-links.spec.ts`).
- **The PR was already linked by hand** (or by VCS sync) on the ticket: no duplicate row, `source` stays `vcs`, `jobId` is recorded. Pinned in Task 4 (integration).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/vcs/connection-pr-match.ts` | Pure: does a PR link belong to the connection's repo (D458). |
| `apps/api/src/vcs/pr-state.ts` | Pure: provider PR status -> `prState` (moved out of `VcsPrSyncService`). |
| `apps/api/src/vcs/domain/vcs.repository.ts` | `TicketLinkData.source/jobId`; `findTicketLinkForConnectionPr`; `findActiveTicketLinksWithPrs(projectId, repo)`. |
| `apps/api/src/vcs/prisma-vcs.repository.ts` | The two repo-scoped lookups. |
| `apps/api/src/vcs/vcs-pr-sync.service.ts` | `applyMergedPr` (D457); poll passes the connection repo. |
| `apps/api/src/vcs/vcs-webhook.service.ts` | Repo-scoped lookup at 7 sites; merged handler uses `applyMergedPr`. |
| `apps/api/src/fleet/git-broker/github-app-client.ts` | `getPullRequest`. |
| `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` | `getMergeRequest`. |
| `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` | `findJobForPrLinks`, `upsertFleetPrLink`, `findRefreshableFleetLinks`. |
| `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` | `upsertPrLinks`; `onTerminal` runs it for every terminal state. |
| `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts` | The poller (D456). |
| `apps/api/src/fleet/tickets/fleet-tickets.module.ts` | Imports `VcsModule`, `GitBrokerModule`; provides the refresher. |
| `apps/api/src/fleet/ingest/bundle-ingest.service.ts`, `ingest.module.ts` | Calls `upsertPrLinks` after a correction fills `resultPrUrl`. |
| `apps/api/src/config/fleet.config.ts`, `env.validation.ts`, `common/test-helpers/fleet-config.ts` | `FLEET_PR_REFRESH_MS` / `prRefreshMs`. |
| `apps/api/src/ticket-links/**`, `apps/api/src/tickets/**` | `source` and `jobId` on link responses. |

---

### Task 1: Repo-scoped VCS matching (D458)

**Files:**
- Create: `apps/api/src/vcs/connection-pr-match.ts`, `apps/api/src/vcs/connection-pr-match.spec.ts`
- Modify: `apps/api/src/vcs/domain/vcs.repository.ts:19-33,92-93`
- Modify: `apps/api/src/vcs/prisma-vcs.repository.ts:227-276`
- Modify: `apps/api/src/vcs/vcs-pr-sync.service.ts:69`
- Modify: `apps/api/src/vcs/vcs-webhook.service.ts` (7 calls to `findTicketLinkByPrNumber`, lines ~306-526)
- Modify (tests that name the old method or signature): `apps/api/src/vcs/prisma-vcs.repository.spec.ts:58-80`, `apps/api/src/vcs/vcs-webhook.service.spec.ts:37`, `apps/api/src/vcs/vcs-webhook.merged-terminal.spec.ts` (every `findTicketLinkByPrNumber`), `apps/api/test/integration/vcs/vcs-pr-sync.service.spec.ts:173`, `apps/api/test/integration/vcs/vcs-merged-pr.integration.spec.ts:250`
- Test: `apps/api/test/integration/fleet/fleet-pr-matching.integration.spec.ts`

**Interfaces:**
- Produces: `ConnectionRepo = { repoOwner: string; repoName: string }`; `linkMatchesConnection(link: { externalRef: string | null; prNumber: number | null; source?: string }, repo: ConnectionRepo): boolean`; `IVcsRepository.findTicketLinkForConnectionPr(projectId: string, repo: ConnectionRepo, prNumber: number): Promise<TicketLinkData | null>` (replaces `findTicketLinkByPrNumber`); `IVcsRepository.findActiveTicketLinksWithPrs(projectId: string, repo: ConnectionRepo): Promise<TicketLinkData[]>`; `TicketLinkData` gains `source?: string; jobId?: string | null`.

- [ ] **Step 1: Write the failing predicate test**

`apps/api/src/vcs/connection-pr-match.spec.ts`:

```ts
import { linkMatchesConnection } from './connection-pr-match';

const repo = { repoOwner: 'Acme', repoName: 'App' };
const link = (externalRef: string | null, prNumber: number | null = 5, source?: string) => ({ externalRef, prNumber, source });

describe('linkMatchesConnection (C9 §3.6, D458)', () => {
  it('matches the connection repo case-insensitively', () => {
    expect(linkMatchesConnection(link('acme/app#5'), repo)).toBe(true);
  });

  it('rejects another repo with the same PR number', () => {
    expect(linkMatchesConnection(link('owner2/repo2#5'), repo)).toBe(false);
  });

  it('rejects a ref whose number is not the link prNumber', () => {
    expect(linkMatchesConnection(link('acme/app#6'), repo)).toBe(false);
  });

  it('matches a legacy null-ref vcs row by number only (source missing means vcs)', () => {
    expect(linkMatchesConnection(link(null), repo)).toBe(true);
    expect(linkMatchesConnection(link(null, 5, 'vcs'), repo)).toBe(true);
  });

  it('never matches a null-ref fleet row', () => {
    expect(linkMatchesConnection(link(null, 5, 'fleet'), repo)).toBe(false);
  });

  it('matches a GitLab nested-group repo', () => {
    expect(linkMatchesConnection(link('grp/sub/app#5'), { repoOwner: 'grp/sub', repoName: 'app' })).toBe(true);
  });

  it('rejects a ref that is not owner/repo#N', () => {
    expect(linkMatchesConnection(link('feature-branch'), repo)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && bunx jest src/vcs/connection-pr-match.spec.ts`
Expected: FAIL, "Cannot find module './connection-pr-match'".

- [ ] **Step 3: Implement the predicate**

`apps/api/src/vcs/connection-pr-match.ts`:

```ts
/** The repo a `VcsConnection` watches; a `VcsConnectionDomain` satisfies it. */
export interface ConnectionRepo {
  repoOwner: string;
  repoName: string;
}

const REF = /^(.+)#(\d+)$/;

/**
 * Fleet C9 §3.6 (D458): a PR link belongs to the connection's repo when its externalRef is
 * `<repoOwner>/<repoName>#<prNumber>` (case-insensitive). A row without externalRef predates
 * repo-scoped links and matches by number only, and only when it came from VCS.
 */
export function linkMatchesConnection(
  link: { externalRef: string | null; prNumber: number | null; source?: string },
  repo: ConnectionRepo,
): boolean {
  if (link.externalRef === null) return (link.source ?? 'vcs') === 'vcs';
  const match = REF.exec(link.externalRef);
  if (!match) return false;
  return match[1].toLowerCase() === `${repo.repoOwner}/${repo.repoName}`.toLowerCase() && Number(match[2]) === link.prNumber;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd apps/api && bunx jest src/vcs/connection-pr-match.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Change the repository contract**

In `apps/api/src/vcs/domain/vcs.repository.ts`:

```ts
import type { ConnectionRepo } from '../connection-pr-match';
```

Add to `TicketLinkData` (after `externalRef`):

```ts
  /** vcs | fleet (fleet C9 §1); absent on hand-built test rows, read as vcs. */
  source?: string;
  jobId?: string | null;
```

Replace the two lookup lines in `IVcsRepository`:

```ts
  /** C9 §3.6: active PR links of the project that belong to the connection's repo (D458). */
  findActiveTicketLinksWithPrs(projectId: string, repo: ConnectionRepo): Promise<TicketLinkData[]>;
  /** C9 §3.6: the project's link for PR `prNumber` of the connection's repo (D458); webhook lookups. */
  findTicketLinkForConnectionPr(projectId: string, repo: ConnectionRepo, prNumber: number): Promise<TicketLinkData | null>;
```

- [ ] **Step 6: Write the failing repository unit test**

In `apps/api/src/vcs/prisma-vcs.repository.spec.ts`, change the existing call `await repo.findActiveTicketLinksWithPrs('p1');` to `await repo.findActiveTicketLinksWithPrs('p1', { repoOwner: 'acme', repoName: 'app' });` (the `findMany` argument it asserts is unchanged), and append:

```ts
  it('findActiveTicketLinksWithPrs drops links of other repos (D458)', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'mine', externalRef: 'acme/app#5', prNumber: 5, source: 'vcs' },
      { id: 'other', externalRef: 'other/lib#5', prNumber: 5, source: 'fleet' },
      { id: 'legacy', externalRef: null, prNumber: 6, source: 'vcs' },
    ]);
    const rows = await repo.findActiveTicketLinksWithPrs('p1', { repoOwner: 'acme', repoName: 'app' });
    expect(rows.map((r) => r.id)).toEqual(['mine', 'legacy']);
  });

  it('findTicketLinkForConnectionPr returns the connection repo link, not another repo with the same number', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'other', externalRef: 'other/lib#5', prNumber: 5, source: 'fleet' },
      { id: 'mine', externalRef: 'ACME/App#5', prNumber: 5, source: 'vcs' },
    ]);
    const row = await repo.findTicketLinkForConnectionPr('p1', { repoOwner: 'acme', repoName: 'app' }, 5);
    expect(row?.id).toBe('mine');
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { prNumber: 5, ticket: { projectId: 'p1' } } }));
  });

  it('findTicketLinkForConnectionPr returns null when only another repo has that number', async () => {
    mockFindMany.mockResolvedValue([{ id: 'other', externalRef: 'other/lib#5', prNumber: 5, source: 'fleet' }]);
    await expect(repo.findTicketLinkForConnectionPr('p1', { repoOwner: 'acme', repoName: 'app' }, 5)).resolves.toBeNull();
  });
```

Run: `cd apps/api && bunx jest src/vcs/prisma-vcs.repository.spec.ts`
Expected: FAIL (type error / `findTicketLinkForConnectionPr is not a function`).

- [ ] **Step 7: Implement the lookups**

In `apps/api/src/vcs/prisma-vcs.repository.ts`, add the import:

```ts
import { ConnectionRepo, linkMatchesConnection } from './connection-pr-match';
```

Replace `findActiveTicketLinksWithPrs` and `findTicketLinkByPrNumber` (lines 227-276) with:

```ts
  /**
   * Active PR links of the project that belong to the connection's repo (C9 §3.6, D458).
   * The DB narrows by project and state; the repo match runs here (plan P2: no LIKE wildcards).
   */
  async findActiveTicketLinksWithPrs(projectId: string, repo: ConnectionRepo): Promise<TicketLinkData[]> {
    const rows = (await this.db.ticketLink.findMany({
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
            projectId: true,
            number: true,
            externalVcsId: true,
          },
        },
      },
      where: {
        prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] },
        ticket: { projectId, deletedAt: null },
      },
    })) as TicketLinkData[];
    return rows.filter((link) => linkMatchesConnection(link, repo));
  }

  /**
   * The project's link for PR `prNumber` of the connection's repo; webhook lookups (C9 §3.6, D458).
   * Oldest first, so the result is stable when a ticket pair links the same PR.
   */
  async findTicketLinkForConnectionPr(projectId: string, repo: ConnectionRepo, prNumber: number): Promise<TicketLinkData | null> {
    const rows = (await this.db.ticketLink.findMany({
      where: { prNumber, ticket: { projectId } },
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
            projectId: true,
            number: true,
            externalVcsId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })) as TicketLinkData[];
    return rows.find((link) => linkMatchesConnection(link, repo)) ?? null;
  }
```

- [ ] **Step 8: Move the callers**

`apps/api/src/vcs/vcs-pr-sync.service.ts:69`:

```ts
    const ticketLinks = await this.vcsRepo.findActiveTicketLinksWithPrs(project.id, connection);
```

`apps/api/src/vcs/vcs-webhook.service.ts`: every

```ts
    const ticketLink = await this.vcsRepo.findTicketLinkByPrNumber(connection.project.id, prNumber);
```

becomes

```ts
    const ticketLink = await this.vcsRepo.findTicketLinkForConnectionPr(connection.project.id, connection, prNumber);
```

(7 sites: opened, merged, closed, ready_for_review, reopened, converted_to_draft, synchronize). Update the comments that say "Find TicketLink by prNumber" to "Find this repo's TicketLink for the PR".

Tests that name the old method: in `vcs-webhook.service.spec.ts` and `vcs-webhook.merged-terminal.spec.ts` rename the mock key `findTicketLinkByPrNumber` to `findTicketLinkForConnectionPr` (all occurrences, including the `repo` type on line 65). In `test/integration/vcs/vcs-pr-sync.service.spec.ts:173` change the expectation to `toHaveBeenCalledWith(projectId, mockVcsConnection)`. In `test/integration/vcs/vcs-merged-pr.integration.spec.ts:250` change the call to `repo.findActiveTicketLinksWithPrs(projectId, connection)`.

Run: `cd apps/api && bunx tsc --noEmit -p tsconfig.json && bunx jest src/vcs`
Expected: PASS. If a VCS fixture's `externalRef` names a different repo than its connection, fix the fixture (it was relying on the number-only match this task removes); do not loosen the predicate.

- [ ] **Step 9: Write the regression integration test**

`apps/api/test/integration/fleet/fleet-pr-matching.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1b — repo-scoped VCS PR matching (PG), spec §3.6, D458, §6 regression.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-matching.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { GitHubWebhookPayload, VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import type { VcsConnectionWithProjectDomain } from '../../../src/vcs/domain/vcs.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const closed = (number: number, owner = 'acme', name = 'app'): GitHubWebhookPayload => ({
  action: 'closed',
  pull_request: {
    number, title: 'PR', body: null, user: { login: 'dev' }, html_url: `https://github.com/${owner}/${name}/pull/${number}`,
    state: 'closed', draft: false, merged: false, merged_at: null, merged_by: null,
    base: { ref: 'main', repo: { full_name: `${owner}/${name}` } }, head: { ref: 'feat', repo: { full_name: `${owner}/${name}` } },
  },
});

describeIntegration('repo-scoped VCS PR matching (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let vcsRepo: PrismaVcsRepository;
  let webhook: VcsWebhookService;
  let connection: VcsConnectionWithProjectDomain;
  let otherRepoId: string;
  let n = 100;

  const ticket = async () => {
    n += 1;
    return prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
  };
  const fleetLinkOnOtherRepo = async (prNumber: number) => {
    const t = await ticket();
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: otherRepoId, ref: 'main', command: 'RUN', feature: `f${n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      },
    });
    return prisma.ticketLink.create({
      data: {
        ticketId: t.id, url: `https://github.com/other/lib/pull/${prNumber}`, provider: 'github', linkType: 'pr',
        source: 'fleet', jobId: job.id, prNumber, externalRef: `other/lib#${prNumber}`, prState: 'open',
      },
    });
  };
  const vcsLink = async (prNumber: number, externalRef: string | null = `acme/app#${prNumber}`) => {
    const t = await ticket();
    return prisma.ticketLink.create({
      data: { ticketId: t.id, url: `https://github.com/acme/app/pull/${prNumber}`, provider: 'github', linkType: 'pr', prNumber, externalRef, prState: 'open' },
    });
  };
  const state = async (id: string) => (await prisma.ticketLink.findUniqueOrThrow({ where: { id } })).prState;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    vcsRepo = app.get(PrismaVcsRepository);
    webhook = app.get(VcsWebhookService);
    otherRepoId = (await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'other', name: 'lib', defaultBranch: 'main', githubInstallationId: BigInt(78), createdById: world.ids.root },
    })).id;
    const conn = await prisma.vcsConnection.create({
      data: { projectId: world.projectId, provider: 'github', repoOwner: 'acme', repoName: 'app', encryptedToken: 'unused', syncMode: 'webhook' },
    });
    connection = (await vcsRepo.findVcsConnectionById(conn.id)) as VcsConnectionWithProjectDomain;
  });
  afterAll(async () => {
    await app.close();
  });

  it('a webhook for PR #5 closes the connection repo link and leaves the other repo fleet link open', async () => {
    const fleet = await fleetLinkOnOtherRepo(5);
    const mine = await vcsLink(5);
    await expect(webhook.handleWebhook(connection, 'pull_request', closed(5))).resolves.toEqual({ success: true, ignored: false });
    expect(await state(mine.id)).toBe('closed');
    expect(await state(fleet.id)).toBe('open');
  });

  it('ignores a webhook when only another repo has a link with that number', async () => {
    const fleet = await fleetLinkOnOtherRepo(6);
    const result = await webhook.handleWebhook(connection, 'pull_request', closed(6));
    expect(result).toEqual(expect.objectContaining({ success: true, ignored: true }));
    expect(await state(fleet.id)).toBe('open');
  });

  it('the poll query returns the connection repo links and legacy null-ref vcs rows only', async () => {
    const fleet = await fleetLinkOnOtherRepo(7);
    const mine = await vcsLink(8);
    const legacy = await vcsLink(9, null);
    const ids = (await vcsRepo.findActiveTicketLinksWithPrs(world.projectId, connection)).map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, legacy.id]));
    expect(ids).not.toContain(fleet.id);
  });
});
```

- [ ] **Step 10: Run it and see it pass**

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-matching.integration.spec.ts test/integration/vcs`
Expected: PASS. (Before Step 7 the first test fails: the old number-only lookup could pick the fleet link.)

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/vcs apps/api/test/integration/vcs apps/api/test/integration/fleet/fleet-pr-matching.integration.spec.ts
git commit -m "fix(vcs): match PR links by the connection repo, not the PR number alone (C9 D458)"
```

---

### Task 2: Shared, gated merge step (D457)

**Files:**
- Create: `apps/api/src/vcs/pr-state.ts`, `apps/api/src/vcs/pr-state.spec.ts`
- Modify: `apps/api/src/vcs/vcs-pr-sync.service.ts:81-127,194-205`
- Modify: `apps/api/src/vcs/vcs-webhook.service.ts:336-388` (`handlePullRequestMerged`)
- Modify: `apps/api/src/vcs/vcs-pr-sync.service.spec.ts`, `apps/api/src/vcs/vcs-webhook.merged-terminal.spec.ts`
- Test: `apps/api/test/integration/vcs/vcs-merge-step.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1 `TicketLinkData`.
- Produces: `mapPrState(pr: Pick<VcsPrStatus, 'merged' | 'state' | 'draft'>): string`; `VcsPrSyncService.applyMergedPr(link: TicketLinkData, prStatus: VcsPrStatus): Promise<PrStateWriteResult>`.

- [ ] **Step 1: Write the failing `mapPrState` test**

`apps/api/src/vcs/pr-state.spec.ts`:

```ts
import { mapPrState } from './pr-state';

describe('mapPrState', () => {
  it.each([
    [{ merged: true, state: 'closed', draft: false }, 'merged'],
    [{ merged: false, state: 'open', draft: true }, 'draft'],
    [{ merged: false, state: 'open', draft: false }, 'open'],
    [{ merged: false, state: 'closed', draft: false }, 'closed'],
    [{ merged: false, state: 'locked', draft: false }, 'locked'],
  ])('%j -> %s', (pr, expected) => {
    expect(mapPrState(pr)).toBe(expected);
  });
});
```

Run: `cd apps/api && bunx jest src/vcs/pr-state.spec.ts`
Expected: FAIL, "Cannot find module './pr-state'".

- [ ] **Step 2: Move `mapPrState` out of the service**

`apps/api/src/vcs/pr-state.ts`:

```ts
import type { VcsPrStatus } from './types';

/** TicketLink.prState for a provider PR status: draft | open | merged | closed (other states pass through). */
export function mapPrState(pr: Pick<VcsPrStatus, 'merged' | 'state' | 'draft'>): string {
  if (pr.merged) return 'merged';
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open';
  return pr.state === 'closed' ? 'closed' : pr.state;
}
```

In `vcs-pr-sync.service.ts` delete the private `mapPrState` method (lines 194-205), add `import { mapPrState } from './pr-state';` and change `this.mapPrState(prStatus)` to `mapPrState(prStatus)`.

Run: `cd apps/api && bunx jest src/vcs/pr-state.spec.ts src/vcs/vcs-pr-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing `applyMergedPr` unit tests**

Append to `apps/api/src/vcs/vcs-pr-sync.service.spec.ts`, inside the top-level `describe` (reuse its `service`, `mockRepo`, `makeTicketLink`, and the file's `VcsPrStatus` builder; if the builder is named differently, use it):

```ts
  describe('applyMergedPr (C9 §3.5, D457)', () => {
    const merged: VcsPrStatus = {
      number: 7, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T00:00:00Z'),
      mergedBy: 'dev', mergeSha: 'abc', url: 'https://github.com/owner/repo/pull/7', title: 'PR',
    };

    it('writes merged first, then transitions an IN_PROGRESS ticket', async () => {
      const link = makeTicketLink();
      await expect(service.applyMergedPr(link, merged)).resolves.toBe('updated');
      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith('link-1', 'merged');
      expect(mockRepo.applyMergedPrTransition).toHaveBeenCalledTimes(1);
      expect(mockRepo.updateTicketLinkWithPrState.mock.invocationCallOrder[0])
        .toBeLessThan(mockRepo.applyMergedPrTransition.mock.invocationCallOrder[0]);
    });

    it.each(['already-merged', 'not-found'] as const)('does not transition when the write returned %s', async (outcome) => {
      mockRepo.updateTicketLinkWithPrState.mockResolvedValueOnce(outcome);
      await expect(service.applyMergedPr(makeTicketLink(), merged)).resolves.toBe(outcome);
      expect(mockRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });

    it('records merged without a transition for a ticket that is not IN_PROGRESS', async () => {
      const link = makeTicketLink({ ticket: { id: 'ticket-1', status: 'CREATED', projectId: 'proj-1', number: 42, externalVcsId: null } });
      await expect(service.applyMergedPr(link, merged)).resolves.toBe('updated');
      expect(mockRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });
  });
```

Run: `cd apps/api && bunx jest src/vcs/vcs-pr-sync.service.spec.ts`
Expected: FAIL, "service.applyMergedPr is not a function".

- [ ] **Step 4: Implement `applyMergedPr` and use it in the poll**

In `vcs-pr-sync.service.ts`, import `PrStateWriteResult` from `./domain/vcs.repository` and add above `handleMergedPrAutoTransition`:

```ts
  /**
   * Fleet C9 §3.5 (D457): the one merge step for the VCS poll, the webhook and the fleet
   * PR-state refresher. The conditional write runs first; only the writer that moved the link
   * to `merged` transitions the ticket, so two paths that see one merge yield one VERIFY_FIX
   * and one FIX_REPORT comment. Transition failures are logged inside and never undo the write.
   */
  async applyMergedPr(link: TicketLinkData, prStatus: VcsPrStatus): Promise<PrStateWriteResult> {
    const outcome = await this.vcsRepo.updateTicketLinkWithPrState(link.id, 'merged');
    if (outcome === 'updated') await this.handleMergedPrAutoTransition(link, prStatus);
    return outcome;
  }
```

In `syncPrStatus`, replace the body of `if (!terminal) { ... }` up to (not including) the AC6 link-extraction block with:

```ts
            const outcome = newPrState === 'merged'
              ? await this.applyMergedPr(link, prStatus)
              : await this.vcsRepo.updateTicketLinkWithPrState(link.id, newPrState);
            if (outcome === 'updated') {
              updated++;
            }
```

Update the method's doc comment: replace "Failures in auto-transition do not prevent prState from being persisted" with "prState is written first; the transition runs only for the writer that recorded the merge (D457)".

Run: `cd apps/api && bunx jest src/vcs/vcs-pr-sync.service.spec.ts`
Expected: PASS (existing tests mock the write as `'updated'`, so "still update prState to merged even when auto-transition fails" keeps passing).

- [ ] **Step 5: Use it in the webhook and fix its spec**

Replace the body of `handlePullRequestMerged` after the `ALREADY_MERGED` early return with:

```ts
    const outcome = await this.prSyncService.applyMergedPr(ticketLink, {
      number: pr.number,
      state: pr.state,
      draft: pr.draft,
      merged: pr.merged,
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      mergedBy: pr.merged_by?.login ?? null,
      mergeSha: pr.merge_commit_sha ?? null,
      url: pr.html_url,
      title: pr.title,
    });
    if (outcome !== 'updated') {
      return VcsWebhookService.ignoredWrite(outcome);
    }

    this.logger.debug(`Updated TicketLink ${ticketLink.id} prState to 'merged' for merged PR #${prNumber}`);

    return {
      success: true,
      ignored: false,
    };
```

Remove the now-unused `TicketLinkData` import from `vcs-webhook.service.ts` if the linter flags it.

In `apps/api/src/vcs/vcs-webhook.merged-terminal.spec.ts`: change the `prSync` mock to `{ applyMergedPr: jest.fn().mockResolvedValue('updated') }` (type `{ applyMergedPr: jest.Mock }`); in "a duplicate merged delivery ..." expect `prSync.applyMergedPr` not called; replace the body of "an open link still moves to merged" with:

```ts
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('open'));

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(prSync.applyMergedPr).toHaveBeenCalledWith(link('open'), expect.objectContaining({ merged: true, url: 'https://github.com/acme/widgets/pull/7' }));
    expect(result).toEqual({ success: true, ignored: false });
```

and append:

```ts
  it('reports a merge another path already recorded as already merged (D457)', async () => {
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('open'));
    prSync.applyMergedPr.mockResolvedValueOnce('already-merged');

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(result).toEqual({ success: true, ignored: true, reason: 'PR is already merged' });
  });
```

In `vcs-webhook.service.spec.ts:70` rename the `handleMergedPrAutoTransition: jest.fn()` mock entry to `applyMergedPr: jest.fn().mockResolvedValue('updated')` and update any assertion on the old name the same way.

Run: `cd apps/api && bunx jest src/vcs`
Expected: PASS.

- [ ] **Step 6: Write the concurrency integration test**

`apps/api/test/integration/vcs/vcs-merge-step.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1b — one merge seen by two paths yields one transition (PG), spec §3.5, D457.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/vcs/vcs-merge-step.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsPrStatus } from '../../../src/vcs/types';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('shared merge step (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let prSync: VcsPrSyncService;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    prSync = app.get(VcsPrSyncService);
  });
  afterAll(async () => {
    await app.close();
  });

  it('two concurrent merge steps on one link: one VERIFY_FIX, one FIX_REPORT comment, one VCS_PR_MERGED activity', async () => {
    const project = await prisma.project.create({ data: { name: 'merge', slug: 'merge', key: 'MRG' } });
    const ticket = await prisma.ticket.create({ data: { projectId: project.id, number: 1, type: 'TASK', title: 'T1', status: 'IN_PROGRESS' } });
    const url = 'https://github.com/acme/app/pull/3';
    const created = await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: 3, externalRef: 'acme/app#3', prState: 'open' },
    });
    const link = (await prisma.ticketLink.findUniqueOrThrow({
      where: { id: created.id },
      include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
    })) as TicketLinkData;
    const status: VcsPrStatus = {
      number: 3, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev', mergeSha: 'abc', url, title: 'PR',
    };

    const outcomes = await Promise.all([prSync.applyMergedPr(link, status), prSync.applyMergedPr(link, status)]);

    expect([...outcomes].sort()).toEqual(['already-merged', 'updated']);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(1);
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(1);
  });
});
```

- [ ] **Step 7: Run it and see it pass**

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/vcs`
Expected: PASS (the new test plus the existing VCS integration suite, including `vcs-merged-pr.integration.spec.ts`).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/vcs apps/api/test/integration/vcs
git commit -m "fix(vcs): record a PR merge before transitioning, once per merge (C9 D457)"
```

---

### Task 3: Read one PR from the forge (GitHub App, GitLab token)

**Files:**
- Modify: `apps/api/src/fleet/git-broker/github-app-client.ts`, `github-app-client.spec.ts`
- Modify: `apps/api/src/fleet/git-broker/gitlab-access-checker.ts`, `gitlab-access-checker.spec.ts`

**Interfaces:**
- Produces: `GitHubAppClient.getPullRequest(token: string, owner: string, name: string, number: number): Promise<VcsPrStatus | null>`; `GitLabAccessChecker.getMergeRequest(token: string, owner: string, name: string, iid: number): Promise<VcsPrStatus | null>`. Both: `null` on 404, `RepoCheckException('provider_error')` on any other non-200 or a malformed body, `RepoCheckException('provider_unreachable')` from `FleetHttpClient` on network failure.

- [ ] **Step 1: Write the failing GitHub tests**

Append inside `describe('GitHubAppClient', ...)` in `github-app-client.spec.ts`:

```ts
  describe('getPullRequest (C9 §3.4)', () => {
    const PR = 'GET /repos/acme/app/pulls/9';

    it('maps a merged PR and sends the given token', async () => {
      forge.routes.set(PR, () => ({
        status: 200,
        body: {
          state: 'closed', draft: false, merged: true, merged_at: '2026-10-06T01:02:03Z', merged_by: { login: 'dev' },
          merge_commit_sha: 'abc123', html_url: 'https://github.com/acme/app/pull/9', title: 'Fix it',
        },
      }));
      await expect(client.getPullRequest('ghs_tok', 'acme', 'app', 9)).resolves.toEqual({
        number: 9, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T01:02:03Z'), mergedBy: 'dev',
        mergeSha: 'abc123', url: 'https://github.com/acme/app/pull/9', title: 'Fix it',
      });
      expect(forge.requests[0].headers.authorization).toBe('Bearer ghs_tok');
    });

    it('maps an open draft PR', async () => {
      forge.routes.set(PR, () => ({ status: 200, body: { state: 'open', draft: true, merged: false, merged_at: null, merged_by: null, html_url: 'u', title: 't' } }));
      await expect(client.getPullRequest('t', 'acme', 'app', 9)).resolves.toEqual(expect.objectContaining({ state: 'open', draft: true, merged: false, mergedBy: null, mergeSha: null }));
    });

    it('returns null for 404', async () => {
      await expect(client.getPullRequest('t', 'acme', 'app', 9)).resolves.toBeNull();
    });

    it.each([
      [{ status: 500, body: {} }],
      [{ status: 200, body: { draft: false } }],
    ])('throws provider_error for %j', async (reply) => {
      forge.routes.set(PR, () => reply);
      await expect(client.getPullRequest('t', 'acme', 'app', 9)).rejects.toMatchObject({ reason: 'provider_error' });
    });
  });
```

Run: `cd apps/api && bunx jest src/fleet/git-broker/github-app-client.spec.ts`
Expected: FAIL, "client.getPullRequest is not a function".

- [ ] **Step 2: Implement `getPullRequest`**

In `github-app-client.ts` add `import type { VcsPrStatus } from '../../vcs/types';` and, after `commentOnPullRequest`:

```ts
  /**
   * Fleet C9 §3.4: one PR's state, read with a repo-scoped installation token the caller minted
   * (one mint per repo per refresh pass, plan P1). Null when the PR does not exist.
   */
  async getPullRequest(token: string, owner: string, name: string, number: number): Promise<VcsPrStatus | null> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`;
    const res = await this.http.request('GET', `${this.api}${path}`, this.headers(token));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (typeof b.state !== 'string' || typeof b.html_url !== 'string') throw new RepoCheckException('provider_error');
    const mergedBy = obj(b.merged_by).login;
    return {
      number,
      state: b.state,
      draft: b.draft === true,
      merged: b.merged === true,
      mergedAt: typeof b.merged_at === 'string' ? new Date(b.merged_at) : null,
      mergedBy: typeof mergedBy === 'string' ? mergedBy : null,
      mergeSha: typeof b.merge_commit_sha === 'string' ? b.merge_commit_sha : null,
      url: b.html_url,
      title: typeof b.title === 'string' ? b.title : '',
    };
  }
```

Run: `cd apps/api && bunx jest src/fleet/git-broker/github-app-client.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing GitLab tests**

Append inside `describe('GitLabAccessChecker', ...)` in `gitlab-access-checker.spec.ts`:

```ts
  describe('getMergeRequest (C9 §3.4)', () => {
    const MR = `GET /api/v4/projects/${encodeURIComponent('grp/sub/app')}/merge_requests/4`;

    it('maps a merged MR and sends the token', async () => {
      forge.routes.set(MR, () => ({
        status: 200,
        body: {
          state: 'merged', draft: false, merged_at: '2026-10-06T01:00:00Z', merged_by: { username: 'dev' },
          merge_commit_sha: null, squash_commit_sha: 'sq1', web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/4', title: 'Fix',
        },
      }));
      await expect(checker.getMergeRequest('glpat', 'grp/sub', 'app', 4)).resolves.toEqual({
        number: 4, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T01:00:00Z'), mergedBy: 'dev',
        mergeSha: 'sq1', url: 'https://gitlab.com/grp/sub/app/-/merge_requests/4', title: 'Fix',
      });
      expect(forge.requests.at(-1)?.headers['private-token']).toBe('glpat');
    });

    it.each([
      [{ state: 'opened', draft: true }, { state: 'open', draft: true, merged: false }],
      [{ state: 'opened', work_in_progress: true }, { state: 'open', draft: true, merged: false }],
      [{ state: 'closed' }, { state: 'closed', draft: false, merged: false }],
      [{ state: 'locked' }, { state: 'closed', draft: false, merged: false }],
    ])('maps %j', async (body, expected) => {
      forge.routes.set(MR, () => ({ status: 200, body: { web_url: 'u', title: 't', ...body } }));
      await expect(checker.getMergeRequest('t', 'grp/sub', 'app', 4)).resolves.toEqual(expect.objectContaining(expected));
    });

    it('returns null for 404 and throws provider_error for 502', async () => {
      await expect(checker.getMergeRequest('t', 'grp/sub', 'app', 4)).resolves.toBeNull();
      forge.routes.set(MR, () => ({ status: 502, body: {} }));
      await expect(checker.getMergeRequest('t', 'grp/sub', 'app', 4)).rejects.toMatchObject({ reason: 'provider_error' });
    });
  });
```

Run: `cd apps/api && bunx jest src/fleet/git-broker/gitlab-access-checker.spec.ts`
Expected: FAIL, "checker.getMergeRequest is not a function".

- [ ] **Step 4: Implement `getMergeRequest`**

In `gitlab-access-checker.ts` add `import type { VcsPrStatus } from '../../vcs/types';` and, after `commentOnMergeRequest`:

```ts
  /** Fleet C9 §3.4: one MR's state with the project's GitLab token. Null when the MR does not exist. */
  async getMergeRequest(token: string, owner: string, name: string, iid: number): Promise<VcsPrStatus | null> {
    const api = this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '');
    const res = await this.http.request('GET', `${api}/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests/${iid}`, { 'private-token': token });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (typeof b.state !== 'string' || typeof b.web_url !== 'string') throw new RepoCheckException('provider_error');
    const mergedBy = obj(b.merged_by).username;
    const sha = typeof b.merge_commit_sha === 'string' ? b.merge_commit_sha : typeof b.squash_commit_sha === 'string' ? b.squash_commit_sha : null;
    return {
      number: iid,
      state: b.state === 'opened' ? 'open' : 'closed',
      draft: b.draft === true || b.work_in_progress === true,
      merged: b.state === 'merged',
      mergedAt: typeof b.merged_at === 'string' ? new Date(b.merged_at) : null,
      mergedBy: typeof mergedBy === 'string' ? mergedBy : null,
      mergeSha: sha,
      url: b.web_url,
      title: typeof b.title === 'string' ? b.title : '',
    };
  }
```

Run: `cd apps/api && bunx jest src/fleet/git-broker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/git-broker
git commit -m "feat(fleet): read one PR / MR state through the fleet forge clients (C9 §3.4)"
```

---

### Task 4: Fleet PR links on tickets (§3.3, D455)

**Files:**
- Modify: `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts`
- Modify: `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`, `fleet-job-ticket.effects.spec.ts`
- Modify: `apps/api/src/vcs/pr-state-write-sites.spec.ts:40-57`
- Modify: `apps/api/src/fleet/ingest/bundle-ingest.service.ts`, `bundle-ingest.service.spec.ts:14`, `apps/api/src/fleet/ingest/ingest.module.ts`
- Create: `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts`

**Interfaces:**
- Consumes: slice 1a `findTicketsForJob`, `FleetTicketEventRecorder.record`; `prNumberFor(repo, url)` from `apps/api/src/fleet/sync/pr-attribution.service.ts`.
- Produces: `PrLinkJob = { id: string; projectId: string; requestedById: string; resultPrUrl: string | null; repo: { provider: 'github' | 'gitlab'; owner: string; name: string } }`; repository `findJobForPrLinks(jobId: string): Promise<PrLinkJob | null>` and `upsertFleetPrLink(input: FleetPrLinkInput): Promise<boolean>` (true = row created), where `FleetPrLinkInput = { ticketId: string; jobId: string; url: string; provider: string; prNumber: number; externalRef: string; now: Date }`; `FleetJobTicketEffects.upsertPrLinks(jobId: string): Promise<void>` (never throws). `onTerminal` now runs `upsertPrLinks` for every terminal state.

- [ ] **Step 1: Write the failing effects unit tests**

In `fleet-job-ticket.effects.spec.ts`, in the `onTerminal` describe: extend the `repo` type and the `beforeEach` mock with

```ts
      findJobForPrLinks: jest.fn().mockResolvedValue(null),
      upsertFleetPrLink: jest.fn().mockResolvedValue(true),
```

(add `findJobForPrLinks: jest.Mock; upsertFleetPrLink: jest.Mock` to the `repo` type), and rename the test `'does nothing for %s'` to `'writes no failure comment for %s'` with the body:

```ts
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.createSystemComment).not.toHaveBeenCalled();
```

Then append a new describe at the end of the file:

```ts
describe('FleetJobTicketEffects.upsertPrLinks (C9 §3.3, D455)', () => {
  const prJob = (resultPrUrl: string | null) => ({
    id: 'j1', projectId: 'p', requestedById: 'u1', resultPrUrl, repo: { provider: 'github' as const, owner: 'acme', name: 'app' },
  });
  const linked = (ticketId: string) => ({ ticketId, ref: ticketId, title: ticketId, status: 'IN_PROGRESS', notifiedEpoch: null });
  let repo: Record<string, jest.Mock>;
  let events: { record: jest.Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    repo = {
      findJobForEffects: jest.fn().mockResolvedValue(null),
      findJobForPrLinks: jest.fn().mockResolvedValue(prJob('https://github.com/acme/app/pull/9')),
      findTicketsForJob: jest.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      upsertFleetPrLink: jest.fn().mockResolvedValue(true),
    };
    events = { record: jest.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never);
  });

  it('links the PR on every linked ticket and records TICKET_UPDATED for each created row', async () => {
    repo.upsertFleetPrLink.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).toHaveBeenCalledWith({
      ticketId: 't1', jobId: 'j1', url: 'https://github.com/acme/app/pull/9', provider: 'github', prNumber: 9, externalRef: 'acme/app#9', now: expect.any(Date),
    });
    expect(events.record.mock.calls).toEqual([[{
      projectId: 'p', ticketId: 't1', action: 'TICKET_UPDATED', actorId: 'u1', data: { fleetPrLinked: 'https://github.com/acme/app/pull/9', jobId: 'j1' },
    }]]);
  });

  it('does nothing without a resultPrUrl', async () => {
    repo.findJobForPrLinks.mockResolvedValue(prJob(null));
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).not.toHaveBeenCalled();
  });

  it("ignores a PR URL that does not name the job's repo", async () => {
    repo.findJobForPrLinks.mockResolvedValue(prJob('https://github.com/evil/fork/pull/9'));
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).not.toHaveBeenCalled();
  });

  it('keeps going when one ticket fails, and never throws', async () => {
    repo.upsertFleetPrLink.mockRejectedValueOnce(new Error('fk'));
    await expect(effects.upsertPrLinks('j1')).resolves.toBeUndefined();
    expect(repo.upsertFleetPrLink).toHaveBeenCalledTimes(2);
    repo.findJobForPrLinks.mockRejectedValueOnce(new Error('db down'));
    await expect(effects.upsertPrLinks('j1')).resolves.toBeUndefined();
  });

  it('runs from onTerminal for a COMPLETED job (no comment, PR linked)', async () => {
    repo.findJobForEffects.mockResolvedValue({ id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state: 'COMPLETED', leaseEpoch: 1, stateReason: null, escalationReason: null, requestedById: 'u1' });
    await effects.onTerminal(['j1']);
    expect(repo.upsertFleetPrLink).toHaveBeenCalledTimes(2);
  });
});
```

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-job-ticket.effects.spec.ts`
Expected: FAIL, "effects.upsertPrLinks is not a function".

- [ ] **Step 2: Add the repository methods**

In `prisma-fleet-tickets.repository.ts`, add the types next to the existing ones:

```ts
export interface PrLinkJob {
  id: string; projectId: string; requestedById: string; resultPrUrl: string | null;
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string };
}
export interface FleetPrLinkInput {
  ticketId: string; jobId: string; url: string; provider: string; prNumber: number; externalRef: string; now: Date;
}
```

and the methods (after `createSystemComment`):

```ts
  async findJobForPrLinks(jobId: string): Promise<PrLinkJob | null> {
    const r = await this.db.fleetJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, requestedById: true, resultPrUrl: true, repo: { select: { provider: true, owner: true, name: true } } },
    });
    return r ? { ...r, repo: { ...r.repo, provider: r.repo.provider as 'github' | 'gitlab' } } : null;
  }

  /**
   * D455: insert the fleet PR link, or point the existing (ticketId, url) link at this job
   * (a vcs link keeps source=vcs; plan P4: latest job wins). True only when a row was created.
   * Never writes prState on an existing row (M12; see vcs/pr-state-write-sites.spec.ts).
   * Call inside txManager.run.
   */
  async upsertFleetPrLink(input: FleetPrLinkInput): Promise<boolean> {
    const { ticketId, jobId, url, provider, prNumber, externalRef, now } = input;
    const { count } = await this.db.ticketLink.createMany({
      data: [{ ticketId, url, provider, linkType: 'pr', source: TicketLinkSource.FLEET, jobId, prNumber, externalRef, prState: 'open', prUpdatedAt: now }],
      skipDuplicates: true,
    });
    if (count === 1) return true;
    await this.db.ticketLink.updateMany({ where: { ticketId, url }, data: { jobId } });
    return false;
  }
```

- [ ] **Step 3: Implement `upsertPrLinks` and wire it into `onTerminal`**

In `fleet-job-ticket.effects.ts` add imports:

```ts
import { prNumberFor } from '../sync/pr-attribution.service';
import type { PrLinkJob } from './prisma-fleet-tickets.repository';
```

Replace `onTerminal` with:

```ts
  /** D453/D454/D455: after commit, from sync afterTerminal and the sweeper. Failure comment, then the PR link. */
  async onTerminal(jobIds: readonly string[]): Promise<void> {
    for (const jobId of new Set(jobIds)) {
      await this.commentOnFailure(jobId);
      await this.upsertPrLinks(jobId);
    }
  }

  /** C9 §3.3 (D455): the job's PR as a `pr` link on each linked ticket. Also after ingest fills resultPrUrl. Never throws. */
  async upsertPrLinks(jobId: string): Promise<void> {
    try {
      const job = await this.repo.findJobForPrLinks(jobId);
      if (!job?.resultPrUrl) return;
      const prNumber = prNumberFor(job.repo, job.resultPrUrl);
      if (prNumber === null) {
        this.logger.warn(`Fleet job ${jobId}: resultPrUrl does not name ${job.repo.owner}/${job.repo.name}; no PR link`);
        return;
      }
      for (const ticket of await this.repo.findTicketsForJob(jobId)) {
        await this.linkPr(job, ticket, prNumber);
      }
    } catch (error) {
      this.logger.warn(`Fleet job ${jobId}: PR links failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async commentOnFailure(jobId: string): Promise<void> {
    try {
      const job = await this.repo.findJobForEffects(jobId);
      if (!job || !FAILURE_STATES.has(job.state)) return;
      const body = failureCommentBody(job);
      for (const ticket of await this.repo.findTicketsForJob(jobId)) {
        await this.commentOnce(job, ticket, body);
      }
    } catch (error) {
      this.logger.warn(`Fleet job ${jobId}: ticket effects failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async linkPr(job: PrLinkJob, ticket: LinkedTicket, prNumber: number): Promise<void> {
    const url = job.resultPrUrl as string;
    try {
      await this.txManager.run(async () => {
        const created = await this.repo.upsertFleetPrLink({
          ticketId: ticket.ticketId, jobId: job.id, url, provider: job.repo.provider, prNumber,
          externalRef: `${job.repo.owner}/${job.repo.name}#${prNumber}`, now: new Date(),
        });
        if (!created) return;
        await this.events.record({ projectId: job.projectId, ticketId: ticket.ticketId, action: 'TICKET_UPDATED', actorId: job.requestedById, data: { fleetPrLinked: url, jobId: job.id } });
      });
    } catch (error) {
      this.logger.warn(`Fleet job ${job.id}: PR link on ticket ${ticket.ref} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
```

Run: `cd apps/api && bunx jest src/fleet/tickets`
Expected: PASS.

- [ ] **Step 4: Update the M12 tripwire**

In `apps/api/src/vcs/pr-state-write-sites.spec.ts` change the expected site list and pin the third test to the VCS write:

```ts
    expect(sites.map((s) => s.site).sort()).toEqual([
      'fleet/tickets/prisma-fleet-tickets.repository.ts:updateMany',
      'vcs/prisma-vcs.repository.ts:updateMany',
      'vcs/prisma-vcs.repository.ts:upsert',
    ]);
```

```ts
  it('the conditional updateMany skips merged rows but not NULL ones', () => {
    const update = sites.find((s) => s.site === 'vcs/prisma-vcs.repository.ts:updateMany');
```

Add one line to the file's header comment: "The fleet PR-link `updateMany` (C9 D455) sets `jobId` only."

Run: `cd apps/api && bunx jest src/vcs/pr-state-write-sites.spec.ts`
Expected: PASS (the second test still proves only the VCS `updateMany` names `prState`).

- [ ] **Step 5: Write the failing ingest hook test**

`apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts`:

```ts
import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';
import { computeCorrection } from './ingest-corrections';

jest.mock('./bundle-reader', () => ({ readBundleFiles: jest.fn(async () => ({})) }));
jest.mock('./parse-bundle', () => ({
  parseBundle: jest.fn(() => ({ naxRunId: null, rows: [], ledgerCostUsd: '0', runStatus: 'completed', finish: null, partial: false, files: [] })),
}));
jest.mock('./ingest-corrections', () => ({ computeCorrection: jest.fn() }));

const now = new Date('2026-10-06T10:00:00Z');

function make() {
  const job = { id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED', requestedById: 'u' };
  const repo = {
    claimNext: jest.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: jest.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: jest.fn(), markOutcome: jest.fn(), markRetry: jest.fn(), markFailed: jest.fn(),
  };
  const store = { get: jest.fn(async () => Readable.from([])) };
  const jobs = { lockById: jest.fn(async () => job), update: jest.fn(async () => job), appendEvent: jest.fn() };
  const live = { event: jest.fn(() => ({})), publish: jest.fn() };
  const ticketEffects = { upsertPrLinks: jest.fn().mockResolvedValue(undefined) };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: jest.fn() } as never, { signal: jest.fn() } as never,
    { run: (fn: () => unknown) => fn() } as never, ticketEffects as never,
  );
  return { svc, ticketEffects, repo };
}

describe('BundleIngestService PR links after corrections (C9 §3.3)', () => {
  it('links the PR on the tickets when the correction filled resultPrUrl', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: { resultPrUrl: 'https://github.com/acme/app/pull/9' }, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, ticketEffects, repo } = make();
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(ticketEffects.upsertPrLinks).toHaveBeenCalledWith('j1');
  });

  it('does not link when the correction left resultPrUrl alone', async () => {
    (computeCorrection as jest.Mock).mockReturnValue({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, ticketEffects } = make();
    await svc.ingestOne(now);
    expect(ticketEffects.upsertPrLinks).not.toHaveBeenCalled();
  });
});
```

Run: `cd apps/api && bunx jest src/fleet/ingest/bundle-ingest.pr-links.spec.ts`
Expected: FAIL (`upsertPrLinks` never called).

- [ ] **Step 6: Call `upsertPrLinks` after ingest**

In `bundle-ingest.service.ts` add `import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';`, add the constructor parameter last:

```ts
    private readonly ticketEffects: FleetJobTicketEffects,
```

change the transaction's return to

```ts
      return { event: this.live.event(updated), spendKeys: correction.costRaised ? jobSpendKeys(updated) : [], prFilled: 'resultPrUrl' in correction.patch };
```

and after `if (result.spendKeys.length > 0) this.budgets.signal(result.spendKeys);` add

```ts
    if (result.prFilled) void this.ticketEffects.upsertPrLinks(claim.jobId); // C9 §3.3: late PR URL; never throws
```

In `ingest.module.ts` add `FleetTicketsModule` (from `'../tickets/fleet-tickets.module'`) to `imports`. In `bundle-ingest.service.spec.ts:14` append `{ upsertPrLinks: jest.fn() } as never` as the last constructor argument. Search for any other construction site and update it the same way:

```bash
grep -rn "new BundleIngestService(" apps/api/src apps/api/test
```

Run: `cd apps/api && bunx jest src/fleet/ingest && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Write the integration test**

`apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1b — fleet PR links on linked tickets (PG), spec §3.3, D455.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-links.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet PR links (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let effects: FleetJobTicketEffects;
  let n = 0;

  const ticket = async () => {
    n += 1;
    return prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
  };
  const jobFor = async (ticketIds: string[], resultPrUrl: string | null, state = 'COMPLETED') => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `f${n}-${ticketIds.length}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state, leaseEpoch: 1, resultPrUrl,
      },
    });
    await prisma.fleetJobTicket.createMany({ data: ticketIds.map((ticketId) => ({ jobId: job.id, ticketId })) });
    return job;
  };
  const links = (ticketId: string) => prisma.ticketLink.findMany({ where: { ticketId } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    effects = app.get(FleetJobTicketEffects);
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates one fleet pr link per linked ticket, once, with a TICKET_UPDATED event', async () => {
    const [a, b] = [await ticket(), await ticket()];
    const job = await jobFor([a.id, b.id], 'https://github.com/acme/app/pull/9');
    await effects.onTerminal([job.id]);
    await effects.onTerminal([job.id]);
    for (const t of [a, b]) {
      expect(await links(t.id)).toEqual([expect.objectContaining({
        url: 'https://github.com/acme/app/pull/9', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id,
        prNumber: 9, externalRef: 'acme/app#9', prState: 'open',
      })]);
      expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, action: 'TICKET_UPDATED' } })).toBe(1);
    }
  });

  it('an existing vcs link for the same URL keeps source vcs and gains the job id', async () => {
    const t = await ticket();
    const url = 'https://github.com/acme/app/pull/10';
    await prisma.ticketLink.create({ data: { ticketId: t.id, url, provider: 'github', linkType: 'pr', prNumber: 10, externalRef: 'acme/app#10', prState: 'draft' } });
    const job = await jobFor([t.id], url);
    await effects.upsertPrLinks(job.id);
    expect(await links(t.id)).toEqual([expect.objectContaining({ source: 'vcs', jobId: job.id, prState: 'draft' })]);
    expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, action: 'TICKET_UPDATED' } })).toBe(0);
  });

  it('ignores a PR URL on another repo, and a job without a PR', async () => {
    const t = await ticket();
    await effects.upsertPrLinks((await jobFor([t.id], 'https://github.com/evil/fork/pull/1')).id);
    await effects.upsertPrLinks((await jobFor([t.id], null, 'FAILED')).id);
    expect(await links(t.id)).toEqual([]);
  });

  it('unlink removes the fleet PR link but not a vcs link', async () => {
    const t = await ticket();
    const job = await jobFor([t.id], 'https://github.com/acme/app/pull/11');
    await effects.upsertPrLinks(job.id);
    await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://example.com/doc', provider: 'other', linkType: 'url' } });
    await expect(app.get(PrismaFleetTicketsRepository).unlink(job.id, t.id)).resolves.toBe(true);
    expect((await links(t.id)).map((l) => l.source)).toEqual(['vcs']);
  });
});
```

- [ ] **Step 8: Run it and see it pass**

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-links.integration.spec.ts test/integration/fleet/fleet-tickets-terminal.integration.spec.ts`
Expected: PASS (slice 1a's terminal suite still passes: COMPLETED writes no comment).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet/tickets apps/api/src/fleet/ingest apps/api/src/vcs/pr-state-write-sites.spec.ts apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts
git commit -m "feat(fleet): link a job's PR on its tickets, on terminal and after ingest (C9 §3.3)"
```

---

### Task 5: Fleet PR-state refresher (§3.4, D456)

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`, `apps/api/src/config/env.validation.ts:~77`, `apps/api/src/config/fleet.config.spec.ts`, `apps/api/src/common/test-helpers/fleet-config.ts`
- Modify: `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts`
- Create: `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts`, `fleet-pr-state.refresher.spec.ts`
- Modify: `apps/api/src/fleet/tickets/fleet-tickets.module.ts`
- Test: `apps/api/test/integration/fleet/fleet-pr-refresher.integration.spec.ts`

**Interfaces:**
- Consumes: Task 2 `mapPrState`, `VcsPrSyncService.applyMergedPr`; Task 3 `getPullRequest`, `getMergeRequest`; `GitHubAppClient.mintInstallationToken(installationId, repoName)`; `GitLabTokenSource.resolve(projectId, owner, name)`; `IVcsRepository.updateTicketLinkWithPrState`.
- Produces: `IFleetConfig.prRefreshMs: number`; `RefreshRepo`, `RefreshableLink` types; repository `findRefreshableFleetLinks(limit: number): Promise<RefreshableLink[]>`; `FleetPrStateRefresher.refresh(): Promise<RefreshSummary>` with `RefreshSummary = { skipped: boolean; checked: number; changed: number; failedRepos: number }`.

- [ ] **Step 1: Write the failing config tests**

In `fleet.config.spec.ts` append (follow the file's existing `process.env` reset pattern):

```ts
  it('defaults the fleet PR refresh to 10 minutes and reads an override (C9 D456)', () => {
    delete process.env.FLEET_PR_REFRESH_MS;
    expect(fleetConfig().prRefreshMs).toBe(600_000);
    process.env.FLEET_PR_REFRESH_MS = '120000';
    expect(fleetConfig().prRefreshMs).toBe(120_000);
    delete process.env.FLEET_PR_REFRESH_MS;
  });

  it.each(['59999', '1.5', 'abc'])('refuses boot on FLEET_PR_REFRESH_MS=%s', (value) => {
    expect(() => validate({ ...BASE, FLEET_PR_REFRESH_MS: value })).toThrow();
  });
```

Run: `cd apps/api && bunx jest src/config/fleet.config.spec.ts`
Expected: FAIL.

- [ ] **Step 2: Add the config**

`fleet.config.ts`: in `IFleetConfig` after `jobQueuedWarnSec`:

```ts
  /** C9 §3.4 (D456): fleet PR-state refresher interval (ms); min 60 000 enforced at boot. */
  prRefreshMs: number;
```

In `FleetConfigSchema`: `@IsOptional() @IsString() FLEET_PR_REFRESH_MS: string;`. In the factory: `prRefreshMs: int('FLEET_PR_REFRESH_MS', 600_000),`.

`env.validation.ts`, after `FLEET_JOB_QUEUED_WARN_SEC`:

```ts
  FLEET_PR_REFRESH_MS: Joi.number().integer().min(60_000).max(86_400_000).optional(),
```

`common/test-helpers/fleet-config.ts`: add `prRefreshMs: 600_000,` after `jobQueuedWarnSec`.

Run: `cd apps/api && bunx jest src/config && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors (fix any other full `IFleetConfig` literal tsc reports by adding `prRefreshMs: 600_000`).

- [ ] **Step 3: Add the repository query**

In `prisma-fleet-tickets.repository.ts`:

```ts
export interface RefreshRepo {
  id: string; projectId: string; provider: 'github' | 'gitlab'; owner: string; name: string; githubInstallationId: bigint | null;
}
/** A fleet PR link to refresh; structurally a vcs TicketLinkData plus the job's repo. */
export interface RefreshableLink {
  id: string; ticketId: string; url: string; prNumber: number; prState: string | null; externalRef: string | null; source: string;
  ticket: { id: string; status: string; projectId: string; number: number; externalVcsId: string | null };
  repo: RefreshRepo;
}
```

```ts
  /** D456: open fleet PR links of live tickets with their job's repo, least recently refreshed first (plan P5). */
  async findRefreshableFleetLinks(limit: number): Promise<RefreshableLink[]> {
    const rows = await this.db.ticketLink.findMany({
      where: {
        source: TicketLinkSource.FLEET, jobId: { not: null }, prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] }, ticket: { deletedAt: null },
      },
      select: {
        id: true, ticketId: true, url: true, prNumber: true, prState: true, externalRef: true, source: true,
        ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } },
        job: { select: { repo: { select: { id: true, projectId: true, provider: true, owner: true, name: true, githubInstallationId: true } } } },
      },
      orderBy: { prUpdatedAt: 'asc' },
      take: limit,
    });
    return rows.flatMap(({ job, prNumber, ...rest }) =>
      job && prNumber !== null ? [{ ...rest, prNumber, repo: { ...job.repo, provider: job.repo.provider as 'github' | 'gitlab' } }] : []);
  }
```

- [ ] **Step 4: Write the failing refresher unit tests**

`apps/api/src/fleet/tickets/fleet-pr-state.refresher.spec.ts`:

```ts
import { FleetPrStateRefresher } from './fleet-pr-state.refresher';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const gh = { id: 'r1', projectId: 'p', provider: 'github' as const, owner: 'acme', name: 'app', githubInstallationId: BigInt(77) };
const gl = { id: 'r2', projectId: 'p', provider: 'gitlab' as const, owner: 'grp', name: 'lib', githubInstallationId: null };
const link = (id: string, prNumber: number, repo = gh, prState = 'open') => ({
  id, ticketId: `t-${id}`, url: `u${prNumber}`, prNumber, prState, externalRef: `${repo.owner}/${repo.name}#${prNumber}`, source: 'fleet',
  ticket: { id: `t-${id}`, status: 'IN_PROGRESS', projectId: 'p', number: 1, externalVcsId: null }, repo,
});
const pr = (over: Record<string, unknown> = {}) => ({
  number: 1, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: 'u', title: 't', ...over,
});

describe('FleetPrStateRefresher (C9 §3.4, D456)', () => {
  let repo: { findRefreshableFleetLinks: jest.Mock };
  let github: { mintInstallationToken: jest.Mock; getPullRequest: jest.Mock };
  let gitlab: { getMergeRequest: jest.Mock };
  let gitlabTokens: { resolve: jest.Mock };
  let vcsRepo: { updateTicketLinkWithPrState: jest.Mock };
  let prSync: { applyMergedPr: jest.Mock };
  let refresher: FleetPrStateRefresher;

  beforeEach(() => {
    repo = { findRefreshableFleetLinks: jest.fn().mockResolvedValue([]) };
    github = { mintInstallationToken: jest.fn().mockResolvedValue({ token: 'ghs', expiresAt: new Date() }), getPullRequest: jest.fn().mockResolvedValue(pr()) };
    gitlab = { getMergeRequest: jest.fn().mockResolvedValue(pr()) };
    gitlabTokens = { resolve: jest.fn().mockResolvedValue('glpat') };
    vcsRepo = { updateTicketLinkWithPrState: jest.fn().mockResolvedValue('updated') };
    prSync = { applyMergedPr: jest.fn().mockResolvedValue('updated') };
    refresher = new FleetPrStateRefresher(
      repo as never, github as never, gitlab as never, gitlabTokens as never, vcsRepo as never, prSync as never, testFleetConfig(),
    );
  });

  it('mints one GitHub token per repo and reads each PR with it', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 2)]);
    await refresher.refresh();
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(github.mintInstallationToken).toHaveBeenCalledWith(BigInt(77), 'app');
    expect(github.getPullRequest.mock.calls).toEqual([['ghs', 'acme', 'app', 1], ['ghs', 'acme', 'app', 2]]);
  });

  it('reads GitLab MRs with the project token', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 4, gl)]);
    await refresher.refresh();
    expect(gitlabTokens.resolve).toHaveBeenCalledWith('p', 'grp', 'lib');
    expect(gitlab.getMergeRequest).toHaveBeenCalledWith('glpat', 'grp', 'lib', 4);
  });

  it('writes a changed state, skips an unchanged one, and closes a 404', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 2), link('c', 3)]);
    github.getPullRequest.mockResolvedValueOnce(pr({ draft: true })).mockResolvedValueOnce(pr()).mockResolvedValueOnce(null);
    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 3, changed: 2, failedRepos: 0 });
    expect(vcsRepo.updateTicketLinkWithPrState.mock.calls).toEqual([['a', 'draft'], ['c', 'closed']]);
  });

  it('routes a merge through the shared merge step, not a plain write', async () => {
    const l = link('a', 1);
    repo.findRefreshableFleetLinks.mockResolvedValue([l]);
    github.getPullRequest.mockResolvedValue(pr({ state: 'closed', merged: true }));
    await refresher.refresh();
    expect(prSync.applyMergedPr).toHaveBeenCalledWith(l, expect.objectContaining({ merged: true }));
    expect(vcsRepo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
  });

  it('skips a repo whose token cannot be minted and still refreshes the others', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 4, gl)]);
    github.mintInstallationToken.mockRejectedValue(new RepoCheckException('app_not_installed'));
    gitlab.getMergeRequest.mockResolvedValue(pr({ state: 'closed' }));
    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 1, changed: 1, failedRepos: 1 });
    expect(vcsRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith('b', 'closed');
  });

  it('counts a GitHub repo without an installation id as failed', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1, { ...gh, githubInstallationId: null })]);
    await expect(refresher.refresh()).resolves.toEqual(expect.objectContaining({ failedRepos: 1, checked: 0 }));
  });

  it('a failed PR read skips that link only', async () => {
    repo.findRefreshableFleetLinks.mockResolvedValue([link('a', 1), link('b', 2)]);
    github.getPullRequest.mockRejectedValueOnce(new RepoCheckException('provider_error')).mockResolvedValueOnce(pr({ state: 'closed' }));
    await refresher.refresh();
    expect(vcsRepo.updateTicketLinkWithPrState.mock.calls).toEqual([['b', 'closed']]);
  });

  it('skips a pass while one is running', async () => {
    let release: () => void = () => undefined;
    repo.findRefreshableFleetLinks.mockReturnValue(new Promise((resolve) => { release = () => resolve([]); }));
    const first = refresher.refresh();
    await expect(refresher.refresh()).resolves.toEqual({ skipped: true, checked: 0, changed: 0, failedRepos: 0 });
    release();
    await expect(first).resolves.toEqual(expect.objectContaining({ skipped: false }));
  });

  it('never throws when the link query fails', async () => {
    repo.findRefreshableFleetLinks.mockRejectedValue(new Error('db down'));
    await expect(refresher.refresh()).resolves.toEqual({ skipped: false, checked: 0, changed: 0, failedRepos: 0 });
  });

  it('starts no timer when background work is off (plan P3)', () => {
    const spy = jest.spyOn(global, 'setInterval');
    refresher.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-pr-state.refresher.spec.ts`
Expected: FAIL, "Cannot find module './fleet-pr-state.refresher'".

- [ ] **Step 5: Implement the refresher**

`apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IVcsRepository, VCS_REPOSITORY } from '../../vcs/domain/vcs.repository';
import { mapPrState } from '../../vcs/pr-state';
import type { VcsPrStatus } from '../../vcs/types';
import { VcsPrSyncService } from '../../vcs/vcs-pr-sync.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import type { RefreshableLink, RefreshRepo } from './prisma-fleet-tickets.repository';

export interface RefreshSummary {
  skipped: boolean;
  checked: number;
  changed: number;
  failedRepos: number;
}

type ReadPr = (number: number) => Promise<VcsPrStatus | null>;

const errorName = (error: unknown): string =>
  error instanceof RepoCheckException ? error.reason : error instanceof Error ? error.name : 'unknown';

/**
 * Fleet C9 §3.4 (D456): keeps fleet PR links current without a VcsConnection, through the
 * koda-fleet GitHub App or the project's GitLab token. In process (single API instance), like
 * FleetSweeper; one pass at a time; never throws.
 */
@Injectable()
export class FleetPrStateRefresher implements OnModuleInit, OnModuleDestroy {
  static readonly BATCH = 500; // plan P5

  private readonly logger = new Logger(FleetPrStateRefresher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repo: PrismaFleetTicketsRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly gitlabTokens: GitLabTokenSource,
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: Pick<IVcsRepository, 'updateTicketLinkWithPrState'>,
    private readonly prSync: VcsPrSyncService,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'sweepEnabled' | 'prRefreshMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.config.sweepEnabled) return; // plan P3
    this.timer = setInterval(() => void this.refresh(), this.config.prRefreshMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<RefreshSummary> {
    if (this.running) return { skipped: true, checked: 0, changed: 0, failedRepos: 0 };
    this.running = true;
    const summary: RefreshSummary = { skipped: false, checked: 0, changed: 0, failedRepos: 0 };
    try {
      const byRepo = new Map<string, RefreshableLink[]>();
      for (const link of await this.repo.findRefreshableFleetLinks(FleetPrStateRefresher.BATCH)) {
        byRepo.set(link.repo.id, [...(byRepo.get(link.repo.id) ?? []), link]);
      }
      for (const links of byRepo.values()) {
        const counts = await this.refreshRepo(links);
        if (counts === null) summary.failedRepos += 1;
        else {
          summary.checked += counts.checked;
          summary.changed += counts.changed;
        }
      }
    } catch (error) {
      this.logger.warn(`Fleet PR refresh failed: ${errorName(error)}`);
    } finally {
      this.running = false;
    }
    return summary;
  }

  /** Null when the repo could not be read at all (token or install missing). */
  private async refreshRepo(links: readonly RefreshableLink[]): Promise<{ checked: number; changed: number } | null> {
    const repo = links[0].repo;
    let read: ReadPr;
    try {
      read = await this.readerFor(repo);
    } catch (error) {
      this.logger.warn(`Fleet PR refresh: ${repo.owner}/${repo.name} skipped (${errorName(error)})`);
      return null;
    }
    let checked = 0;
    let changed = 0;
    for (const link of links) {
      try {
        const pr = await read(link.prNumber);
        checked += 1;
        if (await this.apply(link, pr)) changed += 1;
      } catch (error) {
        this.logger.debug(`Fleet PR refresh: link ${link.id} skipped (${errorName(error)})`);
      }
    }
    return { checked, changed };
  }

  private async readerFor(repo: RefreshRepo): Promise<ReadPr> {
    if (repo.provider === 'github') {
      if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
      const { token } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      return (number) => this.github.getPullRequest(token, repo.owner, repo.name, number);
    }
    const token = await this.gitlabTokens.resolve(repo.projectId, repo.owner, repo.name);
    return (number) => this.gitlab.getMergeRequest(token, repo.owner, repo.name, number);
  }

  /** True when this pass changed the link. A deleted PR (null) becomes closed, like the VCS poll's 404. */
  private async apply(link: RefreshableLink, pr: VcsPrStatus | null): Promise<boolean> {
    const next = pr === null ? 'closed' : mapPrState(pr);
    if (next === link.prState) return false;
    const outcome = pr !== null && next === 'merged'
      ? await this.prSync.applyMergedPr(link, pr)
      : await this.vcsRepo.updateTicketLinkWithPrState(link.id, next);
    return outcome === 'updated';
  }
}
```

(`RepoCheckException.reason` is a fixed code such as `app_not_installed`; logs never carry a token or a forge body.)

- [ ] **Step 6: Wire the module**

`fleet-tickets.module.ts`:

```ts
import { VcsModule } from '../../vcs/vcs.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { FleetPrStateRefresher } from './fleet-pr-state.refresher';
```

`imports: [PrismaModule, TicketsModule, EventsModule, ProjectAccessModule, VcsModule, GitBrokerModule]`, add `FleetPrStateRefresher` to `providers` and to `exports`.

Run: `cd apps/api && bunx jest src/fleet src/config && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors. (`fleet.module.spec.ts` compiles the module graph; it must stay green.)

- [ ] **Step 7: Write the integration test**

`apps/api/test/integration/fleet/fleet-pr-refresher.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1b — fleet PR-state refresher (PG), spec §3.4, §3.5, §6.
 * The forge is stubbed on the app's GitHubAppClient instance; DB, VCS repository and merge step are real.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-refresher.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { FleetPrStateRefresher } from '../../../src/fleet/tickets/fleet-pr-state.refresher';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsPrStatus } from '../../../src/vcs/types';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet PR-state refresher (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let refresher: FleetPrStateRefresher;
  let getPullRequest: jest.SpyInstance;
  let n = 0;

  const status = (over: Partial<VcsPrStatus> = {}): VcsPrStatus => ({
    number: 1, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: 'u', title: 't', ...over,
  });
  const fleetLink = async (prNumber: number) => {
    n += 1;
    const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `f${n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      },
    });
    const link = await prisma.ticketLink.create({
      data: {
        ticketId: ticket.id, url: `https://github.com/acme/app/pull/${prNumber}`, provider: 'github', linkType: 'pr',
        source: 'fleet', jobId: job.id, prNumber, externalRef: `acme/app#${prNumber}`, prState: 'open', prUpdatedAt: new Date(0),
      },
    });
    return { ticket, link };
  };
  const linkState = async (id: string) => (await prisma.ticketLink.findUniqueOrThrow({ where: { id } })).prState;
  const fixReports = (ticketId: string) => prisma.comment.count({ where: { ticketId, type: 'FIX_REPORT' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    refresher = app.get(FleetPrStateRefresher);
    const github = app.get(GitHubAppClient);
    jest.spyOn(github, 'mintInstallationToken').mockResolvedValue({ token: 'ghs_test', expiresAt: new Date(Date.now() + 3_600_000) });
    getPullRequest = jest.spyOn(github, 'getPullRequest');
  });
  beforeEach(async () => {
    getPullRequest.mockReset();
    await prisma.ticketLink.updateMany({ where: { source: 'fleet' }, data: { prState: 'closed' } }); // isolate each test's links
  });
  afterAll(async () => {
    await app.close();
  });

  it('a merged PR moves the ticket to VERIFY_FIX once; the next pass no longer reads it', async () => {
    const { ticket, link } = await fleetLink(21);
    getPullRequest.mockResolvedValue(status({ number: 21, state: 'closed', merged: true, mergedBy: 'dev', mergeSha: 'abc', url: link.url }));
    await expect(refresher.refresh()).resolves.toEqual(expect.objectContaining({ checked: 1, changed: 1 }));
    expect(await linkState(link.id)).toBe('merged');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await fixReports(ticket.id)).toBe(1);
    getPullRequest.mockClear();
    await refresher.refresh();
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('a deleted PR (404) closes the link without a transition', async () => {
    const { ticket, link } = await fleetLink(22);
    getPullRequest.mockResolvedValue(null);
    await refresher.refresh();
    expect(await linkState(link.id)).toBe('closed');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('IN_PROGRESS');
  });

  it('the VCS path and the refresher seeing one merge yield one transition and one comment', async () => {
    const { ticket, link } = await fleetLink(23);
    const merged = status({ number: 23, state: 'closed', merged: true, mergedBy: 'dev', mergeSha: 'abc', url: link.url });
    getPullRequest.mockResolvedValue(merged);
    const vcsView = (await prisma.ticketLink.findUniqueOrThrow({
      where: { id: link.id },
      include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
    })) as TicketLinkData;
    await Promise.all([refresher.refresh(), app.get(VcsPrSyncService).applyMergedPr(vcsView, merged)]);
    expect(await linkState(link.id)).toBe('merged');
    expect(await fixReports(ticket.id)).toBe(1);
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(1);
  });
});
```

- [ ] **Step 8: Run it and see it pass**

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-refresher.integration.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/config apps/api/src/common/test-helpers/fleet-config.ts apps/api/src/fleet/tickets apps/api/test/integration/fleet/fleet-pr-refresher.integration.spec.ts
git commit -m "feat(fleet): refresh fleet PR state through the forge, merge via the shared step (C9 §3.4)"
```

---

### Task 6: `source` and `jobId` on ticket link responses; contract

**Files:**
- Modify: `apps/api/src/ticket-links/dto/ticket-link-response.dto.ts`
- Create: `apps/api/src/ticket-links/dto/ticket-link-response.dto.spec.ts`
- Modify: `apps/api/src/ticket-links/domain/ticket-link.domain.ts`, `apps/api/src/ticket-links/prisma-ticket-link.repository.ts:15-27`
- Modify: `apps/api/src/tickets/dto/ticket-response.dto.ts:~104-117`, `apps/api/src/tickets/prisma-tickets.repository.ts:26-37,113-124`, `apps/api/src/tickets/domain/ticket.domain.ts:24-35`
- Modify: `apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts` (one API test)
- Regenerate: `apps/cli/src/generated/**` (via `bun run generate`)

**Interfaces:**
- Produces: `TicketLinkResponseDto.source: string` (`vcs | fleet`) and `TicketLinkResponseDto.jobId: string | null`, on every ticket link response (ticket detail `links[]`, ticket-links endpoints). Slice 2 renders "via fleet" from `source`.

- [ ] **Step 1: Write the failing DTO test**

`apps/api/src/ticket-links/dto/ticket-link-response.dto.spec.ts`:

```ts
import { TicketLinkResponseDto } from './ticket-link-response.dto';

const base = { id: 'l1', ticketId: 't1', url: 'u', provider: 'github', externalRef: 'acme/app#9', prState: 'open', prNumber: 9, prUpdatedAt: null, linkType: 'pr', createdAt: new Date(0) };

describe('TicketLinkResponseDto.from (C9 §2, slice 1b)', () => {
  it('passes source and jobId through', () => {
    expect(TicketLinkResponseDto.from({ ...base, source: 'fleet', jobId: 'j1' })).toEqual(expect.objectContaining({ source: 'fleet', jobId: 'j1' }));
  });

  it('defaults a row without them to vcs / null', () => {
    expect(TicketLinkResponseDto.from(base)).toEqual(expect.objectContaining({ source: 'vcs', jobId: null }));
  });
});
```

Run: `cd apps/api && bunx jest src/ticket-links/dto/ticket-link-response.dto.spec.ts`
Expected: FAIL.

- [ ] **Step 2: Add the fields everywhere a link is mapped**

`ticket-link-response.dto.ts`, after `linkType`:

```ts
  @ApiProperty({ description: 'vcs | fleet: fleet links were written by a fleet job (C9)' })
  source!: string;

  @ApiProperty({ nullable: true, type: String, description: 'The fleet job that produced the link' })
  jobId!: string | null;
```

and in `from()` after `linkType`:

```ts
      source: link.source ?? 'vcs',
      jobId: link.jobId ?? null,
```

`tickets/dto/ticket-response.dto.ts` link mapping: add the same two lines after `linkType`.

`ticket-links/domain/ticket-link.domain.ts` (`TicketLinkDomain`) and `tickets/domain/ticket.domain.ts` (`TicketLink`): add

```ts
  source?: string;
  jobId?: string | null;
```

`ticket-links/prisma-ticket-link.repository.ts` `toDomain`: add `source: m.source, jobId: m.jobId ?? null,`.

`tickets/prisma-tickets.repository.ts`: add `source: string; jobId: string | null;` to `PrismaTicketLinkRow`, and `source: l.source, jobId: l.jobId,` to the `links` mapping (the include is `links: true`, so both columns are already read).

Run: `cd apps/api && bunx jest src/ticket-links src/tickets && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 3: Add the API-level assertion**

In `apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts` add `import request from 'supertest';`, change the helpers import to `import { bootHttpApp, data } from '../../helpers/http-app';`, and append:

```ts
  it('the ticket detail response carries source and jobId on the fleet link', async () => {
    const t = await ticket();
    const job = await jobFor([t.id], 'https://github.com/acme/app/pull/12');
    await effects.upsertPrLinks(job.id);
    const body = data<{ links: Array<{ url: string; source: string; jobId: string | null }> }>(
      await request(app.getHttpServer()).get(`/api/projects/web/tickets/WEB-${t.number}`).set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200),
    );
    expect(body.links).toEqual([expect.objectContaining({ url: 'https://github.com/acme/app/pull/12', source: 'fleet', jobId: job.id })]);
  });
```

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-links.integration.spec.ts`
Expected: PASS.

- [ ] **Step 4: Regenerate the contract**

```bash
bun run generate
git status --short openapi.json apps/cli/src/generated
```

Expected: `openapi.json` and the generated `TicketLinkResponseDto` type gain `source` and `jobId`; nothing else changes. Then:

```bash
cd apps/cli && bunx tsc --noEmit && cd ../..
```

Expected: no type errors (the CLI does not construct link DTOs).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ticket-links apps/api/src/tickets apps/api/test/integration/fleet/fleet-pr-links.integration.spec.ts openapi.json apps/cli/src/generated
git commit -m "feat(api): expose source and jobId on ticket links (C9 slice 1b)"
```

---

### Task 7: Repo-wide verification and PR

**Files:** none new.

- [ ] **Step 1: Repo-wide gates**

```bash
bun run type-check && bun run lint && bun run test
cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet test/integration/vcs && cd ../..
```

Expected: all green. Fix any failure in the task that owns the file, then re-run.

- [ ] **Step 2: Whitespace and contract**

```bash
git diff --check main...HEAD
bun run generate && git diff --exit-code
```

Expected: no output; no diff.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/fleet-c9-slice-1b-pr-links
gh pr create --title "feat(fleet): C9 slice 1b — fleet PR links, PR-state refresher, repo-scoped matching" --body "$(cat <<'EOF'
## What

Fleet C9 slice 1b (spec `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md`, plan `docs/superpowers/plans/2026-10-06-fleet-c9-slice-1b-pr-links.md`): a fleet job's PR shows up on its tickets and its merge moves them to VERIFY_FIX. No migration (schema landed in slice 1a).

## How

- **Repo-scoped VCS matching (D458):** the webhook and the poll match `TicketLink` by the connection's `owner/repo#N`; legacy null-ref rows match by number only when `source = vcs`. A fleet PR on another repo with the same number is no longer touched (regression test).
- **Shared merge step (D457):** `VcsPrSyncService.applyMergedPr` writes `merged` first and transitions only for the writer that won, so poll, webhook and refresher seeing one merge give one VERIFY_FIX and one FIX_REPORT comment.
- **Fleet PR links (D455):** on terminal (any state) and after bundle ingest fills `resultPrUrl`, each linked ticket gets a `pr` link (`source = fleet`, `jobId`); an existing link for the same URL keeps its source and gains `jobId`.
- **Refresher (D456):** `FleetPrStateRefresher` reads PR / MR state through the `koda-fleet` GitHub App (one token per repo per pass) or the project GitLab token, every `FLEET_PR_REFRESH_MS` (default 10 min, min 1 min); 404 -> closed; per-repo and per-link failures are isolated; one pass at a time.
- `TicketLinkResponseDto` gains `source` and `jobId`; contract regenerated.

Slice 2 (web) follows.

## Verification

- type-check, lint, unit tests, fleet + VCS integration suites (PG) green; `bun run generate` clean.
EOF
)"
```

Do not merge; the user reviews the PR.

---

## Self-review notes

- **Spec coverage:** §3.3 -> Task 4 (terminal + ingest); §3.4 -> Tasks 3 and 5; §3.5 -> Task 2 (and Task 5 uses it); §3.6 -> Task 1; slice 1b `TicketLinkResponseDto.source/jobId` -> Task 6; §6 regressions (other-repo fleet link untouched by webhook; VCS + refresher on one merge) -> Task 1 Step 9 and Task 5 Step 7. The live check (§6) runs after slice 2, not here.
- **Not in this slice:** the slice 1a minor (requeue / cancel responses return `tickets: null`) is a slice 2 item, since slice 2 renders `DispatchResultDto`; web, i18n, E2E are slice 2.
