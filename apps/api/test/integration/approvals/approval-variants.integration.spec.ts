import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import {
  configurableTestCommand,
  type ConfigurableTestCommand,
} from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

/** The variant a REST route for `DELETE /labels/:id` registers (US-001's naming: `rest:<path>.<verb>`). */
const VARIANT = 'rest:variants-probe';
const input = { labelId: 'l1' };
const now = new Date('2026-11-05T09:00:00Z');

(canRunDbTests() ? describe : describe.skip)('Approval command variants through AppModule', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let gate: ApprovalGate;
  let decisions: ApprovalDecisionService;
  /** The key's primary command: what every request without a variant runs. */
  let labels: ConfigurableTestCommand;
  /** The REST route's variant of the same key. */
  let restLabels: ConfigurableTestCommand;
  const agent = { type: 'AGENT', id: 'a1' } as const;
  const user = { type: 'USER', id: 'u1' } as const;

  const open = async (variant?: string) => {
    const outcome = await withTestActor(agent, () => gate.gate('label.delete', input,
      variant === undefined ? { projectId: 'p1' } : { projectId: 'p1', variant }, now));
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);
    return outcome.request;
  };
  const decide = (id: string) => withTestActor(user, () => decisions.decide(id, 'approve', null, now));
  const stored = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  /** A decider who holds both `approval.decide` and the action key. */
  const eligible = () => grantRole(db, user, 'project-admin', 'p1');

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'variants-p1', key: 'VARS', name: 'Variants project' } });
    gate = app.get(ApprovalGate, { strict: false });
    decisions = app.get(ApprovalDecisionService, { strict: false });
    labels = configurableTestCommand('label.delete');
    restLabels = configurableTestCommand('label.delete', { variant: VARIANT });
    const registry = app.get(ApprovalCommandRegistry, { strict: false });
    registry.register(labels.command);
    registry.register(restLabels.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset(); restLabels.reset();
    await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalId: { in: ['a1', 'u1'] } } });
    await grantKeys(db, agent, ['label.delete'], 'p1');
    await app.get(PermissionCache, { strict: false }).invalidate();
  });

  it('AC-7: a gate call with a variant stores that variant on the pending request', async () => {
    const request = await open(VARIANT);

    expect(request).toMatchObject({ permissionKey: 'label.delete', variant: VARIANT, status: 'pending' });
    expect((await stored(request.id)).variant).toBe(VARIANT);
    expect(labels.state.calls).toEqual([]);
    expect(restLabels.state.calls).toEqual([]);
  });

  it('AC-8: the same call without a variant stores a null column and a record with no variant', async () => {
    const request = await open();

    expect((await stored(request.id)).variant).toBeNull();
    expect('variant' in request).toBe(false);
    expect(labels.state.calls).toEqual([]);
    expect(restLabels.state.calls).toEqual([]);
  });

  it('AC-9: a pending variant request does not de-duplicate the same input without a variant', async () => {
    const variantRequest = await open(VARIANT);
    const primaryRequest = await open();

    expect(primaryRequest.id).not.toBe(variantRequest.id);
    expect((await stored(primaryRequest.id)).variant).toBeNull();
    expect(await db.approvalRequest.count()).toBe(2);
    // Within one pair the retry is still de-duplicated.
    expect((await open(VARIANT)).id).toBe(variantRequest.id);
    expect(await db.approvalRequest.count()).toBe(2);
  });

  it('AC-10: approving a variant request runs the variant command once and the primary never', async () => {
    await eligible();
    const request = await open(VARIANT);

    const settled = await decide(request.id);

    expect(settled.status).toBe('executed');
    expect(restLabels.state.calls).toEqual([input]);
    expect(labels.state.calls).toEqual([]);
    // The executed row keeps the variant it ran.
    expect((await stored(request.id)).variant).toBe(VARIANT);
  });

  it('AC-11: approving a request whose variant names no registered command settles failed with no-command', async () => {
    await eligible();
    const request = await open(VARIANT);
    // The command a stored variant names can be gone by the time the request is approved.
    await db.approvalRequest.update({ where: { id: request.id }, data: { variant: 'rest:gone' } });

    const settled = await decide(request.id);

    expect(settled).toMatchObject({ status: 'failed', result: { error: 'no-command' } });
    // An eligible approver is not blocked by the missing variant: the approval is on record, and the
    // execution that follows settles the request failed.
    expect(await db.approvalDecision.count({ where: { requestId: request.id } })).toBe(1);
    expect(await stored(request.id)).toMatchObject({
      status: 'failed', result: { error: 'no-command' },
      satisfiedBy: 'human', approverType: 'USER', approverId: 'u1', decidedAt: now,
    });
    expect(labels.state.calls).toEqual([]);
    expect(restLabels.state.calls).toEqual([]);
  });

  it('AC-12: approving a null-variant request runs the primary command', async () => {
    await eligible();
    const request = await open();
    expect((await stored(request.id)).variant).toBeNull();

    const settled = await decide(request.id);

    expect(settled.status).toBe('executed');
    expect(labels.state.calls).toEqual([input]);
    expect(restLabels.state.calls).toEqual([]);
  });
});
