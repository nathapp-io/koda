import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolvePageOption, type IPageOption } from '@nathapp/nestjs-common';
import {
  AbstractPrismaRepository,
  Paginate,
  PrismaService,
  type PrismaModelDelegate,
} from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type IPageResult, type ITransactionManager } from '@nathapp/nestjs-data';
import {
  Prisma,
  type PrismaClient,
  type ProviderCredential as ProviderCredentialRow,
} from '../../generated/prisma/client';
import { isRecordNotFound } from '../../common/utils/prisma-errors';
import {
  GLOBAL_SCOPE_KEY,
  PROVIDER_AVAILABILITY_MAX_ROWS,
  type ActiveProviderScope,
  type ActiveProviderScopeQuery,
  type IProviderCredentialRepository,
  type NewProviderCredential,
  type NewProviderCredentialIssue,
  type ProviderCredential,
  type ProviderCredentialLookup,
  type ProviderCredentialPatch,
  type ProviderCredentialScope,
  PROVIDER_CREDENTIAL_PAGE_SIZE_MAX,
  PROVIDER_KEY_SUMMARY_MAX_PAGES,
  PROVIDER_KEY_SUMMARY_PAGE_SIZE,
  scopeKeyFor,
} from './provider-credential.domain';

/**
 * Deterministic page order: provider, then creation time, then the id as the final total order.
 * Two PROJECT/REPO rows can share a `providerId` (and a millisecond), so `id` is what keeps a page
 * boundary from repeating or skipping a row.
 */
export const PROVIDER_CREDENTIAL_ORDER_BY: Prisma.ProviderCredentialOrderByWithRelationInput[] = [
  { providerId: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

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
  private readonly logger = new Logger(PrismaProviderCredentialRepository.name);

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

  async lockById(id: string): Promise<ProviderCredential | null> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM "ProviderCredential" WHERE id = ${id} FOR UPDATE
    `);
    if (rows.length === 0) return null;
    return this.findById(id);
  }

  /**
   * US-005: the scope check of a REPO key. `FleetRepo` belongs to the fleet-repo module, and this module
   * depends on no fleet-repo service, so the check is one primary-key read of the owning project here
   * rather than a new cross-module dependency for a single column.
   */
  async findRepoProject(repoId: string): Promise<string | null> {
    const row = await this.prisma.client.fleetRepo.findUnique({
      where: { id: repoId },
      select: { projectId: true },
    });
    return row?.projectId ?? null;
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

  async listActiveScopes(
    query: ActiveProviderScopeQuery,
  ): Promise<ActiveProviderScope[]> {
    const projectIds = [...query.projectIds];
    const repoIds = [...query.repoIds];
    if (projectIds.length === 0 && repoIds.length === 0) return [];
    const rows = await this.prisma.client.providerCredential.findMany({
      where: {
        disabledAt: null,
        OR: [
          { scopeKey: GLOBAL_SCOPE_KEY },
          { projectId: { in: projectIds } },
          { repoId: { in: repoIds } },
        ],
      },
      select: { scope: true, projectId: true, repoId: true, providerId: true },
      orderBy: PROVIDER_CREDENTIAL_ORDER_BY,
      // One row per scope and provider, so this is bounded by the caller's scopes times their providers.
      take: PROVIDER_AVAILABILITY_MAX_ROWS + 1,
    });
    if (rows.length > PROVIDER_AVAILABILITY_MAX_ROWS) {
      // Truncating under-reports what the vault can serve, which only keeps a local credential refusal
      // in place; a caller that reaches this needs its scopes narrowed, not a bigger read.
      this.logger.warn(`Provider availability read exceeded ${PROVIDER_AVAILABILITY_MAX_ROWS} rows for ${projectIds.length} projects and ${repoIds.length} repos; the answer is truncated`);
    }
    return rows.slice(0, PROVIDER_AVAILABILITY_MAX_ROWS).map((row) => ({
      scope: row.scope as ProviderCredentialScope,
      projectId: row.projectId,
      repoId: row.repoId,
      providerId: row.providerId,
    }));
  }

  async listGlobal(page: IPageOption): Promise<IPageResult<ProviderCredential>> {
    return this.listPage({ scopeKey: GLOBAL_SCOPE_KEY }, page);
  }

  /**
   * C10 US-007: the board's `kodaKeys`, read in bounded pages. Creation accepts any valid provider id
   * and nothing bounds the GLOBAL inventory, so one page would hide keys that exist; the loop stops at
   * the first partial page. The order is total (provider, created, id), so two calls agree, and the
   * {@link PROVIDER_KEY_SUMMARY_MAX_PAGES} bound keeps the loop finite: an inventory that reaches it
   * fails loudly instead of answering a board that lost keys.
   *
   * Paging is by offset and this read holds no transaction, so a credential written between two pages
   * can shift one row into or out of the window; the board is a derived snapshot and the next request
   * answers the settled inventory.
   */
  async listActiveGlobal(): Promise<ProviderCredential[]> {
    const rows: ProviderCredential[] = [];
    for (let page = 0; page < PROVIDER_KEY_SUMMARY_MAX_PAGES; page += 1) {
      const batch = await this.prisma.client.providerCredential.findMany({
        where: { scopeKey: GLOBAL_SCOPE_KEY, disabledAt: null },
        orderBy: PROVIDER_CREDENTIAL_ORDER_BY,
        skip: page * PROVIDER_KEY_SUMMARY_PAGE_SIZE,
        take: PROVIDER_KEY_SUMMARY_PAGE_SIZE,
      });
      for (const row of batch) rows.push(this.toDomain(row));
      if (batch.length < PROVIDER_KEY_SUMMARY_PAGE_SIZE) return rows;
    }
    const cap = PROVIDER_KEY_SUMMARY_MAX_PAGES * PROVIDER_KEY_SUMMARY_PAGE_SIZE;
    this.logger.error(`Active GLOBAL provider credentials exceed ${cap} rows; the credential board is refused rather than truncated`);
    throw new Error(`Provider credential GLOBAL inventory exceeds ${cap} rows`);
  }

  async listForProject(projectId: string, page: IPageOption): Promise<IPageResult<ProviderCredential>> {
    // REPO rows carry their project too, so one project filter answers both project scopes.
    return this.listPage({ projectId }, page);
  }

  /**
   * One bounded page of credentials. The requested `size` is clamped to
   * {@link PROVIDER_CREDENTIAL_PAGE_SIZE_MAX} and the page reports `total`/`hasNext`, so a large
   * request yields another page instead of an unbounded table read or a silent truncation.
   */
  private async listPage(
    where: Prisma.ProviderCredentialWhereInput,
    page: IPageOption,
  ): Promise<IPageResult<ProviderCredential>> {
    const { current, size } = resolvePageOption(page, PROVIDER_CREDENTIAL_PAGE_SIZE_MAX);
    const rows = await Paginate(
      this.prisma.client.providerCredential,
      { current, size },
      { where, orderBy: PROVIDER_CREDENTIAL_ORDER_BY },
    );
    return rows.remap((row: ProviderCredentialRow) => this.toDomain(row));
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
