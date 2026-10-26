import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { currentContext, type ActionApproval } from '../../../src/action-context/action-context';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('ApprovalGate immediate execution through AppModule', () => {
  let app: NathApplication;
  let gate: ApprovalGate;
  let policies: ApprovalPolicyService;
  let db: ReturnType<typeof fixtureDb>;
  const testCommand = configurableTestCommand('label.delete');
  let executionApproval: ActionApproval | undefined;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'gate-p1', key: 'GATE', name: 'Gate project' } });
    gate = app.get(ApprovalGate, { strict: false });
    policies = app.get(ApprovalPolicyService, { strict: false });
    const execute = testCommand.command.execute;
    testCommand.command.execute = async (parsed) => {
      await Promise.resolve();
      executionApproval = currentContext()?.approval;
      return execute(parsed);
    };
    app.get(ApprovalCommandRegistry, { strict: false }).register(testCommand.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    testCommand.reset();
    executionApproval = undefined;
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  it.each([
    ['AC-5', 'USER', null, false, { requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }],
    ['AC-6', 'AGENT', 'none', false, { requiredMode: 'none', satisfiedBy: 'none' }],
    ['AC-7', 'USER', 'none', false, { requiredMode: 'none', satisfiedBy: 'none' }],
    ['AC-9', 'USER', 'human', true, { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }],
  ] as const)('%s: executes once without opening a request', async (_ac, type, mode, requireDistinctApprover, approval) => {
    if (mode !== null) {
      await withTestActor({ type: 'USER', id: 'u1' }, () => policies.create({
        projectId: 'p1', permissionPattern: 'label.delete', appliesTo: { kind: 'all' }, mode, requireDistinctApprover,
      }));
    }
    const outcome = await withTestActor({ type, id: type === 'USER' ? 'u1' : 'a1' }, () => gate.gate('label.delete', { labelId: 'l1' }, { projectId: 'p1' }));
    expect(outcome).toEqual({ status: 'executed', result: 'done', approval });
    expect(executionApproval).toEqual(approval);
    expect(testCommand.state.calls).toEqual([{ labelId: 'l1' }]);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
