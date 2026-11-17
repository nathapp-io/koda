/**
 * The Prisma client is faked here so this runs without a database: the GitLab remote lookup reads
 * a bounded page of the rows that carry the whole identity, never the whole table (the API data
 * rule).
 */
import type { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { MAX_GITLAB_REMOTE_CANDIDATES, PrismaFleetRepoRepository } from './prisma-fleet-repo.repository';

interface FindManyArgs {
  where: { provider: string; OR: Array<Record<string, unknown>> };
  orderBy: Array<{ createdAt: 'asc' } | { id: 'asc' }>;
  take: number;
}

function build(): { repo: PrismaFleetRepoRepository; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn(async (_args: FindManyArgs) => []);
  const repo = new PrismaFleetRepoRepository({ client: { fleetRepo: { findMany } } } as unknown as PrismaService<PrismaClient>);
  return { repo, findMany };
}

describe('PrismaFleetRepoRepository.findGitLabByRemote', () => {
  it('reads the rows that carry the whole identity, in registration order, within a bound', async () => {
    const { repo, findMany } = build();

    await repo.findGitLabByRemote([{ host: 'https://gitlab.com', owner: 'grp', name: 'app' }]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        provider: 'gitlab',
        OR: [
          {
            host: { equals: 'https://gitlab.com', mode: 'insensitive' },
            owner: { equals: 'grp', mode: 'insensitive' },
            name: { equals: 'app', mode: 'insensitive' },
          },
          {
            host: { equals: 'https://gitlab.com/', mode: 'insensitive' },
            owner: { equals: 'grp', mode: 'insensitive' },
            name: { equals: 'app', mode: 'insensitive' },
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_GITLAB_REMOTE_CANDIDATES,
    });
  });

  it('filters on the identity, so the bound cannot hide a registered repo behind same-named rows', async () => {
    const { repo, findMany } = build();

    await repo.findGitLabByRemote([{ host: 'https://gitlab.com', owner: 'grp', name: 'app' }]);

    const where = findMany.mock.calls[0][0].where;
    // Every branch of the filter names the host, the namespace and the name: the bound applies to
    // the rows that already carry the identity, not to a page of same-named rows.
    expect(where.OR.every((branch) => 'host' in branch && 'owner' in branch && 'name' in branch)).toBe(true);
  });

  it('never leaves the bound off the query', () => {
    expect(MAX_GITLAB_REMOTE_CANDIDATES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_GITLAB_REMOTE_CANDIDATES)).toBe(true);
  });

  it('reads nothing without an identity', async () => {
    const { repo, findMany } = build();

    await expect(repo.findGitLabByRemote([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
