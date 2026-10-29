import type { VcsManualSync } from './vcs-manual-sync.service';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { IVcsConfig } from '../config/vcs.config';
import type { VcsConnectionService } from './vcs-connection.service';
import { VcsRouteCommands, VCS_ROUTE_VARIANTS } from './vcs-route.commands';

describe('VcsRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const service = { delete: vi.fn().mockResolvedValue(undefined), testConnection: vi.fn().mockResolvedValue({ ok: false, latencyMs: 12, error: 'Invalid token' }) };
    const config: IVcsConfig = { encryptionKey: 'k1', defaultPollingIntervalMs: 300000, githubApiUrl: '', gitlabApiUrl: '' };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    const apply = vi.fn().mockResolvedValue({ issuesSynced: 1 });
    const manual = { startPrExtractions: vi.fn(), syncPr: vi.fn(), prepareSyncPr: vi.fn(), syncIssue: vi.fn().mockResolvedValue({ issuesSynced: 1 }), syncAll: vi.fn().mockResolvedValue({ issuesSynced: 1 }), prepareSyncIssue: vi.fn().mockResolvedValue(apply), prepareSyncAll: vi.fn().mockResolvedValue(apply) };
    new VcsRouteCommands(registry, service as unknown as VcsConnectionService, loader as unknown as ActorPrincipalLoader, config, manual as unknown as VcsManualSync).onModuleInit();
    const command = registry.get('vcs.connection.test', VCS_ROUTE_VARIANTS.test);
    if (!command) throw new Error('Missing test command');
    return { registry, service, config, loader, command, manual, apply };
  }
  it.each([['vcs.sync.issue', 'rest:vcs.sync-issue'], ['vcs.sync.all', 'rest:vcs.sync-all']])('AC-9: registers prepared %s / %s', (key, variant) => {
    const { registry } = build();
    expect(registry.get(key, variant)).toMatchObject({ key, variant, prepare: expect.any(Function) });
  });
  it.each([
    ['vcs.sync.issue', 'rest:vcs.sync-issue', 'syncIssue', 'prepareSyncIssue'],
    ['vcs.sync.all', 'rest:vcs.sync-all', 'syncAll', 'prepareSyncAll'],
  ] as const)('parses and delegates immediate and prepared %s', async (key, variant, run, prepare) => {
    const { registry, manual, apply, loader } = build();
    const command = registry.get(key, variant);
    if (!command?.prepare) throw new Error('Missing prepared command');
    const input = command.parse({ slug: 'alpha', projectId: 'p', issueNumber: '7', token: 'discard', headers: {} });
    expect(input).toEqual({ slug: 'alpha', projectId: 'p', ...(run === 'syncIssue' ? { issueNumber: '7' } : {}) });
    const result = await command.execute(input);
    expect(command.toResult?.(result)).toBe(result);
    const args = run === 'syncIssue' ? ['alpha', '7'] : ['alpha'];
    expect(manual[run]).toHaveBeenCalledWith(...args);
    const mutate = await command.prepare(input);
    expect(manual[prepare]).toHaveBeenCalledWith(...args);
    expect(apply).not.toHaveBeenCalled();
    expect(await mutate()).toEqual({ issuesSynced: 1 });
    expect(apply).toHaveBeenCalledOnce();
    expect(loader.forContext).toHaveBeenCalledTimes(3);
  });
  it('PR AC-10: sync-pr stores only updated and maps the extraction follow-up', async () => {
    const { registry, manual } = build();
    const command = registry.get('vcs.sync.pr', 'rest:vcs.sync-pr');
    if (!command?.toResult || !command.afterCommit) throw new Error('Missing sync-pr hooks');
    const result = { updated: 1, skipped: 0, extractions: [{ ticket: { id: 't' } }] };
    expect(command.toResult(result)).toEqual({ updated: 1 });
    expect(command.parse({ slug: 'alpha', projectId: 'p', token: 'secret' })).toEqual({ slug: 'alpha', projectId: 'p' });
    expect(command.prepare).toBeTypeOf('function');
    expect(command.afterCommit).toBeTypeOf('function');
    await command.afterCommit({ slug: 'alpha', projectId: 'p' }, undefined, result);
    expect(manual.startPrExtractions).toHaveBeenCalledExactlyOnceWith(result);
  });
  it('AC-11: registers both exact variants', () => {
    const { registry } = build();
    expect(registry.get('vcs.connection.delete', 'rest:vcs.delete')).toBeDefined();
    expect(registry.get('vcs.connection.test', 'rest:vcs.test')).toBeDefined();
  });
  it('AC-9: executes with the runtime key and stores the service DTO unchanged', async () => {
    const { command, service, loader, config } = build();
    const input = command.parse({ projectId: 'p1', encryptionKey: 'ignored', token: 'ignored' });
    expect(input).toEqual({ projectId: 'p1' });
    const output = await command.execute(input);
    expect(service.testConnection).toHaveBeenCalledExactlyOnceWith('p1', 'k1');
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(command.toResult?.(output)).toBe(output);
    expect(output).toEqual({ ok: false, latencyMs: 12, error: 'Invalid token' });
    config.encryptionKey = 'k2';
    await command.execute(input);
    expect(service.testConnection).toHaveBeenLastCalledWith('p1', 'k2');
  });
  it('AC-10: refuses execution if the encryption key disappears while waiting', async () => {
    const { command, config, service } = build();
    const input = command.parse({ projectId: 'p1' });
    config.encryptionKey = null;
    await expect(command.execute(input)).rejects.toMatchObject({ prefix: 'vcs' });
    await expect(command.execute(input)).rejects.toThrow(ValidationAppException);
    expect(service.testConnection).not.toHaveBeenCalled();
  });
  it('deletes using parsed project id, returning null without toResult', async () => {
    const { registry, service } = build();
    const command = registry.get('vcs.connection.delete', VCS_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing delete command');
    expect(await command.execute(command.parse({ projectId: 'p1', extra: 1 }))).toBeNull();
    expect(service.delete).toHaveBeenCalledExactlyOnceWith('p1');
    expect(command.toResult).toBeUndefined();
    for (const value of [null, [], {}, { projectId: '' }, { projectId: 3 }]) expect(() => command.parse(value)).toThrow(ValidationAppException);
  });
});
