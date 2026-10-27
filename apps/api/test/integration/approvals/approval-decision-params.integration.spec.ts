/**
 * Permissions P3 approval core (US-003): a decider's params reach the database, and a rejection's
 * effect rolls back with the decision it belongs to.
 *
 * The unit spec (`src/approvals/approval-decision-params.spec.ts`) pins the validation order with mocks;
 * this one pins the two things a mock cannot: the JSONB column the migration adds, and a throwing
 * `onReject` leaving no decision row behind.
 */
import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { PrismaApprovalRequestRepository } from '../../../src/approvals/prisma-approval-request.repository';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261106090000_approval_fleet_core';
const now = new Date('2026-11-05T09:00:00Z');
const actor = { type: 'AGENT', id: 'a1' } as const;
const user = { type: 'USER', id: 'u1' } as const;

integration('Approval decision params through AppModule', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let service: ApprovalDecisionService;
  let gate: ApprovalGate;
  let requests: PrismaApprovalRequestRepository;
  /** No decision hooks: a decision may carry no params, and a reject has no effect of its own. */
  const labels = configurableTestCommand('label.delete');
  /** Carries `onReject`, so a rejection writes (or fails to write) inside the decide transaction. */
  const roles = configurableTestCommand('role.manage');

  const open = async (command: typeof labels | typeof roles, projectId: string | null) => {
    const global = command === roles;
    const outcome = await withTestActor(actor, () => gate.gate(
      command.command.key, global ? { roleId: 'r1' } : { labelId: 'l1' }, { projectId }, now,
    ));
    if (outcome.status !== 'pending') throw new Error('expected pending request');

    return outcome.request;
  };
  const decide = (id: string, decision: 'approve' | 'reject', params?: unknown) =>
    withTestActor(user, () => service.decide(id, decision, decision === 'reject' ? 'no' : null, now, params));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'decide-params', key: 'DPRM', name: 'p1' } });
    gate = app.get(ApprovalGate, { strict: false });
    service = app.get(ApprovalDecisionService, { strict: false });
    requests = app.get(PrismaApprovalRequestRepository, { strict: false });
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    registry.register(labels.command);
    registry.register(roles.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset();
    roles.reset();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalId: { in: ['a1', 'u1'] } } });
    await grantKeys(db, actor, ['label.delete'], 'p1');
    await grantKeys(db, actor, ['role.manage'], null);
    // Fixtures bypass membership services, so invalidate their cached effective keys explicitly.
    await app.get(PermissionCache, { strict: false }).invalidate();
  });

  it('AC-1: createDecision with params round-trips through findDecisions', async () => {
    await grantRole(db, user, 'project-admin', 'p1');
    const request = await open(labels, 'p1');

    const decision = await withTestActor(user, () => requests.createDecision({
      requestId: request.id, deciderType: 'USER', deciderId: 'u1', decision: 'approve', params: { remember: true },
    }));

    expect(decision.params).toEqual({ remember: true });
    expect(await requests.findDecisions(request.id)).toEqual([
      expect.objectContaining({ id: decision.id, params: { remember: true } }),
    ]);
  });

  it('AC-2: a reject without params stores SQL NULL and reads back as params null', async () => {
    await grantRole(db, user, 'project-admin', 'p1');
    const request = await open(labels, 'p1');

    expect(await decide(request.id, 'reject')).toMatchObject({ status: 'rejected' });

    const rows = await db.$queryRaw<Array<{ params: unknown }>>`SELECT "params" FROM "ApprovalDecision" WHERE "requestId" = ${request.id}`;
    expect(rows).toEqual([{ params: null }]);
    expect(await requests.findDecisions(request.id)).toEqual([expect.objectContaining({ decision: 'reject', params: null })]);
  });

  it('US-004 AC-1: an approval with params executes its command with the parsed decision', async () => {
    await grantRole(db, user, 'project-admin', 'p1');
    // The command freezes the decider's params into the decision the execution re-parses.
    labels.state.parseDecision = { calls: [], result: { remember: true }, throws: false };
    const request = await open(labels, 'p1');

    const settled = await decide(request.id, 'approve', { remember: true });

    expect(settled.status).toBe('executed');
    expect(labels.state.decisions).toEqual([{ remember: true }]);
    // Once at decide time, once from the stored column at execution: the same params both times.
    expect(labels.state.parseDecision.calls).toEqual([
      { decision: 'approve', params: { remember: true }, input: { labelId: 'l1' } },
      { decision: 'approve', params: { remember: true }, input: { labelId: 'l1' } },
    ]);
    expect(await requests.findDecisions(request.id)).toEqual([
      expect.objectContaining({ decision: 'approve', params: { remember: true } }),
    ]);
  });

  it('AC-12: a throwing onReject rolls the whole decision back and propagates its error', async () => {
    await grantRole(db, user, 'admin', null);
    roles.state.onReject = { calls: [], throws: new Error('runner command refused') };
    const request = await open(roles, null);

    await expect(decide(request.id, 'reject')).rejects.toThrow('runner command refused');

    expect(roles.state.onReject.calls).toHaveLength(1);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('pending');
    expect(await db.approvalDecision.count({ where: { requestId: request.id } })).toBe(0);
  });

  it('AC-12: records the decision when onReject answers', async () => {
    await grantRole(db, user, 'admin', null);
    roles.state.onReject = { calls: [], throws: null };
    const request = await open(roles, null);

    expect(await decide(request.id, 'reject')).toMatchObject({ status: 'rejected' });

    expect(roles.state.onReject.calls).toEqual([{ input: { roleId: 'r1' }, decision: undefined }]);
    expect(await db.approvalDecision.count({ where: { requestId: request.id } })).toBe(1);
  });
});

integration('approval fleet core migration adds the decision params column', () => {
  let scratch: ScratchSchema;
  const schema = `approval_params_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, schema, MIGRATION);
    await applyMigration(scratch.db, MIGRATION);
  }, 60_000);
  afterAll(async () => { await scratch?.drop(); });

  it('AC-1: the migration stores and answers a JSON params value', async () => {
    const columns = await scratch.db.$queryRaw<Array<{ data_type: string; is_nullable: string }>>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'ApprovalDecision' AND column_name = 'params'`;
    expect(columns).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);

    const request = await scratch.db.approvalRequest.create({
      data: {
        permissionKey: 'label.delete', actorType: 'AGENT', actorId: 'a1', origin: 'rest', correlationId: 'c1',
        input: { labelId: 'l1' }, inputHash: 'hash', requiredMode: 'agent', onTimeout: 'reject',
        approverMustHoldAction: true, requireDistinctApprover: false, expiresAt: new Date(now.getTime() + 60_000),
      },
    });
    await scratch.db.approvalDecision.create({
      data: { requestId: request.id, deciderType: 'USER', deciderId: 'u1', decision: 'approve', params: { remember: true } },
    });

    expect(await scratch.db.approvalDecision.findMany({ where: { requestId: request.id } })).toEqual([
      expect.objectContaining({ params: { remember: true } }),
    ]);
  });
});
