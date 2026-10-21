import type { ExtractionService } from '../../../memory/extraction.service';
import type { MemoryItem } from '../../../memory/memory-item-repository';
import type { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import { MemoryReplaceRefusedError, MemoryWriteGuard } from '../../../memory/memory-write.guard';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_RECORD_DECISION } from '../koda-tool-descriptors';
import { recordDecisionTool, type RecordDecisionInput } from './record-decision-tool';

/**
 * Fleet S5b 2b1 US-007: the decision tool's parser, its masked requester-scoped preview (with the supersession line)
 * and its requester-attributed `ExtractionService.recordDecision`. The tool is pure over its two collaborators here —
 * the DB-backed path (route, propose, approve, stored memory row) is
 * `test/integration/fleet/assistant-record-decision-tool.integration.spec.ts`.
 */

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data: (text: string) => text,
} as unknown as ToolContext;

/** A stored memory item, with the three fields the supersession line reads. */
const item = (over: Partial<MemoryItem>): MemoryItem =>
  ({
    id: 'm2', projectId: 'project-1', kind: 'DECISION', subject: 'agent:dev-1', predicate: 'db',
    status: 'active', confidence: 1, createdAt: new Date(0), updatedAt: new Date(0), ...over,
  }) as MemoryItem;

/** The token a preview must never show: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

type RecordDecisionArgs = Parameters<ExtractionService['recordDecision']>;

/**
 * The tool over its collaborators; the defaults answer "no active decision" and `memoryId: 'm4'`. `US-008` added the
 * guard: `replaceCheck` answers a spy the record would run inside its transaction, and `refusesReplace` makes both
 * halves of the check refuse (the preview's `assertMayReplace` and the in-transaction callback).
 */
function toolDeps(over: {
  active?: MemoryItem | null;
  memoryId?: string;
  refusesReplace?: boolean;
  failsReplace?: boolean;
} = {}) {
  const findActive = vi.fn(async () => over.active ?? null);
  const beforeSupersede = vi.fn(async (): Promise<void> => {
    if (over.refusesReplace) throw new MemoryReplaceRefusedError('m2');
  });
  const recordDecision = vi.fn(async () => {
    if (over.failsReplace) throw new MemoryReplaceRefusedError('m2');
    return { canonicalId: 'c1', memoryId: over.memoryId ?? 'm4' };
  });
  const guard = {
    assertMayReplace: vi.fn(async () => {
      if (over.refusesReplace) throw new MemoryReplaceRefusedError('m2');
    }),
    replaceCheck: vi.fn(() => beforeSupersede),
  };
  const memory = { findActive } as unknown as PrismaMemoryItemRepository;
  const extraction = { recordDecision } as unknown as ExtractionService;
  return {
    findActive,
    recordDecision,
    memory,
    guard,
    beforeSupersede,
    tool: recordDecisionTool({ memory, extraction, guard: guard as unknown as MemoryWriteGuard }),
  };
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
function previewOf(tool: AssistantTool<RecordDecisionInput>, input: RecordDecisionInput): Promise<string> {
  const preview = tool.preview;
  if (!preview) throw new Error('koda_record_decision declares no preview');
  return preview(ctx, input);
}

/** A valid input, with the fields each test overrides. */
const draft = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ topic: 'db', decision: 'use postgres', ...over });

