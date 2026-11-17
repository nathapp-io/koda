import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FleetReposService } from '../../../src/fleet/repos/fleet-repos.service';
import { afterEach } from 'vitest';
import { canRunDbTests } from '../../helpers/test-environment';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('GitLab remote repo lookup (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let createdRepoIds: string[] = [];

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    base = await seedFleetBase(db);
  });
  afterAll(async () => { await app?.close(); });
  afterEach(async () => {
    if (createdRepoIds.length > 0) await db.fleetRepo.deleteMany({ where: { id: { in: createdRepoIds } } });
    createdRepoIds = [];
    await db.fleetRepo.deleteMany({ where: { owner: { startsWith: 'flood-' } } });
  });

  const createRepo = async (provider: 'github' | 'gitlab', owner: string, name: string, host?: string) => {
    const repo = await db.fleetRepo.create({
      data: {
        projectId: base.projectId,
        provider,
        owner,
        name,
        defaultBranch: 'main',
        githubInstallationId: provider === 'github' ? BigInt(1) : null,
        ...(host === undefined ? {} : { host }),
        createdById: base.adminId,
      },
    });
    createdRepoIds.push(repo.id);
    return repo;
  };

  it('AC-9 resolves the case-insensitive identity on the exact host, not another host', async () => {
    const exact = await createRepo('gitlab', 'Grp/Sub', 'App', 'https://gitlab.example.com');
    await createRepo('gitlab', 'Grp/Sub', 'App', 'https://gitlab.com');
    const resolved = await app.get(FleetReposService).findGitLabByRemoteUrl('https://gitlab.example.com/grp/sub/app');
    expect(resolved?.id).toBe(exact.id);
  });

  it('AC-10 matches a registered host path prefix', async () => {
    const repo = await createRepo('gitlab', 'grp', 'app', 'https://example.com/gitlab');
    const resolved = await app.get(FleetReposService).findGitLabByRemoteUrl('https://example.com/gitlab/grp/app');
    expect(resolved?.id).toBe(repo.id);
  });

  it('AC-11 does not match a remote outside the registered host path prefix', async () => {
    await createRepo('gitlab', 'grp', 'app', 'https://example.com/gitlab');
    expect(await app.get(FleetReposService).findGitLabByRemoteUrl('https://example.com/grp/app')).toBeNull();
  });

  it('AC-12 does not resolve a GitHub repo as a GitLab remote', async () => {
    await createRepo('github', 'grp', 'app', 'https://github.example.com');
    expect(await app.get(FleetReposService).findGitLabByRemoteUrl('https://github.example.com/grp/app')).toBeNull();
  });

  it('resolves a registered repo that follows more than 500 same-named rows', async () => {
    // 501 rows carry the same name on the same host, registered before the repo the remote names:
    // a lookup that reads a bounded page of same-named rows and matches the URL afterwards never
    // reaches the registered row, and the flow entry answers 404 for a repo that is registered.
    const registeredAt = new Date('2026-01-01T00:00:00.000Z');
    await db.fleetRepo.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        projectId: base.projectId,
        provider: 'gitlab',
        owner: `flood-${index}`,
        name: 'app',
        defaultBranch: 'main',
        githubInstallationId: null,
        host: 'https://gitlab.example.com',
        createdById: base.adminId,
        createdAt: registeredAt,
      })),
    });
    const target = await createRepo('gitlab', 'grp', 'app', 'https://gitlab.example.com');

    const resolved = await app.get(FleetReposService).findGitLabByRemoteUrl('https://gitlab.example.com/grp/app');

    expect(resolved?.id).toBe(target.id);
  });
});
