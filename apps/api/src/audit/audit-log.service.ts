import { Injectable } from '@nestjs/common';
import { ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { ActionActorType } from '../action-context/action-context';
import { remapPage } from '../common/dto/koda-page.query';
import type { AuditEntryFilters } from './domain/audit-entry.domain';
import { AuditEntryDto } from './dto/audit-entry.dto';
import { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';

export interface AuditListQuery {
  key?: string;
  actorType?: ActionActorType;
  actorId?: string;
  approverId?: string;
  projectId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function asUtcBoundary(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (value === undefined) return undefined;
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return new Date(value);
}

@Injectable()
export class AuditLogService {
  constructor(private readonly repo: PrismaAuditEntryRepository) {}

  async list(query: AuditListQuery, page: IPageOption): Promise<IPageResult<AuditEntryDto>> {
    const from = asUtcBoundary(query.from, false);
    const to = asUtcBoundary(query.to, true);
    if (from && to && from.getTime() > to.getTime()) {
      throw new ValidationAppException({ reason: 'from must not be after to' }, 'audit.auditQuery');
    }
    const filters: AuditEntryFilters = {
      ...(query.key !== undefined ? { key: query.key } : {}),
      ...(query.actorType !== undefined ? { actorType: query.actorType } : {}),
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.approverId !== undefined ? { approverId: query.approverId } : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.resourceType !== undefined ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    };
    return remapPage(await this.repo.findPage(filters, page), AuditEntryDto.from);
  }
}
