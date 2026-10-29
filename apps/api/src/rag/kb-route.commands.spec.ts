import { KbDocumentAddition } from './kb-document-addition.service';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { KbRouteCommands, KB_ROUTE_VARIANTS } from './kb-route.commands';
import { KbDocumentDeletion } from './kb-document-deletion.service';

import { RagService } from './rag.service';
import { AuditRecorder } from '../audit/audit-recorder.service';

describe('KB graphify and optimize commands', () => {
  const nodes = [{ id: 'n1', label: 'Node' }];
  const links = [{ source: 'n1', target: 'n1', relation: 'self' }];
  const result = { imported: 1, cleared: 2 };
  let registry: ApprovalCommandRegistry;
  let rag: { importGraphify: ReturnType<typeof vi.fn>; optimizeTable: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn>; audited: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    registry = new ApprovalCommandRegistry();
    rag = { importGraphify: vi.fn().mockResolvedValue(result), optimizeTable: vi.fn().mockResolvedValue(undefined) };
    audit = {
      record: vi.fn().mockResolvedValue(undefined),
      audited: vi.fn(async (work: () => Promise<unknown>, entries: (value: unknown) => unknown) => {
        const value = await work(); await audit.record(entries(value)); return value;
      }),
    };
    new KbRouteCommands(registry, {} as KbDocumentDeletion, { forContext: vi.fn().mockResolvedValue({ actorType: 'agent', id: 'a1' }) } as unknown as ActorPrincipalLoader, {} as KbDocumentAddition, rag as unknown as RagService, audit as unknown as AuditRecorder).onModuleInit();
  });
  it.each([['kb.graphify.import', 'rest:kb.graphify-import'], ['kb.optimize', 'rest:kb.optimize']])('AC-10: registers %s / %s with prepare', (key, variant) => {
    expect(registry.get(key, variant)).toMatchObject({ key, variant, prepare: expect.any(Function) });
  });
  it('AC-7: imports in prepare, then only audits and returns the original counts', async () => {
    const command = registry.get('kb.graphify.import', 'rest:kb.graphify-import');
    if (!command?.prepare) throw new Error('missing graphify prepare');
    const input = command.parse({ slug: 'alpha', projectId: 'p1', graph: { nodes, links }, ignored: true });
    expect(input).toEqual({ slug: 'alpha', projectId: 'p1', graph: { nodes, links } });
    const callback = await command.prepare(input);
    expect(rag.importGraphify).toHaveBeenCalledExactlyOnceWith('p1', nodes, links);
    expect(audit.record).not.toHaveBeenCalled();
    expect(await callback()).toEqual(result);
    expect(rag.importGraphify).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'kb.graphify.import', resourceType: 'project', resourceId: 'p1', projectId: 'p1', summary: 'imported 1 nodes, cleared 2' });
    expect(command.toResult?.(result)).toEqual(result);
  });
  it('graphify run imports once, defaults links, validates the frozen body and audits', async () => {
    const command = registry.get('kb.graphify.import', 'rest:kb.graphify-import');
    if (!command) throw new Error('missing graphify command');
    for (const invalid of [null, {}, { slug: 'alpha', projectId: 'p1' }, { slug: 'alpha', projectId: 'p1', graph: { nodes: [{}] } }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    expect(await command.execute(command.parse({ slug: 'alpha', projectId: 'p1', graph: { nodes } }))).toEqual(result);
    expect(rag.importGraphify).toHaveBeenCalledExactlyOnceWith('p1', nodes, []);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
  it('AC-8: optimize run performs work and records one audit', async () => {
    const command = registry.get('kb.optimize', 'rest:kb.optimize');
    if (!command) throw new Error('missing optimize command');
    const optimized = await command.execute(command.parse({ slug: 'alpha', projectId: 'p1' }));
    expect(optimized).toEqual({ optimized: true });
    expect(rag.optimizeTable).toHaveBeenCalledExactlyOnceWith('p1');
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'kb.optimize', resourceType: 'project', resourceId: 'p1', projectId: 'p1', summary: 'kb table optimized' });
    expect(command.toResult?.(optimized)).toEqual(optimized);
  });
  it('optimize prepares once before auditing in its callback', async () => {
    const command = registry.get('kb.optimize', 'rest:kb.optimize');
    if (!command?.prepare) throw new Error('missing optimize prepare');
    const callback = await command.prepare(command.parse({ slug: 'alpha', projectId: 'p1' }));
    expect(rag.optimizeTable).toHaveBeenCalledExactlyOnceWith('p1');
    expect(audit.record).not.toHaveBeenCalled();
    expect(await callback()).toEqual({ optimized: true });
    expect(rag.optimizeTable).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
  it.each([['kb.graphify.import', 'rest:kb.graphify-import', 'importGraphify'], ['kb.optimize', 'rest:kb.optimize', 'optimizeTable']] as const)('propagates %s store failures without auditing', async (key, variant, method) => {
    const command = registry.get(key, variant);
    if (!command?.prepare) throw new Error('missing command');
    rag[method].mockRejectedValue(new TypeError('store failed'));
    const input = command.parse({ slug: 'alpha', projectId: 'p1', graph: { nodes, links } });
    await expect(command.prepare(input)).rejects.toThrow(TypeError);
    await expect(command.execute(input)).rejects.toThrow(TypeError);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('KbRouteCommands', () => {
  it('registers addition with DTO validation, immediate and prepared execution', async () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { actorType: 'agent', id: 'a1' };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const result = { indexed: true, id: 'row1', sourceId: 's1' };
    const apply = vi.fn().mockResolvedValue(result);
    const addition = { add: vi.fn().mockResolvedValue(result), prepare: vi.fn().mockResolvedValue(apply), withExecution: vi.fn(async (_projectId: string, transaction: () => Promise<unknown>) => transaction()) };
    new KbRouteCommands(registry, {} as KbDocumentDeletion, loader as unknown as ActorPrincipalLoader, addition as unknown as KbDocumentAddition, {} as RagService, {} as AuditRecorder).onModuleInit();
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
    new KbRouteCommands(registry, deletion as unknown as KbDocumentDeletion, loader as unknown as ActorPrincipalLoader, {} as KbDocumentAddition, {} as RagService, {} as AuditRecorder).onModuleInit();
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
