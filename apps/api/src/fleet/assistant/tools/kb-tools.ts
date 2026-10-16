import { NotFoundAppException } from '@nathapp/nestjs-common';
import { isSafeFilterValue } from '../../../rag/lance-table-manager';
import type { KnowledgeChunkRow } from '../../knowledge/knowledge-chunk-store';
import type { KnowledgeRepoRef } from '../../knowledge/knowledge-index.domain';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import {
  KNOWLEDGE_SEARCH_MAX_PREFIX_LENGTH,
  KNOWLEDGE_SEARCH_MAX_QUERY_LENGTH,
  type KnowledgeHit,
  type KnowledgeSearchService,
} from '../../knowledge/knowledge-search.service';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_GET_DOC, KODA_KB_SEARCH } from '../koda-tool-descriptors';

/**
 * Fleet S5b US-006 (1c-c-D13): the two documentation tools a thread agent reads a project's indexed docs with.
 * `koda_kb_search` answers citable chunks, `koda_get_doc` reads them back — always through the index, never from
 * GitHub, so a citation names the text that was indexed rather than a historical revision. The project is the
 * thread's own (S5b-R7): both tools resolve their repository inside `ctx.projectId`, so a foreign repository is
 * `not_found` rather than readable. Input is parsed by hand (1b-D5) and the descriptors' `inputSchema` is what
 * the model sees; both are `permission: { kind: 'member' }` (1b-D1), like the REST routes they read.
 */

/** The hits `koda_kb_search` answers when the caller does not choose (1c-c-D13); the route's ceiling is 50. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/** A document is answered in parts of at most this many characters (1c-c-D13). */
const MAX_PART_CHARS = 12_000;
const DEFAULT_PART = 1;
/** The empty project's answer: a distinct line, because "no results" would read as a failed search. */
const EMPTY_ANSWER = 'knowledge index is empty for this project';
const NO_HITS_ANSWER = 'no results';

/** `owner/name`, the same shape the search body and a citation carry. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** 1c-c-R7: `<owner>/<name>:<path>[@<sha>][#<anchor>]` — the citation `koda_kb_search` answers with. */
const CITATION_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+):([^@#]+)(?:@[0-9a-f]{7,40})?(?:#([a-z0-9_-]+))?$/;
/** A GitHub heading anchor, as the chunker writes it and a citation's `#` part spells it. */
const ANCHOR_PATTERN = /^[a-z0-9_-]+$/;

export interface KnowledgeToolDeps {
  search: KnowledgeSearchService;
  index: KnowledgeIndexService;
}

/** The `koda_kb_search` input after parsing: the query, the optional repository and prefix, and the hit limit. */
export interface KbSearchInput {
  query: string;
  repo?: string;
  pathPrefix?: string;
  limit: number;
}

/** The `koda_get_doc` input after parsing: one repository, one path, and the optional section and part. */
export interface GetDocInput {
  owner: string;
  name: string;
  path: string;
  anchor?: string;
  part?: number;
}

/** The input as a record; a missing key, a null and a non-object body all read as absent fields. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** A required 1- to `max`-character text. */
function requiredText(value: unknown, max: number, reason: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new ToolInputError(reason);
  return value;
}

/** An optional `owner/name`; absent and null are both "not given". */
function optionalRepo(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !REPO_PATTERN.test(value)) throw new ToolInputError('repo');
  return value;
}

/** An optional relative path prefix, the same rule the search route applies (1c-c-D12). */
function optionalPathPrefix(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > KNOWLEDGE_SEARCH_MAX_PREFIX_LENGTH) {
    throw new ToolInputError('pathPrefix');
  }
  if (value.startsWith('/') || value.includes('..')) throw new ToolInputError('pathPrefix');
  return value;
}

/** An optional hit limit inside the tool's own 1..20; absent defaults to `DEFAULT_LIMIT`. */
function optionalLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ToolInputError('limit');
  }
  return value;
}

/** An optional anchor: an anchor of another shape can name no chunk, so it is refused here, not searched for. */
function optionalAnchor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !ANCHOR_PATTERN.test(value)) throw new ToolInputError('anchor');
  return value;
}

/** An optional 1-based part number. */
function optionalPart(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < DEFAULT_PART) throw new ToolInputError('part');
  return value;
}

