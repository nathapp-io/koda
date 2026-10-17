import type { MemoryItem } from '../../../memory/memory-item-repository';
import { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_ADD_MEMORY } from '../koda-tool-descriptors';
import { addMemoryTool, type AddMemoryInput } from './add-memory-tool';

/**
 * Fleet S5b 2b1 US-006: the memory tool's parser, its masked project-scoped preview (with the replacement line) and
 * its requester-attributed upsert. The tool is pure over one collaborator here — the DB-backed path (route, propose,
 * approve, `koda_memory_search`) is `test/integration/fleet/assistant-add-memory-tool.integration.spec.ts`.
 */

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test', projectRole: 'DEVELOPER' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data: (text: string) => text,
} as unknown as ToolContext;

/** A stored memory item, with the three fields the replacement line reads. */
const item = (over: Partial<MemoryItem>): MemoryItem =>
  ({
    id: 'm1', projectId: 'project-1', kind: 'FACT', subject: 'api', predicate: 'runs on',
    status: 'active', confidence: 0.8, createdAt: new Date(0), updatedAt: new Date(0), ...over,
  }) as MemoryItem;

/** The token a preview must never show: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

type UpsertArgs = Parameters<PrismaMemoryItemRepository['upsert']>[0];

/** The tool over its one collaborator; the two defaults answer "no active item" and "saved as m3". */
function toolDeps(over: { active?: MemoryItem | null; saved?: MemoryItem } = {}) {
  const findActive = vi.fn(async () => over.active ?? null);
  const upsert = vi.fn(async () => over.saved ?? item({ id: 'm3' }));
  const memory = { findActive, upsert } as unknown as PrismaMemoryItemRepository;
  return { findActive, upsert, tool: addMemoryTool({ memory }) };
}

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

/** The tool's preview; fails loudly when a write tool declares none. */
function previewOf(tool: AssistantTool<AddMemoryInput>, input: AddMemoryInput): Promise<string> {
  const preview = tool.preview;
  if (!preview) throw new Error('koda_add_memory declares no preview');
  return preview(ctx, input);
}

/** A valid input, with the fields each test overrides. */
const draft = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ kind: 'FACT', subject: 'api', predicate: 'runs on', ...over });

describe('koda_add_memory parse (US-006)', () => {
  it('AC-1: kind DECISION refuses with reason kind', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ kind: 'DECISION', subject: 's', predicate: 'p' }))).toBe('kind');
  });

  it('accepts the four non-decision kinds and refuses every other kind', () => {
    const tool = toolDeps().tool;

    for (const kind of ['FACT', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN']) {
      expect(tool.parse({ kind, subject: 's', predicate: 'p' }).kind).toBe(kind);
    }
    for (const kind of ['decision', 'NOTE', 7, undefined, null]) {
      expect(reasonOf(() => tool.parse({ kind, subject: 's', predicate: 'p' }))).toBe('kind');
    }
  });

  it('AC-2: a blank subject refuses with reason subject', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ kind: 'FACT', subject: ' ', predicate: 'p' }))).toBe('subject');
  });

  it('judges subject and predicate on their trimmed length, and keeps them as written', () => {
    const tool = toolDeps().tool;
    const long = 'a'.repeat(200);

    expect(reasonOf(() => tool.parse(draft({ subject: '' })))).toBe('subject');
    expect(reasonOf(() => tool.parse(draft({ subject: 7 })))).toBe('subject');
    expect(reasonOf(() => tool.parse(draft({ subject: `${long}a` })))).toBe('subject');
    expect(reasonOf(() => tool.parse(draft({ predicate: '   ' })))).toBe('predicate');
    expect(reasonOf(() => tool.parse(draft({ predicate: 7 })))).toBe('predicate');
    expect(reasonOf(() => tool.parse(draft({ predicate: `${long}a` })))).toBe('predicate');

    const parsed = tool.parse(draft({ subject: `  ${long}  `, predicate: '  runs on  ' }));
    expect(parsed.subject).toBe(`  ${long}  `);
    expect(parsed.predicate).toBe('  runs on  ');
  });

  it('AC-3: a caller-supplied ownerId is dropped before the proposal (2b-R5)', () => {
    const parsed = toolDeps().tool.parse({ kind: 'FACT', subject: 's', predicate: 'p', ownerId: 'someone' });

    expect(parsed).toEqual({ kind: 'FACT', subject: 's', predicate: 'p' });
    expect(Object.keys(parsed)).toEqual(['kind', 'subject', 'predicate']);
    expect('ownerId' in parsed).toBe(false);
  });

  it('takes an optional object of at most 4000 characters after trim, kept as written', () => {
    const tool = toolDeps().tool;
    const who = 'a'.repeat(4_000);

    expect(tool.parse(draft()).object).toBeUndefined();
    expect(tool.parse(draft({ object: who })).object).toBe(who);
    expect(tool.parse(draft({ object: `  ${who}  ` })).object).toBe(`  ${who}  `);
    expect(tool.parse(draft({ object: '' })).object).toBe('');
    expect(reasonOf(() => tool.parse(draft({ object: `${who}a` })))).toBe('object');
    expect(reasonOf(() => tool.parse(draft({ object: 7 })))).toBe('object');
  });

  it('is a write tool for project members, with the memory write descriptor (2b1-D4, 2b1-D8)', () => {
    const tool = toolDeps().tool;
    expect(tool.descriptor).toBe(KODA_ADD_MEMORY);
    expect(tool.descriptor.name).toBe('koda_add_memory');
    expect(tool.kind).toBe('write');
    expect(tool.permission).toEqual({ kind: 'member' });
  });
});

