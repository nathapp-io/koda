import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { ProjectMembersService } from './project-members.service';
import { MemberRouteCommands, MEMBER_ROUTE_VARIANTS } from './member-route.commands';

describe('MemberRouteCommands', () => {
  it('validates the body, reloads the principal and preserves the member result', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { id: 'u1' };
    const service = { add: vi.fn().mockResolvedValue(result) };
    new MemberRouteCommands(registry, service as unknown as ProjectMembersService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('member.add', MEMBER_ROUTE_VARIANTS.add);
    if (!command) throw new Error('Missing route command');
    const input = command.parse({ slug: 'alpha', member: { email: 'user@example.com', roleKey: 'viewer', extra: true }, extra: true });
    expect(input).toEqual({ slug: 'alpha', member: { email: 'user@example.com', roleKey: 'viewer' } });
    expect(command.parse(input)).toEqual(input);
    const output = await command.execute(input);
    expect(output).toBe(result);
    if (!command.toResult) throw new Error('Missing result projection');
    expect(command.toResult(output)).toBe(result);
    expect(service.add).toHaveBeenCalledExactlyOnceWith('alpha', { email: 'user@example.com', roleKey: 'viewer' }, principal);
    expect(loader.forContext).toHaveBeenCalledOnce();
    for (const invalid of [null, [], {}, { slug: 'alpha' }, { slug: 'alpha', member: {} }, { slug: 'alpha', member: { email: 'bad' } }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
  });
});
