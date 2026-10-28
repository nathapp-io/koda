import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { ConfigJobsService } from './config-jobs.service';
import { RepoConfigRouteCommands, REPO_CONFIG_ROUTE_VARIANTS } from './repo-config-route.commands';

describe('RepoConfigRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { job: { id: 'j1', command: 'CONFIG_DRIFT' }, placement: { assigned: false, runnerId: null, misfits: [] } };
    const jobs = { submitDrift: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new RepoConfigRouteCommands(registry, jobs as unknown as ConfigJobsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('fleet.repo.drift.check', REPO_CONFIG_ROUTE_VARIANTS.driftCheck);
    if (!command) throw new Error('Missing drift command');
    return { command, jobs, loader, result };
  }
  it('AC-9: registers the drift-check variant', () => {
    expect(build().command).toMatchObject({ key: 'fleet.repo.drift.check', variant: 'rest:project-repo-config.drift-check' });
  });
  it('AC-6: reloads the requester and preserves the complete dispatch result without an envelope', async () => {
    const { command, jobs, loader, result } = build();
    const input = command.parse({ projectId: 'p1', repoId: 'r1', extra: true });
    expect(input).toEqual({ projectId: 'p1', repoId: 'r1' });
    const out = await command.execute(input);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(jobs.submitDrift).toHaveBeenCalledExactlyOnceWith('a1', 'p1', 'r1');
    expect(out).toBe(result);
    expect(command.toResult?.(out)).toBe(result);
  });
  it('validates both identifiers and propagates service failure', async () => {
    const { command, jobs } = build();
    for (const invalid of [null, [], {}, { projectId: 'p1' }, { projectId: '', repoId: 'r1' }, { projectId: 'p1', repoId: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    const error = new Error('repo unavailable');
    jobs.submitDrift.mockRejectedValue(error);
    await expect(command.execute(command.parse({ projectId: 'p1', repoId: 'r1' }))).rejects.toBe(error);
  });
});
