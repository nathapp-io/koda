import { CodeIntelOutboxSubscriber } from './code-intel-outbox.subscriber';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { AstIndexService } from './ast-index.service';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';
import { currentContext } from '../action-context/action-context';

describe('CodeIntelOutboxSubscriber', () => {
  it('registers code_commit and delegates to CodeCommitOutboxHandler when present', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const handler = { process: vi.fn().mockResolvedValue(undefined) } as unknown as CodeCommitOutboxHandler;

    new CodeIntelOutboxSubscriber(registry, { record: vi.fn().mockResolvedValue(undefined) } as never, handler, undefined).onModuleInit();
    expect(registry.getHandlers('code_commit').length).toBe(1);

    await registry.publish(outboxRecord('code_commit', { repoId: 'r', commitHash: 'c', projectId: 'p' }));
    expect(handler.process).toHaveBeenCalledTimes(1);
  });

  it('runs as SYSTEM/codeintel and audits the indexed push exactly once', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const record = vi.fn().mockResolvedValue(undefined);
    let actor: unknown;
    const handler = {
      process: vi.fn(async (_payload: unknown, onIndexed: (counts: { symbolsIndexed: number; filesIndexed: number }) => Promise<void>) => {
        actor = currentContext()?.actor;
        await onIndexed({ symbolsIndexed: 3, filesIndexed: 1 });
      }),
    } as unknown as CodeCommitOutboxHandler;
    new CodeIntelOutboxSubscriber(registry, { record } as never, handler).onModuleInit();
    await registry.publish(outboxRecord('code_commit', { repoId: 'acme/w', commitHash: 'c1', projectId: 'p-1', changedFiles: ['a.ts'] }));
    expect(actor).toEqual({ type: 'SYSTEM', id: 'codeintel' });
    expect(record).toHaveBeenCalledExactlyOnceWith({
      key: 'system.codeintel.index-commit', resourceType: 'code-repo', resourceId: 'acme/w', projectId: 'p-1',
      summary: 'indexed 3 symbols in 1 files',
    });
  });

  it('falls back to AstIndexService.indexCommit when no CodeCommitOutboxHandler', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const ast = { indexCommit: vi.fn().mockResolvedValue(undefined) } as unknown as AstIndexService;

    new CodeIntelOutboxSubscriber(registry, { record: vi.fn().mockResolvedValue(undefined) } as never, undefined, ast).onModuleInit();
    await registry.publish(
      outboxRecord('code_commit', { repoId: 'r', commitHash: 'c', projectId: 'p', changedFiles: [{ path: 'a.ts', content: 'x' }] }),
    );
    expect(ast.indexCommit).toHaveBeenCalledWith('r', 'c', [{ path: 'a.ts', content: 'x' }], 'p', expect.any(Function));
  });
});