describe('koda_add_memory preview (US-006)', () => {
  it('AC-4: with no active item it answers exactly the header and the object line', async () => {
    const { findActive, tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse(draft({ object: 'bun' })));

    expect(preview).toBe('Remember in web: FACT api / runs on\nbun');
    expect(findActive.mock.calls).toEqual([['project-1', 'FACT', 'api', 'runs on']]);
  });

  it('AC-5: an active item with an object is the last line, as Replaces memory:<id>: <object>', async () => {
    const { tool } = toolDeps({ active: item({ id: 'm1', object: 'node' }) });

    const preview = await previewOf(tool, tool.parse(draft({ object: 'bun' })));

    expect(preview).toBe('Remember in web: FACT api / runs on\nbun\nReplaces memory:m1: node');
    expect(preview.split('\n').at(-1)).toBe('Replaces memory:m1: node');
  });

  it('AC-6: an active item without an object is the last line, as Replaces memory:<id>', async () => {
    const { tool } = toolDeps({ active: item({ id: 'm1' }) });

    const preview = await previewOf(tool, tool.parse(draft()));

    expect(preview.split('\n').at(-1)).toBe('Replaces memory:m1');
    expect(preview).toBe('Remember in web: FACT api / runs on\nReplaces memory:m1');
  });

  it('names the project slug and the kind and leaves the object line out when there is no object', async () => {
    const { tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse({ kind: 'CONSTRAINT', subject: 'deploys', predicate: 'need' }));

    expect(preview).toBe('Remember in web: CONSTRAINT deploys / need');
  });

  it('reads the replacement through the project-scoped key, never a cross-project query', async () => {
    const { findActive, tool } = toolDeps({ active: item({ id: 'm1' }) });

    await previewOf(tool, tool.parse({ kind: 'PREFERENCE', subject: '  tabs  ', predicate: 'over spaces' }));

    expect(findActive.mock.calls).toEqual([['project-1', 'PREFERENCE', '  tabs  ', 'over spaces']]);
  });

  it('masks a token written into the object, and writes nothing', async () => {
    const { upsert, tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse(draft({ object: `token=${TOKEN}` })));

    expect(preview).not.toContain(TOKEN);
    expect(preview).toContain('token=[masked]');
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('koda_add_memory execute (US-006)', () => {
  it('AC-7: upserts once, attributed to the requester, in the thread, with confidence 0.8 (2b-R5, 2b1-D7)', async () => {
    const { upsert, tool } = toolDeps();

    await tool.execute(ctx, tool.parse(draft({ object: 'bun' })));

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      projectId: 'project-1',
      kind: 'FACT',
      subject: 'api',
      predicate: 'runs on',
      object: 'bun',
      sourceType: 'thread',
      sourceId: 'thread-1',
      confidence: 0.8,
      ownerId: 'dev-1',
    });
  });

  it('AC-8: the stored item answers memory:<id> saved', async () => {
    const { tool } = toolDeps({ saved: item({ id: 'm3' }) });

    expect(await tool.execute(ctx, tool.parse(draft({ object: 'bun' })))).toBe('memory:m3 saved');
  });

  it('omits the object key when the parser saw none, so the item is stored without one', async () => {
    const { upsert, tool } = toolDeps();

    await tool.execute(ctx, tool.parse(draft()));

    const input = upsert.mock.calls[0]?.[0] as UpsertArgs;
    expect(Object.keys(input)).toEqual([
      'projectId', 'kind', 'subject', 'predicate', 'sourceType', 'sourceId', 'confidence', 'ownerId',
    ]);
  });

  it('ignores a caller-supplied ownerId: the upsert still carries the requester', async () => {
    const { upsert, tool } = toolDeps();

    await tool.execute(ctx, tool.parse(draft({ ownerId: 'someone' })));

    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ ownerId: 'dev-1' });
  });
});
