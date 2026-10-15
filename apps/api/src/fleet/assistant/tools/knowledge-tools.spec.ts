import { Test, type TestingModule } from '@nestjs/testing';
import type { IPageResult } from '@nathapp/nestjs-data';
import { MemoryGovernanceService } from '../../../memory/memory-governance.service';
import type { MemoryItem } from '../../../memory/memory-item-repository';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolInputError, type ToolContext } from '../assistant-tool.types';
import { KODA_TOOL_DESCRIPTORS } from '../koda-tool-descriptors';
import { KnowledgeTools, memorySearchTool } from './knowledge-tools';

const TOOL_NAMES = ['koda_memory_search'] as const;

/** The parser never touches the service, so the stub only satisfies the DI graph. */
const stubMemory = {} as MemoryGovernanceService;

/** The `reason` a parser refuses with; fails loudly when it accepts or throws something else. */
function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).reason;
  }
  throw new Error('expected the parser to refuse this input');
}

const FENCE_OPEN = '<<koda-data-0000000000000000>>';
const FENCE_CLOSE = '<<end-koda-data-0000000000000000>>';

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-15T00:00:00.000Z'),
  data: (text: string) => `${FENCE_OPEN}\n${text}\n${FENCE_CLOSE}`,
} as unknown as ToolContext;

const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-1',
  kind: 'FACT',
  subject: 'Deploy pipeline',
  predicate: 'status',
  object: 'green',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-15T00:00:00.000Z'),
  ...over,
});

const page = (records: MemoryItem[], over: Partial<IPageResult<MemoryItem>> = {}): IPageResult<MemoryItem> => ({
  records, total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, ...over,
});

/** The tool under test, with the service's own page answer stubbed. */
const toolWith = (answer: IPageResult<MemoryItem>) => {
  const getProjectMemory = vi.fn(async () => answer);
  return { getProjectMemory, tool: memorySearchTool({ getProjectMemory } as unknown as MemoryGovernanceService) };
};

// The real registry, filled by KnowledgeTools.onModuleInit through Nest's lifecycle.
describe('knowledge tools (US-004)', () => {
  let module: TestingModule;
  let registry: AssistantToolRegistry;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        KnowledgeTools,
        AssistantToolRegistry,
        { provide: MemoryGovernanceService, useValue: stubMemory },
      ],
    }).compile();
    await module.init();
    registry = module.get(AssistantToolRegistry);
  });

  afterAll(async () => {
    await module.close();
  });

  it('AC-1: registers koda_memory_search with its KODA_TOOL_DESCRIPTORS entry as its descriptor', () => {
    for (const name of TOOL_NAMES) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.descriptor).toBe(KODA_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name));
    }
    expect(KODA_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toContain('koda_memory_search');
  });

  it('declares project membership as its permission', () => {
    expect(registry.get('koda_memory_search')?.permission).toEqual({ kind: 'member' });
  });

  it('AC-11: the parser refuses each invalid field with its own reason', () => {
    const tool = memorySearchTool(stubMemory);
    const cases: Array<[string, unknown, string]> = [
      ['an empty text', { text: '' }, 'text'],
      ['a whitespace-only text', { text: '   ' }, 'text'],
      ['a 101-character text', { text: 'x'.repeat(101) }, 'text'],
      ['an unknown kind', { kind: 'NOTE' }, 'kind'],
      ['an unknown status', { status: 'deleted' }, 'status'],
      ['page 0', { page: 0 }, 'page'],
      ['a fractional page', { page: 1.5 }, 'page'],
    ];
    for (const [label, input, reason] of cases) expect(reasonOf(() => tool.parse(input)), label).toBe(reason);
  });

  it('parse keeps the filters it was given and defaults page to 1', () => {
    const tool = memorySearchTool(stubMemory);
    expect(tool.parse({ text: 'deploy', kind: 'DECISION', status: 'superseded', page: 2 })).toEqual({
      text: 'deploy', kind: 'DECISION', status: 'superseded', page: 2,
    });
    expect(tool.parse({})).toEqual({ text: undefined, kind: undefined, status: undefined, page: 1 });
    expect(tool.parse(null)).toEqual({ text: undefined, kind: undefined, status: undefined, page: 1 });
    // The API's own spellings of kind, status, a 1-character and a 100-character text are all accepted.
    expect(tool.parse({ text: 'x' })).toMatchObject({ text: 'x' });
    expect(tool.parse({ text: 'x'.repeat(100) })).toMatchObject({ text: 'x'.repeat(100) });
    for (const kind of ['FACT', 'DECISION', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN']) {
      expect(tool.parse({ kind })).toMatchObject({ kind });
    }
    for (const status of ['active', 'superseded', 'rejected']) {
      expect(tool.parse({ status })).toMatchObject({ status });
    }
  });
});

describe('koda_memory_search execute (US-004)', () => {
  it('asks for the thread project newest-updatedAt first, one page of 20', async () => {
    const { getProjectMemory, tool } = toolWith(page([item()]));

    await tool.execute(ctx, tool.parse({ text: 'deploy', kind: 'FACT', status: 'active', page: 3 }));

    expect(getProjectMemory).toHaveBeenCalledWith(
      { projectId: 'project-1', text: 'deploy', kind: 'FACT', status: 'active', orderBy: 'updatedAt' },
      { current: 3, size: 20 },
    );
  });

  it('AC-7: each item is a header line and one fence holding subject, predicate and object', async () => {
    // 0.9 rather than a third decimal: `toFixed(2)` is the contract, and a value like 0.855 is not exact in binary.
    const { tool } = toolWith(page([item({ confidence: 0.9 })]));

    const content = await tool.execute(ctx, tool.parse({}));

    expect(content).toBe(
      [
        'memory:mem-1 FACT active confidence 0.90 updated 2026-10-15T00:00:00.000Z',
        FENCE_OPEN,
        'Deploy pipeline status green',
        FENCE_CLOSE,
      ].join('\n'),
    );
  });

  it('omits a null object from the fenced line', async () => {
    const { tool } = toolWith(page([item({ subject: 'ticket:2', predicate: 'in_progress_since', object: undefined })]));

    const content = await tool.execute(ctx, tool.parse({}));

    expect(content.split('\n').at(2)).toBe('ticket:2 in_progress_since');
  });

  it('AC-8: a full page ends with the next-page line', async () => {
    const records = Array.from({ length: 20 }, (_, index) => item({ id: `mem-${index}`, confidence: 0.5 }));
    const { tool } = toolWith(page(records, { total: 21, hasNext: true }));

    const lines = (await tool.execute(ctx, tool.parse({ page: 1 }))).split('\n');

    expect(lines.filter((line) => line.startsWith('memory:'))).toHaveLength(20);
    expect(lines.at(-1)).toBe('more: call koda_memory_search with page 2');
  });

  it('AC-9: no matching item answers the single line no memory items', async () => {
    const { tool } = toolWith(page([]));

    expect(await tool.execute(ctx, tool.parse({ page: 5 }))).toBe('no memory items');
  });
});
