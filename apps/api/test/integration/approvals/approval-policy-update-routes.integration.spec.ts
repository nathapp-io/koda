import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { ApprovalPolicyNotFoundError } from '../../../src/approvals/domain/approval.errors';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval policy update and delete REST', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  const body = { permissionPattern: 'label.delete', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' } as const;
  const server = () => app.getHttpServer();
  const path = (id: string) => `/api/approval-policies/${id}`;
  const patch = (id: string, payload: object, token = world.tokens.root) => request(server()).patch(path(id)).set('Authorization', `Bearer ${token}`).send(payload);
  const remove = (id: string, token = world.tokens.root) => request(server()).delete(path(id)).set('Authorization', `Bearer ${token}`);
  const create = (projectId: string | null) => withTestActor({ type: 'USER', id: world.ids.root }, () => app.get(ApprovalPolicyService).create({ ...body, projectId }));
  const sentence = (key: string, code: string) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8'));
    return catalog[key][code] as string;
  };
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
  });
  it('AC-1: updates a global policy', async () => {
    const policy = await create(null);
    expect(data<{ mode: string }>(await patch(policy.id, { mode: 'agent' }).expect(200)).mode).toBe('agent');
    expect(data<{ timeoutSec: number | null }>(await patch(policy.id, { timeoutSec: null }).expect(200)).timeoutSec).toBeNull();
  });
  it('AC-2: rejects an empty patch with the localized validation message', async () => {
    const policy = await create(null);
    const res = await patch(policy.id, {}).expect(400);
    expect(res.body.message).toBe(sentence('emptyPolicyPatch', '400'));
  });
  it('AC-3/4: hides project policies and leaves their mode unchanged', async () => {
    const policy = await create(world.projectId);
    await patch(policy.id, { mode: 'agent' }).expect(404);
    expect((await db.approvalPolicy.findUniqueOrThrow({ where: { id: policy.id } })).mode).toBe(policy.mode);
  });
  it('AC-5: unknown policy patch returns the localized not-found message', async () => {
    const res = await patch(randomUUID(), { mode: 'agent' }).expect(404);
    expect(res.body.message).toBe(sentence('policyNotFound', '404'));
  });
  it('AC-6/7: deletes a global policy once', async () => {
    const policy = await create(null);
    await remove(policy.id).expect(204);
    const res = await remove(policy.id).expect(404);
    expect(res.body.message).toBe(sentence('policyNotFound', '404'));
  });
  it('AC-8: hides project policies from global deletion', async () => {
    const policy = await create(world.projectId);
    await remove(policy.id).expect(404);
    expect(await db.approvalPolicy.findUnique({ where: { id: policy.id } })).not.toBeNull();
  });
  it('AC-9: get throws the domain not-found error for unknown ids', async () => {
    await expect(app.get(ApprovalPolicyService).get(randomUUID())).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
  });
});
