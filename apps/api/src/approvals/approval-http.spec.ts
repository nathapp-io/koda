import { NotFoundAppException } from '@nathapp/nestjs-common';
import { validateSync } from 'class-validator';
import { parseQuery } from '../common/dto/koda-page.query';
import { ApprovalRequestNotFoundError } from './domain/approval.errors';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { rethrowApprovalError } from './approval-http-errors';
import { ApprovalDecisionDto, ApprovalRequestDto, ApprovalRequestSummaryDto } from './dto/approval-request.dto';
import { ListApprovalRequestsQuery } from './dto/list-approval-requests.query';

const date = new Date('2026-10-01T00:00:00.000Z');
const record: ApprovalRequestRecord = {
  id: 'request', permissionKey: 'label.delete', projectId: 'p', actor: { type: 'AGENT', id: 'agent' },
  onBehalfOf: { type: 'USER', id: 'user' }, origin: 'rest', correlationId: 'correlation', input: { labelId: 'label' },
  inputHash: 'hash', requiredMode: 'human', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
  requireDistinctApprover: false, status: 'executed', satisfiedBy: 'human', approverType: 'USER', approverId: 'approver',
  expiresAt: date, decidedAt: date, settledAt: date, result: { deleted: true }, createdAt: date,
};

describe('approval HTTP boundary', () => {
  it('documents every approval mode including self', () => {
    for (const field of ['requiredMode', 'satisfiedBy']) {
      expect(Reflect.getMetadata('swagger/apiModelProperties', ApprovalRequestSummaryDto.prototype, field).enum)
        .toEqual(['none', 'self', 'agent', 'human']);
    }
  });
  it('serializes exactly the summary allowlist and non-null dates', () => {
    expect(ApprovalRequestSummaryDto.from(record)).toEqual({
      id: 'request', permissionKey: 'label.delete', projectId: 'p', actorType: 'AGENT', actorId: 'agent',
      onBehalfOfType: 'USER', onBehalfOfId: 'user', origin: 'rest', requiredMode: 'human', status: 'executed',
      satisfiedBy: 'human', approverType: 'USER', approverId: 'approver', expiresAt: date.toISOString(),
      decidedAt: date.toISOString(), settledAt: date.toISOString(), createdAt: date.toISOString(),
    });
  });
  it('detail retains result and serializes decisions without internal requestId', () => {
    const decision = { id: 'decision', requestId: record.id, deciderType: 'USER' as const, deciderId: 'user', decision: 'reject' as const, comment: null, decidedAt: date };
    expect(ApprovalRequestDto.from({ request: record, decisions: [decision] })).toEqual({
      ...ApprovalRequestSummaryDto.from(record), input: record.input, result: record.result,
      decisions: [{ id: 'decision', deciderType: 'USER', deciderId: 'user', decision: 'reject', comment: null, decidedAt: date.toISOString() }],
    });
    expect(ApprovalDecisionDto.from(decision)).not.toHaveProperty('requestId');
  });
  it('maps only request-not-found and preserves other errors by identity', () => {
    expect(() => rethrowApprovalError(new ApprovalRequestNotFoundError('missing'))).toThrow(NotFoundAppException);
    const error = new Error('database unavailable');
    expect(() => rethrowApprovalError(error)).toThrow(error);
  });
  it.each(['true', 'false'])('mine=%s is boolean after parsing', (mine) => {
    const query = parseQuery(ListApprovalRequestsQuery, { mine });
    expect(query.mine).toBe(mine === 'true');
    expect(validateSync(query)).toEqual([]);
  });
  it.each([{ mine: 'yes' }, { status: 'bogus' }, { projectId: '' }, { permissionKey: '' }, { permissionKey: 'a'.repeat(201) }])('rejects malformed filters %j', (raw) => {
    expect(validateSync(parseQuery(ListApprovalRequestsQuery, raw)).length).toBeGreaterThan(0);
  });
});
