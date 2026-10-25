/**
 * Fleet S5b US-002 — `KnowledgeIndexService` is the module's public face over the saved patterns: the stored list
 * wins, an absent row means the default corpus, and saving null clears it. Direct instantiation: the service has
 * only constructor dependencies and no Nest lifecycle.
 */
import type { IKnowledgeIndexRepository } from './knowledge-index.domain';
import { KnowledgeIndexService } from './knowledge-index.service';
import { DEFAULT_KNOWLEDGE_PATTERNS } from './knowledge-patterns';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

function harness(stored: string[] | null = null) {
  const repository = {
    findProjectPatterns: vi.fn(async () => stored),
    saveProjectPatterns: vi.fn(async (_projectId: string, _patterns: string[] | null) => undefined),
  };
  const service = new KnowledgeIndexService(repository as unknown as IKnowledgeIndexRepository, mockAuditRecorder);
  return { service, repository };
}

describe('KnowledgeIndexService.getPatterns (US-002)', () => {
  it('answers the default corpus with custom false for a project that saved none', async () => {
    const { service, repository } = harness(null);

    const result = await service.getPatterns('p1');

    expect(repository.findProjectPatterns).toHaveBeenCalledWith('p1');
    expect(result).toEqual({ patterns: [...DEFAULT_KNOWLEDGE_PATTERNS], custom: false });
  });

  it('answers the stored list with custom true', async () => {
    const { service } = harness(['handbook/*.md']);

    expect(await service.getPatterns('p1')).toEqual({ patterns: ['handbook/*.md'], custom: true });
  });

  it('hands out a copy of the default corpus, so a caller cannot mutate the module constant', async () => {
    const { service } = harness(null);

    const first = await service.getPatterns('p1');
    first.patterns.push('docs/*.md');

    expect(await service.getPatterns('p1')).toEqual({ patterns: [...DEFAULT_KNOWLEDGE_PATTERNS], custom: false });
  });
});

describe('KnowledgeIndexService.savePatterns (US-002)', () => {
  it('stores a list and answers it as the custom one', async () => {
    const { service, repository } = harness();

    const result = await service.savePatterns('p1', ['handbook/*.md']);

    expect(repository.saveProjectPatterns).toHaveBeenCalledWith('p1', ['handbook/*.md']);
    expect(result).toEqual({ patterns: ['handbook/*.md'], custom: true });
  });

  it('clears the row for null and answers the default corpus', async () => {
    const { service, repository } = harness();

    const result = await service.savePatterns('p1', null);

    expect(repository.saveProjectPatterns).toHaveBeenCalledWith('p1', null);
    expect(result).toEqual({ patterns: [...DEFAULT_KNOWLEDGE_PATTERNS], custom: false });
  });
});
