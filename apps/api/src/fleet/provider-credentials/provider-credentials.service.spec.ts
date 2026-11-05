import { Logger } from '@nestjs/common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { Prisma } from '../../generated/prisma/client';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import type { FleetActivityService } from '../activity/fleet-activity.service';
import type { IProviderCredentialRepository, ProviderCredential } from './provider-credential.domain';
import { ProviderCredentialsService } from './provider-credentials.service';
import type { IProviderCredentialsConfig } from '../../config/provider-credentials.config';
import { LocalSecretStore, type SecretStore } from './secret-store';

const makeCredential = (overrides: Partial<ProviderCredential> = {}): ProviderCredential => ({
  id: 'cred-1', scope: 'PROJECT', scopeKey: 'project:p1', projectId: 'p1', repoId: null,
  providerId: 'openrouter', name: 'primary', encryptedKey: 'ciphertext-secret', last4: '1234',
  fingerprint: 'fingerprint', createdById: 'user-1', updatedById: 'user-1', disabledAt: null,
  createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
});

function setup(enabled = true) {
  const repository: IProviderCredentialRepository = {
    findById: vi.fn().mockResolvedValue(null),
    findActiveCandidates: vi.fn().mockResolvedValue([]),
    findRepoProject: vi.fn().mockResolvedValue(null),
    lockById: vi.fn().mockResolvedValue(null),
    listGlobal: vi.fn(), listForProject: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), recordIssue: vi.fn(),
  };
  const secretStore: SecretStore = {
    seal: vi.fn((plaintext: string) => ({ encryptedKey: `sealed:${plaintext}`, last4: plaintext.slice(-4), fingerprint: `fp:${plaintext}` })),
    open: vi.fn((ciphertext: string) => ciphertext.replace('sealed:', '')),
  };
  const config: IProviderCredentialsConfig = { encryptionKey: enabled ? '0123456789abcdef'.repeat(4) : undefined };
  // The management writes (C10 US-003) record activity and audit in the mutation transaction; a no-op
  // transaction and a recording spy keep these unit tests behaviour-only.
  const activity = { record: vi.fn().mockResolvedValue(undefined), list: vi.fn() } as unknown as FleetActivityService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditRecorder;
  const txManager: ITransactionManager = {
    run: <T>(fn: () => Promise<T>) => fn(), getClient: () => undefined, isInTransaction: () => true,
  };
  const service = new ProviderCredentialsService(repository, secretStore, config, activity, txManager, audit);
  return { service, repository, secretStore, config, activity, audit };
}

