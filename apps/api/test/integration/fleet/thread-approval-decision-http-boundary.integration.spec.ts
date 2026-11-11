import { canRunDbTests } from '../../helpers/test-environment';
/**
 * thread-agents-modes US-008 fix round 1 (F1) — the decision routes over the production HTTP adapter.
 *
 * The rest of the story's coverage boots the Express test adapter, which has no parameter-length limit. Production
 * boots Fastify, whose default `maxParamLength` is 100: a pending approval whose request id is 101..128 characters —
 * the bound the ingest fold and the decision validation both accept — answered 414 FST_ERR_MAX_PARAM_LENGTH instead of
 * reaching the handler, so that approval could never be decided. These tests drive the real Fastify adapter through
 * `inject` (the repo's fastify-mode pattern: no loopback socket), for both routes.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-approval-decision-http-boundary.integration.spec.ts
 */
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, TEST_PASSWORD } from '../../helpers/http-app';
import { FLEET_CAPS } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const EXPIRES_AT = '2026-11-24T01:00:00.000Z';
/** Exactly the request-id bound the pending list and the decision validation accept. */
const LONGEST_ID = 'r'.repeat(128);

describeIntegration('fleet thread approval decision HTTP boundary (PG, US-008)', () => {
  let app: NathApplication;
  let http: FastifyInstance;
  let db: PrismaClient;
  let projectId: string;
  let repoId: string;
  let rootId: string;
  let devToken: string;
  let devId: string;
  let agentId: string;
  let agentKey: string;
  let runnerId: string;
  let n = 0;

  /** One request through the real Fastify/Nest pipeline, as the audit suites do (no socket, no proxy). */
  const api = async (method: HTTPMethods, url: string, status: number, payload?: object, token?: string): Promise<{ statusCode: number; body: string }> => {
    const response = await http.inject({
      method, url, ...(payload === undefined ? {} : { payload }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(response.statusCode, response.body).toBe(status);
    return { statusCode: response.statusCode, body: response.body };
  };
  const dataOf = <T>(body: string): T => (JSON.parse(body) as { ret: number; data: T }).data;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    http = app.getHttpAdapter().getInstance<FastifyInstance>();
    db = fixtureDb(app);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;

    const root = dataOf<{ accessToken: string; user: { id: string } }>(
      (await api('POST', '/api/auth/register', 201, { email: 'boundary-owner@koda.test', name: 'Owner', password: TEST_PASSWORD })).body,
    );
    rootId = root.user.id;
    projectId = dataOf<{ id: string }>((await api('POST', '/api/projects', 201, { name: 'web', slug: 'web', key: 'WEB' }, root.accessToken)).body).id;
    await api('POST', '/api/admin/users', 201, { email: 'boundary-dev@koda.test', name: 'dev', password: TEST_PASSWORD, role: 'MEMBER' }, root.accessToken);
    devToken = dataOf<{ accessToken: string }>(
      (await api('POST', '/api/auth/login', 200, { email: 'boundary-dev@koda.test', password: TEST_PASSWORD })).body,
    ).accessToken;
    devId = (await db.user.findUniqueOrThrow({ where: { email: 'boundary-dev@koda.test' } })).id;
    await grantRole(db, { type: 'USER', id: devId }, 'developer', projectId);

    const agent = dataOf<{ apiKey: string; agent: { id: string } }>(
      (await api('POST', '/api/agents', 201, { name: 'boundary-agent', slug: 'boundary-agent', capabilities: ['typescript'] }, root.accessToken)).body,
    );
    agentId = agent.agent.id;
    agentKey = agent.apiKey;
    await grantKeys(db, { type: 'AGENT', id: agentId }, ['project.read', 'thread.answer'], projectId);

    repoId = (await db.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77), createdById: rootId },
    })).id;
    runnerId = (await db.runner.create({
      data: {
        name: 'boundary-runner', apiKeyHash: 'boundary-runner-hash', os: 'linux', arch: 'x64', labels: [], capacity: 2,
        capabilities: { ...FLEET_CAPS, threadWrite: true }, daemonVersion: '0.1.0', protocolVersion: 4, bootId: 'boundary-boot',
        enabled: true, lastSeenAt: new Date(), createdById: rootId,
      },
    })).id;
    await app.get(PermissionCache).invalidate();
  }, 90_000);
  afterAll(async () => {
    await app?.close();
  });

  const pending = (requestId: string): Record<string, unknown> => ({
    requestId, tool: 'bash', summary: 'Run the test suite', command: 'bun run test', expiresAt: EXPIRES_AT,
  });

  /** A REPO thread created by dev, with a RUNNING THREAD job requested by dev at lease epoch 1. */
  const liveThread = async (requestIds: string[], kind: 'REPO' | 'WORKSPACE' = 'REPO') => {
    const owner = kind === 'WORKSPACE' ? agentId : devId;
    const thread = await db.chatThread.create({
      data: {
        kind, projectId, repoId: kind === 'REPO' ? repoId : null, baseRef: kind === 'REPO' ? 'trunk' : null,
        feature: kind === 'REPO' ? `boundary-${++n}` : null, title: `Boundary ${n}`,
        createdById: owner, createdByType: kind === 'WORKSPACE' ? 'AGENT' : 'USER',
        runnerId, backend: { kind: 'native', model: 'm1' }, skills: [], pendingApprovals: requestIds.map(pending),
      },
    });
    const job = await db.fleetJob.create({
      data: {
        projectId, repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [], selectorLabels: [],
        maxCostUsd: 5, requestedById: owner, requestedByType: kind === 'WORKSPACE' ? 'AGENT' : 'USER', threadId: thread.id,
        runnerId, state: 'RUNNING', leaseEpoch: 1,
      },
    });
    await db.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      },
    });
    return { threadId: thread.id, jobId: job.id };
  };
  const commandsOf = (jobId: string) => db.fleetCommand.findMany({ where: { jobId } });

  it('AC-1: the project route answers a pending request id of 128 characters', async () => {
    const s = await liveThread([LONGEST_ID]);

    const res = await api('POST', `/api/projects/web/threads/${s.threadId}/approvals/${LONGEST_ID}`, 200, { decision: 'allow' }, devToken);

    expect(dataOf<Record<string, never>>(res.body)).toEqual({});
    expect(await commandsOf(s.jobId)).toEqual([expect.objectContaining({
      type: 'THREAD_ANSWER', payload: { requestId: LONGEST_ID, decision: 'allow' },
    })]);
  });

  it('AC-10: the workspace route answers a pending request id of 128 characters', async () => {
    const s = await liveThread([LONGEST_ID], 'WORKSPACE');

    await api('POST', `/api/threads/${s.threadId}/approvals/${LONGEST_ID}`, 200, { decision: 'deny' }, agentKey);

    expect(await commandsOf(s.jobId)).toEqual([expect.objectContaining({
      type: 'THREAD_ANSWER', payload: { requestId: LONGEST_ID, decision: 'deny' },
    })]);
  });

  it('an id past the API bound is the handler 400 naming requestId, not a transport refusal', async () => {
    const s = await liveThread([LONGEST_ID]);

    const res = await api('POST', `/api/projects/web/threads/${s.threadId}/approvals/${'r'.repeat(200)}`, 400, { decision: 'allow' }, devToken);

    expect((JSON.parse(res.body) as { message: string }).message).toContain('requestId');
    expect(await commandsOf(s.jobId)).toEqual([]);
  });
});
