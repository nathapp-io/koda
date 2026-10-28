import { randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

/**
 * US-004 AC-13/AC-14 — a gated write answers 202 even where the route's static status is 201 or 204.
 *
 * Nest re-applies the route's `@HttpCode` after the interceptors run, so a handler cannot answer 202
 * by returning it: it throws `ApprovalPending` and `ApprovalPendingFilter` replies through the HTTP
 * adapter. Production runs Fastify, so this file pins the status on it — through `fastify.inject`, so
 * no socket is opened and the environment's proxies cannot decide the result.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/approvals/approval-pending-status.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

interface Envelope<T> {
  ret: number;
  data: T;
}

interface PendingSummary {
  id: string;
  permissionKey: string;
  status: string;
}

describeIntegration('approval pending status on Fastify (US-004)', () => {
  let app: NathApplication;
  let http: FastifyInstance;
  let db: ReturnType<typeof fixtureDb>;
  let rootToken: string;
  let agentApiKey: string;

  const api = async <T>(method: HTTPMethods, url: string, status: number, payload?: object, token?: string): Promise<T> => {
    // Fastify inject needs no listening socket; a listening server here would mean the test never
    // proved the adapter's own status handling.
    expect(http.server.listening).toBe(false);
    const response = await http.inject({
      method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(response.statusCode, response.body).toBe(status);
    // A 204 route answers no body: there is no envelope to unwrap.
    if (status === 204) return undefined as T;
    const body = response.json<Envelope<T>>();
    expect(body.ret).toBe(0);
    return body.data;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null, adapter: 'fastify' });
    http = app.getHttpAdapter().getInstance<FastifyInstance>();
    db = fixtureDb(app);
    // The first registration is the installation's Owner; it also holds `role.manage` globally.
    const registered = await api<{ accessToken: string; user: { id: string } }>(
      'POST', '/api/auth/register', 201,
      { email: `pending-${randomUUID()}@koda.test`, name: 'Owner', password: TEST_PASSWORD },
    );
    rootToken = registered.accessToken;
    const created = await api<{ apiKey: string; agent: { id: string } }>(
      'POST', '/api/agents', 201, { name: 'pending-agent', slug: 'pending-agent', capabilities: ['typescript'] }, rootToken,
    );
    agentApiKey = created.apiKey;
    await grantKeys(db, { type: 'AGENT', id: created.agent.id }, ['role.manage', 'role.read'], null);
    await app.get(PermissionCache).invalidate();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    resetThrottle(app);
    // Every test starts with an empty inbox; the rows an earlier test opened are not this one's.
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
  });

  it('AC-13: the agent POST /api/roles (a 201 route) answers 202 with a pending status', async () => {
    const summary = await api<PendingSummary>(
      'POST', '/api/roles', 202,
      { key: 'qa-fastify', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] }, agentApiKey,
    );

    expect(summary).toMatchObject({ permissionKey: 'role.manage', status: 'pending' });
    expect(await db.role.findUnique({ where: { key: 'qa-fastify' } })).toBeNull();
  });

  it('AC-14: the agent DELETE /api/roles/:id (a 204 route) answers 202 for role.manage', async () => {
    const role = await api<{ id: string; key: string }>(
      'POST', '/api/roles', 201,
      { key: 'qa-fastify-delete', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] }, rootToken,
    );

    const summary = await api<PendingSummary>('DELETE', `/api/roles/${role.id}`, 202, undefined, agentApiKey);

    expect(summary.permissionKey).toBe('role.manage');
    expect(summary.status).toBe('pending');
    expect(await db.role.findUnique({ where: { id: role.id } })).not.toBeNull();
    // The root is a human: its own delete answers 204, the route's static status.
    await api('DELETE', `/api/roles/${role.id}`, 204, undefined, rootToken);
    expect(await db.role.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it('a human write keeps the route status: the root POST answers 201', async () => {
    const role = await api<{ key: string; name: string }>(
      'POST', '/api/roles', 201,
      { key: 'qa-fastify-root', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] }, rootToken,
    );

    expect(role).toMatchObject({ key: 'qa-fastify-root', name: 'QA' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
