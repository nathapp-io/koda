import { Prisma } from '../../../generated/prisma/client';
import { PrismaThreadIngestRepository } from './prisma-thread-ingest.repository';
import type { ThreadIngestBatch } from './thread-ingestor';
import type { ThreadLine } from './thread-line';

type Msg = {
  id: string; threadId: string; seq: number; jobId: string | null; turnId: string | null; role: string;
  content: string; status: string; errorReason: string | null; streamRound: number | null; streamRoundStart: number | null;
  toolSummary?: unknown;
  pendingQuestion?: unknown;
};

/**
 * The rows a `findFirst` filter selects, newest seq first (the production approval query orders by seq desc). Honours
 * `toolSummary: { array_contains: [{ ... }] }` as Postgres JSON containment: an entry that has every key/value given.
 */
function matching(messages: Msg[], where: { threadId: string; turnId?: string; role: string; toolSummary?: { array_contains: unknown[] } }): Msg[] {
  return messages
    .filter((m) => m.threadId === where.threadId && m.role === where.role)
    .filter((m) => where.turnId === undefined || m.turnId === where.turnId)
    .filter((m) => {
      if (where.toolSummary === undefined) return true;
      const entries = (m.toolSummary as Array<Record<string, unknown>> | undefined) ?? [];
      return where.toolSummary.array_contains.some((probe) => entries.some((entry) =>
        Object.entries(probe as Record<string, unknown>).every(([key, value]) => entry[key] === value)));
    })
    .sort((a, b) => b.seq - a.seq);
}

/** An in-memory stand-in for the Prisma calls the fold makes. Enough to pin the fold's row effects. */
function fakeClient(opts: { command?: string; threadId?: string | null; nextSeq?: number; messages?: Msg[]; pendingQuestion?: unknown; session?: unknown; resume?: boolean } = {}) {
  const messages: Msg[] = [...(opts.messages ?? [])];
  const thread = {
    id: 'T', nextSeq: opts.nextSeq ?? 2, lastActivityAt: new Date(0),
    pendingQuestion: (opts.pendingQuestion === undefined ? { requestId: 'q1' } : opts.pendingQuestion) as unknown,
    session: (opts.session ?? null) as unknown,
  };
  const turn = { resume: opts.resume ?? false };
  const job = { id: 'J', command: opts.command ?? 'THREAD', threadId: opts.threadId === undefined ? 'T' : opts.threadId };
  const cursor = { offset: 0n, skippedLines: 0 };
  const client = {
    // Row locks (SELECT ... FOR UPDATE) return nothing; the seq UPDATE returns the seq it took and advances the counter.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      if (!strings.join('').includes('"nextSeq"')) return [];
      const taken = Math.max(thread.nextSeq, Math.max(0, ...messages.map((m) => m.seq)) + 1);
      thread.nextSeq = taken + 1;
      return [{ nextSeq: taken }];
    }),
    fleetJob: { findUnique: vi.fn(async () => job) },
    fleetThreadTurn: { findUnique: vi.fn(async () => turn) },
    chatMessage: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; threadId_turnId_role?: unknown } }) => {
        if (where.id) return messages.find((m) => m.id === where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { threadId: string; turnId?: string; role: string; toolSummary?: { array_contains: unknown[] } } }) =>
        matching(messages, where)[0] ?? null),
      findMany: vi.fn(async ({ where }: { where: { threadId: string; role: string } }) =>
        messages.filter((m) => m.threadId === where.threadId && m.role === where.role)),
      create: vi.fn(async ({ data }: { data: Partial<Msg> & { threadId: string } }) => {
        const row: Msg = {
          id: `m${messages.length + 1}`, jobId: null, turnId: null, role: 'user', content: '', status: 'pending',
          errorReason: null, streamRound: null, streamRoundStart: null, seq: 0, ...data,
        };
        messages.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Msg> }) => {
        const row = messages.find((m) => m.id === where.id) as Msg;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { threadId: string; status: { in: string[] } }; data: Partial<Msg> }) => {
        const hit = messages.filter((m) => m.threadId === where.threadId && where.status.in.includes(m.status));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      }),
    },
    chatThread: {
      findUnique: vi.fn(async () => thread),
      update: vi.fn(async ({ data }: { data: Partial<typeof thread> }) => Object.assign(thread, data)),
    },
    threadIngestCursor: { upsert: vi.fn(async () => cursor) },
    $executeRaw: vi.fn(async () => 0),
  };
  return { client, messages, thread };
}

function repoWith(client: unknown): PrismaThreadIngestRepository {
  const prisma = { client } as never;
  const txManager = { run: (fn: () => Promise<unknown>) => fn() } as never;
  return new PrismaThreadIngestRepository(prisma, txManager, { signal: vi.fn() } as never);
}

