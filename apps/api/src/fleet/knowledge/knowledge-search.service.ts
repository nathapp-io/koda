import { Injectable } from '@nestjs/common';
import { OUTCOME_SOURCE, REPO_SOURCE } from '../../rag/lance-table-manager';
import { EmbeddingService } from '../../rag/embedding.service';
import { KnowledgeChunkRow, KnowledgeChunkStore } from './knowledge-chunk-store';
import type { KnowledgeJobInfo } from './knowledge-index.domain';
import { KnowledgeIndexService } from './knowledge-index.service';

/** 1c-c-D7: the reciprocal rank fusion constant, one score contribution per leg a row appears in. */
const RRF_K = 60;
/** Rows each leg asks for; a `pathPrefix` needs a wider page because the prefix filters after the legs. */
const LEG_ROWS = 50;
const PREFIXED_LEG_ROWS = 200;
const SNIPPET_CHARS = 400;
/**
 * S5b 3c-2-D9: how many outcome hits one search describes. The window bounds the ids sent to `describeJobs`
 * (which itself caps its read at 200 jobs); an outcome hit past it is dropped from the answer.
 */
const MAX_DESCRIBED_OUTCOME_HITS = 200;

export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 50;
export const KNOWLEDGE_SEARCH_MAX_QUERY_LENGTH = 500;
export const KNOWLEDGE_SEARCH_MAX_PREFIX_LENGTH = 300;

/** `owner/name` as the search body spells it (the same shape a 1c-c-R7 citation carries). */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** S5b 3c-2-D9: the indexed sources a search may read. `all` is what a body without the field asks for. */
export type KnowledgeSource = 'docs' | 'outcomes' | 'all';
const KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = ['docs', 'outcomes', 'all'];

/** S5b 3c-2-D9: the source of one hit, read off the row's `source_id` namespace (3c-2-D6). */
export type KnowledgeHitSource = 'repo' | 'outcome';

/** S5b 3c-2-D9: the outcome file a job read names, and the outcome kind its `source_id` carries (3c-2-D6). */
const OUTCOME_KIND_BY_PATH: Readonly<Record<string, string>> = {
  'feature-report.md': 'report',
  'decisions.jsonl': 'decisions',
};

/** One search result: the chunk's citation fields plus its fused score. */
export interface KnowledgeHit {
  /** Which indexed source the chunk came from; an outcome hit carries the job fields below as well. */
  source: KnowledgeHitSource;
  repoId: string;
  owner: string;
  name: string;
  path: string;
  sha: string;
  anchor: string;
  headingPath: string;
  title: string;
  abstract: string;
  snippet: string;
  status?: string;
  supersededBy?: string;
  score: number;
  /** Outcome hits only: the job the chunk came from and its current state, read per search (3c-2-R1). */
  jobId?: string;
  feature?: string;
  outcomeKind?: string;
  jobState?: string;
  prState?: string | null;
  prUrl?: string | null;
}

export interface KnowledgeSearchQuery {
  projectId: string;
  query: string;
  /** Which sources to search: repository docs, run outcomes, or both. Defaults to `all` (S5b 3c-2-D9). */
  source?: KnowledgeSource;
  /** Restricts the search to one of the project's repositories (1c-c-D7 repo clause). */
  repoId?: string;
  pathPrefix?: string;
  limit: number;
}

export interface KnowledgeSearchResult {
  lexicalOnly: boolean;
  empty: boolean;
  hits: KnowledgeHit[];
}

/** The search body after validation: `repo` is still `owner/name`, the route resolves it to a repo id. */
export interface KnowledgeSearchBody {
  query: string;
  source?: KnowledgeSource;
  repo?: string;
  pathPrefix?: string;
  limit: number;
}

/** A rejected body carries `reason` (the field to report) and no value; an accepted one the opposite. */
export interface KnowledgeSearchBodyParse {
  ok: boolean;
  value?: KnowledgeSearchBody;
  reason?: string;
}

/**
 * Validates a `POST projects/:slug/knowledge/search` body (1c-c-D12) without throwing, so the HTTP boundary
 * keeps the i18n decision: `ProjectKnowledgeController` turns a rejection into `knowledge.input` (400).
 */