describe('koda_record_decision parse (US-007)', () => {
  it('AC-1: a blank decision refuses with reason decision', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ topic: 'db', decision: '   ' }))).toBe('decision');
  });

  it('judges topic and decision on their trimmed length, and keeps them as written (2b1-D5)', () => {
    const tool = toolDeps().tool;
    const topic = 'a'.repeat(200);
    const decision = 'a'.repeat(4_000);

    expect(reasonOf(() => tool.parse(draft({ topic: ' ' })))).toBe('topic');
    expect(reasonOf(() => tool.parse(draft({ topic: 7 })))).toBe('topic');
    expect(reasonOf(() => tool.parse(draft({ topic: `${topic}a` })))).toBe('topic');
    expect(reasonOf(() => tool.parse(draft({ decision: '' })))).toBe('decision');
    expect(reasonOf(() => tool.parse(draft({ decision: 7 })))).toBe('decision');
    expect(reasonOf(() => tool.parse(draft({ decision: `${decision}a` })))).toBe('decision');

    const parsed = tool.parse(draft({ topic: `  ${topic}  `, decision: `  ${decision}  ` }));
    expect(parsed.topic).toBe(`  ${topic}  `);
    expect(parsed.decision).toBe(`  ${decision}  `);
  });

  it('takes an optional rationale of at most 4000 characters after trim, kept as written, refused as rationale', () => {
    const tool = toolDeps().tool;
    const why = 'a'.repeat(4_000);

    expect(tool.parse(draft()).rationale).toBeUndefined();
    expect(tool.parse(draft({ rationale: why })).rationale).toBe(why);
    expect(tool.parse(draft({ rationale: `  ${why}  ` })).rationale).toBe(`  ${why}  `);
    expect(reasonOf(() => tool.parse(draft({ rationale: `${why}a` })))).toBe('rationale');
    expect(reasonOf(() => tool.parse(draft({ rationale: 7 })))).toBe('rationale');
  });

  it('AC-2: a caller-supplied actorId is dropped before the proposal (2b-R5)', () => {
    const parsed = toolDeps().tool.parse({ topic: 'db', decision: 'use postgres', actorId: 'someone' });

    expect(parsed).toEqual({ topic: 'db', decision: 'use postgres' });
    expect(Object.keys(parsed)).toEqual(['topic', 'decision']);
    expect('actorId' in parsed).toBe(false);
  });

  it('is a write tool for project members, with the record decision descriptor (2b1-D4, 2b1-D8)', () => {
    const tool = toolDeps().tool;
    expect(tool.descriptor).toBe(KODA_RECORD_DECISION);
    expect(tool.descriptor.name).toBe('koda_record_decision');
    expect(tool.kind).toBe('write');
    expect(tool.key).toBe('memory.decision.record');
  });
});

