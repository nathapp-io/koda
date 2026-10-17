import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import * as instructions from './thread-instructions';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';

describe('workspace turn boundaries', () => {
  const principal: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@test.com' };
  function setup() {
    const repository = { get: vi.fn(async () => ({ projectId: 'home' })), sendMessage: vi.fn(), archive: vi.fn(async (): Promise<string | null> => 'job') };
    const resolveMembership = vi.fn(async (): Promise<string | null> => 'DEVELOPER');
    const cancel = vi.fn(async () => undefined);
    const service = new WorkspaceThreadsService(repository as never, {} as never, {} as never, {} as never,
      { findAllForPrincipal: vi.fn(async () => [{ id: 'home' }]) } as never,
      { resolveMembership } as never, new KodaCaslAbilityFactory(), { cancel } as never);
    return { service, repository, resolveMembership, cancel };
  }
  it('maps a membership refusal during the host check to threads.homeProjectAccess', async () => {
    const { service, resolveMembership, repository } = setup();
    resolveMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    await expect(service.sendMessage(principal, 't', { text: 'hi', clientMessageId: 'one' })).rejects.toMatchObject({ prefix: 'threads.homeProjectAccess', httpStatus: 403 });
    expect(repository.sendMessage).not.toHaveBeenCalled();
  });
  it.each([{ text: '', clientMessageId: 'ok' }, { text: '你'.repeat(11000), clientMessageId: 'ok' }, { text: 'hi', clientMessageId: 'bad id' }])('validates message before thread lookup (case %#)', async (input) => {
    const { service, repository } = setup();
    await expect(service.sendMessage(principal, 't', input)).rejects.toMatchObject({ prefix: 'threads.input', httpStatus: 400, args: { reason: 'message' } });
    expect(repository.get).not.toHaveBeenCalled();
  });
  it('archives creator-only, cancels on the home project, and tolerates a terminal race', async () => {
    const { service, repository, cancel } = setup();
    cancel.mockRejectedValue(new ConflictAppException({}, 'fleet.jobs.terminal'));
    await expect(service.archive(principal, 't')).resolves.toBeUndefined();
    expect(repository.archive).toHaveBeenCalledWith({ kind: 'workspace', userId: 'u' }, 't', 'u', false);
    expect(cancel).toHaveBeenCalledWith('u', 'home', 'job', true);
  });
  it('does not cancel without a live job and propagates unexpected cancel failures', async () => {
    const { service, repository, cancel } = setup();
    repository.archive.mockResolvedValueOnce(null);
    await service.archive(principal, 't');
    expect(cancel).not.toHaveBeenCalled();
    cancel.mockRejectedValue(new Error('database unavailable'));
    await expect(service.archive(principal, 't')).rejects.toThrow('database unavailable');
  });
  it('AC-4: instructions have no koda tool names and include skills', () => {
    const text = instructions.buildWorkspaceThreadInstructions({ skills: [] });
    expect(text).toMatch(/^You are a brainstorming partner in a koda workspace thread\./);
    expect(text).not.toContain('koda_');
    expect(text).toContain('Skills available: none.');
  });
  it('AC-12: send passes no repository context', async () => {
    const sendMessage = vi.fn(async () => ({ jobId: 'j' }));
    const service = new WorkspaceThreadsService(
      { get: vi.fn(async () => ({ projectId: 'p' })), sendMessage } as never,
      {} as never, {} as never, {} as never,
      { findAllForPrincipal: vi.fn(async () => [{ id: 'p' }]) } as never,
      { resolveMembership: vi.fn(async () => 'DEVELOPER') } as never,
      new KodaCaslAbilityFactory(), {} as never,
    );
    const principal: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@test.com' };
    await service.sendMessage(principal, 't', { text: 'hi', clientMessageId: 'cm' });
    expect(sendMessage).toHaveBeenCalledWith({ scope: { kind: 'workspace', userId: 'u' }, threadId: 't', userId: 'u', text: 'hi', clientMessageId: 'cm', repoContext: undefined });
  });
});
