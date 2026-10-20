import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import * as instructions from './thread-instructions';
import { WorkspaceThreadsService } from './workspace-threads.service';
import type { PermissionService } from '../../permissions/permission.service';
import type { PermissionDecision } from '../../permissions/permissions.types';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';

const allow = (): PermissionDecision => ({ allowed: true, reason: 'granted' });
const deny = (): PermissionDecision => ({ allowed: false, reason: 'not-granted' });

describe('workspace turn boundaries', () => {
  const principal: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@test.com' };
  function setup() {
    const repository = { get: vi.fn(async () => ({ projectId: 'home' })), sendMessage: vi.fn(), archive: vi.fn(async (): Promise<string | null> => 'job') };
    const can = vi.fn(async (): Promise<PermissionDecision> => allow());
    const cancel = vi.fn(async () => undefined);
    const service = new WorkspaceThreadsService(repository as never, {} as never, {} as never, {} as never,
      { findAllForPrincipal: vi.fn(async () => [{ id: 'home' }]) } as never,
      { resolveMembership: vi.fn(async () => 'DEVELOPER') } as never, { can } as unknown as PermissionService, { cancel } as never);
    return { service, repository, can, cancel };
  }
  /** US-003: hosting is the `thread.create` key of the thread's home project, and its refusal is `permissions`. */
  it('maps a refused thread.create during the host check to 403 permissions', async () => {
    const { service, can, repository } = setup();
    can.mockResolvedValue(deny());
    await expect(service.sendMessage(principal, 't', { text: 'hi', clientMessageId: 'one' })).rejects.toMatchObject({ prefix: 'permissions', httpStatus: 403 });
    expect(can).toHaveBeenCalledWith(principal, 'thread.create', { projectId: 'home' });
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
  it('AC-4: instructions name the workspace koda tools and include skills', () => {
    const text = instructions.buildWorkspaceThreadInstructions({ skills: [] });
    expect(text).toMatch(/^You are a brainstorming partner in a koda workspace thread\./);
    expect(text).toContain('koda_my_projects');
    expect(text).toContain('Skills available: none.');
  });
  it('AC-12: send passes no repository context', async () => {
    const sendMessage = vi.fn(async () => ({ jobId: 'j' }));
    const service = new WorkspaceThreadsService(
      { get: vi.fn(async () => ({ projectId: 'p' })), sendMessage } as never,
      {} as never, {} as never, {} as never,
      { findAllForPrincipal: vi.fn(async () => [{ id: 'p' }]) } as never,
      { resolveMembership: vi.fn(async () => 'DEVELOPER') } as never,
      { can: vi.fn(async () => allow()) } as unknown as PermissionService, {} as never,
    );
    const principal: UserPrincipal = { actorType: 'user', id: 'u', role: 'MEMBER', email: 'u@test.com' };
    await service.sendMessage(principal, 't', { text: 'hi', clientMessageId: 'cm' });
    expect(sendMessage).toHaveBeenCalledWith({ scope: { kind: 'workspace', userId: 'u' }, threadId: 't', userId: 'u', text: 'hi', clientMessageId: 'cm', repoContext: undefined });
  });
  /** US-003: an agent may send into its own workspace thread; the scope and the fence use its id. */
  it('sends as an agent principal through the same workspace scope', async () => {
    const sendMessage = vi.fn(async () => ({ jobId: 'j' }));
    const service = new WorkspaceThreadsService(
      { get: vi.fn(async () => ({ projectId: 'p', createdById: 'ag' })), sendMessage } as never,
      {} as never, {} as never, {} as never,
      { findAllForPrincipal: vi.fn(async () => [{ id: 'p' }]) } as never,
      { resolveMembership: vi.fn(async () => null) } as never,
      { can: vi.fn(async () => allow()) } as unknown as PermissionService, {} as never,
    );
    const agent: AgentPrincipal = { actorType: 'agent', id: 'ag', slug: 'ag', status: 'ACTIVE', agentRoles: [], capabilities: [] };
    await service.sendMessage(agent, 't', { text: 'hi', clientMessageId: 'cm' });
    expect(sendMessage).toHaveBeenCalledWith({ scope: { kind: 'workspace', userId: 'ag' }, threadId: 't', userId: 'ag', text: 'hi', clientMessageId: 'cm', repoContext: undefined });
  });
});
