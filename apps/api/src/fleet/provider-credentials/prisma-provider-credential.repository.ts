import { Inject, Injectable } from '@nestjs/common';
import {
  AbstractPrismaRepository,
  PrismaService,
  type PrismaModelDelegate,
} from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { PrismaClient, ProviderCredential as ProviderCredentialRow } from '../../generated/prisma/client';
import { isRecordNotFound } from '../../common/utils/prisma-errors';
import {
  GLOBAL_SCOPE_KEY,
  type IProviderCredentialRepository,
  type NewProviderCredential,
  type NewProviderCredentialIssue,
  type ProviderCredential,
  type ProviderCredentialLookup,
  type ProviderCredentialPatch,
  type ProviderCredentialScope,
  scopeKeyFor,
} from './provider-credential.domain';

/**
 * Persistence for the provider credential vault (spec §"US-001").
 *
 * Two tables, so this implements the repository contract directly (like `PrismaVcsRepository`) and
 * uses the Prisma client as an escape hatch for the scoped reads and the issue insert; the generic
 * `AbstractPrismaRepository` base still supplies `findById` and the transaction manager this module
 * wires. Every write goes through the transparent transaction proxy, so a caller that opens
 * `txManager.run` keeps its credential write and its activity/audit rows in one transaction.
 */
@Injectable()
export class PrismaProviderCredentialRepository
  extends AbstractPrismaRepository<ProviderCredential, ProviderCredentialRow, string>
  implements IProviderCredentialRepository
{
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: unknown): PrismaModelDelegate<ProviderCredentialRow, string> {
    return (client as Record<string, unknown>).providerCredential as PrismaModelDelegate<
      ProviderCredentialRow,
      string
    >;
  }

  protected toDomain(row: ProviderCredentialRow): ProviderCredential {
    return { ...row, scope: row.scope as ProviderCredentialScope };
  }

  protected toPersistenceCreate(domain: ProviderCredential) {
    return { ...domain };
  }

  protected toPersistenceUpdate(patch: Partial<ProviderCredential>) {
    return { ...patch };
  }

  async findActiveCandidates(
    lookup: ProviderCredentialLookup,
  ): Promise<ProviderCredential[]> {
    const scopeKeys = [
      GLOBAL_SCOPE_KEY,
      scopeKeyFor({ scope: 'PROJECT', projectId: lookup.projectId }),
    ];
    if (lookup.repoId) scopeKeys.push(scopeKeyFor({ scope: 'REPO', repoId: lookup.repoId }));

    const rows = await this.prisma.client.providerCredential.findMany({
      where: { providerId: lookup.providerId, disabledAt: null, scopeKey: { in: scopeKeys } },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async listGlobal(): Promise<ProviderCredential[]> {
    const rows = await this.prisma.client.providerCredential.findMany({
      where: { scopeKey: GLOBAL_SCOPE_KEY },
      orderBy: [{ providerId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toDomain(row));
  }

  async listForProject(projectId: string): Promise<ProviderCredential[]> {
    // REPO rows carry their project too, so one project filter answers both project scopes.
    const rows = await this.prisma.client.providerCredential.findMany({
      where: { projectId },
      orderBy: [{ providerId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toDomain(row));
  }

  async insert(data: NewProviderCredential): Promise<ProviderCredential> {
    const row = await this.prisma.client.providerCredential.create({
      data: {
        scope: data.scope,
        scopeKey: scopeKeyFor(data),
        projectId: data.projectId ?? null,
        repoId: data.repoId ?? null,
        providerId: data.providerId,
        name: data.name,
        encryptedKey: data.encryptedKey,
        last4: data.last4,
        fingerprint: data.fingerprint,
        createdById: data.createdById,
        updatedById: data.updatedById,
      },
    });
    return this.toDomain(row);
  }

  async patch(id: string, patch: ProviderCredentialPatch): Promise<ProviderCredential | null> {
    try {
      const row = await this.prisma.client.providerCredential.update({ where: { id }, data: patch });
      return this.toDomain(row);
    } catch (error) {
      // A credential deleted between the caller's read and this write is a 404, not a 500.
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  async remove(id: string): Promise<boolean> {
    const { count } = await this.prisma.client.providerCredential.deleteMany({ where: { id } });
    return count > 0;
  }

  async recordIssue(data: NewProviderCredentialIssue): Promise<boolean> {
    // The unique index on (jobId, credentialId, fingerprint) is the dedupe: a replayed hand-out
    // stores nothing and must not be reported as a fresh issue.
    const { count } = await this.prisma.client.providerCredentialIssue.createMany({
      data: [data],
      skipDuplicates: true,
    });
    return count === 1;
  }
}
