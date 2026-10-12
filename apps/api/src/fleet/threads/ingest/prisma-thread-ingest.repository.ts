import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ThreadLiveEvent } from '../../../live/thread-event-bus';
import { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { BudgetEvaluator } from '../../budgets/budget-evaluator';
import { jobSpendKeys } from '../../budgets/budget-rules';
import { round4 } from './thread-cost';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ThreadIngestBatch, ThreadIngestRepository, FoldResult } from './thread-ingestor';
import type { UnfoldedStream } from './thread-ingest.bootstrap';
import { ACTIVE_STATES } from '../../jobs/job-state';
import type { AssistantThreadLine, QuestionThreadLine, SessionThreadLine, ThreadLine, ToolThreadLine, UsageThreadLine } from './thread-line';
import {
  linkApprovalRequest, setApprovalDecision, setToolResult, upsertInformationalQuestion, upsertToolCall, type ToolSummaryEntry,
} from './tool-summary';

const ERROR_REASON_MAX = 200;

/** Startup catch-up cap per boot (US-007). */
const UNFOLDED_STREAM_LIMIT = 200;

const QUESTION_TEXT_MAX = 2048;

/** A ThreadSession as stored in `ChatThread.session` (the API `session` JSON). */
interface StoredSession { jobId: string; state: 'live' | 'closed' | 'failed'; resumed: boolean; contextReset: boolean; reason: string | null; at: string }

/** Reads a message's stored `toolSummary` (JSON, written only by this fold) as its typed entries. */
const readSummary = (json: Prisma.JsonValue | null): ToolSummaryEntry[] => (json as unknown as ToolSummaryEntry[] | null) ?? [];

const isToolLine = (line: ThreadLine): line is ToolThreadLine =>
  line.type === 'tool_call' || line.type === 'tool_result' || line.type === 'approval_requested' || line.type === 'approval_resolved';
const isSessionLine = (line: ThreadLine): line is SessionThreadLine =>
  line.type === 'session_started' || line.type === 'session_closed' || line.type === 'session_failed';

