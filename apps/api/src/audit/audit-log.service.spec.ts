import { ValidationAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { describe, expect, it, vi } from 'vitest';
import type { AuditDisplayIds, AuditDisplayNames, AuditEntryFilters, AuditEntryRecord } from './domain/audit-entry.domain';
import { AuditLogService } from './audit-log.service';
import { AuditEntryDto } from './dto/audit-entry.dto';
import type { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';

const record: AuditEntryRecord = {
  id: 'e1', key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', projectId: 'p1',
  actorType: 'AGENT', actorId: 'a1', onBehalfOfType: null, onBehalfOfId: null, origin: 'mcp',
  requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null,
  approvalRequestId: null, correlationId: 'c1', summary: null, createdAt: new Date('2026-10-24T10:15:00.000Z'),
};
const page: IPageResult<AuditEntryRecord> = {
  total: 1, current: 1, size: 20, hasNext: false, hasPrev: false, records: [record],
};
const pageOption: IPageOption = { current: 1, size: 20 };
const emptyNames = (): AuditDisplayNames => ({
  users: new Map(), agents: new Map(), runners: new Map(), projects: new Map(),
});
function setup(records: AuditEntryRecord[] = [record], names: AuditDisplayNames = emptyNames()) {
  const findPage = vi.fn(async (_filters: AuditEntryFilters, _page: IPageOption): Promise<IPageResult<AuditEntryRecord>> => ({
    ...page, total: records.length, records,
  }));
  const findDisplayNames = vi.fn(async (_ids: AuditDisplayIds) => names);
  const findDistinctKeys = vi.fn(async (): Promise<string[]> => ['comment.create', 'ticket.create']);
  const service = new AuditLogService({ findPage, findDisplayNames, findDistinctKeys } as unknown as PrismaAuditEntryRepository);
  return { service, findPage, findDisplayNames, findDistinctKeys };
}

describe('AuditLogService.list', () => {
  it('AC-1: passes all seven non-date filters unchanged', async () => {
    const { service, findPage } = setup();
    const filters = { key: 'ticket.create', actorType: 'AGENT' as const, actorId: 'a1', approverId: 'u2', projectId: 'p1', resourceType: 'ticket', resourceId: 't1' };
    await service.list(filters, pageOption);
    expect(findPage).toHaveBeenCalledWith(filters, pageOption);
  });

  it('AC-2: converts a date-only from to UTC start of day', async () => {
    const { service, findPage } = setup();
    await service.list({ from: '2026-10-24' }, pageOption);
    expect(findPage.mock.calls[0][0].from).toEqual(new Date('2026-10-24T00:00:00.000Z'));
  });

  it('AC-3: converts a date-only to to UTC end of day inclusively', async () => {
    const { service, findPage } = setup();
    await service.list({ to: '2026-10-24' }, pageOption);
    expect(findPage.mock.calls[0][0].to).toEqual(new Date('2026-10-24T23:59:59.999Z'));
  });

  it('AC-4: preserves a UTC instant', async () => {
    const { service, findPage } = setup();
    await service.list({ from: '2026-10-24T10:15:00Z' }, pageOption);
    expect(findPage.mock.calls[0][0].from).toEqual(new Date('2026-10-24T10:15:00Z'));
  });

  it('AC-5/6: rejects reversed windows with audit.auditQuery before repository access', async () => {
    const { service, findPage } = setup();
    let error: unknown;
    try { await service.list({ from: '2026-10-25', to: '2026-10-24' }, pageOption); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).response).toMatchObject({ prefix: 'audit.auditQuery', args: { reason: 'from must not be after to' } });
    expect(findPage).not.toHaveBeenCalled();
  });

  it('AC-7: maps records while preserving page metadata and total', async () => {
    const { service } = setup();
    const result = await service.list({}, pageOption);
    expect(result).toEqual({ ...page, records: [AuditEntryDto.from(record)] });
    expect(result.total).toBe(page.total);
  });

  it('AC-11: batches the page into exactly one findDisplayNames call with distinct ids per kind', async () => {
    const { service, findDisplayNames } = setup([
      { ...record, id: 'e1', actorType: 'USER', actorId: 'u1', projectId: 'p1' },
      { ...record, id: 'e2', actorType: 'USER', actorId: 'u1', projectId: 'p1' },
      { ...record, id: 'e3', actorType: 'USER', actorId: 'u1', projectId: 'p2' },
    ]);
    await service.list({}, { current: 1, size: 3 });
    expect(findDisplayNames).toHaveBeenCalledTimes(1);
    expect(findDisplayNames).toHaveBeenCalledWith({ userIds: ['u1'], agentIds: [], runnerIds: [], projectIds: ['p1', 'p2'] });
  });

  it('AC-12: does not batch an empty page', async () => {
    const { service, findDisplayNames } = setup([]);
    const result = await service.list({}, pageOption);
    expect(findDisplayNames).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
  });

  it('AC-13: rejects with the original error when the label lookup fails', async () => {
    const { service, findDisplayNames } = setup();
    const error = new Error('label lookup unavailable');
    findDisplayNames.mockRejectedValue(error);
    await expect(service.list({}, pageOption)).rejects.toBe(error);
  });

  it('does not batch a page that names no user, agent, runner or project', async () => {
    const { service, findDisplayNames } = setup([
      { ...record, actorType: 'SYSTEM', actorId: 'scheduler', projectId: null },
    ]);
    const result = await service.list({}, pageOption);
    expect(findDisplayNames).not.toHaveBeenCalled();
    expect(result.records[0].display).toEqual({ actor: null, onBehalfOf: null, approver: null, project: null });
  });

  it('resolves every display field from the one batch, per actor kind', async () => {
    const names: AuditDisplayNames = {
      users: new Map([['u1', 'Ada'], ['u2', 'Bea'], ['u3', 'Cy']]),
      agents: new Map([['a1', 'robot']]),
      runners: new Map([['r1', 'wk-mac']]),
      projects: new Map([['p1', { slug: 'web', name: 'Web' }]]),
    };
    const { service } = setup([
      { ...record, id: 'e1', actorType: 'USER', actorId: 'u1', onBehalfOfType: 'USER', onBehalfOfId: 'u2', approverType: 'AGENT', approverId: 'a1', projectId: 'p1' },
      { ...record, id: 'e2', actorType: 'AGENT', actorId: 'a1', projectId: null },
      { ...record, id: 'e3', actorType: 'RUNNER', actorId: 'r1', projectId: 'gone' },
      { ...record, id: 'e4', actorType: 'SYSTEM', actorId: 'scheduler', onBehalfOfType: 'USER', onBehalfOfId: 'u3', projectId: null },
    ], names);
    const { records } = await service.list({}, pageOption);
    expect(records.map((row) => row.display)).toEqual([
      { actor: 'Ada', onBehalfOf: 'Bea', approver: 'robot', project: { slug: 'web', name: 'Web' } },
      { actor: 'robot', onBehalfOf: null, approver: null, project: null },
      { actor: 'wk-mac', onBehalfOf: null, approver: null, project: null },
      { actor: null, onBehalfOf: 'Cy', approver: null, project: null },
    ]);
  });

  it('collects every kind of principal id, including on-behalf-of and approver', async () => {
    const { service, findDisplayNames } = setup([
      { ...record, id: 'e1', actorType: 'RUNNER', actorId: 'r1', onBehalfOfType: 'AGENT', onBehalfOfId: 'a2', approverType: 'USER', approverId: 'u2', projectId: 'p2' },
      { ...record, id: 'e2', actorType: 'SYSTEM', actorId: 'outbox', projectId: 'p2' },
    ]);
    await service.list({}, pageOption);
    expect(findDisplayNames).toHaveBeenCalledWith({ userIds: ['u2'], agentIds: ['a2'], runnerIds: ['r1'], projectIds: ['p2'] });
  });

  it('US-004 AC-7: displays a forge approver as its literal id without looking it up', async () => {
    const { service, findDisplayNames } = setup([{ ...record, actorType: 'SYSTEM', actorId: 'review', projectId: null, approverType: 'FORGE_USER', approverId: 'github:alice' }]);
    const result = await service.list({}, pageOption);
    expect(result.records[0].display.approver).toBe('github:alice');
    expect(findDisplayNames).not.toHaveBeenCalled();
  });

  it('US-002 AC-2: passes correlationId through to findPage unchanged', async () => {
    const { service, findPage } = setup();
    await service.list({ correlationId: 'c-1' }, pageOption);
    expect(findPage).toHaveBeenCalledWith({ correlationId: 'c-1' }, pageOption);
  });

  it('US-002: keeps correlationId out of the filters when the query has none', async () => {
    const { service, findPage } = setup();
    await service.list({ key: 'ticket.create' }, pageOption);
    expect(findPage).toHaveBeenCalledWith({ key: 'ticket.create' }, pageOption);
    expect(findPage.mock.calls[0][0]).not.toHaveProperty('correlationId');
  });
});

describe('AuditLogService.keys', () => {
  it('US-002: returns the repository distinct keys unchanged', async () => {
    const { service, findDistinctKeys } = setup();
    await expect(service.keys()).resolves.toEqual(['comment.create', 'ticket.create']);
    expect(findDistinctKeys).toHaveBeenCalledTimes(1);
    expect(findDistinctKeys).toHaveBeenCalledWith();
  });

  it('US-002: returns an empty list when the repository knows no key', async () => {
    const { service, findDistinctKeys } = setup();
    findDistinctKeys.mockResolvedValue([]);
    await expect(service.keys()).resolves.toEqual([]);
  });

  it('US-002: rejects with the original error when the key lookup fails', async () => {
    const { service, findDistinctKeys } = setup();
    const error = new Error('key lookup unavailable');
    findDistinctKeys.mockRejectedValue(error);
    await expect(service.keys()).rejects.toBe(error);
  });
});
