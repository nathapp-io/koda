import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { CodeIntelRouteCommands, CODE_INTEL_ROUTE_VARIANTS } from './code-intel-route.commands';

describe('CodeIntelRouteCommands', () => {
  it('AC-9/11: registers index, forwards frozen files and records the audit inside the callback', async () => {
    const registry = new ApprovalCommandRegistry();
    const result = { symbolsIndexed: 2, filesIndexed: 1 };
    const astIndex = { indexCommit: vi.fn().mockResolvedValue(result) };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const loader = { forContext: vi.fn().mockResolvedValue({ type: 'USER', id: 'u1' }) };
    new CodeIntelRouteCommands(registry, astIndex as never, audit as never, loader as never).onModuleInit();
    const command = registry.get('codeintel.index.write', CODE_INTEL_ROUTE_VARIANTS.index);
    if (!command || !command.toResult) throw new Error('Missing index command');
    expect(command).toMatchObject({ key: 'codeintel.index.write', variant: 'rest:code-intel.index' });
    const files = [{ path: 'a.ts', content: 'export function alpha() {}' }];
    const input = command.parse({ projectId: 'p1', index: { projectSlug: 'alpha', repoId: 'r1', commitHash: 'c1', files } });
    const output = await command.execute(input);
    expect(astIndex.indexCommit).toHaveBeenCalledExactlyOnceWith('r1', 'c1', files, 'p1', expect.any(Function));
    expect(audit.record).not.toHaveBeenCalled();
    const callback = astIndex.indexCommit.mock.calls[0][4] as (counts: typeof result) => Promise<void>;
    await callback(result);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'codeintel.index.write', resourceType: 'code-repo', resourceId: 'r1', projectId: 'p1', summary: 'indexed 2 symbols in 1 files' });
    expect(command.toResult(output)).toEqual(result);
    expect(() => command.parse({ projectId: 'p1' })).toThrow();
    expect(() => command.parse({ projectId: 'p1', index: { projectSlug: 'alpha', repoId: 'r1', commitHash: 'c1', files: [{ path: '', content: 3 }] } })).toThrow();
    audit.record.mockRejectedValue(new Error('audit down'));
    await expect(callback(result)).rejects.toThrow('audit down');
  });
});
