import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';

/**
 * US-003 AC-5: `findProjectRepos` returns the project's repositories in the anchor order (`createdAt` ascending, ties
 * by `id` ascending), scoped to one project and capped at `PROJECT_CODE_LIMITS.maxRepos + maxUnavailable` (60) rows.
 * A Prisma-shaped stub stands in for the database: the query it receives is what scopes, orders and caps the rows.
 */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, projectId: 'p1', provider: 'github', owner: 'acme', name: id, defaultBranch: 'main',
  githubInstallationId: 7n, createdAt: new Date(0), ...over,
});

function repoWith(rows: ReturnType<typeof row>[]) {
  // The stub applies the query's `select`, like Prisma does, so a column the query does not ask for never reaches the mapping.
  const fleetRepo = {
    findMany: vi.fn(async (args: { select: Record<string, boolean> }) =>
      rows.map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, (r as Record<string, unknown>)[k]])))),
  };
  const repo = new PrismaFleetJobRepository({ client: { fleetRepo } } as never);
  return { repo, fleetRepo };
}

describe('PrismaFleetJobRepository.findProjectRepos (US-003 AC-5)', () => {
  it('AC-5: asks for one project, oldest createdAt first (ties by id) and at most 60 rows', async () => {
    const rows = [row('a'), row('b')];
    const { repo, fleetRepo } = repoWith(rows);

    await repo.findProjectRepos('p1');

    expect(fleetRepo.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'p1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 60,
    }));
  });

  it('AC-5: returns the rows in the queried order, mapped to FleetRepoRef', async () => {
    const { repo } = repoWith([row('oldest'), row('middle'), row('newest')]);

    const result = await repo.findProjectRepos('p1');

    expect(result.map((r) => r.id)).toEqual(['oldest', 'middle', 'newest']);
    expect(result[0]).toEqual({
      id: 'oldest', projectId: 'p1', provider: 'github', owner: 'acme', name: 'oldest', defaultBranch: 'main',
      githubInstallationId: 7n,
    });
  });

  it('AC-5: never selects another project: the project id is the only scope of the query', async () => {
    const { repo, fleetRepo } = repoWith([]);

    await repo.findProjectRepos('p2');

    const [args] = fleetRepo.findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(args.where).toEqual({ projectId: 'p2' });
    expect(Object.keys(args.where)).toEqual(['projectId']);
  });

  it('selects exactly the FleetRepoRef columns, without the audit columns', async () => {
    const { repo, fleetRepo } = repoWith([]);

    await repo.findProjectRepos('p1');

    expect(fleetRepo.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, projectId: true, provider: true, owner: true, name: true, defaultBranch: true, githubInstallationId: true },
    }));
  });

  it('keeps a GitLab repository and a null installation as they are stored', async () => {
    const { repo } = repoWith([row('gl', { provider: 'gitlab', githubInstallationId: null })]);

    const [first] = await repo.findProjectRepos('p1');

    expect(first).toMatchObject({ provider: 'gitlab', githubInstallationId: null });
  });
});
