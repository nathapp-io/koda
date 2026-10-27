import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { PermissionService } from '../../../permissions/permission.service';
import type { ProjectAccessService } from '../../../projects/project-access.service';
import type { KnowledgeChunkRow } from '../../knowledge/knowledge-chunk-store';
import type { KnowledgeRepoRef } from '../../knowledge/knowledge-index.domain';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import type { KnowledgeHit, KnowledgeSearchResult, KnowledgeSearchService } from '../../knowledge/knowledge-search.service';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext } from '../assistant-tool-call.domain';
import { getDocTool, kbSearchTool } from './kb-tools';

/** The project's one repository, as `KnowledgeIndexService.resolveProjectRepo` would answer it. */
const REPO: KnowledgeRepoRef = {
  id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', githubInstallationId: null,
};

const context = (): ToolCallContext => ({
  project: { id: 'p1', slug: 'web' },
  threadId: 't1',
  creator: { id: 'u1', email: 'u1@koda.test', role: 'MEMBER', disabled: false },
});

/** One search hit with every field the tool reads spelled out. */
const hit = (over: Partial<KnowledgeHit> = {}): KnowledgeHit => ({
  source: 'repo', repoId: 'repo-1', owner: 'o', name: 'n', path: 'docs/a.md', sha: 'abcdef1234', anchor: 'cache',
  headingPath: 'A > Cache', title: 'A', abstract: 'The broker keeps a token cache.', snippet: 'the cache is keyed by issuer',
  score: 1, ...over,
});

/** One chunk row of `docs/a.md`, as `KnowledgeSearchService.readDoc` answers them. */
const row = (over: Partial<KnowledgeChunkRow> = {}): KnowledgeChunkRow => ({
  id: 'row-0', sourceId: 'repo:repo-1:docs/a.md', provider: 'fake', repoId: 'repo-1', owner: 'o', name: 'n',
  path: 'docs/a.md', sha: 'abcdef1234', blobSha: 'blob', title: 'A', headingPath: '', anchor: '', chunkIndex: 0,
  chunkCount: 1, abstract: '', text: 'summary', ...over,
});

/** The job a job citation names; 23 characters, inside the 20..40 the citation pattern accepts. */
const JOB_ID = 'cmvjob00000000000000001';

/** One chunk row of a job's `feature-report.md`, as `KnowledgeSearchService.readOutcome` answers them. */
const outcomeRow = (over: Partial<KnowledgeChunkRow> = {}): KnowledgeChunkRow => ({
  id: 'orow-0', sourceId: `outcome:repo-1:${JOB_ID}:report`, provider: 'fake', repoId: 'repo-1', owner: 'o', name: 'n',
  path: 'feature-report.md', sha: 'abcdef1234', blobSha: '', title: 'Feature report', headingPath: '', anchor: '',
  chunkIndex: 0, chunkCount: 1, abstract: '', text: 'report body', jobId: JOB_ID, feature: 'f', outcomeKind: 'report',
  ...over,
});

/** One outcome hit of `koda_kb_search`'s answer, with the job fields the outcome line reads. */
const outcomeHit = (over: Partial<KnowledgeHit> = {}): KnowledgeHit => hit({
  source: 'outcome', path: 'feature-report.md', anchor: 'branch-fix', headingPath: 'Branch fix', jobId: 'j1',
  feature: 'f', outcomeKind: 'report', jobState: 'COMPLETED', prState: 'merged', ...over,
});

const FENCE = /<<koda-data-([0-9a-f]{16})>>\n([\s\S]*?)\n<<end-koda-data-\1>>/;

/** The one `koda-data` fence of a result, or null when the result carries none. */
function fenced(content: string): { text: string; raw: string; token: string } | null {
  const match = FENCE.exec(content);
  if (!match) return null;
  return { text: match[2], raw: match[0], token: match[1] };
}