describe('ProviderCredentialsService', () => {
  it('AC-1: is disabled when the encryption key is unset', () => {
    expect(setup(false).service.isEnabled()).toBe(false);
  });

  it('AC-2: resolves the active most-specific REPO credential', async () => {
    const { service, repository } = setup();
    const repo = makeCredential({ id: 'repo', scope: 'REPO', repoId: 'r1' });
    const project = makeCredential({ id: 'project' });
    const global = makeCredential({ id: 'global', scope: 'GLOBAL', projectId: null, scopeKey: 'global' });
    vi.mocked(repository.findActiveCandidates).mockResolvedValue([global, project, repo]);
    await expect(service.resolve({ projectId: 'p1', repoId: 'r1', providerId: 'openrouter' })).resolves.toEqual(repo);
  });

  it('AC-3: falls through a disabled REPO credential to PROJECT', async () => {
    const { service, repository } = setup();
    const project = makeCredential({ id: 'project' });
    vi.mocked(repository.findActiveCandidates).mockResolvedValue([
      makeCredential({ id: 'repo-disabled', scope: 'REPO', repoId: 'r1', disabledAt: new Date() }),
      project,
    ]);
    await expect(service.resolve({ projectId: 'p1', repoId: 'r1', providerId: 'openrouter' })).resolves.toEqual(project);
  });

  it('AC-4: resolves GLOBAL when no project credential applies', async () => {
    const { service, repository } = setup();
    const global = makeCredential({ id: 'global', scope: 'GLOBAL', scopeKey: 'global', projectId: null });
    vi.mocked(repository.findActiveCandidates).mockResolvedValue([global]);
    await expect(service.resolve({ projectId: 'p1', repoId: null, providerId: 'openrouter' })).resolves.toEqual(global);
  });

  it('AC-5: does not resolve another project credential', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findActiveCandidates).mockResolvedValue([
      makeCredential({ id: 'other-project', projectId: 'p2', scopeKey: 'project:p2' }),
    ]);
    await expect(service.resolve({ projectId: 'p1', repoId: null, providerId: 'openrouter' })).resolves.toBeNull();
  });

  it('AC-6: does not resolve disabled global credentials', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findActiveCandidates).mockResolvedValue([
      makeCredential({ id: 'disabled-global', scope: 'GLOBAL', scopeKey: 'global', projectId: null, disabledAt: new Date() }),
    ]);
    await expect(service.resolve({ projectId: 'p1', repoId: null, providerId: 'openrouter' })).resolves.toBeNull();
  });

  it('AC-7: resolve returns null and avoids repository access when disabled', async () => {
    const { service, repository } = setup(false);
    await expect(service.resolve({ projectId: 'p1', repoId: 'r1', providerId: 'openrouter' })).resolves.toBeNull();
    expect(repository.findActiveCandidates).not.toHaveBeenCalled();
  });

  it('AC-8: decrypts a credential sealed by LocalSecretStore for hand-out', () => {
    const { repository, config, activity, audit } = setup();
    const store = new LocalSecretStore(config);
    const plaintext = 'sk-test-abcdef123456';
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>) => fn(), getClient: () => undefined, isInTransaction: () => true,
    };
    const service = new ProviderCredentialsService(repository, store, config, activity, txManager, audit);
    const credential = makeCredential({ encryptedKey: store.seal(plaintext).encryptedKey });
    expect(service.issueKey(credential)).toBe(plaintext);
  });

  it('AC-9: returns null when decryption fails', async () => {
    const { service, secretStore } = setup();
    vi.mocked(secretStore.open).mockImplementation(() => { throw new Error('sensitive crypto details'); });
    expect(service.issueKey(makeCredential())).toBeNull();
  });

  it('AC-10: logs only the credential id when decryption fails', async () => {
    const { service, secretStore } = setup();
    vi.mocked(secretStore.open).mockImplementation(() => { throw new Error('sensitive crypto details'); });
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await service.issueKey(makeCredential());
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('cred-1'));
    expect(warning.mock.calls.flat().join(' ')).not.toContain('ciphertext-secret');
    expect(warning.mock.calls.flat().join(' ')).not.toContain('sensitive crypto details');
  });

  it('AC-11: rejects a short key with a key validation field', async () => {
    const { service, repository } = setup();
    await expect(service.create({ scope: 'GLOBAL', providerId: 'openrouter', name: 'primary', key: 'short', createdById: 'u1' })).rejects.toMatchObject({ args: { key: expect.any(String) } });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('AC-12: rejects whitespace in a key with a key validation field', async () => {
    const { service, repository } = setup();
    await expect(service.create({ scope: 'GLOBAL', providerId: 'openrouter', name: 'primary', key: '123456789012345 ' , createdById: 'u1' })).rejects.toMatchObject({ args: { key: expect.any(String) } });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('AC-13: maps a P2002 insert error to the credential duplicate conflict', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.insert).mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['scopeKey', 'providerId'] },
    }));
    await expect(service.create({ scope: 'GLOBAL', providerId: 'openrouter', name: 'primary', key: '0123456789abcdef', createdById: 'u1' })).rejects.toMatchObject({ prefix: 'fleet.providerCredentials.duplicate', httpStatus: 409 });
  });

  it('AC-14: create refuses when the vault is off', async () => {
    const { service, repository } = setup(false);
    await expect(service.create({ scope: 'GLOBAL', providerId: 'openrouter', name: 'primary', key: '0123456789abcdef', createdById: 'u1' })).rejects.toMatchObject({ prefix: 'fleet.providerCredentials.vaultOff', httpStatus: 503 });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('keeps the existing fingerprint on a name-only update and rotates it when key changes', async () => {
    const { service, repository, secretStore } = setup();
    const current = makeCredential();
    vi.mocked(repository.findById).mockResolvedValue(current);
    vi.mocked(repository.patch).mockImplementation(async (_id, patch) => ({ ...current, ...patch }));
    await service.update(current.id, { name: 'renamed', updatedById: 'u2' });
    expect(repository.patch).toHaveBeenLastCalledWith(current.id, { name: 'renamed', updatedById: 'u2' });
    expect(secretStore.seal).not.toHaveBeenCalled();

    await service.update(current.id, { key: '0123456789abcdef', updatedById: 'u2' });
    expect(repository.patch).toHaveBeenLastCalledWith(current.id, {
      encryptedKey: 'sealed:0123456789abcdef', last4: 'cdef', fingerprint: 'fp:0123456789abcdef', updatedById: 'u2',
    });
  });

  it('supports independent disabled state updates and removal', async () => {
    const { service, repository } = setup();
    const current = makeCredential();
    vi.mocked(repository.findById).mockResolvedValue(current);
    vi.mocked(repository.patch).mockImplementation(async (_id, patch) => ({ ...current, ...patch }));
    await service.update(current.id, { disabled: true, updatedById: 'u2' });
    const disabledAt = vi.mocked(repository.patch).mock.calls[0]?.[1].disabledAt;
    expect(disabledAt).toBeInstanceOf(Date);
    await service.update(current.id, { disabled: false, updatedById: 'u2' });
    expect(repository.patch).toHaveBeenLastCalledWith(current.id, { disabledAt: null, updatedById: 'u2' });
    vi.mocked(repository.remove).mockResolvedValue(true);
    await expect(service.remove(current.id)).resolves.toBeUndefined();
  });

  it('createGlobal seals a GLOBAL row and records its activity and audit entry', async () => {
    const { service, repository, activity, audit } = setup();
    const row = makeCredential({ scope: 'GLOBAL', scopeKey: 'global', projectId: null });
    vi.mocked(repository.insert).mockResolvedValue(row);

    const dto = await service.createGlobal('u1', { providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456' });

    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'GLOBAL', projectId: null, repoId: null, providerId: 'openrouter', name: 'fleet',
      encryptedKey: 'sealed:sk-or-abcdef123456', last4: '3456', createdById: 'u1', updatedById: 'u1',
    }));
    expect(activity.record).toHaveBeenCalledExactlyOnceWith({
      actorType: 'USER', actorId: 'u1', action: 'credential.created', entityType: 'provider_credential',
      entityId: row.id, projectId: null,
      payload: { providerId: 'openrouter', scope: 'GLOBAL', name: row.name, fingerprint: row.fingerprint },
    });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.credential.create', resourceType: 'provider_credential', resourceId: row.id,
      projectId: null, summary: 'created openrouter',
    });
    expect(dto).toMatchObject({ id: row.id, scope: 'GLOBAL', disabled: false, createdBy: row.createdById });
    expect(dto).not.toHaveProperty('encryptedKey');
  });

  it('createGlobal answers no row and records nothing when the key is invalid', async () => {
    const { service, repository, activity, audit } = setup();

    await expect(service.createGlobal('u1', { providerId: 'openrouter', name: 'fleet', key: 'short' }))
      .rejects.toMatchObject({ args: { key: expect.any(String), property: 'key' } });

    expect(repository.insert).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('listGlobal maps the page to metadata without the sealed key', async () => {
    const { service, repository } = setup();
    const row = makeCredential({ scope: 'GLOBAL', scopeKey: 'global', projectId: null });
    vi.mocked(repository.listGlobal).mockResolvedValue({
      total: 1, current: 1, size: 20, hasNext: false, hasPrev: false, records: [row],
    });

    const page = await service.listGlobal({ current: 1, size: 20 });

    expect(repository.listGlobal).toHaveBeenCalledWith({ current: 1, size: 20 });
    expect(page).toMatchObject({ total: 1, current: 1, size: 20 });
    expect(page.records[0]).toMatchObject({ id: row.id, providerId: 'openrouter', last4: '1234', disabled: false });
    expect(page.records[0]).not.toHaveProperty('encryptedKey');
  });
});