export function parseKnowledgeSearchInput(body: unknown): KnowledgeSearchBodyParse {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'body' };
  const raw = body as Record<string, unknown>;

  const query = raw['query'];
  if (typeof query !== 'string' || query.length < 1 || query.length > KNOWLEDGE_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, reason: 'query' };
  }

  const rawSource = raw['source'];
  if (rawSource !== undefined && !isKnowledgeSource(rawSource)) return { ok: false, reason: 'source' };
  const source = rawSource as KnowledgeSource | undefined;

  const rawRepo = raw['repo'];
  if (rawRepo !== undefined && (typeof rawRepo !== 'string' || !REPO_PATTERN.test(rawRepo))) {
    return { ok: false, reason: 'repo' };
  }
  const repo = typeof rawRepo === 'string' ? rawRepo : undefined;

  const rawPathPrefix = raw['pathPrefix'];
  if (rawPathPrefix !== undefined && !isValidPathPrefix(rawPathPrefix)) return { ok: false, reason: 'pathPrefix' };
  const pathPrefix = typeof rawPathPrefix === 'string' ? rawPathPrefix : undefined;

  const rawLimit = raw['limit'];
  if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > KNOWLEDGE_SEARCH_MAX_LIMIT)) {
    return { ok: false, reason: 'limit' };
  }

  return {
    ok: true,
    value: {
      query,
      ...(source === undefined ? {} : { source }),
      ...(repo === undefined ? {} : { repo }),
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
      limit: rawLimit === undefined ? KNOWLEDGE_SEARCH_DEFAULT_LIMIT : (rawLimit as number),
    },
  };
}

/** S5b 3c-2-D9: a source value must be one of the three, so an unknown one is refused, never defaulted. */
function isKnowledgeSource(value: unknown): value is KnowledgeSource {
  return typeof value === 'string' && (KNOWLEDGE_SOURCES as readonly string[]).includes(value);
}

/** A path prefix is relative, at most 300 characters, and never walks up (1c-c-D12). */
function isValidPathPrefix(value: unknown): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= KNOWLEDGE_SEARCH_MAX_PREFIX_LENGTH
    && !value.startsWith('/') && !value.includes('..');
}

/**
 * The chunk text of a hit, cut to the snippet length. The row's metadata is a JSON cast rather than a validated
 * shape, so a chunk written before the `text` field existed yields an empty snippet instead of throwing.
 */
function snippetOf(text: string | undefined): string {
  return typeof text === 'string' ? text.slice(0, SNIPPET_CHARS) : '';
}

/** The two predicates of one source family, each in its lexical and its vector form (S5b 3c-2-D9). */
function sourcePredicates(sourceValue: string, repoId: string | undefined): { lexical: string; vector: string } {
  // The repo clause is the 1c-c-1 form: the ids of that repository's own chunks, whose namespace is its source.
  const repoClause = repoId === undefined ? '' : ` AND source_id LIKE '${sourceValue}:${repoId}:%'`;
  return {
    lexical: `source = '${sourceValue}'${repoClause}`,
    vector: `source = '${sourceValue}' AND provider != 'none'${repoClause}`,
  };
}

/**
 * The lexical predicate of the asked sources: the doc form for `docs`, the outcome form for `outcomes`, and the
 * union of both for `all`. The vector predicate is the same shape with the 1c-c-D6 unembedded clause added.
 */
function lexicalPredicate(source: KnowledgeSource, repoId: string | undefined): string {
  const doc = sourcePredicates(REPO_SOURCE, repoId).lexical;
  const outcome = sourcePredicates(OUTCOME_SOURCE, repoId).lexical;
  return source === 'docs' ? doc : source === 'outcomes' ? outcome : `(${doc}) OR (${outcome})`;
}

function vectorPredicate(source: KnowledgeSource, repoId: string | undefined): string {
  const doc = sourcePredicates(REPO_SOURCE, repoId).vector;
  const outcome = sourcePredicates(OUTCOME_SOURCE, repoId).vector;
  return source === 'docs' ? doc : source === 'outcomes' ? outcome : `(${doc}) OR (${outcome})`;
}

/** One fused row and its score. */
interface FusedEntry {
  row: KnowledgeChunkRow;
  score: number;
}

/** S5b 3c-2-D9: an outcome chunk is the one whose `source_id` is in the `outcome:` namespace (3c-2-D6). */
function isOutcomeRow(row: KnowledgeChunkRow): boolean {
  return row.sourceId.startsWith(`${OUTCOME_SOURCE}:`);
}

