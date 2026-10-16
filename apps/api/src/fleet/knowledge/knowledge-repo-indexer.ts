import { Inject, Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from '../../rag/embedding.service';
import { RagService } from '../../rag/rag.service';
import type { LanceRecord } from '../../rag/lance-table-manager';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { KnowledgeChunkStore } from './knowledge-chunk-store';
import { selectIndexableEntries } from './knowledge-allowlist';
import { chunkMarkdown } from './markdown-chunker';
import { KNOWLEDGE_INDEX_REPOSITORY, IKnowledgeIndexRepository, KnowledgeFileState, KnowledgeFinishResult, KnowledgeRepoRef } from './knowledge-index.domain';

export interface IndexPassResult {
  status: 'indexed' | 'unchanged' | 'skipped' | 'failed' | 'busy';
  reason?: string;
}

export const KNOWLEDGE_INDEX_CLOCK = Symbol('KNOWLEDGE_INDEX_CLOCK');
const LEASE_MS = 900_000;
/** One embedding request holds at most this many chunk contents (Ollama's batch route). */
export const KNOWLEDGE_EMBED_BATCH = 16;
/** One embedding request's ceiling; a batch that exceeds it costs the whole batch with no per-chunk retry. */
export const EMBED_REQUEST_TIMEOUT_MS = 60_000;
/**
 * How long one file may spend embedding. Below `LEASE_MS` on purpose: a file commits and renews the pass lease
 * after its embedding work, so the deadline keeps the next renewal on time instead of pausing an already-held lease.
 */
export const FILE_EMBED_DEADLINE_MS = 300_000;

/** An embedding request's outcome: the vectors, or why the batch produced none. */
type EmbedOutcome<T> = { kind: 'value'; value: T } | { kind: 'failed' } | { kind: 'timedout' };

/** One default-branch pass. All writes are serial, including the renewal between file commits. */
@Injectable()
export class KnowledgeRepoIndexer {
  private readonly logger = new Logger(KnowledgeRepoIndexer.name);

  constructor(
    @Inject(KNOWLEDGE_INDEX_REPOSITORY) private readonly state: IKnowledgeIndexRepository,
    private readonly github: GitHubAppClient,
    private readonly store: KnowledgeChunkStore,
    private readonly embeddings: EmbeddingService,
    private readonly rag: RagService,
    @Inject(KNOWLEDGE_INDEX_CLOCK) private readonly clock: () => number = Date.now,
  ) {}

  async indexRepo(repoId: string, now = new Date()): Promise<IndexPassResult> {
    const repo = await this.state.findRepo(repoId);
    if (!repo) return { status: 'failed', reason: 'unknown repo' };
    let files = new Map<string, KnowledgeFileState>();
    let skippedCount = 0;
    const finish = (result: Pick<KnowledgeFinishResult, 'status' | 'lastError'> & Partial<KnowledgeFinishResult>) => this.state.finish(repoId, {
      projectId: repo.projectId,
      fileCount: files.size,
      chunkCount: [...files.values()].reduce((sum, file) => sum + file.chunkCount, 0),
      unembeddedCount: [...files.values()].reduce((sum, file) => sum + file.unembeddedCount, 0),
      skippedCount,
      finishedAt: new Date(this.clock()),
      leaseUntil: null,
      ...result,
    });
    if (repo.provider !== 'github' || repo.githubInstallationId === null) {
      const reason = repo.provider !== 'github' ? 'not a GitHub repository' : 'no installation';
      await finish({ status: 'skipped', lastError: reason });
      return { status: 'skipped', reason };
    }
    if (!await this.state.claim(repoId, repo.projectId, now, LEASE_MS)) return { status: 'busy' };
    let token: string | undefined;
    let previousSha: string | null = null;
    let finishedIdle = false;
    try {
      const [previousStates, previousFiles] = await Promise.all([this.state.listStates(repo.projectId), this.state.listFiles(repoId)]);
      files = new Map(previousFiles.map(file => [file.path, file]));
      const previous = previousStates.find(state => state.repoId === repoId);
      previousSha = previous?.indexedSha ?? null;
      skippedCount = previous?.skippedCount ?? 0;
      token = (await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name)).token;
      const head = await this.github.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch);
      if (head === previous?.indexedSha && previousFiles.every(file => file.unembeddedCount === 0)) {
        await finish({ status: 'idle', lastError: previous.lastError, fileCount: previous.fileCount,
          chunkCount: previous.chunkCount, unembeddedCount: previous.unembeddedCount });
        return { status: 'unchanged' };
      }
      const tree = await this.github.getTree(token, repo.owner, repo.name, head, true);
      if (tree.truncated) throw new Error('tree truncated');
      const selection = selectIndexableEntries(tree.entries);
      skippedCount = selection.skipped;
      const kept = new Set(selection.kept.map(entry => entry.path));
      let mutated = false;
      // One fetch at a time (within the four-fetch ceiling) bounds memory and guarantees that a lost
      // renewal cannot leave background tasks writing rows or producing unhandled rejections.
      for (const entry of selection.kept) {
        const existing = files.get(entry.path);
        if (existing?.blobSha === entry.sha && existing.unembeddedCount === 0) continue;
        const file = await this.github.getFile(token, repo.owner, repo.name, entry.path, head);
        if (file === null) {
          await this.store.deleteFile(repo.projectId, this.sourceId(repoId, entry.path));
          if (!await this.state.renew(repoId, new Date(this.clock() + LEASE_MS), now)) return { status: 'failed', reason: 'lease lost' };
          await this.state.deleteFile(repoId, entry.path);
          files.delete(entry.path);
        } else {
          const { rows, unembeddedCount } = await this.rows(repo, entry.path, entry.sha, head, file.content.toString('utf8'), now);
          await this.store.replaceFile(repo.projectId, this.sourceId(repoId, entry.path), rows);
          if (!await this.state.renew(repoId, new Date(this.clock() + LEASE_MS), now)) return { status: 'failed', reason: 'lease lost' };
          const next = { repoId, path: entry.path, blobSha: entry.sha, chunkCount: rows.length, unembeddedCount };
          await this.state.upsertFile(next);
          files.set(entry.path, next);
        }
        mutated = true;
      }
      for (const path of files.keys()) {
        if (kept.has(path)) continue;
        await this.store.deleteFile(repo.projectId, this.sourceId(repoId, path));
        if (!await this.state.renew(repoId, new Date(this.clock() + LEASE_MS), now)) return { status: 'failed', reason: 'lease lost' };
        await this.state.deleteFile(repoId, path);
        files.delete(path);
        mutated = true;
      }
      await finish({ status: 'idle', indexedSha: head, lastError: selection.capMessage });
      finishedIdle = true;
      if (mutated) await this.rag.optimizeTable(repo.projectId);
      return { status: 'indexed' };
    } catch (error) {
      const message = error instanceof RepoCheckException ? error.reason : error instanceof Error ? error.message : String(error);
      const reason = (token ? message.split(token).join('[REDACTED]') : message).slice(0, 500);
      // Optimization runs after the idle finish; restore the checkpoint if it failed.
      await finish({ status: 'failed', lastError: reason, ...(finishedIdle ? { indexedSha: previousSha } : {}) });
      return { status: 'failed', reason };
    }
  }

  private sourceId(repoId: string, path: string): string { return `repo:${repoId}:${path}`; }

  private async rows(repo: KnowledgeRepoRef, path: string, blobSha: string, sha: string, text: string, now: Date): Promise<{ rows: LanceRecord[]; unembeddedCount: number }> {
    const startedAt = this.clock();
    const chunks = chunkMarkdown({ path, text });
    const contents = chunks.map(chunk => `${repo.owner}/${repo.name} · ${path}${chunk.headingPath ? ` · ${chunk.headingPath}` : ''}\n${chunk.abstract}\n\n${chunk.text}`);
    const vectors = await this.embedAll(contents, startedAt);
    const unembeddedCount = vectors.filter(vector => vector === null).length;
    if (unembeddedCount > 0) {
      // Do not log provider errors: they may contain credentials or arbitrary remote response bodies.
      this.logger.warn(`Knowledge file embedding failed for ${unembeddedCount} of ${chunks.length} chunks (repo ${repo.id}); storing unembedded chunks`);
    }
    const sourceId = this.sourceId(repo.id, path);
    return {
      unembeddedCount,
      rows: chunks.map((chunk, index) => {
        const vector = vectors[index];
        return {
          id: `${sourceId}#${chunk.chunkIndex}`, source: 'repo', source_id: sourceId,
          content: contents[index], vector: vector ?? Array(this.embeddings.dimensions).fill(0),
          metadata: JSON.stringify({ repoId: repo.id, owner: repo.owner, name: repo.name, path, sha, blobSha, ...chunk, chunkCount: chunks.length }),
          created_at: now.toISOString(), provider: vector === null ? 'none' : this.embeddings.providerName, model: vector === null ? '' : this.embeddings.modelName,
        };
      }),
    };
  }

  /**
   * Embeds the file's chunk contents in order, one batch of `KNOWLEDGE_EMBED_BATCH` at a time. The batches are
   * sequential on purpose (an exception to the `Promise.all` guidance): they share one embedding server and one
   * file deadline, so parallel requests would compete for the same capacity and could all time out together.
   * `null` marks a chunk that stays unembedded.
   */
  private async embedAll(contents: string[], startedAt: number): Promise<Array<number[] | null>> {
    const vectors: Array<number[] | null> = [];
    for (let start = 0; start < contents.length; start += KNOWLEDGE_EMBED_BATCH) {
      vectors.push(...await this.embedBatch(contents.slice(start, start + KNOWLEDGE_EMBED_BATCH), startedAt));
    }
    return vectors;
  }

  /** One batch: past the deadline every chunk is unembedded; a timed-out batch is never retried per chunk. */
  private async embedBatch(batch: string[], startedAt: number): Promise<Array<number[] | null>> {
    if (this.pastDeadline(startedAt)) return batch.map(() => null);
    const outcome = await this.limited(() => this.embeddings.embedBatch(batch));
    if (outcome.kind === 'timedout') return batch.map(() => null);
    if (outcome.kind === 'value' && validVectors(outcome.value, batch.length, this.embeddings.dimensions)) return outcome.value;
    return this.embedOneByOne(batch, startedAt);
  }

  /** A rejected or malformed batch: each chunk alone, under the same deadline and request timeout. */
  private async embedOneByOne(batch: string[], startedAt: number): Promise<Array<number[] | null>> {
    const vectors: Array<number[] | null> = [];
    for (const content of batch) {
      if (this.pastDeadline(startedAt)) { vectors.push(null); continue; }
      const outcome = await this.limited(() => this.embeddings.embed(content));
      vectors.push(outcome.kind === 'value' && isVectorOf(outcome.value, this.embeddings.dimensions) ? outcome.value : null);
    }
    return vectors;
  }

  private pastDeadline(startedAt: number): boolean {
    return this.clock() - startedAt >= FILE_EMBED_DEADLINE_MS;
  }

  /** Races one embedding call against `EMBED_REQUEST_TIMEOUT_MS`. Never throws: the caller decides the cost. */
  private async limited<T>(call: () => Promise<T>): Promise<EmbedOutcome<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const value = await Promise.race([
        call(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('embedding request timeout')); }, EMBED_REQUEST_TIMEOUT_MS); }),
      ]);
      return { kind: 'value', value };
    } catch {
      // The provider's error is dropped here, never logged or persisted: it may carry credentials.
      return timedOut ? { kind: 'timedout' } : { kind: 'failed' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** D3 validation: every content produced exactly one vector of the configured width. */
function validVectors(vectors: unknown, count: number, dimensions: number): vectors is number[][] {
  return Array.isArray(vectors) && vectors.length === count && vectors.every(vector => isVectorOf(vector, dimensions));
}

/** A resolved vector of the configured width; a malformed resolution is a failed chunk, never a crash. */
function isVectorOf(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions;
}
