import { Test, type TestingModule } from '@nestjs/testing';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CommentsService } from '../../../comments/comments.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { PENDING_ACTION_REPOSITORY, type PendingActionRecord } from '../actions/pending-action.domain';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolInputError, type ToolContext } from '../assistant-tool.types';
import { KODA_ADD_COMMENT, KODA_GET_ACTION, KODA_TOOL_DESCRIPTORS } from '../koda-tool-descriptors';
import { ActionTools, addCommentTool, getActionTool } from './action-tools';

/**
 * Fleet S5b 2a US-003: the pilot confirmed write tool and the scoped action read. Both tools are pure over their
 * dependencies here — the DB-backed path is `test/integration/fleet/assistant-action-tools.integration.spec.ts`.
 */

/** A single-line stand-in for `ToolContext.data`, so the expected text of a result stays readable. */
const data = (text: string): string => `<<koda-data>>${text}<<end-koda-data>>`;

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test', projectRole: 'DEVELOPER' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data,
} as unknown as ToolContext;

const TICKET = { ref: 'KODA-1', title: 'Fix login page' };

/** The `koda_add_comment` dependencies, fresh per call: no mock state outlives one test. */
function commentDeps() {
  const tickets = { findByRef: vi.fn(async () => TICKET) };
  const comments = { create: vi.fn(async () => ({ id: 'c9' })) };
  return {
    tickets,
    comments,
    tool: addCommentTool({ tickets: tickets as unknown as TicketsService, comments: comments as unknown as CommentsService }),
  };
}

/** An action row as the repository answers it, with the fields `koda_get_action` prints. */
const action = (over: Partial<PendingActionRecord> = {}): PendingActionRecord => ({
  actorType: 'user', actorId: 'dev-1', origin: 'thread', approvalMode: 'human', approverType: null, approverId: null,
  id: 'a1', projectId: 'project-1', projectSlug: 'web', threadId: 'thread-1', jobId: 'job-1', toolCallId: 'c1',
  tool: 'koda_add_comment', input: { ref: 'KODA-1', body: 'hello' }, preview: 'Add a comment to KODA-1 "Fix login page":\n\nhello',
  status: 'PENDING', approvalId: 'ap1', decidedAt: null, result: null,
  deliveredAt: null, expiresAt: new Date('2026-10-24T09:00:00.000Z'), createdAt: new Date('2026-10-23T09:00:00.000Z'),
  ...over,
});

/** The `koda_get_action` dependency: one scoped repository read. */
function actionDeps(found: PendingActionRecord | null) {
  const findScopedById = vi.fn(async () => found);
  return { findScopedById, tool: getActionTool({ findScopedById, findScopedByActor: vi.fn(async () => null) }) };
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

describe('koda_add_comment parse (US-003)', () => {
  it('AC-1: a body of whitespace refuses with reason body', () => {
    expect(reasonOf(() => commentDeps().tool.parse({ ref: 'KODA-1', body: '   ' }))).toBe('body');
  });

  it('AC-2: a body of 10001 characters refuses with reason body', () => {
    expect(reasonOf(() => commentDeps().tool.parse({ ref: 'KODA-1', body: 'x'.repeat(10_001) }))).toBe('body');
  });

  it('AC-3: a ref that is not a ticket ref refuses with reason ref', () => {
    expect(reasonOf(() => commentDeps().tool.parse({ ref: 'not a ref', body: 'x' }))).toBe('ref');
  });

  it('accepts a KEY-N ref and a 10000-character body, and keeps the body as written', () => {
    const tool = commentDeps().tool;
    expect(tool.parse({ ref: 'KODA-1', body: '  hello  ' })).toEqual({ ref: 'KODA-1', body: '  hello  ' });
    expect(tool.parse({ ref: 'W1-3', body: 'x'.repeat(10_000) })).toEqual({ ref: 'W1-3', body: 'x'.repeat(10_000) });
    expect(tool.parse({ ref: 'KODA-12', body: 'a\nb' })).toEqual({ ref: 'KODA-12', body: 'a\nb' });
  });

  it('refuses a missing, non-string or non-ref-shaped input', () => {
    const tool = commentDeps().tool;
    expect(reasonOf(() => tool.parse({ body: 'x' }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ref: 'web-1', body: 'x' }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-0', body: 'x' }))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ref: 'clx0a1b2c3d4e5f6g7h8i', body: 'x' }))).toBe('ref');
    expect(reasonOf(() => tool.parse(null))).toBe('ref');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1' }))).toBe('body');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', body: 7 }))).toBe('body');
    expect(reasonOf(() => tool.parse({ ref: 'KODA-1', body: null }))).toBe('body');
  });

  it('is a write tool that needs create Comment', () => {
    const tool = commentDeps().tool;
    expect(tool.descriptor).toBe(KODA_ADD_COMMENT);
    expect(tool.kind).toBe('write');
    expect(tool.permission).toEqual({ kind: 'ability', action: 'create', subject: 'Comment' });
  });
});

