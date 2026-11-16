import { randomUUID } from 'node:crypto';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { PrismaFleetRepoRepository } from '../../../src/fleet/repos/prisma-fleet-repo.repository';
import { GitLabRepoCredentials } from '../../../src/fleet/git-broker/gitlab-repo-credentials';
import { RepoCheckException } from '../../../src/fleet/git-broker/repo-check.exception';
import { decryptToken } from '../../../src/common/utils/encryption.util';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';

/**
 * The per-repo GitLab connection (GitLab parity F1, US-001): the `FleetRepo` host and the
 * credential row behind it, plus the projection the repo row carries without its secrets.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-repo-gitlab-credentials.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENC_KEY = 'c'.repeat(64);
const MIGRATION = '20261216090000_fleet_repo_gitlab_credentials';

describeIntegration('fleet repo GitLab credentials (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repos: PrismaFleetRepoRepository;
  let credentials: GitLabRepoCredentials;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const project = async () => {
    const id = ++seq;
    return prisma.project.create({ data: { name: `gitlab ${id}`, slug: `gitlab-${id}`, key: `GL${id}` } });
  };

  /** A repo row; `host` is left out when the case does not name one, so the column default applies. */
  const repo = async (
    projectId: string,
    over: { provider?: string; owner?: string; name?: string; host?: string } = {},
  ) => prisma.fleetRepo.create({
    data: {
      projectId,
      provider: over.provider ?? 'gitlab',
      owner: over.owner ?? 'acme',
      name: over.name ?? `app-${++seq}`,
      defaultBranch: 'main',
      createdById: 'actor',
      ...(over.host === undefined ? {} : { host: over.host }),
    },
  });

  const fullInput = () => ({
    gitlabProjectId: 4711,
    read: { token: 'glpat-read', userId: 11, username: 'koda-read', expiresAt: new Date('2027-01-01T00:00:00.000Z') },
    write: { token: 'glpat-write', userId: 12, username: 'koda-bot', expiresAt: null, isBot: true },
  });

  beforeAll(async () => {
    saved['VCS_ENCRYPTION_KEY'] = process.env['VCS_ENCRYPTION_KEY'];
    process.env['VCS_ENCRYPTION_KEY'] = ENC_KEY;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    repos = asTestActor(app.get(PrismaFleetRepoRepository, { strict: false }), { type: 'SYSTEM', id: 'seed' });
    credentials = asTestActor(app.get(GitLabRepoCredentials, { strict: false }), { type: 'SYSTEM', id: 'seed' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (saved['VCS_ENCRYPTION_KEY'] === undefined) delete process.env['VCS_ENCRYPTION_KEY'];
    else process.env['VCS_ENCRYPTION_KEY'] = saved['VCS_ENCRYPTION_KEY'];
  });

  it('AC-1: a credential row belongs to its repo and is deleted with it', async () => {
    const p = await project();
    const r = await repo(p.id, { name: 'cascade' });
    await prisma.fleetRepoGitlabCredential.create({
      data: {
        repoId: r.id, gitlabProjectId: 7, encryptedReadToken: 'enc-read', encryptedWriteToken: 'enc-write',
        readTokenUserId: 1, readTokenUsername: 'reader', writeTokenUserId: 2, writeTokenUsername: 'writer', writeTokenIsBot: true,
      },
    });
    expect(await prisma.fleetRepoGitlabCredential.count({ where: { repoId: r.id } })).toBe(1);

    await prisma.fleetRepo.delete({ where: { id: r.id } });
    expect(await prisma.fleetRepoGitlabCredential.count({ where: { repoId: r.id } })).toBe(0);
  });

  it('AC-2: the same owner and name on two hosts are two repos', async () => {
    const p = await project();
    const onGitlab = await repo(p.id, { owner: 'acme', name: 'shared', host: 'https://gitlab.com' });
    const onSelfHosted = await repo(p.id, { owner: 'acme', name: 'shared', host: 'https://gitlab.example.com' });

    expect(onSelfHosted.id).not.toBe(onGitlab.id);
    expect(await prisma.fleetRepo.count({ where: { owner: 'acme', name: 'shared' } })).toBe(2);
  });

  it('AC-3: the same provider, host, owner and name is refused with P2002', async () => {
    const p = await project();
    await repo(p.id, { owner: 'acme', name: 'duplicate', host: 'https://gitlab.com' });

    await expect(repo(p.id, { owner: 'acme', name: 'duplicate', host: 'https://gitlab.com' }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('AC-4: a repo created without a host reads back as github.com', async () => {
    const p = await project();
    const r = await repo(p.id, { provider: 'github', name: 'no-host' });

    const row = await prisma.fleetRepo.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.host).toBe('https://github.com');
  });

  it('AC-14: the repo row carries the credential health and none of its secrets', async () => {
    const p = await project();
    const r = await repo(p.id, { name: 'projection', host: 'https://gitlab.example.com' });
    await prisma.fleetRepoGitlabCredential.create({
      data: {
        repoId: r.id, gitlabProjectId: 99, encryptedReadToken: 'enc-read', encryptedWriteToken: 'enc-write',
        readTokenUserId: 1, readTokenUsername: 'reader', writeTokenUserId: 2, writeTokenUsername: 'writer',
        writeTokenIsBot: false, readTokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'), writeTokenExpiresAt: null,
      },
    });

    const row = await repos.findById(r.id);
    expect(row?.gitlabCredential).toEqual({
      gitlabProjectId: 99,
      readTokenUsername: 'reader',
      writeTokenUsername: 'writer',
      writeTokenIsBot: false,
      readTokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      writeTokenExpiresAt: null,
      readTokenInvalidAt: null,
      writeTokenInvalidAt: null,
    });
    expect(row?.gitlabCredential).not.toHaveProperty('encryptedReadToken');
    expect(row?.gitlabCredential).not.toHaveProperty('encryptedWriteToken');
    expect(row?.host).toBe('https://gitlab.example.com');
  });

  it('a repo without a credential record carries no credential view', async () => {
    const p = await project();
    const r = await repo(p.id, { name: 'no-credential' });

    expect((await repos.findById(r.id))?.gitlabCredential).toBeNull();
  });

  it('the store writes ciphertext and resolves the stored token against the repo host', async () => {
    const p = await project();
    const r = await repo(p.id, { name: 'stored', host: 'https://gitlab.example.com' });

    await credentials.save(r.id, fullInput());

    const row = await prisma.fleetRepoGitlabCredential.findUniqueOrThrow({ where: { repoId: r.id } });
    expect(row.encryptedReadToken).not.toBe('glpat-read');
    expect(row.encryptedWriteToken).not.toBe('glpat-write');
    expect(decryptToken(row.encryptedReadToken, ENC_KEY)).toBe('glpat-read');
    expect(decryptToken(row.encryptedWriteToken, ENC_KEY)).toBe('glpat-write');
    expect(row.readTokenInvalidAt).toBeNull();
    expect(row.writeTokenInvalidAt).toBeNull();

    await expect(credentials.resolve({ id: r.id, host: 'https://gitlab.example.com' }, 'write')).resolves.toEqual({
      token: 'glpat-write',
      target: { apiBase: 'https://gitlab.example.com/api/v4', projectId: 4711 },
    });
  });

  it('a refused call marks that token invalid in the database and nothing else', async () => {
    const p = await project();
    const r = await repo(p.id, { name: 'invalid', host: 'https://gitlab.com' });
    await credentials.save(r.id, fullInput());

    await expect(credentials.call({ id: r.id, host: 'https://gitlab.com' }, 'read', async () => {
      throw new RepoCheckException('gitlab_token_invalid');
    })).rejects.toMatchObject({ reason: 'gitlab_token_invalid' });

    const row = await prisma.fleetRepoGitlabCredential.findUniqueOrThrow({ where: { repoId: r.id } });
    expect(row.readTokenInvalidAt).toBeInstanceOf(Date);
    expect(row.writeTokenInvalidAt).toBeNull();
  });

  it('a save that replaces only the write token keeps the read token and its invalid mark', async () => {
    const p = await project();
    const r = await repo(p.id, { name: 'rotation', host: 'https://gitlab.com' });
    await credentials.save(r.id, fullInput());
    await credentials.markInvalid(r.id, 'read');
    await credentials.markInvalid(r.id, 'write');

    await credentials.save(r.id, {
      gitlabProjectId: 4711,
      write: { token: 'glpat-write-2', userId: 12, username: 'koda-bot', expiresAt: null, isBot: true },
    });

    const row = await prisma.fleetRepoGitlabCredential.findUniqueOrThrow({ where: { repoId: r.id } });
    expect(row.writeTokenInvalidAt).toBeNull();
    expect(row.readTokenInvalidAt).toBeInstanceOf(Date);
    expect(decryptToken(row.encryptedReadToken, ENC_KEY)).toBe('glpat-read');
    expect(decryptToken(row.encryptedWriteToken, ENC_KEY)).toBe('glpat-write-2');
  });
});

describeIntegration('the fleet repo GitLab credential migration (PG)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('Test database URL missing');
    scratch = await scratchSchemaBefore(url, `gitlab_cred_${randomUUID().replaceAll('-', '')}`, MIGRATION);
  }, 180_000);

  afterAll(async () => { await scratch?.drop(); });

  it('moves the GitLab rows to gitlab.com, keeps the GitHub rows and creates no credential row', async () => {
    const id = randomUUID();
    const projectId = `project-${id}`;
    // The rows are written with the columns the schema had before the migration.
    await scratch.db.$executeRaw`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES (${projectId}, ${projectId}, ${`slug-${id}`}, ${`key-${id}`}, now())`;
    await scratch.db.$executeRaw`INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById") VALUES (${`gitlab-${id}`}, ${projectId}, 'gitlab', 'acme', ${`repo-${id}`}, 'main', 'creator')`;
    await scratch.db.$executeRaw`INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById") VALUES (${`github-${id}`}, ${projectId}, 'github', 'acme', ${`repo-${id}`}, 'main', 'creator')`;

    await applyMigration(scratch.db, MIGRATION);

    const rows = await scratch.db.$queryRaw<Array<{ id: string; host: string }>>`
      SELECT "id", "host" FROM "FleetRepo" ORDER BY "id"`;
    expect(rows).toEqual([
      { id: `github-${id}`, host: 'https://github.com' },
      { id: `gitlab-${id}`, host: 'https://gitlab.com' },
    ]);
    const credentials = await scratch.db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM "FleetRepoGitlabCredential"`;
    expect(Number(credentials[0]?.count)).toBe(0);
  });
});
