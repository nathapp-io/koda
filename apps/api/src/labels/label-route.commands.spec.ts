import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { LabelsService } from './labels.service';
import { LabelRouteCommands, LABEL_ROUTE_VARIANTS } from './label-route.commands';

describe('LabelRouteCommands', () => {
  it('AC-10/11/12: registers, parses and executes rest:labels.delete', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { delete: vi.fn().mockResolvedValue(undefined), removeFromTicket: vi.fn().mockResolvedValue(undefined) };
    new LabelRouteCommands(registry, service as unknown as LabelsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    expect(LABEL_ROUTE_VARIANTS.delete).toBe('rest:labels.delete');
    const command = registry.get('label.delete', 'rest:labels.delete');
    if (!command) throw new Error('Missing command');
    const input = {"slug": "alpha", "id": "l1"};
    expect(command.parse({ ...input, ignored: true })).toEqual(input);
    const result = await command.execute(command.parse(input));
    expect(service.delete).toHaveBeenCalledExactlyOnceWith('alpha', 'l1', principal);
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
  it('AC-10/11/12: registers, parses and executes rest:ticket-labels.remove', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { delete: vi.fn().mockResolvedValue(undefined), removeFromTicket: vi.fn().mockResolvedValue(undefined) };
    new LabelRouteCommands(registry, service as unknown as LabelsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    expect(LABEL_ROUTE_VARIANTS.remove).toBe('rest:ticket-labels.remove');
    const command = registry.get('ticket.label.remove', 'rest:ticket-labels.remove');
    if (!command) throw new Error('Missing command');
    const input = {"slug": "alpha", "ref": "AL-1", "labelId": "l1"};
    expect(command.parse({ ...input, ignored: true })).toEqual(input);
    const result = await command.execute(command.parse(input));
    expect(service.removeFromTicket).toHaveBeenCalledExactlyOnceWith('alpha', 'AL-1', 'l1', principal);
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
