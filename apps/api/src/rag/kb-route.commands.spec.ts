import { KbDocumentAddition } from './kb-document-addition.service';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { KbRouteCommands, KB_ROUTE_VARIANTS } from './kb-route.commands';
import { KbDocumentDeletion } from './kb-document-deletion.service';

describe('KbRouteCommands', () => {
  it('registers addition with DTO validation, immediate and prepared execution', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { indexed: true, id: 'row1', sourceId: 's1' };
    const apply = vi.fn().mockResolvedValue(result);
    const addition = { add: vi.fn().mockResolvedValue(result), prepare: vi.fn().mockResolvedValue(apply), withExecution: vi.fn(async (_projectId: string, transaction: () => Promise<unknown>) => transaction()) };
    new KbRouteCommands(registry, {} as KbDocumentDeletion, loader as unknown as ActorPrincipalLoader, addition as unknown as KbDocumentAddition).onModuleInit();
    const command = registry.get('kb.document.add', KB_ROUTE_VARIANTS.add);
    if (!command?.prepare || !command.toResult) throw new Error('KB add command incomplete');
    const document = { source: 'manual', sourceId: 's1', content: 'hello' };
    const input = command.parse({ slug: 'alpha', projectId: 'p1', document });
    expect(input).toEqual({ slug: 'alpha', projectId: 'p1', document });
    for (const invalid of [null, {}, { slug: 'alpha', projectId: 'p1' }, { slug: 'alpha', projectId: 'p1', document: { ...document, source: 'ticket' } }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    expect(await command.execute(input)).toEqual(result);
    expect(addition.add).toHaveBeenCalledWith(principal, 'p1', document);
    const callback = await command.prepare(input);
    expect(addition.prepare).toHaveBeenCalledWith(principal, 'p1', document);
    expect(apply).not.toHaveBeenCalled();
    expect(await callback()).toEqual(result);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(command.toResult(result)).toEqual(result);
    if (!command.withExecution) throw new Error('Addition transaction boundary missing');
    const transaction = vi.fn().mockResolvedValue('settled');
    expect(await command.withExecution(input, transaction)).toBe('settled');
    expect(addition.withExecution).toHaveBeenCalledWith('p1', transaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('AC-11: registers, validates and executes deletion with a stored result', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const deletion = { delete: vi.fn().mockResolvedValue(undefined) };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    new KbRouteCommands(registry, deletion as unknown as KbDocumentDeletion, loader as unknown as ActorPrincipalLoader, {} as KbDocumentAddition).onModuleInit();
    const command = registry.get('kb.document.delete', KB_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('KB delete command not registered');
    expect(command).toBeDefined();
    expect(command.parse({ projectId: 'p1', sourceId: 's1', ignored: 1 })).toEqual({ projectId: 'p1', sourceId: 's1' });
    for (const source of ['web', 'ticket', 'code', 1]) {
      try { command.parse({ projectId: 'p1', sourceId: 's1', source }); throw new Error('accepted invalid source'); }
      catch (error) { expect(error).toBeInstanceOf(ValidationAppException); expect(error).toMatchObject({ response: { prefix: 'approvals.invalidInput' } }); }
    }
    expect(() => command.parse({ projectId: 'p1' })).toThrow(ValidationAppException);
    const input = command.parse({ projectId: 'p1', sourceId: 's1', source: 'manual' });
    const result = await command.execute(input);
    expect(deletion.delete).toHaveBeenCalledWith(principal, 'p1', 's1', 'manual');
    expect(result).toEqual({ deleted: true });
    expect(command.toResult).toBeTypeOf('function');
    expect(command.toResult?.(result)).toEqual(result);
  });
});
