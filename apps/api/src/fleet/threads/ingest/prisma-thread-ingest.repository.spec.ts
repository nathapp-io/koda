import { Prisma } from '../../../generated/prisma/client';
import { PrismaThreadIngestRepository } from './prisma-thread-ingest.repository';
import type { ThreadIngestBatch } from './thread-ingestor';
import type { ThreadLine } from './thread-line';

type Msg = {
  id: string; threadId: string; seq: number; jobId: string | null; turnId: string | null; role: string;
  content: string; status: string; errorReason: string | null; streamRound: number | null; streamRoundStart: number | null;
  pendingQuestion?: unknown;
};

/** An in-memory stand-in for the Prisma calls the fold makes. Enough to pin the fold's row effects. */
function fakeClient(opts: { command?: string; threadId?: string | null; nextSeq?: number; messages?: Msg[] } = {}) {
  const messages: Msg[] = [...(opts.messages ?? [])];
  const thread = { id: 'T', nextSeq: opts.nextSeq ?? 2, lastActivityAt: new Date(0), pendingQuestion: { requestId: 'q1' } as unknown };
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
    chatMessage: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; threadId_turnId_role?: unknown } }) => {
        if (where.id) return messages.find((m) => m.id === where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { threadId: string; turnId: string; role: string } }) =>
        messages.find((m) => m.threadId === where.threadId && m.turnId === where.turnId && m.role === where.role) ?? null),
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
  return new PrismaThreadIngestRepository(prisma, txManager);
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