interface Harness {
  /** One `AssistantToolExecutor.execute` call; every call gets its own toolCallId. */
  execute(input: unknown, name?: string): Promise<{ content: string; isError: boolean }>;
  search: ReturnType<typeof vi.fn>;
  readDoc: ReturnType<typeof vi.fn>;
  readOutcome: ReturnType<typeof vi.fn>;
  resolveProjectRepo: ReturnType<typeof vi.fn>;
  rows: AssistantToolCallRecord[];
}

/**
 * The two tools behind the real executor, the real registry and the real permission path: only the services
 * they read and the call repository are stubbed, so every assertion runs the production seam.
 */
function harness(opts: { answer?: Partial<KnowledgeSearchResult>; doc?: KnowledgeChunkRow[]; outcome?: KnowledgeChunkRow[]; repo?: KnowledgeRepoRef | null; membership?: Error } = {}): Harness {
  const answer: KnowledgeSearchResult = { lexicalOnly: false, empty: false, hits: [], ...opts.answer };
  const search = vi.fn(async () => answer);
  const readDoc = vi.fn(async () => opts.doc ?? []);
  const readOutcome = vi.fn(async () => opts.outcome ?? []);
  const resolveProjectRepo = vi.fn(async () => (opts.repo === undefined ? REPO : opts.repo));
  const registry = new AssistantToolRegistry();
  const deps = {
    search: { search, readDoc, readOutcome } as unknown as KnowledgeSearchService,
    index: { resolveProjectRepo } as unknown as KnowledgeIndexService,
  };
  registry.register(kbSearchTool(deps), getDocTool(deps));

  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async () => null),
    record: vi.fn(async (record) => { rows.push(record); }),
    findCallContext: vi.fn(async () => context()),
  };
  const access = {
    resolveMembership: vi.fn(async () => {
      if (opts.membership) throw opts.membership;
      return 'DEVELOPER';
    }),
  };
  // Permissions P1 US-004: the tools' keys are `PermissionService` reads now; kb.search and kb.read are held here.
  const permissions = { can: vi.fn(async (_actor: unknown, key: string) => ({ allowed: ['kb.search', 'kb.read'].includes(key), reason: 'granted' })) } as unknown as PermissionService;
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions);
  let callId = 0;
  return {
    search, readDoc, readOutcome, resolveProjectRepo, rows,
    execute: (input: unknown, name = 'koda_kb_search') => {
      callId += 1;
      return executor.execute({ jobId: 'j1', toolCallId: `c${callId}`, name, input });
    },
  };
}

