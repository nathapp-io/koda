import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { FleetFlowsService } from '../../src/fleet/flows/fleet-flows.service';
import type { FleetFlowDto } from '../../src/fleet/flows/dto/fleet-flow.dto';
import { parseFlowAnswers } from '../../src/fleet/flows/flow-answers';
import { fixtureDb } from '../helpers/action-context';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp, data, resetThrottle } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;

/** The English message of an i18n key, with the exception's arguments interpolated. */
function messageOf(key: string, args: Record<string, string> = {}): string {
  const [namespace, ...segments] = key.split('.');
  const catalog: unknown = JSON.parse(readFileSync(join(__dirname, '../../src/i18n/en', `${namespace}.json`), 'utf8'));
  const raw = segments.reduce<unknown>(
    (node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined),
    catalog,
  );
  expect(typeof raw).toBe('string');
  return Object.entries(args).reduce((text, [name, value]) => text.replace(`{${name}}`, value), raw as string);
}

/** The refusal body the API answers: the error code and the English message of its key. */
function refusal(response: request.Response, key: string, args: Record<string, string> = {}): void {
  const code = Number(key.split('.').at(-1));
  expect(response.body).toEqual({ ret: code, message: messageOf(key, args) });
}

describeDb('fleet flow answers route', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let serial = 0;

  const QUESTIONS = [
    { id: '2', question: 'Should the bound be clamped?' },
    { id: '4', question: 'Is -0 a valid upper bound?' },
  ];
  const ANSWERS = { jobId: 'job-1', answers: [{ id: '2', answer: 'Clamp it' }, { id: '4', answer: 'Yes' }] };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    // The agent is rostered with the developer role, so it holds `fleet.flow.answer` too.
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.fleetActivity.deleteMany({ where: { entityType: 'flow' } });
    await db.auditEntry.deleteMany({ where: { key: 'fleet.flow.answer' } });
  });

  /** A flow a review left waiting: one feature with the review's questions. */
  async function createWaitingFlow(over: { projectId?: string; repoId?: string; state?: string } = {}) {
    const state = over.state ?? 'WAITING_ANSWER';
    return db.fleetFlow.create({ data: {
      projectId: over.projectId ?? world.projectId,
      repoId: over.repoId ?? world.repoId,
      entry: 'NAX', createdByType: 'USER', createdById: world.ids.dev,
      branch: `feat/answers-${++serial}`, specSha: 'a'.repeat(40),
      reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '25',
      state,
      features: { create: [{ position: 0, feature: 'answers', specPath: 'docs/answers.md', dependsOn: [],
        state, questionsJobId: 'job-1', questions: QUESTIONS }] },
    } });
  }

  /** A policy that asks every user of the project for `fleet.flow.answer`. */
  async function seedUserAskPolicy(key: string, projectId: string) {
    const selector = `${projectId}|${key}|type:USER`;
    return db.approvalPolicy.upsert({
      where: { selector },
      create: { selector, projectId, permissionPattern: key, principalType: 'USER', mode: 'agent',
        updatedByType: 'SYSTEM', updatedById: 'test' },
      update: { projectId, permissionPattern: key, principalType: 'USER', mode: 'agent',
        updatedByType: 'SYSTEM', updatedById: 'test' },
      select: { id: true },
    });
  }

  const answersUrl = (id: string) => `/api/projects/web/flows/${id}/answers`;
  const answer = (id: string, body: unknown, token?: string) =>
    request(app.getHttpServer()).post(answersUrl(id)).set('Authorization', `Bearer ${token ?? world.tokens.dev}`).send(body as object);
  const decide = (requestId: string) =>
    request(app.getHttpServer()).post(`/api/approvals/${requestId}/decisions`)
      .set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' });

  it('AC-1: a user with fleet.flow.answer answers a waiting flow and the flow resumes running', async () => {
    const flow = await createWaitingFlow();
    const dto = data<FleetFlowDto>(await answer(flow.id, ANSWERS).expect(200));
    expect(dto).toMatchObject({ id: flow.id, state: 'RUNNING' });
    expect(dto.features[0]).toMatchObject({
      state: 'RUNNING',
      answers: [{ id: '2', answer: 'Clamp it' }, { id: '4', answer: 'Yes' }],
      answeredAt: expect.any(String),
    });
    const stored = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(stored.state).toBe('RUNNING');
    expect(await db.auditEntry.count({ where: { key: 'fleet.flow.answer', resourceId: flow.id } })).toBe(1);
    expect(await db.fleetActivity.findFirstOrThrow({ where: { action: 'flow.answered', entityId: flow.id } }))
      .toMatchObject({ projectId: world.projectId, payload: { flowId: flow.id, jobId: 'job-1', count: 2 } });
  });

  it('AC-2: an agent holding fleet.flow.answer is refused and the flow keeps waiting', async () => {
    const flow = await createWaitingFlow();
    refusal(await answer(flow.id, ANSWERS, agent.apiKey).expect(403), 'fleet.flows.answerHumanOnly.40003');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
    const feature = await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
    expect(feature.answers).toBeNull();
  });

  it('AC-3: an agent under an asking policy is refused and opens no approval request', async () => {
    const flow = await createWaitingFlow();
    const policy = await seedWaitPolicy(db, 'fleet.flow.answer', world.projectId);
    try {
      refusal(await answer(flow.id, ANSWERS, agent.apiKey).expect(403), 'fleet.flows.answerHumanOnly.40003');
      expect(await db.approvalRequest.count({ where: { permissionKey: 'fleet.flow.answer' } })).toBe(0);
      expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
    } finally {
      await db.approvalPolicy.delete({ where: { id: policy.id } });
    }
  });

  it('AC-4: a user without fleet.flow.answer is refused', async () => {
    const flow = await createWaitingFlow();
    refusal(await answer(flow.id, ANSWERS, world.tokens.viewer).expect(403), 'permissions.40003');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
  });

  it('AC-5: a flow that is not waiting answers 409 notWaiting', async () => {
    const flow = await createWaitingFlow({ state: 'PENDING' });
    refusal(await answer(flow.id, ANSWERS).expect(409), 'fleet.flows.notWaiting.409');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('PENDING');
  });

  it('AC-6: answers for another review answer 409 answersStale', async () => {
    const flow = await createWaitingFlow();
    refusal(await answer(flow.id, { jobId: 'job-0', answers: ANSWERS.answers }).expect(409), 'fleet.flows.answersStale.409');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
  });

  it('AC-7: an empty body answers 400 answersInput naming the jobId', async () => {
    const flow = await createWaitingFlow();
    refusal(await answer(flow.id, {}).expect(400), 'fleet.flows.answersInput.-2', { reason: 'jobId' });
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
  });

  it('AC-8: a flow of another project answers 404 notFound', async () => {
    const foreign = await createWaitingFlow({ projectId: world.opsProjectId, repoId: world.foreignRepoId });
    refusal(await answer(foreign.id, ANSWERS).expect(404), 'fleet.flows.notFound.404');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: foreign.id } })).state).toBe('WAITING_ANSWER');
  });

  it('AC-9: under an asking policy the answer waits for an approval request', async () => {
    const flow = await createWaitingFlow();
    const policy = await seedUserAskPolicy('fleet.flow.answer', world.projectId);
    try {
      const ask = data<{ id: string; permissionKey: string }>(await answer(flow.id, ANSWERS).expect(202));
      expect(ask.permissionKey).toBe('fleet.flow.answer');
      expect(await db.approvalRequest.count({ where: { id: ask.id, status: 'pending' } })).toBe(1);
      expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
    } finally {
      await db.approvalPolicy.delete({ where: { id: policy.id } });
    }
  });

  it('AC-10: approving the request records the answers and resumes the flow', async () => {
    const flow = await createWaitingFlow();
    const policy = await seedUserAskPolicy('fleet.flow.answer', world.projectId);
    try {
      const ask = data<{ id: string }>(await answer(flow.id, ANSWERS).expect(202));
      await decide(ask.id).expect(200);
      const stored = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
      expect(stored.state).toBe('RUNNING');
      const feature = await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } });
      expect(feature.answers).toEqual([{ id: '2', answer: 'Clamp it' }, { id: '4', answer: 'Yes' }]);
      expect(feature.answeredById).toBe(world.ids.dev);
    } finally {
      await db.approvalPolicy.delete({ where: { id: policy.id } });
    }
  });

  it('AC-14: an answer without a question and a question without an answer are both 400 answersInput', async () => {
    const flow = await createWaitingFlow();
    refusal(await answer(flow.id, { jobId: 'job-1', answers: [{ id: '9', answer: 'A' }] }).expect(400),
      'fleet.flows.answersInput.-2', { reason: 'unknown question 9' });
    refusal(await answer(flow.id, { jobId: 'job-1', answers: [{ id: '2', answer: 'A' }] }).expect(400),
      'fleet.flows.answersInput.-2', { reason: 'missing answer 4' });
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('WAITING_ANSWER');
  });

  it('AC-15: the route command answers through the service with the parsed body and the caller identity', async () => {
    const flow = await createWaitingFlow();
    const answerSpy = vi.spyOn(app.get(FleetFlowsService), 'answer');
    try {
      await answer(flow.id, ANSWERS).expect(200);
      expect(answerSpy).toHaveBeenCalledOnce();
      expect(answerSpy).toHaveBeenCalledWith(
        world.projectId, flow.id, parseFlowAnswers(ANSWERS), { type: 'USER', id: world.ids.dev },
      );
    } finally {
      answerSpy.mockRestore();
    }
  });
});
