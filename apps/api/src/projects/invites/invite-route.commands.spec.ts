import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { ProjectInvitesService } from './project-invites.service';
import { InviteRouteCommands, INVITE_ROUTE_VARIANTS } from './invite-route.commands';

describe('InviteRouteCommands', () => {
  it('AC-9: registers redeem commands and excludes locale from create approval input', () => {
    const registry = new ApprovalCommandRegistry();
    const service = { create: vi.fn(), resend: vi.fn(), cancel: vi.fn() };
    new InviteRouteCommands(registry, service as unknown as ProjectInvitesService, {} as ActorPrincipalLoader).onModuleInit();

    const create = registry.get('invite.create', INVITE_ROUTE_VARIANTS.create);
    const resend = registry.get('invite.resend', INVITE_ROUTE_VARIANTS.resend);
    expect(create?.redeem).toBeDefined();
    expect(resend?.redeem).toBeDefined();
    expect(create?.redeem?.redact({ slug: 's', projectId: 'p1', invite: { email: 'e@x.test', roleKey: 'viewer' }, locale: 'zh' })).toEqual({ slug: 's', projectId: 'p1', invite: { email: 'e@x.test', roleKey: 'viewer' } });
  });

  it('AC-9: executes cancellation as the loaded principal and returns null', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { cancel: vi.fn().mockResolvedValue(undefined) };
    new InviteRouteCommands(registry, service as unknown as ProjectInvitesService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('invite.cancel', INVITE_ROUTE_VARIANTS.cancel);
    if (!command) throw new Error('Missing route command');
    const input = command.parse({ slug: 'alpha', id: 'i1', header: 'discard' });
    expect(input).toEqual({ slug: 'alpha', id: 'i1' });
    expect(await command.execute(input)).toBeNull();
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith('alpha', 'i1', principal);
    expect(command.toResult).toBeUndefined();
    for (const invalid of [null, [], {}, { slug: 'alpha' }, { slug: 'alpha', id: '' }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
  });
});
