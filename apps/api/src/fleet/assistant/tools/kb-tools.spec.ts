import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { KodaCaslAbilityFactory } from '../../../auth/casl/koda-casl-ability.factory';
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
  resolveProjectRepo: ReturnType<typeof vi.fn>;
  rows: AssistantToolCallRecord[];
}

/**
 * The two tools behind the real executor, the real registry and the real permission path: only the services
 * they read and the call repository are stubbed, so every assertion runs the production seam.
 */
function harness(opts: { answer?: Partial<KnowledgeSearchResult>; doc?: KnowledgeChunkRow[]; repo?: KnowledgeRepoRef | null; membership?: Error } = {}): Harness {
  const answer: KnowledgeSearchResult = { lexicalOnly: false, empty: false, hits: [], ...opts.answer };
  const search = vi.fn(async () => answer);
  const readDoc = vi.fn(async () => opts.doc ?? []);
  const resolveProjectRepo = vi.fn(async () => (opts.repo === undefined ? REPO : opts.repo));
  const registry = new AssistantToolRegistry();
  const deps = {
    search: { search, readDoc } as unknown as KnowledgeSearchService,
    index: { resolveProjectRepo } as unknown as KnowledgeIndexService,
  };
  registry.register(kbSearchTool(deps), getDocTool(deps));

  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
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
  const executor = new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, new KodaCaslAbilityFactory());
  let callId = 0;
  return {
    search, readDoc, resolveProjectRepo, rows,
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
      search: { search: vi.fn(), readDoc: vi.fn() } as unknown as KnowledgeSearchService,
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
    for (const name of ['koda_kb_search', 'koda_get_doc']) expect(registry.get(name)?.permission).toEqual({ kind: 'member' });
  });
});