describe('koda_kb_search through AssistantToolExecutor (US-006)', () => {
  it('AC-2: asks the search service for the call project with the default limit of 8', async () => {
    const h = harness({ answer: { hits: [hit()] } });

    const result = await h.execute({ query: 'token cache' });

    expect(result.isError).toBe(false);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search).toHaveBeenCalledWith({ projectId: 'p1', query: 'token cache', limit: 8 });
  });

  it('US-006 AC-1: passes the asked source to the search service, with the call project and the default limit', async () => {
    const h = harness({ answer: { hits: [] } });

    const result = await h.execute({ query: 'advisor', source: 'outcomes' });

    expect(result.isError).toBe(false);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search).toHaveBeenCalledWith({ projectId: 'p1', query: 'advisor', source: 'outcomes', limit: 8 });
  });

  it('US-006 AC-2: an unknown source is invalid_input and reads nothing', async () => {
    const cases: Array<[string, unknown]> = [
      ['a source of another vocabulary', { query: 'advisor', source: 'code' }],
      ['a source that is not a string', { query: 'advisor', source: 1 }],
    ];
    for (const [label, input] of cases) {
      const h = harness();
      expect(await h.execute(input), label).toEqual({ content: 'invalid_input: source', isError: true });
      expect(h.search, label).not.toHaveBeenCalled();
      expect(h.resolveProjectRepo, label).not.toHaveBeenCalled();
    }
  });

  it('US-006 AC-3: an outcome hit is named by its job citation, its feature and its run state', async () => {
    const h = harness({ answer: { hits: [outcomeHit()] } });

    const { content } = await h.execute({ query: 'advisor', source: 'outcomes' });
    const lines = content.split('\n');

    expect(h.search).toHaveBeenCalledWith({ projectId: 'p1', query: 'advisor', source: 'outcomes', limit: 8 });
    expect(lines[0]).toBe('1 results for "advisor"');
    expect(lines[1]).toBe('[1] job:j1/feature-report.md#branch-fix — f · Branch fix (run COMPLETED, PR merged)');
    // The text of an outcome hit is fenced exactly as a doc hit's, abstract first.
    expect(fenced(content)?.text).toBe('The broker keeps a token cache.\nthe cache is keyed by issuer');
  });

  it('US-006 AC-4: an anchorless outcome chunk drops its anchor, its heading and a missing PR state each on its own', async () => {
    const decisions = outcomeHit({
      path: 'decisions.jsonl', anchor: '', headingPath: 'Decision D-1', jobState: 'FAILED', prState: null,
    });
    const bare = outcomeHit({ path: 'feature-report.md', anchor: '', headingPath: '', jobState: 'QUEUED', prState: undefined });

    const first = (await harness({ answer: { hits: [decisions] } }).execute({ query: 'q', source: 'outcomes' })).content.split('\n');
    const second = (await harness({ answer: { hits: [bare] } }).execute({ query: 'q', source: 'outcomes' })).content.split('\n');

    expect(first[1]).toBe('[1] job:j1/decisions.jsonl — f · Decision D-1 (run FAILED)');
    expect(second[1]).toBe('[1] job:j1/feature-report.md — f (run QUEUED)');
  });

  it('US-006 AC-5: an empty answer names the sources that were asked for', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['outcomes', 'no run outcomes are indexed for this project'],
      ['docs', 'knowledge index is empty for this project'],
      ['all', 'knowledge index is empty for this project'],
      [undefined, 'knowledge index is empty for this project'],
    ];
    for (const [source, answer] of cases) {
      const h = harness({ answer: { empty: true } });

      const result = await h.execute({ query: 'advisor', ...(source === undefined ? {} : { source }) });

      expect(result.content, String(source)).toBe(answer);
      expect(result.isError, String(source)).toBe(false);
    }
  });

  it('a doc hit keeps its own citation line when the answer carries both sources', async () => {
    const h = harness({ answer: { hits: [hit(), outcomeHit()] } });

    const pointers = (await h.execute({ query: 'cache' })).content.split('\n').filter((line) => line.startsWith('['));

    expect(pointers).toEqual([
      '[1] o/n:docs/a.md@abcdef1#cache — A > Cache',
      '[2] job:j1/feature-report.md#branch-fix — f · Branch fix (run COMPLETED, PR merged)',
    ]);
  });

  it('AC-3: names the hit by its citation and its heading path under the result count', async () => {
    const h = harness({ answer: { hits: [hit()] } });

    const lines = (await h.execute({ query: 'token cache' })).content.split('\n');

    expect(lines[0]).toBe('1 results for "token cache"');
    expect(lines[1]).toBe('[1] o/n:docs/a.md@abcdef1#cache — A > Cache');
  });

  it('AC-4: the hit abstract and snippet are fenced, and appear nowhere else', async () => {
    const h = harness({ answer: { hits: [hit({ abstract: 'ABSTRACT', snippet: 'SNIPPET' })] } });

    const { content } = await h.execute({ query: 'token cache' });
    const fence = fenced(content);

    expect(fence?.text).toBe('ABSTRACT\nSNIPPET');
    // The fence tokens of one result are the pair, and the fields are inside it rather than beside it.
    expect(content.replace(fence?.raw ?? '', '')).not.toContain('SNIPPET');
  });

  it('AC-5: a superseded chunk adds its status line under the citation', async () => {
    const h = harness({ answer: { hits: [hit({ status: 'superseded', supersededBy: 'docs/adr/0009.md' })] } });

    const lines = (await h.execute({ query: 'token cache' })).content.split('\n');

    expect(lines[2]).toBe('(status: superseded → docs/adr/0009.md)');
  });

  it('AC-6: lexicalOnly, empty and no-hit answers each keep their exact shape', async () => {
    const lexical = harness({ answer: { hits: [hit()], lexicalOnly: true } });
    const empty = harness({ answer: { empty: true } });
    const none = harness({ answer: { hits: [] } });

    const first = (await lexical.execute({ query: 'token cache' })).content.split('\n')[0];
    expect(first).toBe('1 results for "token cache" (lexical results only: embeddings unavailable)');
    expect((await empty.execute({ query: 'token cache' })).content).toBe('knowledge index is empty for this project');
    expect((await none.execute({ query: 'token cache' })).content).toBe('no results');
  });

  it('AC-7: each malformed field answers invalid_input with its own reason, before any read', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['an empty query', { query: '' }, 'query'],
      ['a 501-character query', { query: 'x'.repeat(501) }, 'query'],
      ['limit 21', { query: 'q', limit: 21 }, 'limit'],
      ['a pathPrefix that walks up', { query: 'q', pathPrefix: '../x' }, 'pathPrefix'],
    ];
    for (const [label, input, reason] of cases) {
      const h = harness();
      expect(await h.execute(input), label).toEqual({ content: `invalid_input: ${reason}`, isError: true });
      expect(h.search, label).not.toHaveBeenCalled();
      expect(h.resolveProjectRepo, label).not.toHaveBeenCalled();
    }
  });

  it('AC-8: an unknown repo on either tool is not_found', async () => {
    const cases: Array<[string, string, unknown]> = [
      ['koda_kb_search', 'koda_kb_search', { query: 'q', repo: 'o/missing' }],
      ['koda_get_doc', 'koda_get_doc', { repo: 'o/missing', path: 'docs/a.md' }],
    ];
    for (const [label, name, input] of cases) {
      const h = harness({ repo: null });
      expect(await h.execute(input, name), label).toEqual({ content: 'not_found', isError: true });
      expect(h.resolveProjectRepo, label).toHaveBeenCalledWith('p1', { owner: 'o', name: 'missing' });
    }
  });

  it('resolves a named repo to its id and passes the pathPrefix and limit through', async () => {
    const h = harness({ answer: { hits: [] } });

    await h.execute({ query: 'adr', repo: 'o/n', pathPrefix: 'docs/adr/', limit: 5 });

    expect(h.resolveProjectRepo).toHaveBeenCalledWith('p1', { owner: 'o', name: 'n' });
    expect(h.search).toHaveBeenCalledWith({ projectId: 'p1', query: 'adr', repoId: 'repo-1', pathPrefix: 'docs/adr/', limit: 5 });
  });

  it('omits the anchor of a chunk that has none, and lists one fence per hit', async () => {
    const h = harness({ answer: { hits: [hit({ anchor: '', headingPath: 'A' }), hit({ path: 'docs/b.md', anchor: 'b', headingPath: 'B' })] } });

    const { content } = await h.execute({ query: 'token cache' });
    const pointers = content.split('\n').filter((line) => line.startsWith('['));

    expect(content.split('\n')[0]).toBe('2 results for "token cache"');
    expect(pointers).toEqual(['[1] o/n:docs/a.md@abcdef1 — A', '[2] o/n:docs/b.md@abcdef1#b — B']);
    expect(content.match(/<<end-koda-data-[0-9a-f]{16}>>/g)).toHaveLength(2);
  });

  it('is member-gated: a creator who is not a project member is refused and reads nothing', async () => {
    const h = harness({ membership: new ForbiddenAppException({}, 'projects') });

    const result = await h.execute({ query: 'token cache' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('forbidden');
    expect(h.search).not.toHaveBeenCalled();
  });
});

