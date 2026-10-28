import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-005 — the comment, label, ticket-label and watcher routes check their catalog
 * key, and a comment mutation also checks the row's author, over real HTTP + Postgres
 * (AC-1 .. AC-17).
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, tickets, labels, agent bindings) are built as that Owner; every
 * assertion below acts as a principal whose only source in `p1` is one role binding (users and
 * agents). No test asserts through a bypass.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/core-comments-labels-watchers.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>
)['40003'];

type RoleKey = 'reviewer' | 'triager' | 'developer' | 'viewer' | 'approver' | 'project-admin';

interface CommentDto {
  id: string;
  body: string;
  authorUserId: string | null;
  authorAgentId: string | null;
}

interface LabelDto {
  id: string;
  name: string;
}

describeIntegration('comment, label and watcher route keys (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let counter = 0;
  let rootId = '';
  let agentId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const createKeyedAgent = async (slug: string, keys: string[]): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const actor = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, actor);
    await grantKeys(db, actor, keys, p1Id);
    await membership.invalidatePermissions();
    tokens[slug] = body.apiKey;
    return body.agent.id;
  };
  const commentDeleteRequestCount = (actorId: string) => db.approvalRequest.count({
    where: { permissionKey: 'comment.delete', actorType: 'AGENT', actorId },
  });
  const actorApprovalRequestCount = (actorId: string) => db.approvalRequest.count({
    where: { actorType: 'AGENT', actorId },
  });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
      role: 'MEMBER',
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: RoleKey): Promise<unknown> =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    ));

  /** A ticket built by the Owner. */
  const createTicket = async (): Promise<string> => {
    const created = await asRoot('post', `/api/projects/${P1_SLUG}/tickets`, {
      type: 'BUG',
      title: `route ${(counter += 1)}`,
    }).expect(201);
    return data<{ ref: string }>(created).ref;
  };

  /** A comment written through the real route by `who`; returns its id. */
  const commentBy = async (who: string, ref: string, body: string): Promise<string> => {
    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/comments`)
      .set(auth(who))
      .send({ body })
      .expect(201);
    return data<CommentDto>(res).id;
  };

  /** The comments of a ticket, read by the Owner, so a mutation can be checked independently. */
  const comments = async (ref: string): Promise<CommentDto[]> => {
    const res = await asRoot('get', `/api/projects/${P1_SLUG}/tickets/${ref}/comments`).expect(200);
    return data<CommentDto[]>(res);
  };

  const commentById = async (ref: string, id: string): Promise<CommentDto | undefined> =>
    (await comments(ref)).find((comment) => comment.id === id);

  /** A label of p1 created by the Owner. */
  const createLabel = async (): Promise<string> => {
    const res = await asRoot('post', `/api/projects/${P1_SLUG}/labels`, {
      name: `label-${(counter += 1)}`,
      color: '#00ff00',
    }).expect(201);
    return data<LabelDto>(res).id;
  };

  /** The labels of p1, read by the Owner. */
  const labels = async (): Promise<LabelDto[]> => {
    const res = await asRoot('get', `/api/projects/${P1_SLUG}/labels`).expect(200);
    return data<LabelDto[]>(res);
  };

  /** An agent with the project-scoped viewer role binding used for the labels permission case. */
  const createAgent = async (slug: string): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    tokens[slug] = body.apiKey;
    // The binding is written after the principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    membership = app.get(MembershipService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['viewer', 'approver', 'developer', 'padmin', 'triager', 'reviewer', 'outsider']) {
      await createUser(who);
    }

    const project = await asRoot('post', '/api/projects', {
      name: 'P1',
      slug: P1_SLUG,
      key: P1_KEY,
    }).expect(201);
    p1Id = data<{ id: string }>(project).id;

    await bind('viewer', 'viewer');
    await bind('approver', 'approver');
    await bind('developer', 'developer');
    await bind('padmin', 'project-admin');
    await bind('triager', 'triager');
    await bind('reviewer', 'reviewer');
    // AC-8's caller keeps no source in p1 at all.

    // AC-14: a viewer role binding in p1, used to test label-key refusal.
    agentId = await createAgent('p1-role-viewer-agent');
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(db, [
      { type: 'USER', id: rootId },
      { type: 'USER', id: userIds.viewer },
      { type: 'USER', id: userIds.approver },
      { type: 'USER', id: userIds.developer },
      { type: 'USER', id: userIds.padmin },
      { type: 'USER', id: userIds.triager },
      { type: 'USER', id: userIds.reviewer },
      { type: 'USER', id: userIds.outsider },
      { type: 'AGENT', id: agentId },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — POST …/comments needs comment.create, GET needs comment.read
  // -------------------------------------------------------------------------

  it('AC-1: a viewer binding alone creates a comment with POST …/comments', async () => {
    const ref = await createTicket();

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/comments`)
      .set(auth('viewer'))
      .send({ body: 'from a viewer' })
      .expect(201);

    const comment = data<CommentDto>(res);
    expect(comment.body).toBe('from a viewer');
    expect(comment.authorUserId).toBe(userIds.viewer);
    await expect(commentById(ref, comment.id)).resolves.toEqual(
      expect.objectContaining({ body: 'from a viewer' }),
    );
  }, TIMEOUT);

  it('AC-2: an approver binding alone is refused by POST …/comments and writes no comment', async () => {
    const ref = await createTicket();

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/comments`)
      .set(auth('approver'))
      .send({ body: 'from an approver' });

    expectPermissionsRefusal(res);
    await expect(comments(ref)).resolves.toEqual([]);
  }, TIMEOUT);

  it('AC-3: an approver binding alone lists the comments with GET …/comments', async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'readable');

    const res = await request(server)
      .get(`/api/projects/${P1_SLUG}/tickets/${ref}/comments`)
      .set(auth('approver'))
      .expect(200);

    expect(data<CommentDto[]>(res).map((comment) => comment.id)).toEqual([id]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 — PATCH /comments/:id needs comment.update and the row's author
  // -------------------------------------------------------------------------

  it('AC-4: a developer binding alone edits its own comment and the body changes', async () => {
    const ref = await createTicket();
    const id = await commentBy('developer', ref, 'before');

    const res = await request(server)
      .patch(`/api/comments/${id}`)
      .set(auth('developer'))
      .send({ body: 'after' })
      .expect(200);

    expect(data<CommentDto>(res).body).toBe('after');
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'after' }));
  }, TIMEOUT);

  it("AC-5: a developer binding alone is refused by PATCH on another user's comment and the body stays", async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'not yours');

    const res = await request(server)
      .patch(`/api/comments/${id}`)
      .set(auth('developer'))
      .send({ body: 'hijacked' });

    expectPermissionsRefusal(res);
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'not yours' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 — DELETE /comments/:id needs comment.delete and the row's author
  // -------------------------------------------------------------------------

  it('AC-6: a project-admin binding alone deletes another user\'s comment', async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'deletable');

    await request(server).delete(`/api/comments/${id}`).set(auth('padmin')).expect(204);

    await expect(commentById(ref, id)).resolves.toBeUndefined();
  }, TIMEOUT);

  it("AC-7: a developer binding alone is refused by DELETE on another user's comment and it remains", async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'mine');

    const res = await request(server).delete(`/api/comments/${id}`).set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'mine' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-8 — a non-member still gets 404, not 403
  // -------------------------------------------------------------------------

  it('AC-8: a non-admin with no source in p1 gets 404 from PATCH /comments/:id and the body stays', async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'hidden');

    const res = await request(server)
      .patch(`/api/comments/${id}`)
      .set(auth('outsider'))
      .send({ body: 'hijacked' });

    expect(res.status).toBe(404);
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'hidden' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // US-008: HTTP comment deletion approval and denial boundaries
  // -------------------------------------------------------------------------

  it('US-008 AC-1: an agent with comment.delete and project.read requests approval and deletes after root approval', async () => {
    const agentId = await createKeyedAgent('comment-delete-agent', ['project.read', 'comment.delete']);
    const ref = await createTicket();
    const id = await commentBy('root', ref, 'agent may delete');
    const before = await commentDeleteRequestCount(agentId);

    const response = await request(server).delete(`/api/comments/${id}`).set(auth('comment-delete-agent')).expect(202);
    const pending = data<{ id: string; permissionKey: string; projectId: string }>(response);
    expect(pending).toEqual(expect.objectContaining({ permissionKey: 'comment.delete', projectId: p1Id }));
    await request(server).post(`/api/approvals/${pending.id}/decisions`).set(auth('root')).send({ decision: 'approve' }).expect(200);

    expect(await db.approvalRequest.count({ where: { permissionKey: 'comment.delete', actorType: 'AGENT', actorId: agentId } })).toBe(before + 1);
    await expect(commentById(ref, id)).resolves.toBeUndefined();
  }, TIMEOUT);

  it('US-008 AC-2: a granted agent deleting a missing comment gets 404 and creates no request', async () => {
    const agentId = await createKeyedAgent('comment-delete-missing-agent', ['project.read', 'comment.delete']);
    const before = await actorApprovalRequestCount(agentId);

    const response = await request(server).delete('/api/comments/comment-does-not-exist').set(auth('comment-delete-missing-agent'));

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Comment not found');
    expect(await actorApprovalRequestCount(agentId)).toBe(before);
  }, TIMEOUT);

  it('US-008 AC-3: an agent with only comment.delete.own gets a deferred failure on another author\'s comment', async () => {
    const agentId = await createKeyedAgent('comment-delete-own-agent', ['project.read', 'comment.delete.own']);
    const ref = await createTicket();
    const id = await commentBy('root', ref, 'not agent authored');

    const response = await request(server).delete(`/api/comments/${id}`).set(auth('comment-delete-own-agent')).expect(202);
    const pending = data<{ id: string }>(response);
    const decision = await request(server).post(`/api/approvals/${pending.id}/decisions`).set(auth('root')).send({ decision: 'approve' }).expect(200);

    expect(data<{ status: string }>(decision).status).toBe('failed');
    await expect(db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true } })).resolves.toEqual({ status: 'failed' });
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'not agent authored' }));
  }, TIMEOUT);

  it('US-008 AC-4: the root token deletes immediately without creating an approval request', async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'root delete');
    const before = await db.approvalRequest.count();

    await request(server).delete(`/api/comments/${id}`).set(auth('root')).expect(204);

    expect(await db.approvalRequest.count()).toBe(before);
    await expect(commentById(ref, id)).resolves.toBeUndefined();
  }, TIMEOUT);

  it('US-008 AC-11: a non-member deleting a comment gets 404 and creates no approval request', async () => {
    const ref = await createTicket();
    const id = await commentBy('viewer', ref, 'non-member delete');
    const before = await db.approvalRequest.count();

    const response = await request(server).delete(`/api/comments/${id}`).set(auth('outsider'));

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Comment not found');
    expect(await db.approvalRequest.count()).toBe(before);
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'non-member delete' }));
  }, TIMEOUT);

  it('US-008 AC-12: a project member with no comment deletion key gets permissions 403 and no request', async () => {
    const agentId = await createKeyedAgent('comment-delete-keyless-agent', ['project.read']);
    const ref = await createTicket();
    const id = await commentBy('root', ref, 'keyless refusal');
    const before = await db.approvalRequest.count();

    const response = await request(server).delete(`/api/comments/${id}`).set(auth('comment-delete-keyless-agent'));

    expectPermissionsRefusal(response);
    expect(await db.approvalRequest.count()).toBe(before);
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ body: 'keyless refusal' }));
    expect(await commentDeleteRequestCount(agentId)).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 — binding-based access with only the baseline and least-privilege project grants.
  // -------------------------------------------------------------------------

  it('AC-9: a binding-based agent deletes its own comment only after root approval', async () => {
    const slug = 'p1-binding-agent-us008';
    const projectKeys = ['project.read', 'comment.create', 'comment.delete.own'];
    const agentId = await createKeyedAgent(slug, projectKeys);
    const grants = await db.roleBinding.findMany({
      where: { principalType: 'AGENT', principalId: agentId },
      include: { role: { select: { key: true, permissions: true } } },
    });
    // Check every binding, not just the expected project: no hidden global or wildcard grant.
    expect(grants).toHaveLength(2);
    expect(grants.filter((grant) => grant.projectId === null).map((grant) => grant.role)).toEqual([
      { key: 'agent', permissions: ['agent.read'] },
    ]);
    const projectGrants = grants.filter((grant) => grant.projectId === p1Id);
    expect(projectGrants).toHaveLength(1);
    expect(projectGrants.flatMap((grant) => grant.role.permissions).sort()).toEqual([...projectKeys].sort());

    const ref = await createTicket();
    const id = await commentBy(slug, ref, 'agent wrote this');

    const response = await request(server).delete(`/api/comments/${id}`).set(auth(slug)).expect(202);
    const pending = data<{ id: string; permissionKey: string; projectId: string }>(response);
    expect(pending).toEqual(expect.objectContaining({ permissionKey: 'comment.delete', projectId: p1Id }));
    await expect(commentById(ref, id)).resolves.toEqual(expect.objectContaining({ authorAgentId: agentId, body: 'agent wrote this' }));
    await expect(db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true } })).resolves.toEqual({ status: 'pending' });

    const decision = await request(server).post(`/api/approvals/${pending.id}/decisions`).set(auth('root')).send({ decision: 'approve' }).expect(200);
    expect(data<{ status: string }>(decision).status).toBe('executed');
    await expect(commentById(ref, id)).resolves.toBeUndefined();
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 .. AC-13 — the label routes need label.create / .read / .update / .delete
  // -------------------------------------------------------------------------

  it('AC-10: a developer binding alone creates a label with POST /projects/:slug/labels', async () => {
    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/labels`)
      .set(auth('developer'))
      .send({ name: 'by-a-developer', color: '#123456' })
      .expect(201);

    const label = data<LabelDto>(res);
    expect(label.name).toBe('by-a-developer');
    await expect(labels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: label.id, name: 'by-a-developer' })]),
    );
  }, TIMEOUT);

  it('AC-11: a developer binding alone renames a label with PATCH /projects/:slug/labels/:id', async () => {
    const id = await createLabel();

    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/labels/${id}`)
      .set(auth('developer'))
      .send({ name: 'renamed-by-developer' })
      .expect(200);

    expect(data<LabelDto>(res)).toEqual(expect.objectContaining({ id, name: 'renamed-by-developer' }));
    await expect(labels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id, name: 'renamed-by-developer' })]),
    );
  }, TIMEOUT);

  it('AC-12: a developer binding alone is refused by DELETE /projects/:slug/labels/:id and the label remains', async () => {
    const id = await createLabel();

    const res = await request(server).delete(`/api/projects/${P1_SLUG}/labels/${id}`).set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(labels()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
  }, TIMEOUT);

  it('AC-13: a viewer binding alone is refused by POST /projects/:slug/labels', async () => {
    const before = await labels();

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/labels`)
      .set(auth('viewer'))
      .send({ name: 'by-a-viewer', color: '#123456' });

    expectPermissionsRefusal(res);
    await expect(labels()).resolves.toEqual(before);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 / AC-15 — the ticket-label routes need ticket.label.assign / .remove
  // -------------------------------------------------------------------------

  it('AC-14: an agent with only a viewer role binding is refused by POST …/tickets/:ref/labels', async () => {
    const ref = await createTicket();
    const labelId = await createLabel();

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/labels`)
      .set(auth('p1-role-viewer-agent'))
      .send({ labelId });

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-15: a triager binding alone assigns an existing label of p1 to a ticket', async () => {
    const ref = await createTicket();
    const labelId = await createLabel();

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/tickets/${ref}/labels`)
      .set(auth('triager'))
      .send({ labelId })
      .expect(201);

    expect(JSON.stringify(data<unknown>(res))).toContain(labelId);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-16 / AC-17 — the watch routes need ticket.watch.read / .set / .unset
  // -------------------------------------------------------------------------

  it('AC-16: a reviewer binding alone is refused by PUT …/tickets/:ref/watch', async () => {
    const ref = await createTicket();

    const res = await request(server).put(`/api/projects/${P1_SLUG}/tickets/${ref}/watch`).set(auth('reviewer'));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-17: a viewer binding alone watches a ticket with PUT …/tickets/:ref/watch', async () => {
    const ref = await createTicket();

    const res = await request(server)
      .put(`/api/projects/${P1_SLUG}/tickets/${ref}/watch`)
      .set(auth('viewer'))
      .expect(200);

    expect(data<{ watching: boolean }>(res).watching).toBe(true);
  }, TIMEOUT);
});
