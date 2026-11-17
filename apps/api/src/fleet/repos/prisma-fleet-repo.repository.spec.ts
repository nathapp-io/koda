/**
 * The Prisma client is faked here so this runs without a database: the GitLab name lookup reads a
 * bounded page of the rows that carry the name, never the whole table (the API data rule).
 */
import type { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { MAX_GITLAB_NAME_CANDIDATES, PrismaFleetRepoRepository } from './prisma-fleet-repo.repository';

interface FindManyArgs {
  where: { provider: string; name: { equals: string; mode: string } };
  orderBy: Array<{ createdAt: 'asc' } | { id: 'asc' }>;
  take: number;
}

function build(): { repo: PrismaFleetRepoRepository; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn(async (_args: FindManyArgs) => []);
  const repo = new PrismaFleetRepoRepository({ client: { fleetRepo: { findMany } } } as unknown as PrismaService<PrismaClient>);
  return { repo, findMany };
}

describe('PrismaFleetRepoRepository.findGitLabByName', () => {
  it('reads the GitLab rows with that name, in registration order, within a bound', async () => {
    const { repo, findMany } = build();

    await repo.findGitLabByName('app');

    expect(findMany).toHaveBeenCalledWith({
      where: { provider: 'gitlab', name: { equals: 'app', mode: 'insensitive' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_GITLAB_NAME_CANDIDATES,
    });
  });

  it('never leaves the bound off the query', () => {
    expect(MAX_GITLAB_NAME_CANDIDATES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_GITLAB_NAME_CANDIDATES)).toBe(true);
  });
});