describe('koda_get_doc through AssistantToolExecutor (US-006)', () => {
  it('AC-9: a citation ignores its sha, reads the indexed file and answers the anchored chunk', async () => {
    const h = harness({
      doc: [
        row({ id: 'c0', chunkIndex: 0, anchor: '', text: 'SUMMARY' }),
        row({ id: 'c1', chunkIndex: 1, anchor: 'cache', headingPath: 'A > Cache', text: 'The cache is keyed by issuer.' }),
      ],
    });

    const { content, isError } = await h.execute({ citation: 'o/n:docs/a.md@1111111#cache' }, 'koda_get_doc');
    const lines = content.split('\n');

    expect(isError).toBe(false);
    expect(h.readDoc).toHaveBeenCalledWith('p1', 'repo-1', 'docs/a.md');
    expect(h.resolveProjectRepo).toHaveBeenCalledWith('p1', { owner: 'o', name: 'n' });
    expect(lines[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 1');
    expect(fenced(content)?.text).toBe('The cache is keyed by issuer.');
    expect(content).not.toContain('SUMMARY');
  });

  it('US-006 AC-6: a job citation reads the job outcome file and answers its anchored report chunk', async () => {
    const h = harness({
      outcome: [
        outcomeRow({ id: 'o0', chunkIndex: 0, anchor: '', text: 'SUMMARY' }),
        outcomeRow({ id: 'o1', chunkIndex: 1, anchor: 'branch-fix', headingPath: 'Branch fix', text: 'the branch fix' }),
      ],
    });

    const { content, isError } = await h.execute({ citation: `job:${JOB_ID}/feature-report.md#branch-fix` }, 'koda_get_doc');
    const lines = content.split('\n');

    expect(isError).toBe(false);
    expect(h.readOutcome).toHaveBeenCalledTimes(1);
    expect(h.readOutcome).toHaveBeenCalledWith('p1', JOB_ID, 'feature-report.md');
    expect(h.readDoc).not.toHaveBeenCalled();
    // A job citation names no repository, so the project's repository is never resolved for it.
    expect(h.resolveProjectRepo).not.toHaveBeenCalled();
    expect(lines[0]).toBe(`job:${JOB_ID}/feature-report.md (f) part 1 of 1`);
    expect(fenced(content)?.text).toBe('the branch fix');
  });

  it('US-006: a report drops its summary chunk even when the anchor names it, a single-chunk report keeps it', async () => {
    // Chunk 0 of a report is its summary, so an anchor that only matches it names no row of the answer (3c-2-D11).
    const twoChunks = harness({
      outcome: [
        outcomeRow({ id: 'o0', chunkIndex: 0, anchor: 'branch-fix', text: 'SUMMARY' }),
        outcomeRow({ id: 'o1', chunkIndex: 1, anchor: 'other', text: 'body' }),
      ],
    });
    const only = harness({ outcome: [outcomeRow({ chunkIndex: 0, anchor: 'branch-fix', text: 'the whole report' })] });

    expect(await twoChunks.execute({ citation: `job:${JOB_ID}/feature-report.md#branch-fix` }, 'koda_get_doc'))
      .toEqual({ content: 'not_found', isError: true });
    expect(fenced((await only.execute({ citation: `job:${JOB_ID}/feature-report.md#branch-fix` }, 'koda_get_doc')).content)?.text)
      .toBe('the whole report');
  });

  it('US-006 AC-7: a decisions citation answers every decision, the chunk 0 one first', async () => {
    const decision = (over: Partial<KnowledgeChunkRow>): KnowledgeChunkRow =>
      outcomeRow({ path: 'decisions.jsonl', outcomeKind: 'decisions', feature: 'f', ...over });
    const h = harness({
      outcome: [
        decision({ id: 'o1', chunkIndex: 1, anchor: 'decision-d-2', text: 'Decision D-2' }),
        decision({ id: 'o0', chunkIndex: 0, anchor: 'decision-d-1', text: 'Decision D-1' }),
      ],
    });

    const { content, isError } = await h.execute({ citation: `job:${JOB_ID}/decisions.jsonl` }, 'koda_get_doc');

    expect(isError).toBe(false);
    expect(h.readOutcome).toHaveBeenCalledWith('p1', JOB_ID, 'decisions.jsonl');
    expect(content.split('\n')[0]).toBe(`job:${JOB_ID}/decisions.jsonl (f) part 1 of 1`);
    // Both chunks are answered, in chunkIndex order: chunk 0 of a decisions log is a decision, not a summary.
    expect(fenced(content)?.text).toBe('Decision D-1\n\nDecision D-2');
  });

  it('US-006 AC-8: a job citation the index holds no row for is not_found, a foreign job included', async () => {
    const h = harness({ outcome: [] });

    expect(await h.execute({ citation: `job:${JOB_ID}/feature-report.md` }, 'koda_get_doc'))
      .toEqual({ content: 'not_found', isError: true });
    expect(h.readOutcome).toHaveBeenCalledWith('p1', JOB_ID, 'feature-report.md');
    expect(h.readDoc).not.toHaveBeenCalled();

    // A job of another project: readOutcome describes only this project's jobs, so it answers no row.
    const foreign = 'cmvjob99999999999999999';
    const other = harness({ outcome: [] });
    expect(await other.execute({ citation: `job:${foreign}/decisions.jsonl` }, 'koda_get_doc'))
      .toEqual({ content: 'not_found', isError: true });
    expect(other.readOutcome).toHaveBeenCalledWith('p1', foreign, 'decisions.jsonl');
    expect(other.resolveProjectRepo).not.toHaveBeenCalled();
  });

  it('US-006: an unmatched anchor and a part past the last one are not_found on a job citation', async () => {
    const anchored = harness({
      outcome: [
        outcomeRow({ id: 'o0', chunkIndex: 0, anchor: 'a', text: 'first' }),
        outcomeRow({ id: 'o1', chunkIndex: 1, anchor: 'b', text: 'second' }),
      ],
    });
    const text = Array.from({ length: 30 }, (_, i) => String(i).padEnd(999, 'x')).join('\n');
    const long = harness({ outcome: [outcomeRow({ anchor: '', text })] });

    expect(await anchored.execute({ citation: `job:${JOB_ID}/feature-report.md#missing` }, 'koda_get_doc'))
      .toEqual({ content: 'not_found', isError: true });

    const second = await long.execute({ citation: `job:${JOB_ID}/feature-report.md`, part: 2 }, 'koda_get_doc');
    const fourth = await long.execute({ citation: `job:${JOB_ID}/feature-report.md`, part: 4 }, 'koda_get_doc');
    expect(second.content.split('\n')[0]).toBe(`job:${JOB_ID}/feature-report.md (f) part 2 of 3`);
    // 12 lines fit in a 12000-character part, so the second part is the 13th to the 24th line.
    expect(fenced(second.content)?.text?.split('\n')).toEqual(text.split('\n').slice(12, 24));
    expect(fourth).toEqual({ content: 'not_found', isError: true });
  });

  it('US-006 AC-9: a job citation naming a file the outcome pass never writes is refused', async () => {
    const cases: Array<[string, string]> = [
      ['another path of the bundle', `job:${JOB_ID}/prd.json`],
      ['a job id outside the citation pattern', 'job:j1/feature-report.md'],
      ['a job citation of another shape', 'job:cmvjob00000000000000001/feature-report.md#A B'],
    ];
    for (const [label, citation] of cases) {
      const h = harness();
      expect(await h.execute({ citation }, 'koda_get_doc'), label).toEqual({ content: 'invalid_input: citation', isError: true });
      expect(h.readOutcome, label).not.toHaveBeenCalled();
      expect(h.readDoc, label).not.toHaveBeenCalled();
    }
  });

  it('US-006 AC-10: a document citation and the repo form read the repository file and never an outcome', async () => {
    const doc = [row({ chunkIndex: 0, text: 'SUMMARY' }), row({ id: 'c1', chunkIndex: 1, anchor: 'a', text: 'body' })];
    const cited = harness({ doc });
    const named = harness({ doc });

    const { content } = await cited.execute({ citation: 'o/n:docs/a.md@abc1234' }, 'koda_get_doc');
    const fromRepoForm = await named.execute({ repo: 'o/n', path: 'docs/a.md' }, 'koda_get_doc');

    expect(cited.readDoc).toHaveBeenCalledWith('p1', 'repo-1', 'docs/a.md');
    expect(content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 1');
    expect(fenced(content)?.text).toBe('body');
    expect(fromRepoForm.content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 1');
    expect(cited.readOutcome).not.toHaveBeenCalled();
    expect(named.readOutcome).not.toHaveBeenCalled();
  });

  it('AC-10: the whole-file form joins every chunk but the summary, in chunkIndex order', async () => {
    const h = harness({
      doc: [
        row({ id: 'c2', chunkIndex: 2, anchor: 'b', text: 'second section' }),
        row({ id: 'c0', chunkIndex: 0, anchor: '', text: 'SUMMARY' }),
        row({ id: 'c1', chunkIndex: 1, anchor: 'a', text: 'first section' }),
      ],
    });

    const { content } = await h.execute({ repo: 'o/n', path: 'docs/a.md' }, 'koda_get_doc');

    expect(content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 1');
    expect(fenced(content)?.text).toBe('first section\n\nsecond section');
  });

  it('AC-11: a 29999-character document answers three parts, and a part past the last is not_found', async () => {
    const text = Array.from({ length: 30 }, () => 'x'.repeat(999)).join('\n');
    expect(text).toHaveLength(29999);
    const doc = [row({ anchor: 'a', text })];

    const absent = await harness({ doc }).execute({ repo: 'o/n', path: 'docs/a.md' }, 'koda_get_doc');
    const third = await harness({ doc }).execute({ repo: 'o/n', path: 'docs/a.md', part: 3 }, 'koda_get_doc');
    const fourth = await harness({ doc }).execute({ repo: 'o/n', path: 'docs/a.md', part: 4 }, 'koda_get_doc');

    expect(absent.content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 3');
    expect(third.content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 3 of 3');
    expect(fenced(absent.content)?.text.split('\n').at(-1)).toBe('x'.repeat(999));
    expect(fourth).toEqual({ content: 'not_found', isError: true });
  });

  it('AC-12: a malformed citation, an unsafe path and an unmatched anchor are each refused their own way', async () => {
    const badCitation = await harness().execute({ citation: 'not a citation' }, 'koda_get_doc');
    expect(badCitation).toEqual({ content: 'invalid_input: citation', isError: true });

    const badPath = harness();
    expect(await badPath.execute({ repo: 'o/n', path: "docs/it's.md" }, 'koda_get_doc')).toEqual({ content: 'invalid_input: path', isError: true });
    expect(badPath.readDoc).not.toHaveBeenCalled();

    const h = harness({ doc: [row({ chunkIndex: 0, anchor: '' }), row({ id: 'c1', chunkIndex: 1, anchor: 'cache' })] });
    expect(await h.execute({ repo: 'o/n', path: 'docs/a.md', anchor: 'missing' }, 'koda_get_doc')).toEqual({ content: 'not_found', isError: true });
    expect(h.readDoc).toHaveBeenCalledTimes(1);
  });

  it('AC-13: one 13000-character line is cut at 12000 characters into a second part', async () => {
    const h = harness({ doc: [row({ anchor: 'a', text: 'y'.repeat(13000) })] });

    const { content } = await h.execute({ repo: 'o/n', path: 'docs/a.md' }, 'koda_get_doc');

    expect(content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 2');
    expect(fenced(content)?.text).toBe('y'.repeat(12000));
  });

  it('AC-15: a file the index holds no rows for is not_found', async () => {
    const h = harness({ doc: [] });

    expect(await h.execute({ repo: 'o/n', path: 'docs/a.md' }, 'koda_get_doc')).toEqual({ content: 'not_found', isError: true });
    expect(h.readDoc).toHaveBeenCalledWith('p1', 'repo-1', 'docs/a.md');
  });

  it('AC-9: a citation without an anchor answers the whole document, its sha still ignored', async () => {
    const h = harness({ doc: [row({ chunkIndex: 0, anchor: '', text: 'SUMMARY' }), row({ id: 'c1', chunkIndex: 1, anchor: 'a', text: 'body' })] });

    const { content } = await h.execute({ citation: 'o/n:docs/a.md@9999999' }, 'koda_get_doc');

    expect(content.split('\n')[0]).toBe('o/n:docs/a.md@abcdef1 (indexed) part 1 of 1');
    expect(fenced(content)?.text).toBe('body');
  });

  it('reports invalid_input for a citation whose path is unsafe, and for a missing repo or path', async () => {
    const cases: Array<[string, unknown, string]> = [
      ["a citation path with a quote", { citation: "o/n:docs/it's.md@abcdef1" }, 'path'],
      ['no citation, no repo', {}, 'repo'],
      ['a repo with no path', { repo: 'o/n' }, 'path'],
      ['a malformed repo', { repo: 'n', path: 'docs/a.md' }, 'repo'],
      ['part 0', { repo: 'o/n', path: 'docs/a.md', part: 0 }, 'part'],
      ['an unknown anchor shape', { repo: 'o/n', path: 'docs/a.md', anchor: 'A B' }, 'anchor'],
    ];
    for (const [label, input, reason] of cases) {
      const h = harness();
      expect(await h.execute(input, 'koda_get_doc'), label).toEqual({ content: `invalid_input: ${reason}`, isError: true });
      expect(h.readDoc, label).not.toHaveBeenCalled();
    }
  });

  it('is member-gated, like koda_kb_search', async () => {
    const h = harness({ membership: new ForbiddenAppException({}, 'projects') });

    const result = await h.execute({ repo: 'o/n', path: 'docs/a.md' }, 'koda_get_doc');

    expect(result.isError).toBe(true);
    expect(result.content).toContain('forbidden');
    expect(h.readDoc).not.toHaveBeenCalled();
  });
});

describe('the kb tool descriptors (US-006)', () => {
  it('declares both tools to the model with the input the parser accepts', () => {
    const deps = {
      search: { search: vi.fn(), readDoc: vi.fn(), readOutcome: vi.fn() } as unknown as KnowledgeSearchService,
      index: { resolveProjectRepo: vi.fn() } as unknown as KnowledgeIndexService,
    };
    const registry = new AssistantToolRegistry();
    registry.register(kbSearchTool(deps), getDocTool(deps));

    expect(registry.get('koda_kb_search')?.descriptor.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { minLength: 1, maxLength: 500 }, limit: { minimum: 1, maximum: 20 } },
    });
    expect(registry.get('koda_get_doc')?.descriptor.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { part: { minimum: 1 }, repo: { pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } },
    });
    for (const name of ['koda_kb_search', 'koda_get_doc']) {
      expect({ name, key: registry.get(name)?.key }).toEqual({ name, key: name === 'koda_kb_search' ? 'kb.search' : 'kb.read' });
    }
  });

  it('US-006 AC-11: koda_kb_search advertises the three sources and koda_get_doc names the job citation', () => {
    const deps = {
      search: { search: vi.fn(), readDoc: vi.fn(), readOutcome: vi.fn() } as unknown as KnowledgeSearchService,
      index: { resolveProjectRepo: vi.fn() } as unknown as KnowledgeIndexService,
    };
    const registry = new AssistantToolRegistry();
    registry.register(kbSearchTool(deps), getDocTool(deps));
    const schema = (name: string): Record<string, unknown> => registry.get(name)?.descriptor.inputSchema as Record<string, unknown>;
    const properties = schema('koda_kb_search')['properties'] as Record<string, unknown>;

    expect(properties['source']).toMatchObject({ type: 'string', enum: ['docs', 'outcomes', 'all'] });
    // The model only learns the job citation from the descriptor, so the property has to name its shape.
    const citation = (schema('koda_get_doc')['properties'] as Record<string, unknown>)['citation'] as { description: string };
    expect(citation.description).toContain('job:<jobId>/feature-report.md');
  });
});
