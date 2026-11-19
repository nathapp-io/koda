/**
 * Webhook signature v2 US-005 — a v2-only delivery is accepted end to end by the real route.
 *
 * Every request enters through the app booted by `bootHttpApp` (real guards, pipes and signature
 * verification) against a project whose `ciWebhookToken` is set through `fixtureDb`, using the raw-body
 * delivery pattern of `test/integration/audit/audit-ci-webhook.integration.spec.ts`.
 *
 * The signature is computed here, independently of the API: HMAC-SHA256 over
 * `<x-ci-timestamp>.<x-ci-delivery>.<raw body>` keyed by the project's `ciWebhookToken`, with the exact
 * timestamp text and the exact JSON string that is sent. No `x-ci-signature` is set, so a delivery that
 * answers 200 proves the route verifies v2 and does not fall back to v1.
 *
 * AC-2 changes only the delivery id inside the signed input: same secret, same body, same fresh
 * timestamp, same unused `x-ci-delivery` header — so a 401 can only come from the v2 signature binding the
 * delivery id, and it proves the 200 in AC-1 is not a route that accepts any v2-shaped header.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { MAX_DELIVERY_ID_BYTES } from '../../../src/webhook-security/webhook-signature';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const SLUG = 'ci-webhook-signature-v2';
const KEY = 'CWV';
const SECRET = 'ci-webhook-signature-v2-secret-0123456789';
const ROUTE = `/api/projects/${SLUG}/ci-webhook`;

const failedPayload = (pipelineId = 'pl-v2-1001') => ({
  event: 'pipeline_failed',
  pipeline: { id: pipelineId, url: `https://ci.example.test/${pipelineId}` },
  commit: { sha: 'abc123def456cvv', message: 'feat: v2 only delivery' },
  failures: [{ test: 'CheckoutService.retries', file: 'apps/api/src/checkout/retries.spec.ts', line: 42 }],
});

describeIntegration('CI webhook v2-only delivery over HTTP (US-005)', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let projectId: string;
  let deliveries = 0;

  /** Decimal Unix seconds, fresh on every call, as the scheme requires. */
  const freshTimestamp = (): string => String(Math.floor(Date.now() / 1000));

  /** The scheme's signed input: `<timestamp>.<deliveryId>.<raw body>`. */
  const signedV2 = (timestamp: string, deliveryId: string, body: string): string =>
    `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;

  /**
   * A v2-only delivery: `x-ci-timestamp`, `x-ci-delivery` and `x-ci-signature-v2`, no `x-ci-signature`.
   * `signedDeliveryId` defaults to the sent header, so a caller changes only the signed input.
   */
  const deliverV2 = (
    payload: unknown,
    options?: { deliveryId?: string; signedDeliveryId?: string; timestamp?: string },
  ) => {
    const body = JSON.stringify(payload);
    const deliveryId = options?.deliveryId ?? `ci-v2-${++deliveries}`;
    const timestamp = options?.timestamp ?? freshTimestamp();
    const signature = signedV2(timestamp, options?.signedDeliveryId ?? deliveryId, body);

    return request(server)
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .set('x-ci-timestamp', timestamp)
      .set('x-ci-signature-v2', signature)
      .set('x-ci-delivery', deliveryId)
      .send(body);
  };

  /**
   * A delivery injected straight into Fastify, bypassing supertest: the only way to send a body that is
   * absent (`payload` omitted) or not valid UTF-8 (`payload` a Buffer — superagent's `.send()` turns a
   * Buffer into an object). `inject` runs the whole route, including the `preParsing` raw-body hook.
   */
  const injectV2 = (
    deliveryId: string,
    timestamp: string,
    signature: string,
    payload?: Buffer,
  ) =>
    app.getHttpAdapter().getInstance<FastifyInstance>().inject({
      method: 'POST',
      url: ROUTE,
      headers: {
        'content-type': 'application/json',
        'x-ci-timestamp': timestamp,
        'x-ci-signature-v2': signature,
        'x-ci-delivery': deliveryId,
      },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'ci-webhook-v2-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    const token = data<{ accessToken: string }>(registered).accessToken;
    await request(server).post('/api/projects').set({ Authorization: `Bearer ${token}` })
      .send({ name: 'CI Webhook Signature v2', slug: SLUG, key: KEY }).expect(201);
    const project = await db.project.findUniqueOrThrow({ where: { slug: SLUG } });
    projectId = project.id;
    await db.project.update({ where: { id: project.id }, data: { ciWebhookToken: SECRET } });
  });

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-1: a v2-only delivery answers 200 and creates its ticket', async () => {
    const response = await deliverV2(failedPayload()).expect(200);

    const body = data<{ success: boolean; ticketRef: string }>(response);
    expect(body.success).toBe(true);
    expect(body.ticketRef).toMatch(new RegExp(`^${KEY}-\\d+$`));
  });

  it('AC-2: a v2 signature computed over a different delivery id answers 401', async () => {
    const sentDeliveryId = `ci-v2-mismatch-${++deliveries}`;

    const response = await deliverV2(failedPayload('pl-v2-1002'), {
      deliveryId: sentDeliveryId,
      signedDeliveryId: `ci-v2-signed-${deliveries}`,
    });

    expect(response.status).toBe(401);
  });

  /**
   * Review B2: the replay table is unique on (projectId, source, deliveryId), and Postgres caps one
   * B-tree index entry well below the HTTP header limit. A correctly signed oversized id must be
   * refused as a 401 at authentication, not accepted and then failed by the replay insert (a 5xx that
   * would also make the sender retry a request that can never succeed).
   */
  it('review B2: a correctly signed oversized delivery id answers 401 and records nothing', async () => {
    const oversizedId = `ci-v2-${'d'.repeat(MAX_DELIVERY_ID_BYTES)}`;

    const response = await deliverV2(failedPayload('pl-v2-1003'), { deliveryId: oversizedId });

    expect(response.status).toBe(401);
    const recorded = await db.webhookDelivery.findUnique({
      where: { projectId_source_deliveryId: { projectId, source: 'ci', deliveryId: oversizedId } },
    });
    expect(recorded).toBeNull();
  });

  /**
   * Review B1: v2 signs the bytes on the wire. This body carries a `0xff` byte inside a JSON string,
   * which is not valid UTF-8 but still parses as JSON after the parser replaces it — so the received
   * bytes and the decoded text differ. Signing the received bytes must be accepted; signing the
   * decoded text must not be.
   *
   * Sent through `fastify.inject` with a Buffer payload: supertest's `.send()` turns a Buffer into an
   * object, so it cannot put non-UTF-8 bytes on the wire. The inject call still runs the whole route,
   * including the `preParsing` raw-body hook this assertion depends on.
   */
  it('review B1: verifies the raw body bytes, not their UTF-8 decoding', async () => {
    const rawBody = Buffer.concat([
      Buffer.from('{"event":"pipeline_failed","pipeline":{"id":"pl-v2-1004","url":"https://ci.example.test/pl-v2-1004"},"commit":{"sha":"abc123def456b1","message":"feat: '),
      Buffer.from([0xff]),
      Buffer.from('"},"failures":[{"test":"T","line":1}]}'),
    ]);

    const deliveryId = `ci-v2-raw-bytes-${++deliveries}`;
    const timestamp = freshTimestamp();
    const signedOverBytes = `sha256=${createHmac('sha256', SECRET)
      .update(Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8'))
      .update(rawBody)
      .digest('hex')}`;

    const accepted = await injectV2(deliveryId, timestamp, signedOverBytes, rawBody);
    expect(accepted.statusCode).toBe(200);

    const decodedTimestamp = freshTimestamp();
    const decodedId = `ci-v2-decoded-bytes-${++deliveries}`;
    const signedOverText = signedV2(decodedTimestamp, decodedId, rawBody.toString('utf8'));

    const refused = await injectV2(decodedId, decodedTimestamp, signedOverText, rawBody);
    expect(refused.statusCode).toBe(401);
  });

  /**
   * Review B1 (empty body): a JSON request with no body is still handed the synthetic `{}` by the
   * `preParsing` hook, so the parser has a document and DTO validation answers 400. The sender wrote
   * nothing, though, so v2 must cover the zero-length wire body: a signature over that synthetic `{}`
   * authenticates bytes that were never sent and is refused as 401, while the signature over the empty
   * body verifies and the request then fails payload validation — which is why a bodyless delivery
   * never succeeds.
   */
  it('review B1: an empty wire body is signed as empty, not as the synthetic {} parser input', async () => {
    const parserInputTimestamp = freshTimestamp();
    const parserInputId = `ci-v2-empty-parser-input-${++deliveries}`;
    const refused = await injectV2(
      parserInputId,
      parserInputTimestamp,
      signedV2(parserInputTimestamp, parserInputId, '{}'),
    );
    expect(refused.statusCode).toBe(401);

    const emptyTimestamp = freshTimestamp();
    const emptyId = `ci-v2-empty-wire-body-${++deliveries}`;
    const validated = await injectV2(emptyId, emptyTimestamp, signedV2(emptyTimestamp, emptyId, ''));
    expect(validated.statusCode).toBe(400);
  });
});
