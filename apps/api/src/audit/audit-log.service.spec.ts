import { ValidationAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntryFilters, AuditEntryRecord } from './domain/audit-entry.domain';
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
function setup() {
  const findPage = vi.fn(async (_filters: AuditEntryFilters, _page: IPageOption) => page);
  const service = new AuditLogService({ findPage } as unknown as PrismaAuditEntryRepository);
  return { service, findPage };
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
});
