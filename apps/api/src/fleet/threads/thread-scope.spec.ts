import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';
import type { ThreadScope } from './domain/chat-thread.domain';

const project: ThreadScope = { kind: 'project', projectId: 'P' };
const workspace: ThreadScope = { kind: 'workspace', userId: 'U' };

function fixture() {
  const thread = { id: 'T', kind: 'REPO', projectId: 'P', createdById: 'U', repoId: 'R', baseRef: 'main', feature: 'f', specPath: 'spec.md' };
  const client = {
    chatThread: { findFirst: vi.fn().mockResolvedValueOnce(thread).mockResolvedValue(null), update: vi.fn() },
    fleetJob: { findFirst: vi.fn().mockResolvedValue(null) },
    chatMessage: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const repo = new PrismaChatThreadRepository(
    { client } as never, {} as never, { run: (fn: () => Promise<unknown>) => fn() } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    mockAuditRecorder,
  );
  return { repo, client };
}

const mutations = ['updateCap', 'command', 'archive', 'sendMessage'] as const;
function mutate(repo: PrismaChatThreadRepository, method: typeof mutations[number], scope: ThreadScope) {
  switch (method) {
    case 'updateCap': return repo.updateCap(scope, 'T', 'U', '9');
    case 'command': return repo.command(scope, 'T', 'U', 'THREAD_CLOSE', {});
    case 'archive': return repo.archive(scope, 'T', 'U', true);
    case 'sendMessage': return repo.sendMessage({ scope, threadId: 'T', userId: 'U', text: 'hi', clientMessageId: 'c1' });
  }
}

describe.each([project, workspace])('thread mutation fence: $kind', scope => {
  const where = scope.kind === 'project' ? { projectId: 'P', kind: { not: 'WORKSPACE' } } : { createdById: 'U', kind: 'WORKSPACE' };
  it.each(mutations)('%s scopes both the pre-lock and under-lock reads', async method => {
    const { repo, client } = fixture();
    await expect(mutate(repo, method, scope)).rejects.toMatchObject({ prefix: 'threads.notFound' });
    expect(client.chatThread.findFirst.mock.calls).toEqual([
      [{ where: { id: 'T', ...where } }], [{ where: { id: 'T', ...where } }],
    ]);
    expect(client.chatThread.update).not.toHaveBeenCalled();
    expect(client.chatMessage.create).not.toHaveBeenCalled();
  });
});

describe.each(['publish', 'discard'] as const)('project-only %s fence', method => {
  it('excludes WORKSPACE before and after the lock', async () => {
    const { repo, client } = fixture();
    await expect(repo[method]('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.notFound' });
    expect(client.chatThread.findFirst.mock.calls).toEqual([
      [{ where: { id: 'T', projectId: 'P', kind: { not: 'WORKSPACE' } } }],
      [{ where: { id: 'T', projectId: 'P', kind: { not: 'WORKSPACE' } } }],
    ]);
  });
});
