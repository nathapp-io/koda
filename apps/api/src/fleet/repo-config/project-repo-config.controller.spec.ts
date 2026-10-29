/**
 * Permissions P1d (US-007): the repo config routes declare catalog keys, checked after the membership guard.
 *
 * A metadata spec, no database and no Nest app: the decorators are the contract the HTTP cases in
 * test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts observe end to end, and this
 * one pins the key each route names plus the guard order without booting anything.
 */
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { REQUIRES_METADATA, type RequiresMetadata } from '../../permissions/requires.decorator';
import { ProjectRepoConfigController } from './project-repo-config.controller';

type Handler = 'list' | 'read' | 'submitEdit' | 'submitRegenerate' | 'submitDrift';

const guardNames = (handler: Handler): Array<string | undefined> => {
  const fn = ProjectRepoConfigController.prototype[handler] as unknown as object;
  const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as Array<{ name?: string }>;
  return guards.map((guard) => guard.name);
};

describe('ProjectRepoConfigController route keys (US-007)', () => {
  const cases: Array<[Handler, string]> = [
    ['list', 'fleet.repo.config.read'],
    ['read', 'fleet.repo.config.read'],
    ['submitEdit', 'fleet.job.config.edit'],
    ['submitRegenerate', 'fleet.job.config.edit'],
    ['submitDrift', 'fleet.repo.drift.check'],
  ];

  it.each(cases)('%s requires %s, checked by RequiresGuard', (handler, key) => {
    const fn = ProjectRepoConfigController.prototype[handler] as unknown as object;
    const metadata = Reflect.getMetadata(REQUIRES_METADATA, fn) as RequiresMetadata;

    expect(metadata).toEqual({ keys: [key], mode: 'all', enforcedBy: 'guard' });
  });

  it.each(cases)('%s runs ProjectMembershipGuard before RequiresGuard', (handler) => {
    expect(guardNames(handler)).toEqual(['ProjectMembershipGuard', 'RequiresGuard']);
  });

  it.each(cases)('%s carries no legacy decorator, so one mechanism decides it', (handler) => {
    const fn = ProjectRepoConfigController.prototype[handler] as unknown as object;

    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });

  it('AC-11: submitEdit routes the parsed body through the approval gate with project scope', async () => {
    const body = { edits: [{ path: '.nax/context.md', op: 'put' as const, content: 'x', baseSha: null }], prTitle: 'Edit', baseSha: 'c'.repeat(40) };
    const ctx = { project: { id: 'p1', slug: 'web' } } as never;
    const principal = { id: 'a1', type: 'agent' } as never;
    const routeGate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { job: { id: 'j1' } } }) };
    const controller = new ProjectRepoConfigController({} as never, routeGate as never);
    await controller.submitEdit('r1', body, ctx, principal);
    expect(routeGate.run).toHaveBeenCalledWith({
      key: 'fleet.job.config.edit', variant: 'rest:project-repo-config.config-edit', projectId: 'p1',
      input: { slug: 'web', projectId: 'p1', repoId: 'r1', edit: body },
    });
  });

  it('keeps the controller class free of a class-level key or membership guard', () => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, ProjectRepoConfigController)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', ProjectRepoConfigController)).toBeUndefined();
  });
});
