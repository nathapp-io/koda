import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { ProjectInvitesService } from './project-invites.service';
import { InviteRouteCommands, INVITE_ROUTE_VARIANTS } from './invite-route.commands';

describe('InviteRouteCommands', () => {
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