/** The window of outcome hits one search describes, and the distinct job ids inside it. */
interface OutcomeWindow {
  rows: Set<string>;
  jobIds: string[];
}

/**
 * S5b 3c-2-D9: the outcome hits of the fused answer that may be described — the first
 * `MAX_DESCRIBED_OUTCOME_HITS` in rank order, so one search never asks for more job ids than the repository's
 * own cap. A row without a `jobId` can name no job and stays out of the window's ids (it cannot be fenced in).
 */
function outcomeWindow(entries: FusedEntry[]): OutcomeWindow {
  const rows = new Set<string>();
  const seenJobs = new Set<string>();
  const jobIds: string[] = [];
  for (const { row } of entries) {
    if (!isOutcomeRow(row) || rows.size >= MAX_DESCRIBED_OUTCOME_HITS) continue;
    rows.add(row.id);
    if (row.jobId !== undefined && !seenJobs.has(row.jobId)) {
      seenJobs.add(row.jobId);
      jobIds.push(row.jobId);
    }
  }
  return { rows, jobIds };
}

/**
 * Hybrid search over the project's indexed chunks (1c-c-D7, S5b 3c-2-D9). Repository and outcome chunks share
 * the project's LanceDB table with ticket documents, so every leg is restricted to the asked knowledge sources
 * and ticket search and its weighted fusion are untouched (1c-c-R6). The module exports this service;
 * `koda_kb_search` and the search route read through it.
 */
@Injectable()
export class KnowledgeSearchService {
  constructor(
    private readonly store: KnowledgeChunkStore,
    private readonly embedding: EmbeddingService,
    private readonly index: KnowledgeIndexService,
  ) {}

  /** The file's chunks, in `chunkIndex` order; the only read path `koda_get_doc` uses (1c-c-D13). */
  readDoc(projectId: string, repoId: string, path: string): Promise<KnowledgeChunkRow[]> {
    return this.store.readFile(projectId, `repo:${repoId}:${path}`);
  }

  /**
   * S5b 3c-2-D9: one of a job's two outcome files, read back by `koda_get_doc` (US-006). The job is described
   * first, so a foreign or deleted job answers no rows and the store is never read; a path that is not one of
   * the two files the outcome pass writes names no kind, and therefore no rows either.
   */
  async readOutcome(projectId: string, jobId: string, path: string): Promise<KnowledgeChunkRow[]> {
    const kind = OUTCOME_KIND_BY_PATH[path];
    if (kind === undefined) return [];
    const [job] = await this.index.describeJobs(projectId, [jobId]);
    if (job === undefined) return [];
    return this.store.readFile(projectId, `${OUTCOME_SOURCE}:${job.repoId}:${jobId}:${kind}`);
  }

  async search(input: KnowledgeSearchQuery): Promise<KnowledgeSearchResult> {
    const source = input.source ?? 'all';
    const askRows = input.pathPrefix === undefined ? LEG_ROWS : PREFIXED_LEG_ROWS;
    // Both predicates carry the asked sources and the repo clause, so a narrowed search shortens the legs
    // instead of filtering afterwards. The vector leg skips chunks stored without an embedding (1c-c-D6).
    const [lexicalRows, vectorLeg] = await Promise.all([
      this.store.lexical(input.projectId, input.query, lexicalPredicate(source, input.repoId), askRows),
      this.vectorLeg(input.projectId, input.query, vectorPredicate(source, input.repoId), askRows),
    ]);

    const projectRepoIds = new Set((await this.index.listProjectRepos(input.projectId)).map((repo) => repo.id));
    const candidates = this.fuse(lexicalRows, vectorLeg.rows)
      // A deleted fleet repository's chunks stay in the table; the project's repositories decide what is readable.
      .filter((entry) => projectRepoIds.has(entry.row.repoId))
      // S5b 3c-2-D9: a path prefix names a document path, so it drops the outcome hits and keeps the doc hits
      // under it (3c-1). The cut to `limit` comes later, so a dropped hit frees its slot.
      .filter((entry) => input.pathPrefix === undefined
        || (!isOutcomeRow(entry.row) && entry.row.path.startsWith(input.pathPrefix)));

    const window = outcomeWindow(candidates);
    const described = new Map<string, KnowledgeJobInfo>();
    if (window.jobIds.length > 0) {
      for (const job of await this.index.describeJobs(input.projectId, window.jobIds)) described.set(job.jobId, job);
    }
    const hits = candidates
      // S5b 3c-2-D9: an outcome hit is kept only when the project still has its job — a job of another project,
      // a deleted one and one past the description window are all dropped here (US-005).
      .filter((entry) => !isOutcomeRow(entry.row)
        || (window.rows.has(entry.row.id) && described.has(entry.row.jobId ?? '')))
      .map((entry) => toHit(entry.row, entry.score, described.get(entry.row.jobId ?? '')))
      .filter((hit): hit is KnowledgeHit => hit !== null)
      // The cut comes last, so a dropped outcome hit never consumes a slot of the answer (3c-2-D9).
      .slice(0, input.limit);

    return {
      lexicalOnly: vectorLeg.skipped,
      // 1c-c-D7/S5b 3c-2-D9: `empty` means the project's table holds no row of the asked sources. Two empty legs
      // are not the same thing — the embedding can be down (no vector leg) and the lexical leg can miss every
      // stored row — so the table is asked directly, and only when no hit came back.
      empty: hits.length === 0 && !(await this.hasRows(input.projectId, source)),
      hits,
    };
  }

