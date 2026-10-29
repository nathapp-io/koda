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
    const input = {slug: 'alpha', id: 'l1'};
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
    const input = {slug: 'alpha', ref: 'AL-1', labelId: 'l1'};
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

describe('US-007 new write commands', () => {
  it('AC-9: rest:labels.create registers, validates, executes and stores the route result', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { id: 'l1' };
    const service = { create: vi.fn().mockResolvedValue(result) };
    new LabelRouteCommands(registry, service as unknown as LabelsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('label.create', 'rest:labels.create');
    expect(command).toBeDefined();
    if (!command) throw new Error('Missing command');
    const input = {slug: 'alpha', label: {name: 'bug'}};
    const parsed = command.parse({ ...input, ignored: true });
    expect(parsed).toEqual(input);
    expect(await command.execute(parsed)).toEqual(result);
    expect(service.create).toHaveBeenCalledExactlyOnceWith('alpha', {name: 'bug'}, principal);
    expect(command.toResult?.(result)).toEqual(result);
    for (const field of ['slug']) {
      const invalid: Record<string, unknown> = { ...input };
      delete invalid[field];
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    expect(() => command.parse({ ...input, label: { name: 42, labelId: 42 } })).toThrow();
  });
  it('AC-9: rest:labels.update registers, validates, executes and stores the route result', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { id: 'l1' };
    const service = { update: vi.fn().mockResolvedValue(result) };
    new LabelRouteCommands(registry, service as unknown as LabelsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('label.update', 'rest:labels.update');
    expect(command).toBeDefined();
    if (!command) throw new Error('Missing command');
    const input = {slug: 'alpha', id: 'l1', patch: {name: 'defect'}};
    const parsed = command.parse({ ...input, ignored: true });
    expect(parsed).toEqual(input);
    expect(await command.execute(parsed)).toEqual(result);
    expect(service.update).toHaveBeenCalledExactlyOnceWith('alpha', 'l1', {name: 'defect'}, principal);
    expect(command.toResult?.(result)).toEqual(result);
    for (const field of ['slug', 'id']) {
      const invalid: Record<string, unknown> = { ...input };
      delete invalid[field];
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    expect(() => command.parse({ ...input, patch: { name: 42, labelId: 42 } })).toThrow();
  });
  it('AC-9: rest:ticket-labels.assign registers, validates, executes and stores the route result', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { id: 'l1' };
    const service = { assignToTicket: vi.fn().mockResolvedValue(result) };
    new LabelRouteCommands(registry, service as unknown as LabelsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('ticket.label.assign', 'rest:ticket-labels.assign');
    expect(command).toBeDefined();
    if (!command) throw new Error('Missing command');
    const input = {slug: 'alpha', ref: 'AL-1', assignment: {labelId: 'l1'}};
    const parsed = command.parse({ ...input, ignored: true });
    expect(parsed).toEqual(input);
    expect(await command.execute(parsed)).toEqual(result);
    expect(service.assignToTicket).toHaveBeenCalledExactlyOnceWith('alpha', 'AL-1', {labelId: 'l1'}, principal);
    expect(command.toResult?.(result)).toEqual(result);
    for (const field of ['slug', 'ref']) {
      const invalid: Record<string, unknown> = { ...input };
      delete invalid[field];
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    expect(() => command.parse({ ...input, assignment: { name: 42, labelId: 42 } })).toThrow();
  });
});
