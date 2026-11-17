/**
 * The Prisma client is faked here so this runs without a database: the GitLab remote lookup reads
 * a bounded page of the rows that carry the whole identity, never the whole table (the API data
 * rule), and it matches that identity literally — `LOWER(a) = LOWER(b)`, never `ILIKE`, where the
 * `_` of a namespace such as `grp_one` would also match `grpXone`.
 */
import type { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { MAX_GITLAB_REMOTE_CANDIDATES, PrismaFleetRepoRepository } from './prisma-fleet-repo.repository';

/** A rendered `Prisma.Sql`: the SQL fragments and the parameters that sit between them. */
interface SqlLike {
  strings: readonly string[];
  values: readonly unknown[];
}

function build(ids: Array<{ id: string }> = [], rows: Record<string, unknown>[] = []): {
  repo: PrismaFleetRepoRepository;
  queryRaw: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi.fn(async (_query: SqlLike) => ids);
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const repo = new PrismaFleetRepoRepository({ client: { $queryRaw: queryRaw, fleetRepo: { findMany } } } as unknown as PrismaService<PrismaClient>);
  return { repo, queryRaw, findMany };
}

/** The rendered SQL with every parameter replaced by a placeholder. */
const sqlText = (query: SqlLike): string => query.strings.join('?');

/** A stored repo row as the hydration read answers it (only what `toDomain` reads matters). */
function repoRow(id: string): Record<string, unknown> {
  return {
    id, projectId: 'p1', provider: 'gitlab', owner: 'grp', name: 'app', host: 'https://gitlab.com',
    defaultBranch: 'main', createdById: 'u1', createdAt: new Date('2026-01-01T00:00:00.000Z'),
    autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: 1, autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, fixTrustDetectedChecks: false,
    fixAllowUnprotected: false, ruleOverride: null, gitlabCredential: null,
  };
}

describe('PrismaFleetRepoRepository.findGitLabByRemote', () => {
  it('matches the whole identity with literal case-insensitive equality, in registration order and within a bound', async () => {
    const { repo, queryRaw } = build();

    await repo.findGitLabByRemote([{ host: 'https://gitlab.com', owner: 'grp', name: 'app' }]);

    const query = queryRaw.mock.calls[0][0] as SqlLike;
    const text = sqlText(query);
    expect(text).toContain('SELECT "id" FROM "FleetRepo"');
    expect(text).toContain('"provider" = \'gitlab\'');
    expect(text).toContain('ORDER BY "createdAt" ASC, "id" ASC');
    expect(text).toContain('LIMIT ?');
    // Every column compares through LOWER on both sides: a `_` or `%` in a stored or requested
    // identity stays a character, which ILIKE would read as a wildcard.
    expect(text).not.toContain('ILIKE');
    for (const column of ['host', 'owner', 'name']) {
      expect(text.match(new RegExp(`LOWER\\("${column}"\\) = LOWER\\(`, 'g'))).toHaveLength(2);
    }
    // The values carry the identity (and its trailing-slash host variant) and the bound, never a
    // wildcard pattern.
    expect(query.values).toEqual(['https://gitlab.com', 'grp', 'app', 'https://gitlab.com/', 'grp', 'app', MAX_GITLAB_REMOTE_CANDIDATES]);
  });

  it('hydrates the rows in the filter\'s order, not the order the hydration read answers', async () => {
    const { repo, findMany } = build([{ id: 'b' }, { id: 'a' }], [repoRow('a'), repoRow('b')]);

    const found = await repo.findGitLabByRemote([{ host: 'https://gitlab.com', owner: 'grp', name: 'app' }]);

    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ['b', 'a'] } }, take: MAX_GITLAB_REMOTE_CANDIDATES });
    expect(found.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('keeps a positive, finite bound on the read', () => {
    expect(MAX_GITLAB_REMOTE_CANDIDATES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_GITLAB_REMOTE_CANDIDATES)).toBe(true);
  });

  it('reads nothing without an identity', async () => {
    const { repo, queryRaw } = build();

    await expect(repo.findGitLabByRemote([])).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