/**
 * A path is read as a chunk-store source id, so it must be safe to embed in the store's filter (1c-c-D13). The
 * check runs in `parse`, where the executor answers `invalid_input: path` rather than a read that fails.
 */
function assertSafePath(path: string): string {
  if (!isSafeFilterValue(path)) throw new ToolInputError('path');
  return path;
}

/** 1c-c-R7's citation, split into the repository, the path and the optional anchor. The sha is deliberately dropped. */
function parseCitation(value: unknown): GetDocInput {
  const match = typeof value === 'string' ? CITATION_PATTERN.exec(value) : null;
  if (!match) throw new ToolInputError('citation');
  const [, owner, name, path, anchor] = match;
  return { owner, name, path: assertSafePath(path), ...(anchor === undefined ? {} : { anchor }) };
}

/** The `{ repo, path, anchor?, part? }` form, for a document named without a citation. */
function parseRepoForm(raw: Record<string, unknown>): GetDocInput {
  const repo = optionalRepo(raw['repo']);
  if (repo === undefined) throw new ToolInputError('repo');
  const [owner, name] = repo.split('/');
  const rawPath = raw['path'];
  if (typeof rawPath !== 'string' || rawPath.length === 0) throw new ToolInputError('path');
  const path = assertSafePath(rawPath);
  const anchor = optionalAnchor(raw['anchor']);
  const part = optionalPart(raw['part']);
  return {
    owner, name, path,
    ...(anchor === undefined ? {} : { anchor }),
    ...(part === undefined ? {} : { part }),
  };
}

/** The project's repository, or the `not_found` a deleted or foreign one is answered with (1c-c-D13). */
async function projectRepo(index: KnowledgeIndexService, projectId: string, owner: string, name: string): Promise<KnowledgeRepoRef> {
  const repo = await index.resolveProjectRepo(projectId, { owner, name });
  if (!repo) throw new NotFoundAppException({}, 'knowledge.repoNotFound');
  return repo;
}

/** The first seven characters of a sha: what a citation carries and what both tools answer with. */
const sha7 = (sha: string): string => sha.slice(0, 7);

/** `[<i>] <owner>/<name>:<path>@<sha7>#<anchor> — <headingPath>`, the anchor left out when the chunk has none. */
function citationLine(position: number, hit: KnowledgeHit): string {
  const anchor = hit.anchor === '' ? '' : `#${hit.anchor}`;
  return `[${position}] ${hit.owner}/${hit.name}:${hit.path}@${sha7(hit.sha)}${anchor} — ${hit.headingPath}`;
}

/** `(status: <status>[ → <supersededBy>])`, the line a superseded or rejected chunk carries. */
function statusLine(status: string, supersededBy: string | undefined): string {
  return `(status: ${status}${supersededBy === undefined ? '' : ` → ${supersededBy}`})`;
}

/**
 * `koda_kb_search` (US-006): the project's indexed docs, ranked, one citable chunk per hit. The repository is
 * resolved first, so an unknown one is `not_found` before anything is read. Each hit is its citation line, its
 * status line when it has one, and its abstract and snippet in one fence: the whole answer is a list of pointer
 * lines over fenced data, never instructions.
 */
export function kbSearchTool(deps: KnowledgeToolDeps): AssistantTool<KbSearchInput> {
  return {
    descriptor: KODA_KB_SEARCH,
    // 1b-D1: the search route is member-gated, so the tool declares membership rather than one ability.
    permission: { kind: 'member' },
    parse(input: unknown): KbSearchInput {
      const raw = asRecord(input);
      return {
        query: requiredText(raw['query'], KNOWLEDGE_SEARCH_MAX_QUERY_LENGTH, 'query'),
        repo: optionalRepo(raw['repo']),
        pathPrefix: optionalPathPrefix(raw['pathPrefix']),
        limit: optionalLimit(raw['limit']),
      };
    },
    async execute(ctx: ToolContext, input: KbSearchInput): Promise<string> {
      let repo: KnowledgeRepoRef | undefined;
      if (input.repo !== undefined) {
        const [owner, name] = input.repo.split('/');
        repo = await projectRepo(deps.index, ctx.projectId, owner, name);
      }
      const result = await deps.search.search({
        projectId: ctx.projectId,
        query: input.query,
        ...(repo === undefined ? {} : { repoId: repo.id }),
        ...(input.pathPrefix === undefined ? {} : { pathPrefix: input.pathPrefix }),
        limit: input.limit,
      });
      if (result.empty) return EMPTY_ANSWER;
      if (result.hits.length === 0) return NO_HITS_ANSWER;

      const lexicalNote = result.lexicalOnly ? ' (lexical results only: embeddings unavailable)' : '';
      const lines = [`${result.hits.length} results for "${input.query}"${lexicalNote}`];
      result.hits.forEach((hit, index) => {
        lines.push(citationLine(index + 1, hit));
        if (hit.status !== undefined) lines.push(statusLine(hit.status, hit.supersededBy));
        lines.push(ctx.data(`${hit.abstract}\n${hit.snippet}`));
      });
      return lines.join('\n');
    },
  };
}

