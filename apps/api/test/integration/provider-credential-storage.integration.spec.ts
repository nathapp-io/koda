import { ConfigService } from '@nestjs/config';
import type { NathApplication } from '@nathapp/nestjs-app';
import request from 'supertest';
import { bootHttpApp } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { createTestPrismaClient } from '../helpers/test-prisma';
import { canRunDbTests } from '../helpers/test-environment';
import type { PrismaClient } from '../../src/generated/prisma/client';
import {
  IProviderCredentialsConfig,
  PROVIDER_CREDENTIALS_CFG,
} from '../../src/config/provider-credentials.config';
import { LocalSecretStore } from '../../src/fleet/provider-credentials/secret-store';

// The nax sandbox withholds host Postgres; DB behaviour is verified on the host quality run.
const describeDb = canRunDbTests() ? describe : describe.skip;

const ENCRYPTION_KEY_ENV = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';

describeDb('provider credential storage (PG)', () => {
  let prisma: PrismaClient;
  let projectId: string;

  const credentialData = (overrides: Record<string, unknown> = {}) => ({
    scope: 'GLOBAL',
    scopeKey: 'global',
    providerId: 'openrouter',
    name: 'fleet',
    encryptedKey: '00:00:00',
    last4: '3456',
    fingerprint: '0123456789ab',
    createdById: 'user-1',
    updatedById: 'user-1',
    ...overrides,
  });

  beforeAll(async () => {
    await resetDb();
    prisma = createTestPrismaClient();
    const project = await prisma.project.create({
      data: { name: 'Vault', slug: 'vault-storage', key: 'VST' },
    });
    projectId = project.id;
  }, 60000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    await prisma?.providerCredentialIssue.deleteMany();
    await prisma?.providerCredential.deleteMany();
  });

  it('AC-10: two rows with the same scopeKey and providerId collide with P2002', async () => {
    await prisma.providerCredential.create({ data: credentialData() });

    await expect(prisma.providerCredential.create({ data: credentialData({ name: 'second' }) }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.providerCredential.count()).toBe(1);
  });

  it('AC-11: a GLOBAL row and a PROJECT row for the same providerId coexist', async () => {
    await prisma.providerCredential.create({ data: credentialData() });
    await prisma.providerCredential.create({
      data: credentialData({
        scope: 'PROJECT',
        scopeKey: `project:${projectId}`,
        projectId,
        name: 'project key',
      }),
    });

    const scopes = await prisma.providerCredential.findMany({
      where: { providerId: 'openrouter' },
      select: { scope: true, scopeKey: true },
      orderBy: { scopeKey: 'asc' },
    });
    expect(scopes).toEqual([
      { scope: 'GLOBAL', scopeKey: 'global' },
      { scope: 'PROJECT', scopeKey: `project:${projectId}` },
    ]);
  });

  it('AC-11: the same providerId under two different projects also coexists', async () => {
    const other = await prisma.project.create({
      data: { name: 'Vault two', slug: 'vault-storage-two', key: 'VS2' },
    });

    await prisma.providerCredential.create({
      data: credentialData({ scope: 'PROJECT', scopeKey: `project:${projectId}`, projectId }),
    });
    await prisma.providerCredential.create({
      data: credentialData({ scope: 'PROJECT', scopeKey: `project:${other.id}`, projectId: other.id }),
    });

    expect(await prisma.providerCredential.count({ where: { providerId: 'openrouter' } })).toBe(2);
  });

  it('AC-12: two issues with the same jobId, credentialId and fingerprint collide with P2002', async () => {
    const issue = { jobId: 'job-1', credentialId: 'cred-1', fingerprint: '0123456789ab' };
    await prisma.providerCredentialIssue.create({ data: issue });

    await expect(prisma.providerCredentialIssue.create({ data: issue }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.providerCredentialIssue.count()).toBe(1);
  });

  it('AC-12: a different fingerprint for the same job and credential is a new issue row', async () => {
    await prisma.providerCredentialIssue.create({
      data: { jobId: 'job-1', credentialId: 'cred-1', fingerprint: '0123456789ab' },
    });
    await prisma.providerCredentialIssue.create({
      data: { jobId: 'job-1', credentialId: 'cred-1', fingerprint: 'ffffffffffff' },
    });

    expect(await prisma.providerCredentialIssue.count()).toBe(2);
  });

  it('AC-14: the API boots with the vault disabled when the master key is unset', async () => {
    const saved = process.env[ENCRYPTION_KEY_ENV];
    delete process.env[ENCRYPTION_KEY_ENV];
    let app: NathApplication | undefined;
    try {
      app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });

      const config = app.get(ConfigService).get<IProviderCredentialsConfig>(PROVIDER_CREDENTIALS_CFG);
      expect(config?.encryptionKey).toBeUndefined();

      // The vault module is part of the booted graph, and its secret store answers "off"
      // rather than pretending to seal. `strict: false` reaches into the module that owns it.
      const store = app.get(LocalSecretStore, { strict: false });
      expect(store).toBeInstanceOf(LocalSecretStore);
      expect(() => store.seal('sk-test-abcdef123456')).toThrow(/not configured/i);

      await request(app.getHttpServer()).get('/api/health').expect(200);
    } finally {
      if (saved === undefined) delete process.env[ENCRYPTION_KEY_ENV];
      else process.env[ENCRYPTION_KEY_ENV] = saved;
      await app?.close();
    }
  }, 60000);
});
