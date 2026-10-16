import { Inject, Injectable } from '@nestjs/common';
import {
  IKnowledgeIndexRepository, KNOWLEDGE_INDEX_REPOSITORY, KnowledgeProjectState, KnowledgeRepoRef,
} from './knowledge-index.domain';
import { DEFAULT_KNOWLEDGE_PATTERNS } from './knowledge-patterns';

export type { KnowledgeRepoRef } from './knowledge-index.domain';

export type KnowledgeRepoSelector = { repoId: string } | { owner: string; name: string };

/** US-002: the project's effective corpus patterns and whether they are its own. */
export interface KnowledgePatterns {
  patterns: string[];
  custom: boolean;
}

/** The module's public face over the state repository: controllers and other modules never inject the repository. */
@Injectable()
export class KnowledgeIndexService {
  constructor(@Inject(KNOWLEDGE_INDEX_REPOSITORY) private readonly repository: IKnowledgeIndexRepository) {}

  /** The repository only when it is one of the project's repositories; null for any other. */
  async resolveProjectRepo(projectId: string, ref: KnowledgeRepoSelector): Promise<KnowledgeRepoRef | null> {
    const repos = await this.repository.findProjectRepos(projectId);
    if ('repoId' in ref) return repos.find((r) => r.id === ref.repoId) ?? null;
    return repos.find((r) => r.owner === ref.owner && r.name === ref.name) ?? null;
  }

  listProjectRepos(projectId: string): Promise<KnowledgeRepoRef[]> {
    return this.repository.findProjectRepos(projectId);
  }

  /** The project's repositories joined with their index rows (null before a first pass). */
  async listProjectStates(projectId: string): Promise<KnowledgeProjectState[]> {
    const [repos, states] = await Promise.all([this.repository.findProjectRepos(projectId), this.repository.listStates(projectId)]);
    const byRepo = new Map(states.map((s) => [s.repoId, s]));
    return repos.map((repo) => ({ repo, state: byRepo.get(repo.id) ?? null }));
  }

  /** US-002: the stored list, else the default corpus with `custom: false`. */
  async getPatterns(projectId: string): Promise<KnowledgePatterns> {
    const stored = await this.repository.findProjectPatterns(projectId);
    return stored === null ? defaultPatterns() : { patterns: [...stored], custom: true };
  }

  /**
   * US-002: replaces the project's list (null clears it and restores the default corpus). The saved list is
   * returned as stored, so a caller never re-reads what it just wrote.
   */
  async savePatterns(projectId: string, patterns: string[] | null): Promise<KnowledgePatterns> {
    await this.repository.saveProjectPatterns(projectId, patterns);
    return patterns === null ? defaultPatterns() : { patterns: [...patterns], custom: true };
  }
}

/** A fresh copy: the response must not let a caller mutate the module's constant. */
function defaultPatterns(): KnowledgePatterns {
  return { patterns: [...DEFAULT_KNOWLEDGE_PATTERNS], custom: false };
}