/**
 * The file's text: chunk 0 is the document summary, so it is dropped whenever the file has other chunks (1c-c-D13).
 * A requested anchor keeps only the chunks that carry it; null when nothing is left.
 */
function documentText(rows: KnowledgeChunkRow[], anchor: string | undefined): string | null {
  const body = rows.length > 1 ? rows.filter((row) => row.chunkIndex !== 0) : rows;
  const selected = anchor === undefined ? body : body.filter((row) => row.anchor === anchor);
  if (selected.length === 0) return null;
  return [...selected]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((row) => row.text)
    .join('\n\n');
}

/** Every line of the text, splitting a line longer than the part ceiling into consecutive pieces. */
function* linePieces(text: string): Generator<string> {
  for (const line of text.split('\n')) {
    if (line.length <= MAX_PART_CHARS) {
      yield line;
      continue;
    }
    for (let at = 0; at < line.length; at += MAX_PART_CHARS) yield line.slice(at, at + MAX_PART_CHARS);
  }
}

/** The text in parts of at most `MAX_PART_CHARS`, cut at line boundaries and never inside a line but by its length. */
function splitIntoParts(text: string): string[] {
  const parts: string[] = [];
  let lines: string[] = [];
  let length = 0;
  for (const line of linePieces(text)) {
    // One more line would overflow this part: close it and start the next with the line that did not fit.
    if (lines.length > 0 && length + 1 + line.length > MAX_PART_CHARS) {
      parts.push(lines.join('\n'));
      lines = [];
      length = 0;
    }
    length = lines.length === 0 ? line.length : length + 1 + line.length;
    lines.push(line);
    // A piece of exactly the ceiling length is a part of its own, so a cut line never merges with what follows.
    if (length >= MAX_PART_CHARS) {
      parts.push(lines.join('\n'));
      lines = [];
      length = 0;
    }
  }
  if (lines.length > 0) parts.push(lines.join('\n'));
  return parts;
}

/**
 * `koda_get_doc` (US-006): one indexed document of the project, whole or one anchored section, answered in parts
 * with the indexed sha on the header line. The citation's own sha is ignored: the answer is the indexed text, so a
 * stale citation reads today's document rather than a revision koda never fetched. A repository, file, section or
 * part the index holds nothing for is `not_found`.
 */
export function getDocTool(deps: KnowledgeToolDeps): AssistantTool<GetDocInput> {
  return {
    descriptor: KODA_GET_DOC,
    // 1b-D1: the search route reads the same index and is member-gated, so the tool declares membership.
    permission: { kind: 'member' },
    parse(input: unknown): GetDocInput {
      const raw = asRecord(input);
      const citation = raw['citation'];
      return citation === undefined || citation === null ? parseRepoForm(raw) : parseCitation(citation);
    },
    async execute(ctx: ToolContext, input: GetDocInput): Promise<string> {
      const repo = await projectRepo(deps.index, ctx.projectId, input.owner, input.name);
      const rows = await deps.search.readDoc(ctx.projectId, repo.id, input.path);
      if (rows.length === 0) throw new NotFoundAppException({}, 'knowledge.docNotFound');

      const text = documentText(rows, input.anchor);
      if (text === null) throw new NotFoundAppException({}, 'knowledge.docNotFound');
      const parts = splitIntoParts(text);
      const part = input.part ?? DEFAULT_PART;
      const body = parts[part - 1];
      if (body === undefined) throw new NotFoundAppException({}, 'knowledge.docNotFound');

      const header = `${repo.owner}/${repo.name}:${input.path}@${sha7(rows[0].sha)} (indexed) part ${part} of ${parts.length}`;
      return `${header}\n${ctx.data(body)}`;
    },
  };
}