/**
 * C10 US-005: the project-scoped management `ProviderProviderCredentialsService` methods. The HTTP
 * behaviour they answer (tenant isolation, activity, audit) is asserted over the real stack in
 * `test/integration/project-provider-credentials.integration.spec.ts`; these unit cases pin the scope
 * decision each one makes and the fact that a refused scope writes and records nothing.
 */
describe('ProviderCredentialsService project scope (US-005)', () => {
  it('createProject seals a PROJECT row of the pinned project and records it there', async () => {
    const { service, repository, activity, audit } = setup();
    const row = makeCredential({ projectId: 'p1' });
    vi.mocked(repository.insert).mockResolvedValue(row);

    const dto = await service.createProject('u1', 'p1', { providerId: 'openrouter', name: 'primary', key: 'sk-or-abcdef123456' });

    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'PROJECT', projectId: 'p1', repoId: null, createdById: 'u1', updatedById: 'u1',
    }));
    expect(repository.findRepoProject).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'credential.created', entityId: row.id, projectId: 'p1',
      payload: { providerId: 'openrouter', scope: 'PROJECT', name: row.name, fingerprint: row.fingerprint },
    }));
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      key: 'project.credential.create', resourceId: row.id, projectId: 'p1',
    }));
    expect(dto).toMatchObject({ id: row.id, projectId: 'p1', repoId: null });
  });

  it('createProject seals a REPO row once the repo proves it belongs to the project', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findRepoProject).mockResolvedValue('p1');
    vi.mocked(repository.insert).mockResolvedValue(makeCredential({ scope: 'REPO', repoId: 'r1' }));

    await service.createProject('u1', 'p1', { providerId: 'openrouter', name: 'primary', key: 'sk-or-abcdef123456', repoId: 'r1' });

    expect(repository.findRepoProject).toHaveBeenCalledWith('r1');
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ scope: 'REPO', projectId: 'p1', repoId: 'r1' }));
  });

  it('createProject refuses a repo of another project with fleet.repos and writes nothing', async () => {
    const { service, repository, activity, audit } = setup();
    vi.mocked(repository.findRepoProject).mockResolvedValue('p2');

    await expect(service.createProject('u1', 'p1', {
      providerId: 'openrouter', name: 'primary', key: 'sk-or-abcdef123456', repoId: 'r1',
    })).rejects.toMatchObject({ prefix: 'fleet.repos', httpStatus: 404 });

    expect(repository.insert).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('assertProject refuses a GLOBAL row, another project row and a missing id alike', async () => {
    const { service, repository } = setup();

    vi.mocked(repository.findById).mockResolvedValue(makeCredential({ scope: 'GLOBAL', projectId: null }));
    await expect(service.assertProject('p1', 'cred-1')).rejects.toMatchObject({ prefix: 'fleet.providerCredentials.notFound' });

    vi.mocked(repository.findById).mockResolvedValue(makeCredential({ projectId: 'p2' }));
    await expect(service.assertProject('p1', 'cred-1')).rejects.toMatchObject({ prefix: 'fleet.providerCredentials.notFound' });

    vi.mocked(repository.findById).mockResolvedValue(null);
    await expect(service.assertProject('p1', 'cred-1')).rejects.toMatchObject({ prefix: 'fleet.providerCredentials.notFound' });

    vi.mocked(repository.findById).mockResolvedValue(makeCredential({ projectId: 'p1' }));
    await expect(service.assertProject('p1', 'cred-1')).resolves.toBeUndefined();
  });

  it('updateProject refuses another project row and records the rotation in the project', async () => {
    const { service, repository, activity } = setup();
    vi.mocked(repository.findById).mockResolvedValue(makeCredential({ projectId: 'p2' }));
    await expect(service.updateProject('p1', 'cred-1', { name: 'x', updatedById: 'u2' }))
      .rejects.toMatchObject({ prefix: 'fleet.providerCredentials.notFound' });

    const current = makeCredential({ projectId: 'p1' });
    vi.mocked(repository.findById).mockResolvedValue(current);
    vi.mocked(repository.patch).mockResolvedValue({ ...current, fingerprint: 'rotated' });
    await service.updateProject('p1', current.id, { key: '0123456789abcdef', updatedById: 'u2' });
    expect(activity.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'credential.rotated', projectId: 'p1', actorId: 'u2',
    }));
  });

  it('removeProject refuses another project row without deleting it', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.lockById).mockResolvedValue(makeCredential({ projectId: 'p2' }));

    await expect(service.removeProject('p1', 'cred-1', 'u1'))
      .rejects.toMatchObject({ prefix: 'fleet.providerCredentials.notFound' });

    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('listProject asks the repository for the project page and answers metadata only', async () => {
    const { service, repository } = setup();
    const row = makeCredential();
    vi.mocked(repository.listForProject).mockResolvedValue({
      total: 1, current: 1, size: 20, hasNext: false, hasPrev: false, records: [row],
    });

    const page = await service.listProject('p1', { current: 1, size: 20 });

    expect(repository.listForProject).toHaveBeenCalledWith('p1', { current: 1, size: 20 });
    expect(page.records[0]).toMatchObject({ id: row.id, projectId: 'p1' });
    expect(page.records[0]).not.toHaveProperty('encryptedKey');
  });
});