describe('koda_add_comment preview (US-003)', () => {
  it('names the ticket and answers the body the user approves', async () => {
    const { tickets, tool } = commentDeps();

    const preview = await tool.preview?.(ctx, { ref: 'KODA-1', body: 'hello' });

    expect(tickets.findByRef).toHaveBeenCalledWith('web', 'KODA-1');
    expect(preview).toBe('Add a comment to KODA-1 "Fix login page":\n\nhello');
  });

  it('masks secret-like values in the whole preview, so the approved text never carries them', async () => {
    const { tool } = commentDeps();
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;

    const preview = await tool.preview?.(ctx, { ref: 'KODA-1', body: `use ${token}` });

    expect(preview).toBe('Add a comment to KODA-1 "Fix login page":\n\nuse [masked]');
    expect(preview).not.toContain(token);
  });

  it('answers the not-found ref of the read service unchanged, for the executor to map', async () => {
    const tickets = { findByRef: vi.fn(async () => { throw new NotFoundAppException({}, 'tickets'); }) };
    const tool = addCommentTool({ tickets: tickets as unknown as TicketsService, comments: {} as CommentsService });

    await expect(tool.preview?.(ctx, { ref: 'KODA-9', body: 'x' })).rejects.toBeInstanceOf(NotFoundAppException);
  });
});

describe('koda_add_comment execute (US-003)', () => {
  it('AC-9: creates the comment in the context\'s project with the caller as its author', async () => {
    const { comments, tool } = commentDeps();

    await tool.execute(ctx, { ref: 'KODA-1', body: 'hello' });

    expect(comments.create).toHaveBeenCalledWith('web', 'KODA-1', { body: 'hello', type: 'GENERAL' }, ctx.actor);
  });

  it('AC-10: answers the created comment\'s id and the ticket path', async () => {
    const { tool } = commentDeps();

    const content = await tool.execute(ctx, { ref: 'KODA-1', body: 'hello' });

    expect(content).toBe('comment c9 added to KODA-1 /web/tickets/KODA-1');
  });
});

describe('koda_get_action (US-003)', () => {
  it('AC-13: an id of 65 characters refuses with reason id', () => {
    expect(reasonOf(() => actionDeps(null).tool.parse({ id: 'x'.repeat(65) }))).toBe('id');
  });

  it('accepts an id of 1 to 64 characters and refuses everything else', () => {
    const tool = actionDeps(null).tool;
    expect(tool.parse({ id: 'a1' })).toEqual({ id: 'a1' });
    expect(tool.parse({ id: 'x'.repeat(64) })).toEqual({ id: 'x'.repeat(64) });
    expect(reasonOf(() => tool.parse({ id: '' }))).toBe('id');
    expect(reasonOf(() => tool.parse({ id: 42 }))).toBe('id');
    expect(reasonOf(() => tool.parse({}))).toBe('id');
    expect(reasonOf(() => tool.parse(null))).toBe('id');
  });

  it('is a read tool any project member may call', () => {
    const tool = actionDeps(null).tool;
    expect(tool.descriptor).toBe(KODA_GET_ACTION);
    expect(tool.kind).toBeUndefined();
    expect(tool.permission).toEqual({ kind: 'member' });
  });

  it('AC-14: an EXECUTED action answers its result through ctx.data', async () => {
    const result = 'comment c9 added to KODA-1 /web/tickets/KODA-1';
    const tool = actionDeps(action({ status: 'EXECUTED', result, decidedAt: new Date('2026-10-23T09:30:00.000Z') })).tool;

    const content = await tool.execute(ctx, { id: 'a1' });

    expect(content).toBe([
      'action a1 koda_add_comment EXECUTED',
      'requested 2026-10-23T09:00:00.000Z',
      'decided 2026-10-23T09:30:00.000Z',
      'result:',
      data(result),
    ].join('\n'));
  });

  it('names the id, the tool and the status, and adds no decided or result line while undecided', async () => {
    const tool = actionDeps(action({ status: 'REJECTED', approverType: 'user', approverId: 'dev-1', decidedAt: null })).tool;

    const content = await tool.execute(ctx, { id: 'a1' });

    expect(content.split('\n')).toEqual(['action a1 koda_add_comment REJECTED', 'requested 2026-10-23T09:00:00.000Z']);
  });

  it('reads the action scoped by its id, the context\'s project and the context\'s thread', async () => {
    const { findScopedById, tool } = actionDeps(action());

    await tool.execute(ctx, { id: 'a1' });

    expect(findScopedById).toHaveBeenCalledWith('a1', 'project-1', 'thread-1');
  });

  it('throws not found for an action another thread, another project or no one proposed', async () => {
    const tool = actionDeps(null).tool;

    await expect(tool.execute(ctx, { id: 'a1' })).rejects.toBeInstanceOf(NotFoundAppException);
  });
});

// The real registry, filled by ActionTools.onModuleInit through Nest's lifecycle.
describe('ActionTools provider (US-003)', () => {
  let module: TestingModule;
  let registry: AssistantToolRegistry;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        ActionTools,
        AssistantToolRegistry,
        { provide: TicketsService, useValue: { findByRef: vi.fn() } },
        { provide: CommentsService, useValue: { create: vi.fn() } },
        { provide: PENDING_ACTION_REPOSITORY, useValue: { findScopedById: vi.fn() } },
      ],
    }).compile();
    await module.init();
    registry = module.get(AssistantToolRegistry);
  });

  afterAll(async () => {
    await module.close();
  });

  it('registers both action tools with their KODA_TOOL_DESCRIPTORS entry as their descriptor', () => {
    for (const name of ['koda_get_action', 'koda_add_comment']) {
      expect(registry.get(name)?.descriptor).toBe(KODA_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name));
    }
  });
});
