/**
 * Permissions P2 US-006 — CI ticket creation is audited (spec AC1–AC6, failure table).
 *
 * Every AC enters through the booted `AppModule`: a validly signed `POST /api/projects/:slug/ci-webhook`,
 * exactly as `endpoint.e2e.spec.ts` signs one, against a project whose `ciWebhookToken` is set through
 * `fixtureDb(app)`. Each assertion reads the stored `AuditEntry` rows, so the spec proves the writer
 * reaches the recorder rather than a stub.
 *
 * Note on the "accepted non-failed event" AC: the payload DTO accepts `pipeline_failed` and
 * `pipeline_success` (`ci-webhook.dto.ts`, and the same enum is in `openapi.json`). The spec's AC4 names
 * `pipeline_succeeded`, which the API rejects as a validation error — this story must not change payload
 * validation or `openapi.json`, so the AC is exercised with the accepted non-failed event, which is the
 * behaviour the AC describes ("a CI event other than pipeline_failed ... no ticket; no entry").
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const SLUG = 'audit-ci-webhook';
const KEY = 'ACW';
const SECRET = 'ci-audit-webhook-secret-0123456789';
const ROUTE = `/api/projects/${SLUG}/ci-webhook`;
/** The audit key every failed-pipeline ticket records (one per created ticket). */
const AUDIT_KEY = 'system.ci.ticket-create';

interface AuditRow {
  key: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  actorType: string;
  actorId: string;
  origin: string;
  summary: string | null;
  onBehalfOfType: string | null;
  onBehalfOfId: string | null;
}

const failure = { test: 'CheckoutService.retries', file: 'apps/api/src/checkout/retries.spec.ts', line: 42 };
const commit = { sha: 'deadbeefcafe0123456789', message: 'feat: retry checkout' };

const failedPayload = (pipelineId = 'pl-1001') => ({
  event: 'pipeline_failed',
  pipeline: { id: pipelineId, url: `https://ci.example.test/${pipelineId}` },
  commit,
  failures: [failure],
});

