import { CodeIntelOutboxSubscriber } from './code-intel-outbox.subscriber';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { AstIndexService } from './ast-index.service';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';

describe('CodeIntelOutboxSubscriber', () => {
  it('registers code_commit and delegates to CodeCommitOutboxHandler when present', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const handler = { process: jest.fn().mockResolvedValue(undefined) } as unknown as CodeCommitOutboxHandler;

    new CodeIntelOutboxSubscriber(registry, handler, undefined).onModuleInit();
    expect(registry.getHandlers('code_commit').length).toBe(1);

    await registry.publish(outboxRecord('code_commit', { repoId: 'r', commitHash: 'c', projectId: 'p' }));
    expect(handler.process).toHaveBeenCalledTimes(1);
  });

  it('falls back to AstIndexService.indexCommit when no CodeCommitOutboxHandler', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const ast = { indexCommit: jest.fn().mockResolvedValue(undefined) } as unknown as AstIndexService;

    new CodeIntelOutboxSubscriber(registry, undefined, ast).onModuleInit();
    await registry.publish(
      outboxRecord('code_commit', { repoId: 'r', commitHash: 'c', projectId: 'p', changedFiles: [{ path: 'a.ts', content: 'x' }] }),
    );
    expect(ast.indexCommit).toHaveBeenCalledWith('r', 'c', [{ path: 'a.ts', content: 'x' }], 'p');
  });
});
