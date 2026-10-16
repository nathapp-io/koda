import { Injectable } from '@nestjs/common';
import { EmbeddingService } from '../../rag/embedding.service';
import { KnowledgeChunkRow, KnowledgeChunkStore } from './knowledge-chunk-store';
import { KnowledgeIndexService } from './knowledge-index.service';

/** 1c-c-D7: the reciprocal rank fusion constant, one score contribution per leg a row appears in. */
const RRF_K = 60;
/** Rows each leg asks for; a `pathPrefix` needs a wider page because the prefix filters after the legs. */
const LEG_ROWS = 50;
const PREFIXED_LEG_ROWS = 200;
const SNIPPET_CHARS = 400;

export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 50;
export const KNOWLEDGE_SEARCH_MAX_QUERY_LENGTH = 500;
export const KNOWLEDGE_SEARCH_MAX_PREFIX_LENGTH = 300;

/** `owner/name` as the search body spells it (the same shape a 1c-c-R7 citation carries). */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** One search result: the chunk's citation fields plus its fused score. */
export interface KnowledgeHit {
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
}

export interface KnowledgeSearchQuery {
  projectId: string;
  query: string;
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
      ...(repo === undefined ? {} : { repo }),
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
      limit: rawLimit === undefined ? KNOWLEDGE_SEARCH_DEFAULT_LIMIT : (rawLimit as number),
    },
  };
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

/**
 * Hybrid repository-doc search (1c-c-D7). Repository chunks share the project's LanceDB table with ticket
 * documents, so every leg is restricted to `source = 'repo'`: ticket search and its weighted fusion are
 * untouched (1c-c-R6). The module exports this service; `koda_get_doc` and the search route read through it.
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

  async search(input: KnowledgeSearchQuery): Promise<KnowledgeSearchResult> {
    const askRows = input.pathPrefix === undefined ? LEG_ROWS : PREFIXED_LEG_ROWS;
    // Both predicates end with the repo clause, so a restricted search narrows the legs instead of filtering
    // afterwards. The vector leg skips chunks stored without an embedding (1c-c-D6).
    const repoClause = input.repoId === undefined ? '' : ` AND source_id LIKE 'repo:${input.repoId}:%'`;
    const [lexicalRows, vectorLeg] = await Promise.all([
      this.store.lexical(input.projectId, input.query, `source = 'repo'${repoClause}`, askRows),
      this.vectorLeg(input.projectId, input.query, `source = 'repo' AND provider != 'none'${repoClause}`, askRows),
    ]);

    const projectRepoIds = new Set((await this.index.listProjectRepos(input.projectId)).map((repo) => repo.id));
    const hits = this.fuse(lexicalRows, vectorLeg.rows)
      // A deleted fleet repository's chunks stay in the table; the project's repositories decide what is readable.
      .filter((entry) => projectRepoIds.has(entry.row.repoId))
      .filter((entry) => input.pathPrefix === undefined || entry.row.path.startsWith(input.pathPrefix))
      .slice(0, input.limit)
      .map((entry) => toHit(entry.row, entry.score));

    return {
      lexicalOnly: vectorLeg.skipped,
      // The store exposes no count, so "the table holds no repo row" is read off the legs: neither retrieval
      // path answered a row. A query that matches nothing still reaches the vector leg's nearest neighbours.
      empty: lexicalRows.length === 0 && vectorLeg.rows.length === 0,
      hits,
    };
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
  private fuse(lexical: KnowledgeChunkRow[], vector: KnowledgeChunkRow[]): Array<{ row: KnowledgeChunkRow; score: number }> {
    const byId = new Map<string, { row: KnowledgeChunkRow; score: number }>();
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

function toHit(row: KnowledgeChunkRow, score: number): KnowledgeHit {
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
