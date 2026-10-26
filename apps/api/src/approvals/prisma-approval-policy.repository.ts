import { Inject, Injectable, Logger } from '@nestjs/common';
import { AbstractPrismaRepository, Paginate, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type IPageResult, type ITransactionManager } from '@nathapp/nestjs-data';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { ApprovalPolicy, PrismaClient } from '../generated/prisma/client';
import type { ApprovalPolicyRecord } from './domain/approval.domain';

export const MAX_POLICY_CANDIDATES = 500;
export interface ApprovalPolicyFilter { projectId?: string | null; permissionPattern?: string }

@Injectable()
export class PrismaApprovalPolicyRepository extends AbstractPrismaRepository<ApprovalPolicyRecord, ApprovalPolicy, string> {
  private readonly logger = new Logger(PrismaApprovalPolicyRepository.name);
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }

  protected modelDelegate(client: unknown): PrismaModelDelegate<ApprovalPolicy, string> {
    return (client as Record<string, unknown>).approvalPolicy as PrismaModelDelegate<ApprovalPolicy, string>;
  }
  protected toDomain(model: ApprovalPolicy): ApprovalPolicyRecord { return { ...model } as ApprovalPolicyRecord; }
  protected toPersistenceCreate(record: ApprovalPolicyRecord) { return { ...record }; }
  protected toPersistenceUpdate(patch: Partial<ApprovalPolicyRecord>) { return { ...patch }; }

  async findCandidates(permissionKey: string, projectId: string | null): Promise<ApprovalPolicyRecord[]> {
    const rows = await this.prisma.client.approvalPolicy.findMany({
      where: { OR: [{ projectId }, { projectId: null }] },
      orderBy: { id: 'asc' }, take: MAX_POLICY_CANDIDATES,
    });
    if (rows.length >= MAX_POLICY_CANDIDATES) this.logger.warn('Approval policy candidate cap reached; candidates may be truncated');
    return rows.filter(({ permissionPattern: pattern }) => pattern === permissionKey ||
      (pattern.endsWith('.*') && permissionKey.startsWith(pattern.slice(0, -1)))).map((row) => this.toDomain(row));
  }

  async findBySelector(selector: string): Promise<ApprovalPolicyRecord | null> {
    const row = await this.prisma.client.approvalPolicy.findUnique({ where: { selector } });
    return row ? this.toDomain(row) : null;
  }

  async findPage(filter: ApprovalPolicyFilter, page: IPageOption): Promise<IPageResult<ApprovalPolicyRecord>> {
    const rows = await Paginate(this.prisma.client.approvalPolicy, page, { where: filter, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((row: ApprovalPolicy) => this.toDomain(row));
  }
}
