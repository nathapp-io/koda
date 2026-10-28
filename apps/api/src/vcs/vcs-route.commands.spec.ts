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
    new VcsRouteCommands(registry, service as unknown as VcsConnectionService, loader as unknown as ActorPrincipalLoader, config).onModuleInit();
    const command = registry.get('vcs.connection.test', VCS_ROUTE_VARIANTS.test);
    if (!command) throw new Error('Missing test command');
    return { registry, service, config, loader, command };
  }
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