function batch(lines: ThreadLine[], overrides: Partial<ThreadIngestBatch> = {}): ThreadIngestBatch {
  return {
    jobId: 'J', leaseEpoch: 1, endOffset: 100, badLines: 0,
    lines: lines.map((line, i) => ({ line, endOffset: (i + 1) * 10 })),
    ...overrides,
  };
}

const start = (turnId = 't1'): ThreadLine => ({ type: 'turn_start', turnId });
const delta = (text: string, round = 1, turnId = 't1'): ThreadLine => ({ type: 'text_delta', turnId, round, text });
const reset = (round: number, turnId = 't1'): ThreadLine => ({ type: 'stream_reset', turnId, round });
const end = (over: Partial<Extract<ThreadLine, { type: 'turn_end' }>> = {}): ThreadLine => ({
  type: 'turn_end', turnId: 't1', status: 'completed', output: 'Final', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, ...over,
});

describe('PrismaThreadIngestRepository.fold (US-003)', () => {
  it('US-003 AC1: turn_start inserts a streaming assistant message at the next seq with jobId and turnId', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([start('t1')]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'assistant', status: 'streaming', content: '', seq: 2, jobId: 'J', turnId: 't1' });
  });

  it('US-003 AC1: turn_start advances the thread nextSeq so the next message gets a fresh seq', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([start('t1')]));
    expect(thread.nextSeq).toBe(3);
  });

  it('US-003 AC2: text_delta appends its text to the turn message content', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1')]));
    await repo.fold(batch([delta('Hel')]));
    await repo.fold(batch([delta('lo')]));
    expect(messages[0]?.content).toBe('Hello');
  });

  it('US-003 AC3: stream_reset of the same round cuts the content back to where the round began', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([start('t1'), delta('abc'), reset(1), delta('xyz')]));
    expect(messages[0]?.content).toBe('xyz');
  });

  it('US-003 AC4: stream_reset of a later round keeps the text of the earlier round', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([start('t1'), delta('one '), delta('two', 2), reset(2), delta('TWO', 2)]));
    expect(messages[0]?.content).toBe('one TWO');
  });

  it('US-003 AC5: a completed turn_end with output replaces the content and sets status complete', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), delta('partial')]));
    await repo.fold(batch([end({ status: 'completed', output: 'Final' })]));
    expect(messages[0]).toMatchObject({ content: 'Final', status: 'complete' });
  });

  it('US-003 AC6: a cancelled turn_end keeps the streamed content and sets status cancelled', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), delta('partial')]));
    await repo.fold(batch([end({ status: 'cancelled', output: '' })]));
    expect(messages[0]).toMatchObject({ content: 'partial', status: 'cancelled' });
  });

  it('US-003 AC7: an errored turn_end sets status errored and errorReason to the error message', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1')]));
    await repo.fold(batch([end({ status: 'errored', output: '', error: { code: 'E', message: 'boom' } })]));
    expect(messages[0]).toMatchObject({ status: 'errored', errorReason: 'boom' });
  });

  it('US-003 AC7: an errored turn_end without an error message falls back to the error code', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1')]));
    await repo.fold(batch([end({ status: 'errored', output: '', error: { code: 'E' } })]));
    expect(messages[0]).toMatchObject({ status: 'errored', errorReason: 'E' });
  });

  it('US-003 AC7: an errored turn_end truncates errorReason to 200 characters', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1')]));
    await repo.fold(batch([end({ status: 'errored', output: '', error: { message: 'x'.repeat(300) } })]));
    expect(messages[0]?.errorReason).toHaveLength(200);
  });

  it('US-003 AC8: replaying text_delta lines over a message does not duplicate text after a turn_start', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), delta('Hello')]));
    expect(messages[0]?.content).toBe('Hello');
    expect(messages).toHaveLength(1);
  });

  it('US-003 AC10: text_delta for a turn with no turn_start creates no message', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([delta('x', 0, 't9')]));
    expect(messages).toHaveLength(0);
  });

  it('US-003 AC11: a second turn_start for the same turnId creates no second assistant message', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1')]));
    await repo.fold(batch([start('t1')]));
    expect(messages.filter((m) => m.turnId === 't1' && m.role === 'assistant')).toHaveLength(1);
  });

  it('US-003 AC9: a turn_end on a message already errored keeps status errored and sets the content', async () => {
    const { client, messages } = fakeClient({
      nextSeq: 2,
      messages: [{ id: 'm1', threadId: 'T', seq: 2, jobId: 'J', turnId: 't1', role: 'assistant', content: 'partial', status: 'errored', errorReason: 'crashed', streamRound: 1, streamRoundStart: 0 }],
    });
    await repoWith(client).fold(batch([end({ status: 'completed', output: 'Late' })]));
    expect(messages[0]).toMatchObject({ status: 'errored', content: 'Late' });
  });

  it('US-003 turn_end rule: a turn_end clears the pending question and sets lastActivityAt', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2 });
    const before = thread.lastActivityAt;
    await repoWith(client).fold(batch([start('t1'), end()]));
    expect(thread.pendingQuestion).toBe(Prisma.DbNull);
    expect(thread.lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

const tool = (callId: string, input: unknown = { pattern: 'foo' }, turnId = 't1'): ThreadLine => ({ type: 'tool_call', turnId, callId, name: 'search_repo', input });
const result = (callId: string, isError: boolean, preview: string, turnId = 't1'): ThreadLine => ({ type: 'tool_result', turnId, callId, isError, preview });
const question = (over: Partial<Extract<ThreadLine, { type: 'question' }>> = {}): ThreadLine => ({
  type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: '2026-10-14T01:00:00.000Z', answerable: true, ...over,
});
const sessionStarted = (over: Partial<Extract<ThreadLine, { type: 'session_started' }>> = {}): ThreadLine => ({
  type: 'session_started', at: '2026-10-14T00:00:00.000Z', resumed: false, ...over,
});

describe('PrismaThreadIngestRepository.fold tools and approvals (US-004)', () => {
  it('US-004 AC1: a tool_call adds a toolSummary entry to the turn message', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), tool('c1')]));
    expect(messages[0]?.toolSummary).toEqual([
      { callId: 'c1', name: 'search_repo', input: '{"pattern":"foo"}', isError: null, preview: '', decidedBy: null },
    ]);
  });

  it('US-004 AC2: a tool_result sets isError and preview on that entry', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), tool('c1'), result('c1', true, 'refused')]));
    expect(messages[0]?.toolSummary).toEqual([
      expect.objectContaining({ callId: 'c1', isError: true, preview: 'refused' }),
    ]);
  });

  it('US-004 AC6: approval_requested then approval_resolved sets decidedBy on the entry for its callId', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), tool('c1')]));
    await repo.fold(batch([{ type: 'approval_requested', requestId: 'a1', callId: 'c1' }]));
    await repo.fold(batch([{ type: 'approval_resolved', requestId: 'a1', decidedBy: 'profile' }]));
    expect(messages[0]?.toolSummary).toEqual([expect.objectContaining({ callId: 'c1', decidedBy: 'profile' })]);
  });

  it('US-004 AC7: an answerable question sets pendingQuestion to requestId, text and expiresAt', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2, pendingQuestion: null });
    await repoWith(client).fold(batch([start('t1'), question()]));
    expect(thread.pendingQuestion).toEqual({ requestId: 'q1', text: 'Which repo?', expiresAt: '2026-10-14T01:00:00.000Z' });
  });

  it('US-004 AC8: an informational question leaves pendingQuestion null and adds an ask_human entry', async () => {
    const { client, thread, messages } = fakeClient({ nextSeq: 2, pendingQuestion: null });
    await repoWith(client).fold(batch([start('t1'), question({ answerable: false })]));
    expect(thread.pendingQuestion).toBeNull();
    expect(messages[0]?.toolSummary).toEqual([
      { callId: 'q1', name: 'ask_human', input: '', isError: null, preview: 'Which repo?', decidedBy: null },
    ]);
  });

  it('US-004 AC9: turn_end clears an answered pendingQuestion', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2, pendingQuestion: null });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), question()]));
    await repo.fold(batch([end()]));
    expect(thread.pendingQuestion).toBe(Prisma.DbNull);
  });

  it('US-004 AC12: session_started sets the thread session to a live session with resumed and contextReset false', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([sessionStarted()]));
    expect(thread.session).toEqual({ jobId: 'J', state: 'live', resumed: false, contextReset: false, reason: null, at: '2026-10-14T00:00:00.000Z' });
  });

  it('US-004 AC13: session_started with resumed false sets contextReset when the turn was a resume', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2, resume: true });
    await repoWith(client).fold(batch([sessionStarted({ resumed: false })]));
    expect(thread.session).toMatchObject({ resumed: false, contextReset: true });
  });

  it('US-004 AC13: session_started with resumed true on a resume turn does not set contextReset', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2, resume: true });
    await repoWith(client).fold(batch([sessionStarted({ resumed: true })]));
    expect(thread.session).toMatchObject({ resumed: true, contextReset: false });
  });

  it('US-004 AC14: session_failed sets the session state failed and its reason', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([{ type: 'session_failed', reason: 'model_unknown' }]));
    expect(thread.session).toMatchObject({ jobId: 'J', state: 'failed', reason: 'model_unknown', resumed: false, contextReset: false });
  });

  it('US-004 AC14: session_failed errors the pending and streaming messages and keeps their content', async () => {
    const { client, messages } = fakeClient({
      nextSeq: 2,
      messages: [
        { id: 'm1', threadId: 'T', seq: 1, jobId: null, turnId: null, role: 'user', content: 'hi', status: 'pending', errorReason: null, streamRound: null, streamRoundStart: null },
        { id: 'm2', threadId: 'T', seq: 2, jobId: 'J', turnId: 't1', role: 'assistant', content: 'partial', status: 'streaming', errorReason: null, streamRound: 1, streamRoundStart: 0 },
      ],
    });
    await repoWith(client).fold(batch([{ type: 'session_failed', reason: 'model_unknown' }]));
    expect(messages[0]).toMatchObject({ status: 'errored', errorReason: 'model_unknown', content: 'hi' });
    expect(messages[1]).toMatchObject({ status: 'errored', errorReason: 'model_unknown', content: 'partial' });
  });

  it('US-004 AC15: session_closed sets the session state closed with its reason', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2, session: { jobId: 'J', state: 'live', resumed: false, contextReset: false, reason: null, at: 'A' } });
    await repoWith(client).fold(batch([{ type: 'session_closed', reason: 'idle' }]));
    expect(thread.session).toMatchObject({ state: 'closed', reason: 'idle', resumed: false });
  });

  it('US-004 AC6: approval_resolved updates the newest message when two messages hold the same requestId', async () => {
    const holds = (id: string, seq: number) => ({ id, threadId: 'T', seq, jobId: 'J', turnId: `t${seq}`, role: 'assistant', content: '', status: 'complete', errorReason: null, streamRound: null, streamRoundStart: null, toolSummary: [{ callId: 'c1', name: 'x', input: '', isError: null, preview: '', decidedBy: null, requestId: 'a1' }] });
    const { client, messages } = fakeClient({ nextSeq: 9, messages: [holds('old', 2), holds('new', 7)] });
    await repoWith(client).fold(batch([{ type: 'approval_resolved', requestId: 'a1', decidedBy: 'profile' }]));
    expect(messages.find((m) => m.id === 'new')?.toolSummary).toEqual([expect.objectContaining({ decidedBy: 'profile' })]);
    expect(messages.find((m) => m.id === 'old')?.toolSummary).toEqual([expect.objectContaining({ decidedBy: null })]);
  });

  it('US-004 AC6: approval_requested links a requestId to the message that holds the callId', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    const repo = repoWith(client);
    await repo.fold(batch([start('t1'), tool('c1')]));
    await repo.fold(batch([{ type: 'approval_requested', requestId: 'a1', callId: 'c1' }]));
    expect(messages[0]?.toolSummary).toEqual([expect.objectContaining({ callId: 'c1', requestId: 'a1' })]);
  });

  it('US-004 AC8: an informational question for an unknown turn counts one skipped line and adds no entry', async () => {
    const { client, messages } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([question({ turnId: 't9', answerable: false })]));
    expect(messages).toHaveLength(0);
    expect(client.threadIngestCursor.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ skippedLines: { increment: 1 } }),
    }));
  });

  it('US-004 AC15: a close for a new job does not carry the previous job resumed or contextReset flags', async () => {
    const { client, thread } = fakeClient({
      nextSeq: 2,
      session: { jobId: 'OLD', state: 'live', resumed: true, contextReset: true, reason: null, at: 'A' },
    });
    await repoWith(client).fold(batch([{ type: 'session_closed', reason: 'idle' }]));
    expect(thread.session).toEqual({ jobId: 'J', state: 'closed', resumed: false, contextReset: false, reason: 'idle', at: expect.any(String) });
  });

  it('US-004 AC15: a close for the same job keeps its resumed and contextReset flags', async () => {
    const { client, thread } = fakeClient({
      nextSeq: 2,
      session: { jobId: 'J', state: 'live', resumed: true, contextReset: false, reason: null, at: 'A' },
    });
    await repoWith(client).fold(batch([{ type: 'session_closed', reason: 'idle' }]));
    expect(thread.session).toMatchObject({ jobId: 'J', state: 'closed', resumed: true, contextReset: false });
  });

  it('US-004 AC7: an answerable question text is cut to 2048 characters, never splitting a surrogate pair', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2, pendingQuestion: null });
    const text = `${'a'.repeat(2047)}😀tail`;
    await repoWith(client).fold(batch([question({ text })]));
    const stored = (thread.pendingQuestion as { text: string }).text;
    expect([...stored]).toHaveLength(2048);
    expect(stored.endsWith('😀')).toBe(true);
  });

  it('US-004 AC15: session_closed with no prior session sets resumed and contextReset false', async () => {
    const { client, thread } = fakeClient({ nextSeq: 2 });
    await repoWith(client).fold(batch([{ type: 'session_closed', reason: 'idle' }]));
    expect(thread.session).toMatchObject({ state: 'closed', reason: 'idle', resumed: false, contextReset: false });
  });
});
