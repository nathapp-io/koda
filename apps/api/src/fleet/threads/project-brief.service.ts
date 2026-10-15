import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { capText, maskSecrets } from '../assistant/assistant-tool-safety';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { FLEET_REPO_REPOSITORY, type FleetRepoRecord, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';

/** Injection token for the clock this service reads; tests provide a fake (spec 1c-D4). */
export const PROJECT_BRIEF_CLOCK = Symbol('PROJECT_BRIEF_CLOCK');

/** The repository's own context file, then the conventional agent file (spec 1c-D3). */
const CONTEXT_FILE = '.nax/context.md';
const FALLBACK_FILE = 'AGENTS.md';
/** A cached read is served unchanged for this long before the branch head is re-checked (spec 1c-D4). */
const CACHE_TTL_MS = 300_000;
/** Rule api-core: caches need a size cap; the entry with the oldest `checkedAt` goes first (spec 1c-D4). */
const CACHE_MAX_ENTRIES = 200;
/** Repository context never blocks a message for longer than this (spec 1c-D5). */
const READ_TIMEOUT_MS = 3_000;
/** 1c-R3: the cap holds after masking; koda's own `.nax/context.md` is 9411 bytes. */
const MAX_CONTEXT_BYTES = 10_240;

const GITHUB_PROVIDER = 'github';

type UnavailableReason = 'no repository' | 'not a GitHub repository' | 'no installation' | 'no context file' | 'timeout' | 'read failed';

/** What one GitHub read found at one commit: `path` and `text` are null when neither file exists. */
interface BriefRead {
  sha: string;
  path: string | null;
  text: string | null;
}

interface BriefCacheEntry extends BriefRead {
  checkedAt: number;
}

/** The read lost the race against `READ_TIMEOUT_MS` (1c-D5). */
const TIMED_OUT = Symbol('PROJECT_BRIEF_TIMED_OUT');

const unavailable = (reason: UnavailableReason): string => `Repository context: unavailable (${reason})`;

/**
 * Fleet S5b §1c (US-002): the repository section of a thread's instructions.
 *
 * Reads `.nax/context.md` (falling back to `AGENTS.md`) at the repository's default branch head with a
 * repo-scoped GitHub App token, masks and caps the text, and caches the result per repository id (spec 1c-D3..D6).
 * It never throws: a lookup, timeout or forge failure degrades to the cached text, marked `, cached`, or to a
 * one-line `unavailable` section, so a message always reaches the agent (1c-D5). The token lives only inside the
 * read: it is never stored in the cache, logged or returned.
 */
@Injectable()
export class ProjectBriefService {
  private readonly logger = new Logger(ProjectBriefService.name);
  private readonly cache = new Map<string, BriefCacheEntry>();
  private readonly now: () => number;

  constructor(
    private readonly github: GitHubAppClient,
    @Inject(FLEET_REPO_REPOSITORY) private readonly repos: IFleetRepoRepository,
    @Optional() @Inject(PROJECT_BRIEF_CLOCK) now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /**
   * The repository context section for `repoId`, or a one-line reason it is unavailable. `null` (a PROJECT
   * thread of a project without a fleet repo) answers `no repository` without a lookup or a forge call.
   */
  async resolveRepoContext(repoId: string | null): Promise<string> {
    if (repoId === null) return unavailable('no repository');
    try {
      const repo = await this.repos.findById(repoId);
      if (!repo) return unavailable('no repository');
      if (repo.provider !== GITHUB_PROVIDER) return unavailable('not a GitHub repository');
      const installationId = repo.githubInstallationId;
      if (installationId === null) return unavailable('no installation');
      return await this.contextFor(repoId, repo, installationId);
    } catch (error) {
      this.logFailure(repoId, 'read failed', error);
      return unavailable('read failed');
    }
  }

  private async contextFor(repoId: string, repo: FleetRepoRecord, installationId: bigint): Promise<string> {
    const cached = this.cache.get(repoId);
    if (cached && this.now() - cached.checkedAt < CACHE_TTL_MS) return this.section(repo, cached, false);

    let read: BriefRead | typeof TIMED_OUT;
    try {
      read = await this.readWithinTimeout(repo, installationId, cached);
    } catch (error) {
      this.logFailure(repoId, 'read failed', error);
      return this.afterFailure(repo, cached, 'read failed');
    }
    if (read === TIMED_OUT) {
      this.logFailure(repoId, 'timeout');
      return this.afterFailure(repo, cached, 'timeout');
    }
    const entry: BriefCacheEntry = { ...read, checkedAt: this.now() };
    this.remember(repoId, entry);
    return this.section(repo, entry, false);
  }

  /** The cached text when the previous read found one (possibly stale), the failure reason otherwise. */
  private afterFailure(repo: FleetRepoRecord, cached: BriefCacheEntry | undefined, reason: UnavailableReason): string {
    return cached && cached.text !== null ? this.section(repo, cached, true) : unavailable(reason);
  }

  private section(repo: FleetRepoRecord, entry: BriefCacheEntry, cached: boolean): string {
    if (entry.path === null || entry.text === null) return unavailable('no context file');
    const marker = cached ? ', cached' : '';
    return `Repository context (${repo.owner}/${repo.name} ${entry.path} @ ${entry.sha.slice(0, 7)}${marker}):\n${entry.text}`;
  }

  /** The forge read, bounded by `READ_TIMEOUT_MS`; the losing side of the race stays silent. */
  private async readWithinTimeout(repo: FleetRepoRecord, installationId: bigint, cached?: BriefCacheEntry): Promise<BriefRead | typeof TIMED_OUT> {
    const work = this.read(repo, installationId, cached);
    void work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async read(repo: FleetRepoRecord, installationId: bigint, cached?: BriefCacheEntry): Promise<BriefRead> {
    const { token } = await this.github.mintInstallationToken(installationId, repo.name);
    const sha = await this.github.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch);
    // The head is the cache key (1c-D4): an unchanged commit reuses the files read for it.
    if (cached && cached.sha === sha) return { sha, path: cached.path, text: cached.text };
    const context = await this.readFile(token, repo, CONTEXT_FILE, sha);
    if (context !== null) return { sha, path: CONTEXT_FILE, text: context };
    const fallback = await this.readFile(token, repo, FALLBACK_FILE, sha);
    if (fallback !== null) return { sha, path: FALLBACK_FILE, text: fallback };
    return { sha, path: null, text: null };
  }

  /** `null` when the file is absent or holds nothing but whitespace. Masked first, capped second (1c-D6). */
  private async readFile(token: string, repo: FleetRepoRecord, path: string, sha: string): Promise<string | null> {
    const file = await this.github.getFile(token, repo.owner, repo.name, path, sha);
    if (!file) return null;
    const text = file.content.toString('utf8');
    if (text.trim().length === 0) return null;
    return capText(maskSecrets(text), MAX_CONTEXT_BYTES);
  }

  private remember(repoId: string, entry: BriefCacheEntry): void {
    this.cache.set(repoId, entry);
    if (this.cache.size <= CACHE_MAX_ENTRIES) return;
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, value] of this.cache) {
      if (value.checkedAt < oldestAt) {
        oldestAt = value.checkedAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) this.cache.delete(oldestId);
  }

  private logFailure(repoId: string, reason: UnavailableReason, error?: unknown): void {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    this.logger.warn(`repository context unavailable for repository ${repoId} (${reason})${detail}`);
  }
}
