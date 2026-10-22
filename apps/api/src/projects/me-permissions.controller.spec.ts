import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { MePermissionsController } from './me-permissions.controller';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';

/**
 * US-001: the two scopes of `GET /me/permissions`, the projection onto a DTO, and the refusals it
 * inherits instead of inventing. The behavior over HTTP is in
 * `test/integration/permissions/me-permissions.integration.spec.ts`; this spec pins the branches.
 */
describe('MePermissionsController', () => {
  const access = { findProjectIdBySlug: vi.fn(), resolveMembership: vi.fn() };
  const permissions = { effectiveKeys: vi.fn() };
  const controller = new MePermissionsController(access as never, permissions as never);

  const user = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u1@koda.test' } as KodaPrincipal;
  const agent = { actorType: 'agent', id: 'a1', slug: 'a1', status: 'ACTIVE' } as KodaPrincipal;

  afterEach(() => vi.resetAllMocks());

  it('declares the implicit auth.me.read key and runs RequiresGuard, so any authenticated principal passes', () => {
    const handler = (MePermissionsController.prototype as unknown as Record<string, object>)['read'];
    expect(Reflect.getMetadata(REQUIRES_METADATA, handler)).toEqual({
      keys: ['auth.me.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
    const guards = (Reflect.getMetadata('__guards__', handler) ?? []) as unknown[];
    expect(guards).toContain(RequiresGuard);
  });

  it('without a project answers the global scope with the caller\'s keys, ascending', async () => {
    permissions.effectiveKeys.mockResolvedValue(new Set(['ticket.read', 'agent.read']));

    const res = await controller.read({}, user);

    expect(permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, 'global');
    expect(access.findProjectIdBySlug).not.toHaveBeenCalled();
    expect(res).toEqual(
      expect.objectContaining({
        ret: 0,
        data: { scope: 'global', projectSlug: null, keys: ['agent.read', 'ticket.read'] },
      }),
    );
  });

  it('with a project answers the project scope of the slug it resolved', async () => {
    access.findProjectIdBySlug.mockResolvedValue('p1');
    access.resolveMembership.mockResolvedValue('DEVELOPER');
    permissions.effectiveKeys.mockResolvedValue(new Set(['comment.update.own', 'ticket.create']));

    const res = await controller.read({ project: 'koda' }, user);

    expect(access.findProjectIdBySlug).toHaveBeenCalledWith('koda');
    expect(access.resolveMembership).toHaveBeenCalledWith('p1', user);
    expect(permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'USER', id: 'u1' }, { projectId: 'p1' });
    expect(res).toEqual(
      expect.objectContaining({
        ret: 0,
        data: { scope: 'project', projectSlug: 'koda', keys: ['comment.update.own', 'ticket.create'] },
      }),
    );
  });

  it('reads the keys as an AGENT principal for an agent caller', async () => {
    access.findProjectIdBySlug.mockResolvedValue('p1');
    access.resolveMembership.mockResolvedValue(null);
    permissions.effectiveKeys.mockResolvedValue(new Set(['ticket.create']));

    await controller.read({ project: 'koda' }, agent);

    expect(permissions.effectiveKeys).toHaveBeenCalledWith({ type: 'AGENT', id: 'a1' }, { projectId: 'p1' });
  });

  it('propagates the 404 of an unknown slug without computing any keys', async () => {
    access.findProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

    await expect(controller.read({ project: 'nope' }, user)).rejects.toBeInstanceOf(NotFoundAppException);
    expect(access.resolveMembership).not.toHaveBeenCalled();
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
  });

  it('propagates the 403 of a project the caller cannot read without computing any keys', async () => {
    access.findProjectIdBySlug.mockResolvedValue('p1');
    access.resolveMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));

    await expect(controller.read({ project: 'koda' }, user)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
  });

  it('refuses a runner principal instead of reading keys for it', async () => {
    const runner = { actorType: 'runner', id: 'r1', runnerName: 'r1' } as KodaPrincipal;

    await expect(controller.read({}, runner)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
  });
});
