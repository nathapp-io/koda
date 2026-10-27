import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import request from 'supertest';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

interface DetailEntry { id: string; approvalId: string | null; tool: string; preview: string; projectSlug: string; expiresAt: string }
interface Detail { pendingActions: DetailEntry[] }

describeIntegration('assistant thread detail linked approval requests (PG, US-007)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let serial = 0;
  const expiresAt = new Date('2026-10-24T09:00:00.000Z');

  async function seedRequest(threadId: string, status: 'pending' | 'rejected') {
    const id = `assistant-detail-${++serial}`;
    const requestRow = await prisma.approvalRequest.create({ data: {
      id, permissionKey: 'comment.create', projectId: world.projectId, actorType: 'SYSTEM', actorId: 'assistant',
      onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'thread', correlationId: `corr-${id}`,
      input: {} as Prisma.InputJsonValue, inputHash: `hash-${id}`, requiredMode: 'human', onTimeout: 'reject',
      approverMustHoldAction: true, requireDistinctApprover: false, status, expiresAt,
      ...(status === 'rejected' ? { decidedAt: new Date() } : {}),
    } });
    await prisma.assistantActionRequest.create({ data: {
      requestId: requestRow.id, threadId, jobId: null, toolCallId: `tc-${id}`, tool: 'koda_add_comment', preview: `preview-${id}`,
    } });
    return requestRow;
  }

  async function seedThread(): Promise<string> {
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, kind: 'PROJECT', repoId: null, baseRef: null, feature: null, title: 'approval thread',
      createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
    } });
    return thread.id;
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
  }, 120_000);

  afterAll(async () => { await app?.close(); });

  it('AC-1: exposes a linked pending request using its id, link preview, project slug and expiry', async () => {
    const threadId = await seedThread();
    const row = await seedRequest(threadId, 'pending');

    const response = await request(app.getHttpServer()).get(`/api/projects/web/threads/${threadId}`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200);
    const detail = data<Detail>(response);

    expect(detail.pendingActions).toHaveLength(1);
    expect(detail.pendingActions[0]).toMatchObject({
      id: row.id, approvalId: row.id, tool: 'koda_add_comment', preview: `preview-${row.id}`, projectSlug: 'web',
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('AC-2: excludes linked requests that are no longer pending', async () => {
    const threadId = await seedThread();
    await seedRequest(threadId, 'rejected');

    const response = await request(app.getHttpServer()).get(`/api/projects/web/threads/${threadId}`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200);

    expect(data<Detail>(response).pendingActions).toEqual([]);
  });
});
