/**
 * Permissions P3 approval core (US-003): a decider's params on the decide path.
 *
 * The params a decider sends are validated under the request row lock, after eligibility, and stored
 * with the decision; a rejection can additionally run a command hook inside the same transaction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { ApprovalDecisionService } from './approval-decision.service';
import { decideEligibility } from './approval-eligibility';
import type { ApprovalCommand, ApprovalCommandRegistry } from './approval-command.registry';
import { canonicalJson } from './canonical-json';
import { runWithActionContext } from '../action-context/action-context';
import { configurableTestCommand } from './test-helpers/test-approval-command';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';
import { Prisma } from '../generated/prisma/client';
import type { ApprovalExecutionService } from './approval-execution.service';
import type { PermissionService } from '../permissions/permission.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { ApprovalDecideForbiddenError, ApprovalDecisionParamsInvalidError } from './domain/approval.errors';

vi.mock('./approval-eligibility', () => ({ decideEligibility: vi.fn() }));

const now = new Date('2026-11-05T09:00:00Z');
const input = { labelId: 'l1' };

function setup(command?: ApprovalCommand) {
  const request: ApprovalRequestRecord = {
    id: 'r1', permissionKey: 'label.delete', projectId: 'p1', actor: { type: 'AGENT', id: 'a1' },
    onBehalfOf: null, origin: 'rest', correlationId: 'c1', input, inputHash: 'hash',
    requiredMode: 'agent', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
    requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
    expiresAt: new Date(now.getTime() + 1000), decidedAt: null, settledAt: null, result: null, createdAt: now,
  };
  const repo = {
    lockById: vi.fn().mockResolvedValue(request),
    createDecision: vi.fn(),
    transition: vi.fn().mockImplementation(async (_id: string, _from: string, patch: object) => ({ ...request, ...patch })),
  };
  const permissions = { effectiveKeys: vi.fn().mockResolvedValue(new Set(['label.delete', 'approval.decide'])) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const events = { record: vi.fn().mockResolvedValue(undefined) };
  const execution = { execute: vi.fn().mockImplementation(async () => ({ ...request, status: 'executed' })) };
  const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => true) };
  const registry = { get: vi.fn().mockReturnValue(command) };
  const service = new ApprovalDecisionService(
    tx as unknown as ITransactionManager, repo as unknown as PrismaApprovalRequestRepository,
    permissions as unknown as PermissionService, audit as unknown as AuditRecorder,
    execution as unknown as ApprovalExecutionService, events as never,
    registry as unknown as ApprovalCommandRegistry,
  );
  const decide = (decision: 'approve' | 'reject' = 'approve', params?: unknown) => runWithActionContext(
    { actor: { type: 'USER', id: 'u1' }, origin: 'rest' },
    () => service.decide('r1', decision, decision === 'reject' ? 'no' : null, now, params));

  return { request, repo, permissions, audit, events, execution, tx, registry, service, decide };
}

beforeEach(() => { vi.mocked(decideEligibility).mockReset().mockReturnValue({ ok: true, satisfiedBy: 'human' }); });

it('AC-3: stores what parseDecision answered a decider params with', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: { remember: true }, throws: false };
  const s = setup(command);

  await s.decide('approve', { remember: true });

  expect(s.repo.createDecision).toHaveBeenCalledExactlyOnceWith({
    requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'approve', comment: null, decidedAt: now,
    params: { remember: true },
  });
});

it('AC-4: treats a null params as absent on a command without parseDecision', async () => {
  const s = setup(configurableTestCommand('label.delete').command);

  await s.decide('reject', null);

  expect(s.repo.createDecision).toHaveBeenCalledExactlyOnceWith({
    requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'reject', comment: 'no', decidedAt: now,
    params: null,
  });
});

it('AC-5: refuses params a command without parseDecision cannot honour, writing nothing', async () => {
  const s = setup(configurableTestCommand('label.delete').command);

  await expect(s.decide('approve', { a: 1 })).rejects.toEqual(new ApprovalDecisionParamsInvalidError('not-accepted'));

  expect(s.repo.createDecision).not.toHaveBeenCalled();
  expect(s.repo.transition).not.toHaveBeenCalled();
});

it('AC-5: refuses params on a key with no registered command, writing nothing', async () => {
  const s = setup(undefined);

  await expect(s.decide('reject', { a: 1 })).rejects.toEqual(new ApprovalDecisionParamsInvalidError('not-accepted'));

  expect(s.repo.createDecision).not.toHaveBeenCalled();
});

it('AC-6: refuses params whose canonical JSON exceeds 4096 characters before parseDecision', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: 'ok', throws: false };
  const s = setup(command);
  const tooLarge = { v: 'a'.repeat(4_089) };
  expect(canonicalJson(tooLarge)).toHaveLength(4_097);

  await expect(s.decide('approve', tooLarge)).rejects.toEqual(new ApprovalDecisionParamsInvalidError('too-large'));

  expect(state.parseDecision.calls).toEqual([]);
  expect(s.repo.createDecision).not.toHaveBeenCalled();
});

it('AC-6: accepts params at exactly 4096 characters of canonical JSON', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: 'ok', throws: false };
  const s = setup(command);
  const boundary = { v: 'a'.repeat(4_088) };
  expect(canonicalJson(boundary)).toHaveLength(4_096);

  await s.decide('approve', boundary);

  expect(state.parseDecision.calls).toHaveLength(1);
  expect(s.repo.createDecision).toHaveBeenCalledWith(expect.objectContaining({ params: 'ok' }));
});

it('AC-7: maps a throwing parseDecision to invalid without transitioning', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: undefined, throws: true };
  const s = setup(command);

  await expect(s.decide('approve', { remember: true })).rejects.toEqual(new ApprovalDecisionParamsInvalidError('invalid'));

  expect(state.parseDecision.calls).toHaveLength(1);
  expect(s.repo.createDecision).not.toHaveBeenCalled();
  expect(s.repo.transition).not.toHaveBeenCalled();
  expect(s.audit.record).not.toHaveBeenCalled();
});

it('AC-7: maps a frozen input the command no longer parses to invalid, even without params', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.onReject = { calls: [], throws: null };
  state.parseThrows = true;
  const s = setup(command);

  await expect(s.decide('reject')).rejects.toEqual(new ApprovalDecisionParamsInvalidError('invalid'));

  expect(state.onReject.calls).toEqual([]);
  expect(s.repo.createDecision).not.toHaveBeenCalled();
});

it('AC-8: refuses an ineligible decider before reading params or parsing the input', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: undefined, throws: false };
  state.onReject = { calls: [], throws: null };
  const s = setup(command);
  vi.mocked(decideEligibility).mockReturnValue({ ok: false, reason: 'tier-too-low' });

  await expect(s.decide('approve', { a: 1 })).rejects.toEqual(new ApprovalDecideForbiddenError('tier-too-low'));

  expect(state.parseDecision.calls).toEqual([]);
  expect(s.repo.createDecision).not.toHaveBeenCalled();
});

it('AC-9: hands parseDecision the decision, the params and the input the command parses', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: 'ok', throws: false };
  const s = setup(command);

  await s.decide('approve', { remember: true });

  expect(state.parseDecision.calls).toEqual([{ decision: 'approve', params: { remember: true }, input }]);
});

it('AC-9: hands a rejection the reject decision and no params', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: undefined, throws: false };
  const s = setup(command);

  await s.decide('reject');

  expect(state.parseDecision.calls).toEqual([{ decision: 'reject', params: undefined, input }]);
});

it('AC-10: runs onReject once, after the transition and inside the decide transaction', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: { choice: 'deny' }, throws: false };
  state.onReject = { calls: [], throws: null };
  const s = setup(command);
  // Records how many onReject calls had happened when each step ran: 0 at the transition, 1 when the
  // transaction callback returned, so the hook ran strictly between the two.
  const atTransition: number[] = [];
  const atCommit: number[] = [];
  s.repo.transition.mockImplementation(async (_id: string, _from: string, patch: object) => {
    atTransition.push(state.onReject?.calls.length ?? -1);
    return { ...s.request, ...patch };
  });
  s.tx.run.mockImplementation(async (fn: () => Promise<unknown>) => {
    const result = await fn();
    atCommit.push(state.onReject?.calls.length ?? -1);
    return result;
  });

  await s.decide('reject', { choice: 'deny' });

  expect(state.onReject.calls).toEqual([{ input, decision: { choice: 'deny' } }]);
  expect(atTransition).toEqual([0]);
  expect(atCommit).toEqual([1]);
});

it('AC-10: does not run onReject for an approval', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.parseDecision = { calls: [], result: { remember: true }, throws: false };
  state.onReject = { calls: [], throws: null };
  const s = setup(command);

  await s.decide('approve', { remember: true });

  expect(state.onReject.calls).toEqual([]);
});

it('AC-11: calls onReject with the parsed input and undefined when the command has no parseDecision', async () => {
  const { command, state } = configurableTestCommand('label.delete');
  state.onReject = { calls: [], throws: null };
  const s = setup(command);

  await s.decide('reject');

  expect(state.onReject.calls).toEqual([{ input, decision: undefined }]);
  expect(s.repo.createDecision).toHaveBeenCalledWith(expect.objectContaining({ params: null }));
});

describe('PrismaApprovalRequestRepository decision params', () => {
  const create = vi.fn();
  const findMany = vi.fn();
  const prisma = { client: { approvalDecision: { create, findMany } } };
  const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) };
  const repo = new PrismaApprovalRequestRepository(tx as never, prisma as never);
  const decision = {
    id: 'd1', requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'approve', comment: null, decidedAt: now,
  };

  beforeEach(() => {
    create.mockReset().mockImplementation(async ({ data }: { data: object }) => ({ ...decision, ...data }));
    findMany.mockReset();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
  ])('writes %s params as a database NULL', async (_label, params) => {
    await repo.createDecision({ requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'approve', params });

    expect(create).toHaveBeenCalledExactlyOnceWith({ data: expect.objectContaining({ params: Prisma.DbNull }) });
  });

  it('writes a params value as JSON and reads a NULL column back as null', async () => {
    await repo.createDecision({ requestId: 'r1', deciderType: 'USER', deciderId: 'u1', decision: 'approve', params: { remember: true } });
    expect(create).toHaveBeenCalledExactlyOnceWith({ data: expect.objectContaining({ params: { remember: true } }) });

    findMany.mockResolvedValue([{ ...decision, params: null }]);
    expect(await repo.findDecisions('r1')).toEqual([{ ...decision, params: null }]);
  });
});

describe('decision params refusal messages', () => {
  const messages = (locale: 'en' | 'zh') => JSON.parse(
    readFileSync(join(__dirname, `../i18n/${locale}/approvals.json`), 'utf8'),
  ) as Record<string, unknown>;

  it.each(['en', 'zh'] as const)('%s/approvals.json declares invalidDecisionParams for both codes', (locale) => {
    expect(messages(locale).invalidDecisionParams).toEqual({ 400: expect.stringContaining('{reason}'), '-2': expect.stringContaining('{reason}') });
  });

  it('AC-14: en words the refusal with the reason slot', () => {
    expect(messages('en').invalidDecisionParams).toEqual({
      400: 'Invalid decision params: {reason}', '-2': 'Invalid decision params: {reason}',
    });
  });

  it('AC-15: zh words the refusal with the reason slot', () => {
    expect(messages('zh').invalidDecisionParams).toEqual({
      400: '无效的决定参数：{reason}', '-2': '无效的决定参数：{reason}',
    });
  });
});
