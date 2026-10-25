import { describe, expect, it } from 'vitest';
import type { AuditEntryRecord } from '../domain/audit-entry.domain';
import { AuditEntryDto } from './audit-entry.dto';

const base: AuditEntryRecord = {
  id: 'e1', key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', projectId: 'p1',
  actorType: 'AGENT', actorId: 'a1', onBehalfOfType: null, onBehalfOfId: null, origin: 'mcp',
  requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null,
  approvalRequestId: null, correlationId: 'c1', summary: null, createdAt: new Date('2026-10-24T10:15:00.000Z'),
};

describe('AuditEntryDto.from', () => {
  it('AC-8: maps the actor from the flat actor columns', () => {
    expect(AuditEntryDto.from(base).actor).toEqual({ type: 'AGENT', id: 'a1' });
  });
  it('AC-9: maps absent on-behalf-of to null', () => {
    expect(AuditEntryDto.from(base).onBehalfOf).toBeNull();
  });
  it('AC-10: maps on-behalf-of type and id', () => {
    expect(AuditEntryDto.from({ ...base, onBehalfOfType: 'USER', onBehalfOfId: 'u1' }).onBehalfOf).toEqual({ type: 'USER', id: 'u1' });
  });
  it('AC-11: maps empty approval fields and null request id', () => {
    expect(AuditEntryDto.from(base).approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null });
  });
  it('AC-12: maps approver and external approval request id', () => {
    expect(AuditEntryDto.from({ ...base, requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', approvalRequestId: 'pa1' }).approval).toEqual({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' });
  });
  it('AC-13: serializes createdAt as an ISO instant', () => {
    expect(AuditEntryDto.from(base).createdAt).toBe('2026-10-24T10:15:00.000Z');
  });
  it('AC-15: defaults the display block to four nulls when no display is passed', () => {
    expect(AuditEntryDto.from(base).display).toEqual({ actor: null, onBehalfOf: null, approver: null, project: null });
  });
});