  /** S5b 3c-2-D9: whether the table holds a chunk of the asked sources; `all` is satisfied by either one. */
  private async hasRows(projectId: string, source: KnowledgeSource): Promise<boolean> {
    if (source === 'docs') return this.store.hasRepoRows(projectId);
    if (source === 'outcomes') return this.store.hasOutcomeRows(projectId);
    const [repo, outcome] = await Promise.all([this.store.hasRepoRows(projectId), this.store.hasOutcomeRows(projectId)]);
    return repo || outcome;
  }

  /**
   * The vector leg: the query embedding, then the nearest rows. A failed embedding skips the leg entirely
   * (1c-c-D7 failure handling) — a lexical-only answer beats a failed search.
   */
  private async vectorLeg(projectId: string, query: string, predicate: string, limit: number): Promise<{ rows: KnowledgeChunkRow[]; skipped: boolean }> {
    let embedding: number[];
    try {
      embedding = await this.embedding.embed(query);
    } catch {
      return { rows: [], skipped: true };
    }
    return { rows: await this.store.vector(projectId, embedding, predicate, limit), skipped: false };
  }

  /** Reciprocal rank fusion: `Σ 1 / (60 + rank)` over the legs a row appears in, ties broken by row id. */
  private fuse(lexical: KnowledgeChunkRow[], vector: KnowledgeChunkRow[]): FusedEntry[] {
    const byId = new Map<string, FusedEntry>();
    const add = (row: KnowledgeChunkRow, rank: number): void => {
      const entry = byId.get(row.id);
      if (entry) entry.score += 1 / (RRF_K + rank);
      else byId.set(row.id, { row, score: 1 / (RRF_K + rank) });
    };
    lexical.forEach((row, i) => add(row, i + 1));
    vector.forEach((row, i) => add(row, i + 1));
    return [...byId.values()].sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  }
}

/** The fields both sources share: the citation, the text and the fused score. */
function baseHit(row: KnowledgeChunkRow, score: number): Omit<KnowledgeHit, 'source'> {
  return {
    repoId: row.repoId,
    owner: row.owner,
    name: row.name,
    path: row.path,
    sha: row.sha,
    anchor: row.anchor,
    headingPath: row.headingPath,
    title: row.title,
    abstract: row.abstract,
    snippet: snippetOf(row.text),
    ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.supersededBy === undefined ? {} : { supersededBy: row.supersededBy }),
    score,
  };
}

/**
 * One fused row as a hit; an outcome row is enriched with the described job's current state. The project fence
 * upstream keeps only outcome rows whose job the repository answered, so a missing job (unreachable here) answers
 * no hit rather than an outcome hit with no job on it.
 */
function toHit(row: KnowledgeChunkRow, score: number, job: KnowledgeJobInfo | undefined): KnowledgeHit | null {
  if (!isOutcomeRow(row)) return { ...baseHit(row, score), source: 'repo' };
  if (job === undefined) return null;
  return {
    ...baseHit(row, score),
    source: 'outcome',
    jobId: job.jobId,
    feature: job.feature,
    outcomeKind: row.outcomeKind ?? '',
    jobState: job.state,
    prState: job.prState,
    prUrl: job.prUrl,
  };
}
