import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { AuditEntriesOf, AuditRecorder } from '../../audit/audit-recorder.service';
import { withCommittedEffects } from '../../common/committed-effects';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KnowledgeIndexService } from './knowledge-index.service';
import type { KnowledgeIndexQueue } from './knowledge-index.queue';
import { DEFAULT_KNOWLEDGE_PATTERNS } from './knowledge-patterns';
import { KnowledgeIndexAdmin } from './knowledge-index-admin.service';

function build(enabled = true, repos = [{ id: 'r1' }]) {
  const index = {
    savePatterns: vi.fn(async (_id: string, patterns: string[] | null) => ({ patterns: patterns ?? [...DEFAULT_KNOWLEDGE_PATTERNS], custom: patterns !== null })),
    listProjectRepos: vi.fn().mockResolvedValue(repos),
    resolveProjectRepo: vi.fn().mockResolvedValue({ id: 'r1' }),
  };
  const queue = { enqueue: vi.fn() };
  const audit = { audited: vi.fn(async <T>(fn: () => Promise<T>, _entries: AuditEntriesOf<T>) => fn()) };
  const config = { knowledgeIndexEnabled: enabled };
  const admin = new KnowledgeIndexAdmin(index as unknown as KnowledgeIndexService, queue as unknown as KnowledgeIndexQueue, audit as unknown as AuditRecorder, config);
  return { admin, index, queue, audit, config };
}

describe('KnowledgeIndexAdmin', () => {
  it('AC-2: defers patterns wakes until the owning callback returns', async () => {
    const { admin, queue } = build();
    let returned = false;
    queue.enqueue.mockImplementation(() => { expect(returned).toBe(true); });
    await withCommittedEffects(async () => {
      expect(await admin.savePatterns('p1', null)).toMatchObject({ custom: false, queued: 1 });
      expect(queue.enqueue).not.toHaveBeenCalled();
      returned = true;
    });
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith('r1', 'admin');
  });
  it('AC-10: refuses missing repos and disabled indexing before audit or enqueue', async () => {
    const { admin, index, queue, audit, config } = build();
    index.resolveProjectRepo.mockResolvedValue(null);
    await expect(admin.reindex('p1', 'missing')).rejects.toMatchObject({ prefix: 'knowledge.repoNotFound' });
    await expect(admin.reindex('p1', 'missing')).rejects.toBeInstanceOf(NotFoundAppException);
    config.knowledgeIndexEnabled = false;
    await expect(admin.reindex('p1', 'r1')).rejects.toBeInstanceOf(ConflictAppException);
    await expect(admin.reindex('p1', 'r1')).rejects.toMatchObject({ prefix: 'knowledge.disabled' });
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(audit.audited).not.toHaveBeenCalled();
  });
  it('AC-11: never wakes when audit rejects', async () => {
    const { admin, audit, queue } = build();
    audit.audited.mockRejectedValue(new Error('audit failed'));
    await expect(admin.reindex('p1', 'r1')).rejects.toThrow('audit failed');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
  it('AC-12: saves disabled patterns without listing or waking repos', async () => {
    const { admin, index, queue } = build(false);
    expect(await admin.savePatterns('p1', ['docs/**/*.md'])).toEqual({ patterns: ['docs/**/*.md'], custom: true, queued: 0 });
    expect(index.savePatterns).toHaveBeenCalledExactlyOnceWith('p1', ['docs/**/*.md']);
    expect(index.listProjectRepos).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
  it('AC-13: queues every repo once and restores effective defaults', async () => {
    const { admin, index, queue } = build(true, [{ id: 'r1' }, { id: 'r2' }]);
    expect(await admin.savePatterns('p1', null)).toEqual({ patterns: [...DEFAULT_KNOWLEDGE_PATTERNS], custom: false, queued: 2 });
    expect(index.savePatterns).toHaveBeenCalledExactlyOnceWith('p1', null);
    expect(queue.enqueue.mock.calls).toEqual([['r1', 'admin'], ['r2', 'admin']]);
  });
  it('audits a reindex before its commit-safe wake', async () => {
    const { admin, index, audit, queue } = build();
    await withCommittedEffects(async () => {
      expect(await admin.reindex('p1', 'r1')).toEqual({ queued: true });
      expect(index.resolveProjectRepo).toHaveBeenCalledWith('p1', { repoId: 'r1' });
      expect(audit.audited.mock.calls[0][1](undefined)).toEqual({ key: 'fleet.knowledge.repo.reindex', resourceType: 'fleet-repo', resourceId: 'r1', projectId: 'p1', summary: 'reindex queued' });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith('r1', 'admin');
  });
  it('drops all wakes on rollback and never wakes a rejected patterns save', async () => {
    const { admin, index, queue } = build();
    await expect(withCommittedEffects(async () => { await admin.savePatterns('p1', null); throw new Error('rollback'); })).rejects.toThrow('rollback');
    index.savePatterns.mockRejectedValue(new Error('save failed'));
    await expect(admin.savePatterns('p1', null)).rejects.toThrow('save failed');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