describeIntegration('CI webhook ticket audit (real AppModule)', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let projectId: string;
  let deliveries = 0;
  let restoreRecord: (() => void) | undefined;

  /** A signed delivery of the project's CI webhook; `deliveryId` defaults to a fresh one. */
  const deliver = (payload: unknown, deliveryId?: string) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    return request(server)
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .set('x-ci-signature', signature)
      .set('x-ci-delivery', deliveryId ?? `ci-audit-${++deliveries}`)
      .send(body);
  };

  /** Makes `record` reject for `key` only, so one AC's spy cannot leak into the next. */
  const rejectRecordingOf = (key: string): void => {
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === key) throw new Error('audit down');
      await original(input);
    });
    restoreRecord = () => spy.mockRestore();
  };

  const ticketNumberOf = (ticketRef: string): number => Number(ticketRef.split('-')[1]);
  const rowsOf = async (resourceId: string): Promise<AuditRow[]> => {
    return (await db.auditEntry.findMany({ where: { resourceId } })) as AuditRow[];
  };
  const entryCount = (): Promise<number> => db.auditEntry.count({ where: { key: AUDIT_KEY, projectId } });
  const ticketCount = (): Promise<number> => db.ticket.count({ where: { projectId } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'audit-ci-webhook-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    const token = data<{ accessToken: string }>(registered).accessToken;
    await request(server).post('/api/projects').set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Audit CI Webhook', slug: SLUG, key: KEY }).expect(201);
    const project = await db.project.findUniqueOrThrow({ where: { slug: SLUG } });
    projectId = project.id;
    await db.project.update({ where: { id: projectId }, data: { ciWebhookToken: SECRET } });
  });

  beforeEach(() => {
    resetThrottle(app);
  });

  afterEach(() => {
    restoreRecord?.();
    restoreRecord = undefined;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1/AC-2/AC-3: a failed pipeline creates one ticket audited as SYSTEM/ci without its payload', async () => {
    const response = await deliver(failedPayload()).expect(200);
    const body = data<{ success: boolean; ticketRef: string }>(response);
    expect(body.success).toBe(true);
    expect(body.ticketRef).toMatch(new RegExp(`^${KEY}-\\d+$`));

    const ticket = await db.ticket.findFirstOrThrow({
      where: { projectId, number: ticketNumberOf(body.ticketRef) },
    });
    const rows = await rowsOf(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: AUDIT_KEY,
      resourceType: 'ticket',
      resourceId: ticket.id,
      projectId,
      actorType: 'SYSTEM',
      actorId: 'ci',
      origin: 'system',
      summary: `created ${body.ticketRef}`,
      onBehalfOfType: null,
      onBehalfOfId: null,
    });

    // AC-3: the summary names the ticket ref and nothing the pipeline reported.
    expect(rows[0].summary).not.toContain(failure.test);
    expect(rows[0].summary).not.toContain(failure.file);
    expect(rows[0].summary).not.toContain('pl-1001');
    expect(rows[0].summary).not.toContain(commit.sha);
  });

  it('AC-4/AC-5: resending the same x-ci-delivery is refused as a replay and records nothing', async () => {
    const deliveryId = 'ci-audit-replay-1';
    await deliver(failedPayload('pl-1002'), deliveryId).expect(200);
    const entriesBefore = await entryCount();
    expect(entriesBefore).toBeGreaterThan(0);

    await deliver(failedPayload('pl-1002'), deliveryId).expect(409);

    expect(await entryCount()).toBe(entriesBefore);
  });

  it('AC-6/AC-7: an accepted non-failed event answers 200 and records no ticket entry', async () => {
    const entriesBefore = await entryCount();
    const ticketsBefore = await ticketCount();

    const response = await deliver({
      event: 'pipeline_success',
      pipeline: { id: 'pl-1003', url: 'https://ci.example.test/pl-1003' },
      commit,
      failures: [],
    }).expect(200);

    expect(response.body).toMatchObject({ ret: 0 });
    expect(await entryCount()).toBe(entriesBefore);
    expect(await ticketCount()).toBe(ticketsBefore);
  });

  it('AC-8/AC-9/AC-10: a rejected record fails the route, leaves no ticket, and the sender retry succeeds', async () => {
    const deliveryId = 'ci-audit-rejected-1';
    const ticketsBefore = await ticketCount();
    rejectRecordingOf(AUDIT_KEY);

    const failed = await deliver(failedPayload('pl-1004'), deliveryId);

    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await ticketCount()).toBe(ticketsBefore);

    // The controller forgot the delivery id, so the sender's retry with it is accepted.
    restoreRecord?.();
    restoreRecord = undefined;

    const retried = await deliver(failedPayload('pl-1004'), deliveryId).expect(200);
    const body = data<{ success: boolean; ticketRef: string }>(retried);
    expect(body.ticketRef).toMatch(new RegExp(`^${KEY}-\\d+$`));
    expect(await ticketCount()).toBe(ticketsBefore + 1);
  });

  it('AC-11/AC-12/AC-13: ten concurrent deliveries keep their number retries and record one entry each', async () => {
    const ticketsBefore = await ticketCount();
    const deliveryIds = Array.from({ length: 10 }, (_, index) => `ci-audit-concurrent-${index}`);

    const responses = await Promise.all(
      deliveryIds.map((deliveryId, index) => deliver(failedPayload(`pl-concurrent-${index}`), deliveryId)),
    );

    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 10 }, () => 200));
    const refs = responses.map((response) => data<{ ticketRef: string }>(response).ticketRef);
    const numbers = refs.map(ticketNumberOf);
    expect(new Set(numbers).size).toBe(10);
    expect(await ticketCount()).toBe(ticketsBefore + 10);

    const tickets = await db.ticket.findMany({ where: { projectId, number: { in: numbers } } });
    expect(tickets).toHaveLength(10);
    expect(await db.auditEntry.count({
      where: { key: AUDIT_KEY, resourceId: { in: tickets.map((ticket) => ticket.id) } },
    })).toBe(10);
  });

  it('AC-19: a CI event other than pipeline_failed leaves the project ticket count unchanged', async () => {
    const ticketsBefore = await ticketCount();

    await deliver({
      event: 'pipeline_success',
      pipeline: { id: 'pl-1005' },
      commit,
      failures: [],
    }).expect(200);

    expect(await ticketCount()).toBe(ticketsBefore);
  });

  it('AC-20: a delivery refused as a replay leaves the project ticket count unchanged', async () => {
    const deliveryId = 'ci-audit-replay-2';
    await deliver(failedPayload('pl-1006'), deliveryId).expect(200);
    const ticketsBefore = await ticketCount();

    await deliver(failedPayload('pl-1006'), deliveryId).expect(409);

    expect(await ticketCount()).toBe(ticketsBefore);
  });
});
