/**
 * Fleet S5b US-002 — the koda tool executor's audit and replay against PG.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-tool-executor.integration.spec.ts
 */
import { createHash } from 'node:crypto';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { AssistantToolRegistry } from '../../../src/fleet/assistant/assistant-tool.registry';
import type { AssistantTool } from '../../../src/fleet/assistant/assistant-tool.types';
import { stableStringify } from '../../../src/fleet/sync/stable-json';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('AssistantToolExecutor audit and replay (PG, US-002)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let executor: AssistantToolExecutor;
  let jobId: string;
  let outsiderJobId: string;
  const execute = vi.fn(async () => 'fake result');

  const tool: AssistantTool<unknown> = {
    descriptor: { name: 'koda_fake_audit', description: 'd', inputSchema: {} },
    permission: { kind: 'member' },
    // Permissions P1 US-004: the executor checks the tool's catalog key in the job's project. The job's requester
    // here is the installation's ADMIN, who holds every project key.
    key: 'ticket.read',
    parse: (input) => input,
    execute,
  };

  /** A THREAD job on a PROJECT thread created by `createdById`. */
  async function seedThreadJob(base: { projectId: string; repoId: string }, createdById: string): Promise<string> {
    const thread = await prisma.chatThread.create({ data: {
      kind: 'PROJECT', projectId: base.projectId, title: 'audit', createdById, backend: { type: 'native' } as Prisma.InputJsonValue, skills: [],
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'THREAD', feature: `t-${thread.id}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: createdById, threadId: thread.id, state: 'RUNNING',
    } });
    return job.id;
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    executor = app.get(AssistantToolExecutor, { strict: false });
    app.get(AssistantToolRegistry, { strict: false }).register(tool);
    const base = await seedFleetBase(prisma);
    jobId = await seedThreadJob(base, base.adminId);
    const outsider = await prisma.user.create({ data: { email: 'outsider@koda.test', passwordHash: 'x', role: 'MEMBER' } });
    outsiderJobId = await seedThreadJob(base, outsider.id);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => execute.mockClear());

  const call = (over: Partial<{ jobId: string; toolCallId: string; name: string; input: unknown }> = {}) => ({
    jobId, toolCallId: 'c1', name: 'koda_fake_audit', input: { b: 1, a: { d: 2, c: 3 } }, ...over,
  });

  it('AC-12: stores one row whose inputHash is the sha256 of the stable JSON of the raw input, and no input', async () => {
    const input = { b: 1, a: { d: 2, c: 3 } };
    expect(await executor.execute(call({ toolCallId: 'audit-1', input }))).toEqual({ content: 'fake result', isError: false });
    const rows = await prisma.assistantToolCall.findMany({ where: { jobId, toolCallId: 'audit-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputHash).toBe(createHash('sha256').update(stableStringify(input)).digest('hex'));
    expect(rows[0]).toMatchObject({ tool: 'koda_fake_audit', outcome: 'ok', isError: false, resultBytes: 11 });
    expect(JSON.stringify(rows[0])).not.toContain('"d":2');
  });

  it('AC-13: a repeated (jobId, toolCallId) with the same tool and input replays without calling the tool', async () => {
    await executor.execute(call({ toolCallId: 'replay-1' }));
    execute.mockClear();
    expect(await executor.execute(call({ toolCallId: 'replay-1' }))).toEqual({ content: 'fake result', isError: false });
    expect(execute).not.toHaveBeenCalled();
    expect(await prisma.assistantToolCall.count({ where: { jobId, toolCallId: 'replay-1' } })).toBe(1);
  });

  it('AC-14: the same (jobId, toolCallId) with another input answers toolCallId reused', async () => {
    await executor.execute(call({ toolCallId: 'reuse-1' }));
    expect(await executor.execute(call({ toolCallId: 'reuse-1', input: { other: true } }))).toEqual({ content: 'invalid_input: toolCallId reused', isError: true });
    expect(await prisma.assistantToolCall.count({ where: { jobId, toolCallId: 'reuse-1' } })).toBe(1);
  });

  it('AC-17: a stored id reused with another tool answers toolCallId reused and stores nothing', async () => {
    await executor.execute(call({ toolCallId: 'reuse-tool-1' }));
    const before = await prisma.assistantToolCall.findUnique({ where: { jobId_toolCallId: { jobId, toolCallId: 'reuse-tool-1' } } });
    app.get(AssistantToolRegistry, { strict: false }).register({ ...tool, descriptor: { ...tool.descriptor, name: 'koda_fake_other' } });
    expect(await executor.execute(call({ toolCallId: 'reuse-tool-1', name: 'koda_fake_other' }))).toEqual({ content: 'invalid_input: toolCallId reused', isError: true });
    const after = await prisma.assistantToolCall.findMany({ where: { jobId, toolCallId: 'reuse-tool-1' } });
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it('AC-16: a creator who is not a project member is refused and the row records forbidden', async () => {
    const result = await executor.execute(call({ jobId: outsiderJobId, toolCallId: 'forbidden-1' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^forbidden: koda_fake_audit needs project membership on /);
    expect(execute).not.toHaveBeenCalled();
    const row = await prisma.assistantToolCall.findUnique({ where: { jobId_toolCallId: { jobId: outsiderJobId, toolCallId: 'forbidden-1' } } });
    expect(row?.outcome).toBe('forbidden');
  });
});
