import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, Paginate, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { Page, resolvePageOption, type IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { MemoryItem as MemoryItemModel, Prisma, PrismaClient } from '../generated/prisma/client';
import { MemoryKind, MemoryScope } from '../common/enums';
import {
  MemoryQuery,
  ProjectMemoryQuery,
  MemoryItemInput,
  MemoryItem,
  MemoryOwnerType,
} from './memory-item-repository';
import type { MemoryWritten } from './memory-audit';
import { reviewRepoSubject, REVIEW_EVENT_SOURCE } from './review-decisions';

/**
 * The one key an active row of a project is unique on.
 *
 * Every triple keeps `KIND:subject:predicate`. A note (US-001) keys on its slug alone — `NOTE:<slug>` — so
 * re-saving a slug with a new type, body or index line replaces the note the project already has instead of
 * leaving a second note of a different type behind.
 */
export function buildActiveKey(_projectId: string | null, kind: string, subject: string, predicate: string): string {
  return kind === MemoryKind.NOTE ? `${MemoryKind.NOTE}:${subject}` : `${kind}:${subject}:${predicate}`;
}

export interface MemoryDedupKey {
  kind: string;
  subject: string;
  predicate: string;
}

/**
 * Permissions P1 US-008: what `upsert` does inside its transaction, after reading the active item of the
 * key and before superseding it. A throw rolls the transaction back, so a refused supersede writes
 * nothing at all. `beforeSupersede` is not called on the identical-restatement no-op path, which
 * supersedes nothing.
 */
export interface MemoryUpsertOptions {
  /** Runs inside the serializable write, before any no-op check or mutation. */
  beforeWrite?: () => Promise<void>;
  beforeSupersede?: (existing: MemoryItem) => Promise<void>;
  /**
   * Permissions P2 US-002: what the write did, awaited after the insert and still inside the same
   * transaction. A throw rolls the transaction back, so a refused audit entry leaves neither the new item
   * nor the superseded item's status change. Not called on the identical-restatement no-op path, which
   * writes nothing.
   */
  onWritten?: (written: MemoryWritten) => Promise<void>;
}

/** The stored owner kind, read back as the union the domain uses; anything else is a system item. */
function ownerTypeOf(model: MemoryItemModel): MemoryOwnerType | null {
  return model.ownerType === 'USER' || model.ownerType === 'AGENT' ? model.ownerType : null;
}

/** The stored scope, read back as the union the domain uses; anything but `user` is a project row (US-004). */
function scopeOf(model: MemoryItemModel): MemoryScope {
  return model.scope === MemoryScope.USER ? MemoryScope.USER : MemoryScope.PROJECT;
}

/**
 * US-004: the active-key partner of a user-scoped row — `<ownerType>:<ownerId>`, the same string the domain
 * carries as `ownerKey`, so `@@unique([ownerKey, activeKey])` is what makes one principal's note unique.
 *
 * Both halves are required: a user row whose owner is unknown could not be keyed (and would collide with
 * every other unowned user row), so an item that asks for user scope without them is a programming error
 * rather than a row. Only `MemoryWriteService.create` writes user scope, and it always sets both.
 */
function userOwnerKey(item: MemoryItemInput): string {
  if (!item.ownerType || !item.ownerId) {
    throw new Error('memory: a user-scoped item needs an ownerType and an ownerId');
  }
  return `${item.ownerType}:${item.ownerId}`;
}

/**
 * The PostgreSQL text-search configuration every ranked memory query uses (memory-notes US-003). English
 * only: no Chinese segmentation is added, and an unsegmented text is answered by the substring fallback.
 */
const SEARCH_CONFIG = 'english';

/**
 * The text that asks for a search, or undefined. A text of whitespace is no search at all, exactly as the
 * pre-feature `contains` path treats it (S5b US-004).
 */
function searchText(text: string | undefined): string | undefined {
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/**
 * `websearch_to_tsquery` over the bound text — the one expression both the match and the rank read.
 *
 * `websearch_to_tsquery` never raises a syntax error on user text (a stray quote or semicolon is folded
 * away), and the text is a bound parameter, so injection-shaped input stays a value. The configuration is
 * cast because a parameter has no type for Postgres to guess `regconfig` from.
 */
const tsQuery = (text: string): Prisma.Sql => Prisma.sql`websearch_to_tsquery(${SEARCH_CONFIG}::regconfig, ${text})`;

/**
 * The requested `orderBy` as SQL, with the same tiebreakers the Prisma path applies. The unique `id`
 * tiebreaker is last in every variant, so a page boundary can neither repeat nor skip a row whose rank,
 * timestamp and confidence all tie.
 */
function orderBySql(orderBy: ProjectMemoryQuery['orderBy']): Prisma.Sql {
  if (orderBy === 'updatedAt') {
    return Prisma.sql`m."updatedAt" DESC, m."confidence" DESC, m."createdAt" DESC, m."id" DESC`;
  }
  if (orderBy === 'createdAt') {
    return Prisma.sql`m."createdAt" DESC, m."confidence" DESC, m."updatedAt" DESC, m."id" DESC`;
  }
  return Prisma.sql`m."confidence" DESC, m."updatedAt" DESC, m."createdAt" DESC, m."id" DESC`;
}

@Injectable()
export class PrismaMemoryItemRepository
  extends AbstractPrismaRepository<MemoryItem, MemoryItemModel, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<MemoryItemModel, string> {
    return (client as unknown as PrismaClient).memoryItem as unknown as PrismaModelDelegate<MemoryItemModel, string>;
  }

  protected toDomain(m: MemoryItemModel): MemoryItem {
    return {
      id: m.id,
      projectId: m.projectId,
      kind: m.kind,
      subject: m.subject,
      predicate: m.predicate,
      object: m.object ?? undefined,
      description: m.description ?? undefined,
      activeKey: m.activeKey ?? undefined,
      ownerId: m.ownerId ?? undefined,
      ownerType: ownerTypeOf(m),
      scope: scopeOf(m),
      ownerKey: m.ownerKey ?? undefined,
      sourceType: m.sourceType ?? undefined,
      sourceId: m.sourceId ?? undefined,
      status: m.status,
      confidence: m.confidence,
      ttlAt: m.ttlAt ?? undefined,
      supersededBy: m.supersededBy ?? undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      deletedAt: m.deletedAt ?? undefined,
    };
  }

  protected toPersistenceCreate(domain: MemoryItem): Omit<MemoryItemModel, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      projectId: domain.projectId,
      kind: domain.kind,
      subject: domain.subject,
      predicate: domain.predicate,
      object: domain.object ?? null,
      description: domain.description ?? null,
      activeKey: domain.activeKey ?? null,
      ownerId: domain.ownerId ?? null,
      ownerType: domain.ownerType ?? null,
      scope: domain.scope,
      ownerKey: domain.ownerKey ?? null,
      sourceType: domain.sourceType ?? null,
      sourceId: domain.sourceId ?? null,
      status: domain.status,
      confidence: domain.confidence,
      ttlAt: domain.ttlAt ?? null,
      supersededBy: domain.supersededBy ?? null,
      deletedAt: domain.deletedAt ?? null,
    };
  }

  protected toPersistenceUpdate(patch: Partial<MemoryItem>): Partial<Omit<MemoryItemModel, 'id' | 'createdAt' | 'updatedAt'>> {
    const data: Partial<Omit<MemoryItemModel, 'id' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.projectId !== undefined) data.projectId = patch.projectId;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.subject !== undefined) data.subject = patch.subject;
    if (patch.predicate !== undefined) data.predicate = patch.predicate;
    if (patch.object !== undefined) data.object = patch.object ?? null;
    if (patch.description !== undefined) data.description = patch.description ?? null;
    if (patch.activeKey !== undefined) data.activeKey = patch.activeKey ?? null;
    if (patch.ownerId !== undefined) data.ownerId = patch.ownerId ?? null;
    if (patch.ownerType !== undefined) data.ownerType = patch.ownerType ?? null;
    if (patch.scope !== undefined) data.scope = patch.scope;
    if (patch.ownerKey !== undefined) data.ownerKey = patch.ownerKey ?? null;
    if (patch.sourceType !== undefined) data.sourceType = patch.sourceType ?? null;
    if (patch.sourceId !== undefined) data.sourceId = patch.sourceId ?? null;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.confidence !== undefined) data.confidence = patch.confidence;
    if (patch.ttlAt !== undefined) data.ttlAt = patch.ttlAt ?? null;
    if (patch.supersededBy !== undefined) data.supersededBy = patch.supersededBy ?? null;
    if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt ?? null;
    return data;
  }

  async findByProject(query: MemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>> {
    const where: Record<string, unknown> = {
      projectId: query.projectId,
      deletedAt: null,
      status: query.status ?? 'active',
    };
    if (query.kind) where.kind = query.kind;
    if (query.subject) where.subject = query.subject;
    if (query.predicate) where.predicate = query.predicate;
    if (query.activeKey !== undefined) where.activeKey = query.activeKey;
    if (query.sourceType) where.sourceType = query.sourceType;
    if (query.sourceId) where.sourceId = query.sourceId;

    // Unique tiebreaker: rows created in the same burst share timestamps and
    // Postgres does not guarantee a stable order among ties, which would
    // shuffle items across pagination pages.
    const models = await Paginate(this.prisma.client.memoryItem, page, {
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return models.remap((m) => this.toDomain(m));
  }

  /** M21: keyset page over active rows; stable while rows leave 'active'. */
  async findActiveAfterId(projectId: string, afterId: string | null, take: number): Promise<MemoryItem[]> {
    const models = await this.prisma.client.memoryItem.findMany({
      where: {
        projectId,
        deletedAt: null,
        status: 'active',
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
    });
    return models.map((m) => this.toDomain(m));
  }

  /** M21: dedup keys with more than one active row, found in SQL instead of per page. */
  async findDuplicateActiveKeys(projectId: string, kind?: string): Promise<MemoryDedupKey[]> {
    const groups = await this.prisma.client.memoryItem.groupBy({
      by: ['kind', 'subject', 'predicate'],
      where: { projectId, deletedAt: null, status: 'active', ...(kind ? { kind } : {}) },
      having: { id: { _count: { gt: 1 } } },
      orderBy: [{ kind: 'asc' }, { subject: 'asc' }, { predicate: 'asc' }],
    });
    return groups.map(({ kind: k, subject, predicate }) => ({ kind: k, subject, predicate }));
  }

  async findActiveByKey(projectId: string, key: MemoryDedupKey): Promise<MemoryItem[]> {
    const models = await this.prisma.client.memoryItem.findMany({
      where: { projectId, deletedAt: null, status: 'active', kind: key.kind, subject: key.subject, predicate: key.predicate },
      orderBy: { id: 'asc' },
    });
    return models.map((m) => this.toDomain(m));
  }

  /** Durable review guards include deleted rows and all statuses; duplicate takes precedence. */
  async reviewDecisionGuard(projectId: string, sourceId: string, subject: string, predicate: string): Promise<'duplicate' | 'retired' | null> {
    const duplicate = await this.prisma.client.memoryItem.findFirst({
      where: { sourceType: 'review_event', sourceId }, select: { id: true },
    });
    if (duplicate) return 'duplicate';
    const retired = await this.prisma.client.memoryItem.findFirst({
      where: { projectId, subject, predicate, sourceType: 'review_event', status: 'rejected' }, select: { id: true },
    });
    return retired ? 'retired' : null;
  }

  async upsert(item: MemoryItemInput, options?: MemoryUpsertOptions): Promise<MemoryItem> {
    // Permissions P2 US-002: the write runs on the transaction manager rather than a bare
    // `client.$transaction`, so the callback runs in the AsyncLocalStorage the transaction manager (and
    // thus `AuditRecorder.record`) reads — `onWritten` records its entry in this same transaction. The
    // callback still writes through its own `tx`: a `PrismaService` that is not wired with the module's
    // proxy (a bare one in a test) resolves `client` to the root client inside a transaction.
    return this.prisma.withTransaction(
      async (tx) => {
        const db = tx as unknown as PrismaClient;
        await options?.beforeWrite?.();

        const activeKey = buildActiveKey(item.projectId, item.kind, item.subject, item.predicate);

        // US-004: a user-scoped row is keyed on its owner, not on a project — the row has no project at all.
        const scope = item.scope ?? MemoryScope.PROJECT;
        const ownerKey = scope === MemoryScope.USER ? userOwnerKey(item) : null;

        // US-001: the active row is found by its key, never by the triple, so a note (whose key is the slug
        // alone) is replaced when the same slug comes back with another type. US-004: a user row is found by
        // `(ownerKey, activeKey)`, so the same slug written by two principals, or from two projects, is two
        // keys of a different kind — one principal's note never supersedes another's or a project's.
        const existingActive = await db.memoryItem.findFirst({
          where: {
            ...(scope === MemoryScope.USER ? { ownerKey } : { projectId: item.projectId }),
            activeKey,
            deletedAt: null,
          },
        });

        // Outbox replays re-run this handler: restating the same fact from the
        // same source is a no-op instead of superseding an identical row. A note
        // compares its type and index line too (US-001), so a restatement of the
        // whole note is the no-op while a changed type or description supersedes.
        if (
          existingActive &&
          existingActive.object === (item.object ?? null) &&
          existingActive.predicate === item.predicate &&
          existingActive.description === (item.description ?? null) &&
          existingActive.sourceType === item.sourceType &&
          existingActive.sourceId === item.sourceId
        ) {
          return this.toDomain(existingActive);
        }

        if (existingActive) {
          // Permissions P1 US-008: the supersede check runs here — inside the transaction, after the active
          // row was read and before it is touched — so a refusal rolls the whole transaction back and
          // nothing (the supersede, the insert) is written. The no-op path above never supersedes, so it
          // never asks.
          await options?.beforeSupersede?.(this.toDomain(existingActive));
          await db.memoryItem.update({
            where: { id: existingActive.id },
            data: { activeKey: null, status: 'superseded', supersededBy: undefined },
          });
        }

        const created = await db.memoryItem.create({
          data: {
            projectId: scope === MemoryScope.USER ? null : item.projectId,
            kind: item.kind,
            subject: item.subject,
            predicate: item.predicate,
            object: item.object,
            description: item.description ?? null,
            activeKey,
            ownerId: item.ownerId,
            ownerType: item.ownerType ?? null,
            scope,
            ownerKey,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            status: item.status ?? 'active',
            confidence: item.confidence ?? 0.8,
            ttlAt: item.ttlAt ?? null,
            supersededBy: item.supersededBy,
          },
        });

        // Permissions P2 US-002: last, so the audit entry names an item that exists, and inside the
        // transaction, so a refused entry takes the insert (and the supersede above) with it.
        await options?.onWritten?.({
          item: this.toDomain(created),
          superseded: existingActive ? this.toDomain(existingActive) : null,
        });

        return this.toDomain(created);
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /**
   * Permissions P1 US-008: whether a non-deleted ticket of `projectId` has this id. `POST /memory/extract`
   * reads it so a `ticket_event` cannot name a ticket of another project; MemoryModule does not import the
   * tickets module, and this is the same cross-table read `prisma-canonical-state.repository.ts` makes.
   */
  async ticketInProject(projectId: string, ticketId: string): Promise<boolean> {
    const count = await this.prisma.client.ticket.count({
      where: { id: ticketId, projectId, deletedAt: null },
    });
    return count > 0;
  }

  async findActive(
    projectId: string,
    kind: string,
    subject: string,
    predicate: string,
  ): Promise<MemoryItem | null> {
    const m = await this.prisma.client.memoryItem.findFirst({
      where: {
        projectId,
        activeKey: buildActiveKey(projectId, kind, subject, predicate),
        status: 'active',
        deletedAt: null,
      },
    });
    return m ? this.toDomain(m) : null;
  }

  /** Lock, validate and audit in one transaction; callbacks never outlive the row lock. */
  async retire(
    id: string,
    check: (item: MemoryItem | null) => Promise<void>,
    onRetired: (item: MemoryItem) => Promise<void>,
  ): Promise<MemoryItem> {
    return this.prisma.withTransaction(async (tx) => {
      const db = tx as unknown as PrismaClient;
      await db.$queryRaw`SELECT id FROM "MemoryItem" WHERE id = ${id} FOR UPDATE`;
      const model = await db.memoryItem.findUnique({ where: { id } });
      await check(model ? this.toDomain(model) : null);
      const retired = this.toDomain(await db.memoryItem.update({
        where: { id }, data: { status: 'rejected', activeKey: null },
      }));
      await onRetired(retired);
      return retired;
    }, { isolationLevel: 'Serializable' });
  }

  async reject(id: string): Promise<void> {
    await this.prisma.client.memoryItem.update({
      where: { id },
      data: { activeKey: null, status: 'rejected' },
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.client.memoryItem.update({
      where: { id },
      data: { deletedAt: new Date(), activeKey: null },
    });
  }

  async updateDirect(id: string, data: Partial<MemoryItemInput>): Promise<void> {
    const updateData: Record<string, unknown> = {};
    if (data.status !== undefined) updateData.status = data.status;
    if (data.confidence !== undefined) updateData.confidence = data.confidence;
    if (data.activeKey !== undefined) updateData.activeKey = data.activeKey;
    if (data.supersededBy !== undefined) updateData.supersededBy = data.supersededBy;
    if (data.ttlAt !== undefined) updateData.ttlAt = data.ttlAt;

    await this.prisma.client.memoryItem.update({ where: { id }, data: updateData });
  }

  async findReviewDecisionRows(projectId: string, repoId: string, take: number): Promise<{ recorded: MemoryItem[]; reviewMinted: MemoryItem[] }> {
    const now = new Date();
    const eligibility = {
      projectId,
      kind: 'DECISION',
      status: 'active',
      deletedAt: null,
      OR: [{ ttlAt: null }, { ttlAt: { gt: now } }],
    };
    const [recorded, reviewMinted] = await Promise.all([
      this.prisma.client.memoryItem.findMany({
        where: { ...eligibility, AND: [{ OR: [{ sourceType: null }, { sourceType: { not: REVIEW_EVENT_SOURCE } }] }] },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take,
      }),
      this.prisma.client.memoryItem.findMany({
        where: { ...eligibility, sourceType: REVIEW_EVENT_SOURCE, subject: reviewRepoSubject(repoId) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take,
      }),
    ]);
    return { recorded: recorded.map((item) => this.toDomain(item)), reviewMinted: reviewMinted.map((item) => this.toDomain(item)) };
  }

  /**
   * The project's memory page (permissions P1 US-008, S5b US-004), ranked by full text when the caller
   * searches (memory-notes US-003).
   *
   * A non-blank `text` is first offered to PostgreSQL: when `websearch_to_tsquery('english', text)` has any
   * lexeme, `findRankedByText` answers the page by `ts_rank` over the generated `searchVector` — stemmed,
   * multi-word and ranked — where the `contains` path could only match a verbatim substring of one field.
   * Without lexemes (stopwords, punctuation) the pre-feature `contains` path runs unchanged, and it also
   * runs when the ranked query matched nothing: an unsegmented text such as a Chinese phrase has lexemes
   * but segments nothing, so the substring matches it always found are still found here.
   */
  async findByProjectMemory(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>> {
    const text = searchText(query.text);
    if (text !== undefined && (await this.hasSearchLexemes(text))) {
      const ranked = await this.findRankedByText(query, text, page);
      if (ranked.total > 0) return ranked;
    }
    return this.findByContains(query, page);
  }

  /** Whether `websearch_to_tsquery` kept any lexeme: only then is a full-text query worth running. */
  private async hasSearchLexemes(text: string): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<Array<{ lexemes: number }>>(
      Prisma.sql`SELECT numnode(${tsQuery(text)}) AS "lexemes"`,
    );
    return (rows[0]?.lexemes ?? 0) > 0;
  }

  /**
   * The ranked page (memory-notes US-003): one query selects the page's ids with every filter applied in
   * SQL, a second counts the matches, and the rows are then loaded and returned in rank order.
   *
   * Every filter the `contains` path applies is applied here too, in the same shape: the project, the rows
   * that are not soft-deleted, the status, the TTL bound when the status is defaulted (never an `OR` next
   * to the text term, which would let an expired row through), the kind and the subject prefix — the last
   * as `starts_with`, so `%` and `_` are literal characters rather than LIKE wildcards.
   */
  private async findRankedByText(
    query: ProjectMemoryQuery,
    text: string,
    page: IPageOption,
  ): Promise<IPageResult<MemoryItem>> {
    const conditions = [
      Prisma.sql`m."projectId" = ${query.projectId}`,
      Prisma.sql`m."deletedAt" IS NULL`,
    ];
    if (query.status) {
      conditions.push(Prisma.sql`m."status" = ${query.status}`);
    } else {
      const now = new Date();
      conditions.push(Prisma.sql`m."status" = 'active'`, Prisma.sql`(m."ttlAt" IS NULL OR m."ttlAt" > ${now})`);
    }
    if (query.kind) conditions.push(Prisma.sql`m."kind" = ${query.kind}`);
    if (query.subject && query.subject.trim().length > 0) {
      conditions.push(Prisma.sql`starts_with(m."subject", ${query.subject})`);
    }
    conditions.push(Prisma.sql`m."searchVector" @@ ${tsQuery(text)}`);
    const where = Prisma.join(conditions, ' AND ');

    // Order by rank only when the caller asked for no order: an explicit `orderBy` is answered as written.
    const order = query.orderBy === undefined
      ? Prisma.sql`ts_rank(m."searchVector", ${tsQuery(text)}) DESC, m."updatedAt" DESC, m."id" DESC`
      : orderBySql(query.orderBy);
    const { current, size, skip, take } = resolvePageOption(page);
    const [pageRows, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT m."id" FROM "MemoryItem" m WHERE ${where} ORDER BY ${order} OFFSET ${skip} LIMIT ${take}`),
      this.prisma.client.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT count(*)::int AS "total" FROM "MemoryItem" m WHERE ${where}`),
    ]);

    const total = counted[0]?.total ?? 0;
    const records = await this.hydrateRanked(pageRows.map((row) => row.id));
    return new Page({ current, size }, total, records);
  }

  /**
   * The rows of a ranked page, in the order the rank query answered them: `in` does not preserve order, so
   * the models are re-keyed by id and walked in `ids` order. Both queries read the same table, so a row
   * that left between them is simply absent — the page is then one record shorter, never out of order.
   */
  private async hydrateRanked(ids: readonly string[]): Promise<MemoryItem[]> {
    if (ids.length === 0) return [];
    const models = await this.prisma.client.memoryItem.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
    });
    const byId = new Map(models.map((model) => [model.id, this.toDomain(model)]));
    return ids.flatMap((id) => {
      const item = byId.get(id);
      return item === undefined ? [] : [item];
    });
  }

  /**
   * The pre-feature page (S5b US-004): filters in Prisma, `text` as a case-insensitive substring of
   * subject, predicate or object. Kept as it was — it is the answer for a text with no lexeme and the
   * fallback for a ranked query that matched nothing (memory-notes US-003).
   */
  private async findByContains(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>> {
    const where: Record<string, unknown> = { projectId: query.projectId, deletedAt: null };

    if (query.status) {
      where.status = query.status;
    } else {
      where.status = 'active';
      const now = new Date();
      where.OR = [
        { ttlAt: null },
        { ttlAt: { gt: now } },
      ];
    }

    if (query.kind) where.kind = query.kind;
    if (query.subject && query.subject.trim().length > 0) where.subject = { startsWith: query.subject };
    // S5b US-004: the text match is its own AND term. It must never join the TTL `OR` above: an `OR` of a
    // text match and a TTL bound would return expired rows that match the text.
    if (query.text && query.text.trim().length > 0) {
      where.AND = [
        {
          OR: [
            { subject: { contains: query.text, mode: 'insensitive' } },
            { predicate: { contains: query.text, mode: 'insensitive' } },
            { object: { contains: query.text, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const orderByField = query.orderBy ?? 'confidence';
    const orderByClause: Record<string, 'asc' | 'desc'>[] = [];
    if (orderByField === 'confidence') {
      orderByClause.push({ confidence: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' });
    } else if (orderByField === 'updatedAt') {
      orderByClause.push({ updatedAt: 'desc' }, { confidence: 'desc' }, { createdAt: 'desc' });
    } else {
      orderByClause.push({ createdAt: 'desc' }, { confidence: 'desc' }, { updatedAt: 'desc' });
    }
    // Unique tiebreaker: rows created in the same burst share timestamps and
    // confidence, and Postgres does not guarantee a stable order among ties,
    // which would shuffle items across pagination pages.
    orderByClause.push({ id: 'desc' });

    const models = await Paginate(this.prisma.client.memoryItem, page, { where, orderBy: orderByClause });
    return models.remap((m) => this.toDomain(m));
  }
}
