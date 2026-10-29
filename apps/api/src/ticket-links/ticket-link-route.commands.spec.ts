import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { TicketLinksService } from './ticket-links.service';
import { TicketLinkRouteCommands, TICKET_LINK_ROUTE_VARIANTS } from './ticket-link-route.commands';

describe('TicketLinkRouteCommands', () => {
  it('AC-10/11/12: registers, parses and executes rest:ticket-links.remove', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { remove: vi.fn().mockResolvedValue(undefined) };
    new TicketLinkRouteCommands(registry, service as unknown as TicketLinksService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    expect(TICKET_LINK_ROUTE_VARIANTS.remove).toBe('rest:ticket-links.remove');
    const command = registry.get('ticket.link.remove', 'rest:ticket-links.remove');
    if (!command) throw new Error('Missing command');
    const input = {slug: 'alpha', ref: 'AL-1', linkId: 'k1'};
    expect(command.parse({ ...input, ignored: true })).toEqual(input);
    const result = await command.execute(command.parse(input));
    expect(service.remove).toHaveBeenCalledExactlyOnceWith('alpha', 'AL-1', 'k1', principal);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    expect(command.toResult).toBeUndefined();
    for (const field of Object.keys(input)) {
      const bad = { ...input } as Record<string, unknown>;
      delete bad[field];
      try { command.parse(bad); throw new Error('accepted invalid input'); }
      catch (error) { expect(error).toBeInstanceOf(ValidationAppException); expect(error).toMatchObject({ response: { prefix: 'approvals.invalidInput' } }); }
    }
  });
});

describe('US-007 new write commands', () => {
  it.each(['agent', 'user'] as const)('AC-9/11: rest:ticket-links.add registers, validates, executes as %s and stores the route result', async (actorType) => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType, id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { status: 201, link: { id: 'k1' } };
    const service = { create: vi.fn().mockResolvedValue(result) };
    new TicketLinkRouteCommands(registry, service as unknown as TicketLinksService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('ticket.link.add', 'rest:ticket-links.add');
    expect(command).toBeDefined();
    if (!command) throw new Error('Missing command');
    const input = {slug: 'alpha', ref: 'AL-1', link: {url: 'https://example.com'}};
    const parsed = command.parse({ ...input, ignored: true });
    expect(parsed).toEqual(input);
    expect(await command.execute(parsed)).toEqual(result);
    expect(service.create).toHaveBeenCalledExactlyOnceWith('alpha', 'AL-1', {url: 'https://example.com'}, { type: actorType === 'agent' ? 'AGENT' : 'USER', id: 'a1' });
    expect(command.toResult?.(result)).toEqual(result.link);
    for (const field of ['slug', 'ref']) {
      const invalid: Record<string, unknown> = { ...input };
      delete invalid[field];
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    expect(() => command.parse({ ...input, link: {} })).toThrow();
  });
});