describe('koda_record_decision preview (US-007)', () => {
  it('AC-3: with no active decision it answers exactly the header and the rationale line', async () => {
    const { tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse({ topic: 'db', decision: 'use postgres', rationale: 'one engine' }));

    expect(preview).toBe('Record a decision in web on "db": use postgres\nRationale: one engine');
  });

  it('AC-4: it reads the requester\'s active decision on the topic through the project-scoped key', async () => {
    const { findActive, tool } = toolDeps();

    await previewOf(tool, tool.parse(draft()));

    expect(findActive.mock.calls).toEqual([['project-1', 'DECISION', 'agent:dev-1', 'db']]);
  });

  it('AC-5: an active decision is the last line, as Supersedes memory:<id>: <its decision>', async () => {
    const { tool } = toolDeps({ active: item({ id: 'm2', object: 'use sqlite' }) });

    const preview = await previewOf(tool, tool.parse(draft()));

    expect(preview.split('\n').at(-1)).toBe('Supersedes memory:m2: use sqlite');
    expect(preview).toBe('Record a decision in web on "db": use postgres\nSupersedes memory:m2: use sqlite');
  });

  it('names the slug and the quoted topic, and leaves the rationale line out when none is given', async () => {
    const { tool } = toolDeps();

    expect(await previewOf(tool, tool.parse(draft()))).toBe('Record a decision in web on "db": use postgres');
  });

  it('masks a token written into the decision, and writes nothing', async () => {
    const { recordDecision, tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse(draft({ decision: `token=${TOKEN}` })));

    expect(preview).not.toContain(TOKEN);
    expect(preview).toContain('token=[masked]');
    expect(recordDecision).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Permissions P1 US-008 — the preview refuses a supersede it may not make
  // -------------------------------------------------------------------------

  it('US-008: the preview asks the guard about the requester\'s own decision key', async () => {
    const { guard, tool } = toolDeps();

    await previewOf(tool, tool.parse(draft()));

    expect(guard.assertMayReplace).toHaveBeenCalledWith(ctx.actor, 'project-1', {
      kind: 'DECISION', subject: 'agent:dev-1', predicate: 'db',
    });
  });

  it('US-008: a refused replace is a forbidden refusal naming memory.update, not a proposal', async () => {
    const { recordDecision, tool } = toolDeps({ refusesReplace: true });

    await expect(previewOf(tool, tool.parse(draft()))).rejects.toThrow(ToolForbiddenError);
    await expect(previewOf(tool, tool.parse(draft()))).rejects.toMatchObject({ need: 'memory.update' });
    expect(recordDecision).not.toHaveBeenCalled();
  });
});

describe('koda_record_decision execute (US-007)', () => {
  it('AC-6: records once, as the requester, composing the rationale into the stored decision (2b-R5, 2b1-D7)', async () => {
    const { recordDecision, memory, beforeSupersede, tool } = toolDeps();

    await tool.execute(ctx, tool.parse({ topic: 'db', decision: 'use postgres', rationale: 'one engine' }));

    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        actorId: 'dev-1',
        topic: 'db',
        decision: 'use postgres\n\nRationale: one engine',
        sourceId: 'thread:thread-1',
        // US-008: the item records which table its owner names.
        ownerType: 'USER',
      },
      memory,
      { beforeSupersede },
    );
  });

  it('AC-7: without a rationale the decision is stored alone, with no rationale property', async () => {
    const { recordDecision, tool } = toolDeps();

    await tool.execute(ctx, tool.parse({ topic: 'db', decision: 'use postgres' }));

    const input = recordDecision.mock.calls[0]?.[0] as RecordDecisionArgs[0];
    expect(input.decision).toBe('use postgres');
    expect(Object.keys(input)).toEqual(['projectId', 'actorId', 'topic', 'decision', 'sourceId', 'ownerType']);
  });

  it('AC-8: the recorded decision answers decision memory:<id> recorded', async () => {
    const { tool } = toolDeps({ memoryId: 'm4' });

    expect(await tool.execute(ctx, tool.parse(draft()))).toBe('decision memory:m4 recorded');
  });

  it('ignores a caller-supplied actorId: the decision is still recorded as the requester', async () => {
    const { recordDecision, tool } = toolDeps();

    await tool.execute(ctx, tool.parse(draft({ actorId: 'someone' })));

    expect(recordDecision.mock.calls[0]?.[0]).toMatchObject({ actorId: 'dev-1' });
  });

  it('records in the action project, never the thread\'s home project (2b1-D7)', async () => {
    const { recordDecision, tool } = toolDeps();
    const other = { ...ctx, projectId: 'project-2', projectSlug: 'ops', actor: { id: 'dev-2' } } as unknown as ToolContext;

    await tool.execute(other, tool.parse(draft()));

    expect(recordDecision.mock.calls[0]?.[0].projectId).toBe('project-2');
    expect(recordDecision.mock.calls[0]?.[0].actorId).toBe('dev-2');
  });

  // -------------------------------------------------------------------------
  // Permissions P1 US-008 — the replace check and the owner type
  // -------------------------------------------------------------------------

  it('US-008: hands the record the guard\'s replace check, for the requester\'s own decision key', async () => {
    const { guard, recordDecision, beforeSupersede, tool } = toolDeps();

    await tool.execute(ctx, tool.parse(draft()));

    expect(guard.replaceCheck).toHaveBeenCalledWith(ctx.actor, 'project-1');
    expect(recordDecision.mock.calls[0]?.[2]).toEqual({ beforeSupersede });
  });

  it('US-008: an agent records its decision with ownerType AGENT', async () => {
    const { recordDecision, tool } = toolDeps();
    const agentCtx = { ...ctx, actor: { ...ctx.actor, actorType: 'agent', id: 'agent-1' } } as unknown as ToolContext;

    await tool.execute(agentCtx, tool.parse(draft()));

    expect(recordDecision.mock.calls[0]?.[0]).toMatchObject({ actorId: 'agent-1', ownerType: 'AGENT' });
  });

  it('US-008: a supersede the store refuses is a forbidden action, never a generic failure', async () => {
    const { tool } = toolDeps({ failsReplace: true });

    await expect(tool.execute(ctx, tool.parse(draft()))).rejects.toThrow(ToolActionError);
    await expect(tool.execute(ctx, tool.parse(draft()))).rejects.toMatchObject({
      text: 'forbidden: memory:m2 needs memory.update',
    });
  });
});
