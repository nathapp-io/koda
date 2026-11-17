import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { MAX_GITLAB_REMOTE_CANDIDATES } from '../../../src/fleet/repos/prisma-fleet-repo.repository';
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
    await db.fleetRepo.deleteMany({ where: { defaultBranch: 'false-match' } });
  });

  /**
   * Rows registered before any exact identity, whose owner an ILIKE reading of `grp_one` accepts —
   * `_` matches any single character — but the canonical identity does not. `defaultBranch` marks
   * them so `afterEach` can drop them.
   */
  const seedWildcardOnlyRows = async (count: number) => {
    await db.fleetRepo.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        projectId: base.projectId,
        provider: 'gitlab',
        owner: `grp${String.fromCharCode(0x4e00 + index)}one`,
        name: 'app',
        defaultBranch: 'false-match',
        githubInstallationId: null,
        host: 'https://gitlab.example.com',
        createdById: base.adminId,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
    });
  };

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

  it('does not read the underscore of a namespace as a LIKE wildcard', async () => {
    await createRepo('gitlab', 'grpXone', 'app', 'https://gitlab.example.com');

    expect(await app.get(FleetReposService).findGitLabByRemoteUrl('https://gitlab.example.com/grp_one/app')).toBeNull();
  });

  it('answers with the exact underscore identity, not a wildcard-only row registered earlier', async () => {
    await seedWildcardOnlyRows(1);
    const exact = await createRepo('gitlab', 'grp_one', 'app', 'https://gitlab.example.com');

    const resolved = await app.get(FleetReposService).findGitLabByRemoteUrl('https://gitlab.example.com/grp_one/app');

    expect(resolved?.id).toBe(exact.id);
  });

  it('answers with the exact identity when wildcard-only rows alone fill the lookup bound', async () => {
    await seedWildcardOnlyRows(MAX_GITLAB_REMOTE_CANDIDATES + 1);
    // The premise: the ILIKE reading accepts more rows than the lookup may read, so a filter that
    // only post-filters a bounded page can never reach the registered repo.
    const wildcardOnly = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM "FleetRepo" WHERE "provider" = 'gitlab' AND "owner" ILIKE ${'grp_one'}`;
    expect(Number(wildcardOnly[0].count)).toBeGreaterThan(MAX_GITLAB_REMOTE_CANDIDATES);
    const exact = await createRepo('gitlab', 'grp_one', 'app', 'https://gitlab.example.com');

    const resolved = await app.get(FleetReposService).findGitLabByRemoteUrl('https://gitlab.example.com/grp_one/app');

    expect(resolved?.id).toBe(exact.id);
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