@Injectable()
export class PrismaThreadIngestRepository implements ThreadIngestRepository {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly budgets: BudgetEvaluator,
  ) {}

  /** Startup catch-up candidates (US-007): a THREAD attempt whose stream holds bytes past its cursor, at most 200. */
  async findUnfolded(): Promise<UnfoldedStream[]> {
    const rows = await this.prisma.client.$queryRaw<Array<{ jobId: string; leaseEpoch: number }>>`
      SELECT j."id" AS "jobId", l."leaseEpoch" AS "leaseEpoch"
      FROM "FleetJob" j
      JOIN "FleetJobLog" l ON l."jobId" = j."id" AND l."stream" = 'thread'
      LEFT JOIN "ThreadIngestCursor" c ON c."jobId" = l."jobId" AND c."leaseEpoch" = l."leaseEpoch"
      WHERE j."command" = 'THREAD'
        AND (j."state" IN (${Prisma.join([...ACTIVE_STATES])})
          OR j."finishedAt" >= now() - interval '24 hours')
        AND l."sizeBytes" > COALESCE(c."offset", 0)
      ORDER BY j."queuedAt" ASC, j."id" ASC
      LIMIT ${UNFOLDED_STREAM_LIMIT}
    `;
    return rows;
  }

  async readCursor(jobId: string, leaseEpoch: number): Promise<{ offset: number; skippedLines: number }> {
    const cursor = await this.prisma.client.threadIngestCursor.findUnique({
      where: { jobId_leaseEpoch: { jobId, leaseEpoch } },
      select: { offset: true, skippedLines: true },
    });
    return { offset: Number(cursor?.offset ?? 0n), skippedLines: cursor?.skippedLines ?? 0 };
  }

  async fold(batch: ThreadIngestBatch): Promise<FoldResult> {
    let spendKeys: string[] = [];
    const result = await this.txManager.run(async (): Promise<FoldResult> => {
      const db = this.prisma.client;
      await db.$queryRaw`SELECT "id" FROM "FleetJob" WHERE "id" = ${batch.jobId} FOR UPDATE`;
      const job = await db.fleetJob.findUnique({ where: { id: batch.jobId }, select: {
        id: true, command: true, threadId: true, leaseEpoch: true, projectId: true, repoId: true, runnerId: true,
      } });
      let threadId: string | null = null;
      if (job) spendKeys = jobSpendKeys(job);
      if (job?.command === 'THREAD' && job.threadId) {
        await db.$queryRaw`SELECT "id" FROM "ChatThread" WHERE "id" = ${job.threadId} FOR UPDATE`;
        threadId = job.threadId;
      }
      let skippedLines = 0;
      let costChanged = false;
      const changedTurns = new Set<string>();
      const messageEventTurns = new Set<string>();
      const messageIds = new Set<string>();
      const deltaText = new Map<string, string>();
      const resetTurns = new Set<string>();
      const questions: Array<{ requestId: string; text: string }> = [];
      let threadChanged = false;
      if (threadId && job && !batch.rejectedLine) {
        for (const { line } of batch.lines) {
          if (line.type === 'input_consumed') {
            await this.foldInputConsumed(threadId, line.messageId);
            messageIds.add(line.messageId);
          }
          else if (isToolLine(line)) {
            const folded = await this.foldToolLine(threadId, line);
            skippedLines += folded.skipped;
            if ('turnId' in line && folded.messageId) {
              changedTurns.add(line.turnId);
              messageEventTurns.add(line.turnId);
            } else if (folded.messageId) {
              messageIds.add(folded.messageId);
            }
          }
          else if (line.type === 'question') {
            skippedLines += await this.foldQuestion(threadId, line);
            if (line.answerable) {
              questions.push({ requestId: line.requestId, text: line.text });
              threadChanged = true;
            }
            else {
              changedTurns.add(line.turnId);
              messageEventTurns.add(line.turnId);
            }
          }
          else if (isSessionLine(line)) { await this.foldSessionLine(batch, threadId, line); threadChanged = true; }
          else if (line.type === 'usage') {
            const folded = await this.foldUsage(batch, job, threadId, line);
            skippedLines += Number(folded.skipped);
            costChanged = folded.costChanged || costChanged;
            threadChanged = folded.changed || threadChanged;
          }
          else {
            if (line.type === 'turn_end') costChanged = await this.foldTurnEnd(batch, job, threadId, line) || costChanged;
            const skipped = await this.foldAssistantLine(batch, threadId, line);
            skippedLines += skipped;
            if (!skipped && 'turnId' in line) {
              if (line.type === 'turn_end') threadChanged = true;
              changedTurns.add(line.turnId);
              if (line.type === 'text_delta') deltaText.set(line.turnId, (deltaText.get(line.turnId) ?? '') + line.text);
              else messageEventTurns.add(line.turnId);
              if (line.type === 'stream_reset') resetTurns.add(line.turnId);
            }
          }
        }
        if (costChanged) await this.rederiveCosts(batch, job, threadId);
      }
      await db.threadIngestCursor.upsert({
        where: { jobId_leaseEpoch: { jobId: batch.jobId, leaseEpoch: batch.leaseEpoch } },
        create: { jobId: batch.jobId, leaseEpoch: batch.leaseEpoch, offset: BigInt(batch.endOffset), skippedLines: batch.badLines + skippedLines },
        update: { offset: BigInt(batch.endOffset), skippedLines: { increment: batch.badLines + skippedLines } },
      });
      const liveEvents: ThreadLiveEvent[] = [];
      if (threadId && !batch.rejectedLine) {
        const turns = [...changedTurns];
        const messages = turns.length ? await db.chatMessage.findMany({
          where: { threadId, role: 'assistant', turnId: { in: turns } }, select: { id: true, turnId: true },
        }) : [];
        const at = new Date().toISOString();
        const base = { id: randomUUID(), threadId, at };
        for (const messageId of messageIds) liveEvents.push({ ...base, id: randomUUID(), type: 'message', messageId });
        for (const message of messages) {
          if (message.turnId && messageEventTurns.has(message.turnId)) {
            liveEvents.push({ ...base, id: randomUUID(), type: 'message', messageId: message.id });
          }
        }
        for (const message of messages) {
          const text = message.turnId ? deltaText.get(message.turnId) : undefined;
          if (text && !resetTurns.has(message.turnId as string)) liveEvents.push({ ...base, id: randomUUID(), type: 'delta', messageId: message.id, text });
        }
        for (const question of questions) liveEvents.push({ ...base, id: randomUUID(), type: 'question', ...question });
        if (threadChanged) liveEvents.push({ ...base, id: randomUUID(), type: 'thread' });
      }
      return { costChanged, events: liveEvents };
    });
    if (result.costChanged) this.budgets.signal(spendKeys);
    return result;
  }

  private async foldUsage(batch: ThreadIngestBatch, job: { id: string; leaseEpoch: number; projectId: string; repoId: string; runnerId: string | null }, threadId: string, line: UsageThreadLine): Promise<{ costChanged: boolean; skipped: boolean; changed: boolean }> {
    const db = this.prisma.client;
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' } });
    if (!message) return { costChanged: false, skipped: true, changed: false };
    const source = line.costSource ?? 'computed';
    let inserted = true;
    if (source !== 'unpriced') {
      const thread = await db.chatThread.findUniqueOrThrow({ where: { id: threadId }, select: { backend: true, feature: true } });
      const backend = thread.backend as { kind?: string; agent?: string; model?: string };
      const create = await db.fleetCostEvent.createMany({ data: [{
        jobId: job.id, leaseEpoch: batch.leaseEpoch, projectId: job.projectId, repoId: job.repoId, runnerId: job.runnerId,
        at: line.at ? new Date(line.at) : new Date(), agentName: backend.kind === 'native' ? 'native' : backend.agent ?? 'native',
        model: backend.model ?? 'default', profile: 'read', stage: 'thread', featureName: thread.feature,
        callId: `${line.turnId}:${line.round}`, inputTokens: line.inputTokens, outputTokens: line.outputTokens,
        cacheReadTokens: line.cacheRead, cacheWriteTokens: line.cacheWrite, costUsd: new Prisma.Decimal(line.costUsd), pricingSource: source,
      }], skipDuplicates: true });
      inserted = create.count > 0;
    }
    if (!inserted) return { costChanged: false, skipped: false, changed: false };
    const previous = (message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null) ?? {};
    const increments = { input: line.inputTokens, output: line.outputTokens, cacheRead: line.cacheRead, cacheWrite: line.cacheWrite };
    await db.chatMessage.update({ where: { id: message.id }, data: {
      usage: { input: (previous.input ?? 0) + increments.input, output: (previous.output ?? 0) + increments.output,
        cacheRead: (previous.cacheRead ?? 0) + increments.cacheRead, cacheWrite: (previous.cacheWrite ?? 0) + increments.cacheWrite },
      ...(source !== 'unpriced' ? { costSource: source } : {}),
    } });
    const thread = await db.chatThread.findUniqueOrThrow({ where: { id: threadId }, select: { tokens: true } });
    const prior = (thread.tokens as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null) ?? {};
    await db.chatThread.update({ where: { id: threadId }, data: { tokens: {
      input: (prior.input ?? 0) + increments.input, output: (prior.output ?? 0) + increments.output,
      cacheRead: (prior.cacheRead ?? 0) + increments.cacheRead, cacheWrite: (prior.cacheWrite ?? 0) + increments.cacheWrite,
    } } });
    return { costChanged: source !== 'unpriced' && line.costUsd > 0, skipped: false, changed: true };
  }

  private async foldTurnEnd(batch: ThreadIngestBatch, job: { id: string; projectId: string; repoId: string; runnerId: string | null }, threadId: string, line: Extract<AssistantThreadLine, { type: 'turn_end' }>): Promise<boolean> {
    const db = this.prisma.client;
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' } });
    if (!message) return false;
    const previous = (message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null) ?? {};
    const totals = { input: line.usage.inputTokens, output: line.usage.outputTokens, cacheRead: line.usage.cacheReadTokens, cacheWrite: line.usage.cacheWriteTokens };
    const additions = { input: Math.max(0, totals.input - (previous.input ?? 0)), output: Math.max(0, totals.output - (previous.output ?? 0)),
      cacheRead: Math.max(0, totals.cacheRead - (previous.cacheRead ?? 0)), cacheWrite: Math.max(0, totals.cacheWrite - (previous.cacheWrite ?? 0)) };
    if (Object.values(additions).some((value) => value > 0)) {
      const usage = { input: (previous.input ?? 0) + additions.input, output: (previous.output ?? 0) + additions.output,
        cacheRead: (previous.cacheRead ?? 0) + additions.cacheRead, cacheWrite: (previous.cacheWrite ?? 0) + additions.cacheWrite };
      await db.chatMessage.update({ where: { id: message.id }, data: { usage } });
      const thread = await db.chatThread.findUniqueOrThrow({ where: { id: threadId }, select: { tokens: true } });
      const prior = (thread.tokens as typeof usage | null) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      await db.chatThread.update({ where: { id: threadId }, data: { tokens: {
        input: (prior.input ?? 0) + additions.input, output: (prior.output ?? 0) + additions.output,
        cacheRead: (prior.cacheRead ?? 0) + additions.cacheRead, cacheWrite: (prior.cacheWrite ?? 0) + additions.cacheWrite,
      } } });
    }
    if (line.costSource === 'unpriced' || line.costUsd === 0) return false;
    const turnSpend = await this.sumTurnCost(job.id, line.turnId, batch.leaseEpoch);
    const reconcile = new Prisma.Decimal(line.costUsd).sub(turnSpend);
    if (reconcile.lte(0)) return false;
    const thread = await db.chatThread.findUniqueOrThrow({ where: { id: threadId }, select: { backend: true, feature: true } });
    const backend = thread.backend as { kind?: string; agent?: string; model?: string };
    const result = await db.fleetCostEvent.createMany({ data: [{
      jobId: job.id, leaseEpoch: batch.leaseEpoch, projectId: job.projectId, repoId: job.repoId, runnerId: job.runnerId,
      at: new Date(), agentName: backend.kind === 'native' ? 'native' : backend.agent ?? 'native', model: backend.model ?? 'default',
      profile: 'read', stage: 'thread', featureName: thread.feature, callId: `${line.turnId}:turn_end`,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: reconcile, pricingSource: line.costSource ?? 'computed',
    }], skipDuplicates: true });
    return result.count > 0;
  }

  private async rederiveCosts(batch: ThreadIngestBatch, job: { id: string }, threadId: string): Promise<void> {
    const db = this.prisma.client;
    const jobSum = await db.fleetCostEvent.aggregate({ where: { jobId: job.id }, _sum: { costUsd: true } });
    await db.fleetJob.update({ where: { id: job.id }, data: { costSpentUsd: round4(new Prisma.Decimal(jobSum._sum.costUsd ?? 0)) } });
    const threadSum = await db.fleetCostEvent.aggregate({ where: { job: { threadId } }, _sum: { costUsd: true } });
    await db.chatThread.update({ where: { id: threadId }, data: { costUsd: round4(new Prisma.Decimal(threadSum._sum.costUsd ?? 0)) } });
    const messages = await db.chatMessage.findMany({ where: { threadId, role: 'assistant' }, select: { id: true, turnId: true, jobId: true } });
    for (const message of messages) {
      if (!message.turnId) continue;
      const total = await this.sumTurnCost(message.jobId ?? batch.jobId, message.turnId);
      await db.chatMessage.update({ where: { id: message.id }, data: { costUsd: round4(total) } });
    }
  }

  private async sumTurnCost(jobId: string, turnId: string, leaseEpoch?: number): Promise<Prisma.Decimal> {
    const prefix = `${turnId}:`;
    const rows = await this.prisma.client.$queryRaw<Array<{ total: Prisma.Decimal }>>`
      SELECT COALESCE(SUM("costUsd"), 0)::decimal AS "total"
      FROM "FleetCostEvent"
      WHERE "jobId" = ${jobId}
        ${leaseEpoch === undefined ? Prisma.empty : Prisma.sql`AND "leaseEpoch" = ${leaseEpoch}`}
        AND left("callId", char_length(${prefix})) = ${prefix}
        AND substring("callId" FROM char_length(${prefix}) + 1) ~ '^(turn_end|[0-9]+)$'
    `;
    return rows[0]?.total ?? new Prisma.Decimal(0);
  }

  private async foldInputConsumed(threadId: string, messageId: string): Promise<void> {
    const message = await this.prisma.client.chatMessage.findUnique({ where: { id: messageId } });
    if (!message || message.threadId !== threadId || message.role !== 'user') throw new Error('input_consumed message does not belong to this thread');
    if (message.status === 'pending') {
      await this.prisma.client.chatMessage.update({ where: { id: message.id }, data: { status: 'complete' } });
    }
  }

  /** Folds one assistant-side line. Returns 1 when the line is bad (unknown or duplicate turn), else 0. */
  private async foldAssistantLine(batch: ThreadIngestBatch, threadId: string, line: Exclude<AssistantThreadLine, UsageThreadLine>): Promise<number> {
    const db = this.prisma.client;
    if (line.type === 'turn_start') {
      const existing = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' }, select: { id: true } });
      if (existing) return 1;
      const seq = await this.allocateSeq(threadId);
      await db.chatMessage.create({ data: { threadId, seq, role: 'assistant', status: 'streaming', content: '', jobId: batch.jobId, turnId: line.turnId } });
      return 0;
    }
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' } });
    if (!message) return 1;
    if (line.type === 'text_delta') {
      const roundChanged = message.streamRound !== line.round;
      await db.chatMessage.update({ where: { id: message.id }, data: {
        content: message.content + line.text,
        ...(roundChanged ? { streamRound: line.round, streamRoundStart: message.content.length } : {}),
      } });
      return 0;
    }
    if (line.type === 'stream_reset') {
      if (message.streamRound === line.round && message.streamRoundStart !== null) {
        await db.chatMessage.update({ where: { id: message.id }, data: { content: message.content.slice(0, message.streamRoundStart) } });
      }
      return 0;
    }
    const finalOutput = line.status === 'completed' && line.output !== '' && line.outputTruncated !== true;
    const streaming = message.status === 'streaming';
    await db.chatMessage.update({ where: { id: message.id }, data: {
      ...(finalOutput ? { content: line.output } : {}),
      ...(streaming ? { status: line.status === 'completed' ? 'complete' : line.status } : {}),
      ...(streaming && line.status === 'errored' ? { errorReason: (line.error?.message ?? line.error?.code ?? null)?.slice(0, ERROR_REASON_MAX) ?? null } : {}),
    } });
    await db.chatThread.update({ where: { id: threadId }, data: { pendingQuestion: Prisma.DbNull, lastActivityAt: new Date() } });
    return 0;
  }

  /**
   * Folds a tool or approval line into the `toolSummary` of the turn's assistant message. Approval lines carry no turnId,
   * so they match the message whose summary already holds the request. Returns 1 for a tool_* line with no message.
   */
  private async foldToolLine(threadId: string, line: ToolThreadLine): Promise<{ skipped: number; messageId?: string }> {
    const db = this.prisma.client;
    if (line.type === 'approval_requested' && line.callId === undefined) return { skipped: 0 };
    if (line.type === 'approval_requested' || line.type === 'approval_resolved') {
      // The message whose summary holds the call (requested) or the request (resolved). Matched by containment on the JSON.
      // Newest first, so a callId reused across turns always resolves to the same message.
      const holds = line.type === 'approval_requested' ? { callId: line.callId } : { requestId: line.requestId };
      const message = await db.chatMessage.findFirst({
        where: { threadId, role: 'assistant', toolSummary: { array_contains: [holds] } },
        orderBy: { seq: 'desc' },
        select: { id: true, toolSummary: true },
      });
      if (!message) return { skipped: 0 };
      const entries = readSummary(message.toolSummary);
      const next = line.type === 'approval_requested'
        ? linkApprovalRequest(entries, line.callId as string, line.requestId)
        : setApprovalDecision(entries, line.requestId, line.decidedBy);
      if (JSON.stringify(entries) === JSON.stringify(next)) return { skipped: 0 };
      await db.chatMessage.update({ where: { id: message.id }, data: { toolSummary: next as unknown as Prisma.InputJsonValue } });
      return { skipped: 0, messageId: message.id };
    }
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' }, select: { id: true, toolSummary: true } });
    if (!message) return { skipped: 1 };
    const entries = readSummary(message.toolSummary);
    const next = line.type === 'tool_call'
      ? upsertToolCall(entries, { callId: line.callId, name: line.name, input: line.input })
      : setToolResult(entries, line.callId, line.isError, line.preview);
    if (JSON.stringify(entries) === JSON.stringify(next)) return { skipped: 0 };
    await db.chatMessage.update({ where: { id: message.id }, data: { toolSummary: next as unknown as Prisma.InputJsonValue } });
    return { skipped: 0, messageId: message.id };
  }

  /**
   * An answerable question sets the thread's `pendingQuestion`; an informational one becomes an `ask_human` tool entry.
   * Returns 1 when an informational question names a turn with no assistant message, else 0.
   */
  private async foldQuestion(threadId: string, line: QuestionThreadLine): Promise<number> {
    const db = this.prisma.client;
    if (line.answerable) {
      await db.chatThread.update({ where: { id: threadId }, data: {
        pendingQuestion: { requestId: line.requestId, text: [...line.text].slice(0, QUESTION_TEXT_MAX).join(''), expiresAt: line.expiresAt },
      } });
      return 0;
    }
    const message = await db.chatMessage.findFirst({ where: { threadId, turnId: line.turnId, role: 'assistant' }, select: { id: true, toolSummary: true } });
    if (!message) return 1;
    const next = upsertInformationalQuestion(readSummary(message.toolSummary), line.requestId, line.text);
    await db.chatMessage.update({ where: { id: message.id }, data: { toolSummary: next as unknown as Prisma.InputJsonValue } });
    return 0;
  }

  /**
   * Folds a runner session line into `ChatThread.session`. `session_failed` also errors the thread's pending and
   * streaming messages with the reason, keeping their content (fleet S5a §8).
   */
  private async foldSessionLine(batch: ThreadIngestBatch, threadId: string, line: SessionThreadLine): Promise<void> {
    const db = this.prisma.client;
    const at = line.at ?? new Date().toISOString();
    if (line.type === 'session_started') {
      const turn = await db.fleetThreadTurn.findUnique({ where: { jobId: batch.jobId }, select: { resume: true } });
      const session: StoredSession = { jobId: batch.jobId, state: 'live', resumed: line.resumed, contextReset: turn?.resume === true && !line.resumed, reason: null, at };
      await db.chatThread.update({ where: { id: threadId }, data: { session: session as unknown as Prisma.InputJsonValue } });
      return;
    }
    // A close or failure keeps resumed and contextReset only when the stored session belongs to this job; otherwise
    // (no session yet, or a previous job's session) they are false, so a new job never inherits the old flags.
    const previous = (await db.chatThread.findUnique({ where: { id: threadId }, select: { session: true } }))?.session as unknown as StoredSession | null | undefined;
    const current = previous?.jobId === batch.jobId ? previous : null;
    const session: StoredSession = {
      jobId: batch.jobId,
      state: line.type === 'session_closed' ? 'closed' : 'failed',
      resumed: current?.resumed ?? false,
      contextReset: current?.contextReset ?? false,
      reason: line.reason,
      at,
    };
    await db.chatThread.update({ where: { id: threadId }, data: { session: session as unknown as Prisma.InputJsonValue } });
    if (line.type === 'session_failed') {
      await db.chatMessage.updateMany({
        where: { threadId, status: { in: ['pending', 'streaming'] } },
        data: { status: 'errored', errorReason: line.reason.slice(0, ERROR_REASON_MAX) },
      });
    }
  }

  /** Same allocation as `PrismaChatThreadRepository.sendMessage`: the counter, or past the highest existing seq. Caller holds the thread row lock. */
  private async allocateSeq(threadId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<Array<{ nextSeq: number }>>`UPDATE "ChatThread" SET "nextSeq" = GREATEST("nextSeq", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "ChatMessage" WHERE "threadId" = "ChatThread"."id")) + 1 WHERE "id" = ${threadId} RETURNING "nextSeq" - 1 AS "nextSeq"`;
    const seq = rows[0]?.nextSeq;
    if (seq === undefined) throw new Error(`failed to allocate message sequence for thread ${threadId}`);
    return seq;
  }
}
