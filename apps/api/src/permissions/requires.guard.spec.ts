import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectScopedRequest } from '../projects/project-context';
import type { PermissionDecision } from './permissions.types';
import { Requires } from './requires.decorator';
import { RequiresGuard } from './requires.guard';
import type { PermissionService } from './permission.service';

/**
 * US-001 — `RequiresGuard` without a database: the modes, the `enforcedBy: 'service'` opt-out, and
 * every fail-closed branch (unknown key, missing principal, project key without a resolved project).
 *
 * `PermissionService.can` is a double here: the spec pins *which* keys the guard asks about and how
 * it reads the answer, not how the answer is computed (`permission.service.spec.ts` owns that).
 */

/** One handler per guard case; the class carries no class-level @Requires. */
class TestController {
  noMetadata(): void {}

  @Requires('ticket.read')
  ticketRead(): void {}

  @Requires(['ticket.update', 'ticket.assign'])
  ticketWrite(): void {}

  @Requires(['ticket.transition.verify-fix.approve', 'ticket.transition.verify-fix.return'], { mode: 'any' })
  anyTransition(): void {}

  @Requires('comment.update', { enforcedBy: 'service' })
  serviceChecked(): void {}

  @Requires('no.such.key')
  unknownKey(): void {}

  @Requires('session.login')
  login(): void {}

  @Requires('agent.read')
  agentRead(): void {}

  @Requires('comment.delete')
  commentDelete(): void {}
}

const ALLOWED: PermissionDecision = { allowed: true, reason: 'granted' };
const NOT_GRANTED: PermissionDecision = { allowed: false, reason: 'not-granted' };
const NOT_OWNER: PermissionDecision = { allowed: false, reason: 'not-owner' };

const user: KodaPrincipal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u1@koda.test' } as KodaPrincipal;

const projectRequest = (): Partial<ProjectScopedRequest> => ({
  user,
  projectContext: { project: { id: 'p1', slug: 'p1' }, role: 'DEVELOPER' },
});

/** The thrown `AppException`, asserted to be one so `prefix`/`httpStatus` can be read by name. */
async function thrown(run: () => Promise<unknown>): Promise<AppException> {
  const error = await run().then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

describe('RequiresGuard', () => {
  const reflector = new Reflector();
  const answers = new Map<string, PermissionDecision>();
  const can = vi.fn(
    async (_principal: KodaPrincipal, key: string): Promise<PermissionDecision> =>
      answers.get(key) ?? NOT_GRANTED,
  );
  let guard: RequiresGuard;

  const contextFor = (
    handler: () => void,
    request: Partial<ProjectScopedRequest> = projectRequest(),
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  const answer = (entries: Record<string, PermissionDecision>): void => {
    for (const [key, decision] of Object.entries(entries)) answers.set(key, decision);
  };

  beforeEach(() => {
    answers.clear();
    can.mockClear();
    guard = new RequiresGuard(reflector, { can } as unknown as PermissionService);
  });

  it('AC-2: resolves true without asking the catalog when the handler has no @Requires metadata', async () => {
    await expect(guard.canActivate(contextFor(TestController.prototype.noMetadata))).resolves.toBe(true);

    expect(can).not.toHaveBeenCalled();
  });

  it('AC-3: asks can for the route key in the resolved project and allows when it is granted', async () => {
    answer({ 'ticket.read': ALLOWED });

    await expect(guard.canActivate(contextFor(TestController.prototype.ticketRead))).resolves.toBe(true);

    expect(can).toHaveBeenCalledTimes(1);
    expect(can).toHaveBeenCalledWith(user, 'ticket.read', { projectId: 'p1' });
  });

  it('AC-4: refuses ticket.read with the permissions code when can answers not-granted', async () => {
    answer({ 'ticket.read': NOT_GRANTED });

    const error = await thrown(() => guard.canActivate(contextFor(TestController.prototype.ticketRead)));

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error.prefix).toBe('permissions');
    expect(error.httpStatus).toBe(403);
  });

  it('AC-5: all mode refuses when one of two keys is refused', async () => {
    answer({ 'ticket.update': ALLOWED, 'ticket.assign': NOT_GRANTED });

    const error = await thrown(() => guard.canActivate(contextFor(TestController.prototype.ticketWrite)));

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error.prefix).toBe('permissions');
  });

  it('AC-6: any mode allows when only the second key is granted', async () => {
    answer({
      'ticket.transition.verify-fix.approve': NOT_GRANTED,
      'ticket.transition.verify-fix.return': ALLOWED,
    });

    await expect(guard.canActivate(contextFor(TestController.prototype.anyTransition))).resolves.toBe(true);

    expect(can).toHaveBeenCalledTimes(2);
  });

  it('AC-7: enforcedBy service allows without asking can, leaving the check to the handler', async () => {
    await expect(guard.canActivate(contextFor(TestController.prototype.serviceChecked))).resolves.toBe(true);

    expect(can).not.toHaveBeenCalled();
  });

  it('AC-8: refuses an unknown key without asking can', async () => {
    const error = await thrown(() => guard.canActivate(contextFor(TestController.prototype.unknownKey)));

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error.prefix).toBe('permissions');
    expect(can).not.toHaveBeenCalled();
  });

  it('AC-9: refuses a project key when no project was resolved, without asking can', async () => {
    const error = await thrown(() =>
      guard.canActivate(contextFor(TestController.prototype.ticketRead, { user })),
    );

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error.prefix).toBe('permissions');
    expect(can).not.toHaveBeenCalled();
  });

  it('AC-10: allows a public key for an unauthenticated request without asking can', async () => {
    await expect(guard.canActivate(contextFor(TestController.prototype.login, {}))).resolves.toBe(true);

    expect(can).not.toHaveBeenCalled();
  });

  it('AC-11: refuses a role key when the request has no principal, without asking can', async () => {
    const error = await thrown(() => guard.canActivate(contextFor(TestController.prototype.agentRead, {})));

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(error.prefix).toBe('permissions');
    expect(can).not.toHaveBeenCalled();
  });

  it('AC-12: allows an ownable key answered not-owner, so the service can decide on the row', async () => {
    answer({ 'comment.delete': NOT_OWNER });

    await expect(guard.canActivate(contextFor(TestController.prototype.commentDelete))).resolves.toBe(true);

    expect(can).toHaveBeenCalledWith(user, 'comment.delete', { projectId: 'p1' });
  });
});
