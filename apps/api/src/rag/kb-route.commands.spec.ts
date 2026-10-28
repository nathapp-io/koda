import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { KbRouteCommands, KB_ROUTE_VARIANTS } from './kb-route.commands';
import { KbDocumentDeletion } from './kb-document-deletion.service';

describe('KbRouteCommands', () => {
  it('AC-11: registers, validates and executes deletion with a stored result', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const deletion = { delete: vi.fn().mockResolvedValue(undefined) };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    new KbRouteCommands(registry, deletion as unknown as KbDocumentDeletion, loader as unknown as ActorPrincipalLoader).onModuleInit();
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
