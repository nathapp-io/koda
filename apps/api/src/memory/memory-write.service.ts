import { Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ExtractionService, WriteResult } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput, memoryOwnerKey, type MemoryItem } from './memory-item-repository';
import { MemoryRetireException } from './memory-retire.exception';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { MemoryKind, MemoryScope } from '../common/enums';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { MemoryReplaceRefusedError, MemoryWriteGuard, ownerTypeFor } from './memory-write.guard';
import { memoryAuditHook, type MemoryAuditKey } from './memory-audit';
import { noteFieldError } from './memory-note';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { CreateMemoryDto } from './dto/create-memory.dto';
import { ExtractEventDto } from './dto/extract-event.dto';

/** `memory.update`: holding it without a project is the global grant that lets a caller attribute a write. */
const ATTRIBUTE_KEY = 'memory.update';

/**
 * Principal-driven memory writes, including decision retirement.
 *
 * Each one is a service-mode key: the handler first keeps the membership check it has always made
 * (`assertProjectMembership`, which is what refuses a runner and a non-member), then asks
 * `PermissionService` for its catalog key in the named project. The reads live in `MemoryReadController`
 * and `TimelineController`, whose keys the guard checks.
 *
 * No write supersedes silently: every principal-driven `upsert` passes `MemoryWriteGuard.replaceCheck`,
 * which runs inside the repository's transaction and refuses (`MemoryReplaceRefusedError` → 403
 * `permissions`) when the active item belongs to a principal this caller may not replace. `extract`
 * pre-checks every extracted item before the first write, so one forbidden key leaves the whole request
 * unwritten.
 */
@Injectable()
export class MemoryWriteService {
  constructor(
    private readonly extractionService: ExtractionService,
    private readonly repository: PrismaMemoryItemRepository,
    private readonly projectAccess: ProjectAccessService,
    private readonly permissions: PermissionService,
    private readonly writeGuard: MemoryWriteGuard,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * S mode: membership first (the check this route has always made, and the one that keeps the cross-project
   * write path closed), then the catalog key in that project. `can` is what refuses a runner (a runner holds
   * no role key) and a caller whose only grant is another project's.
   */
  private async assertMayWrite(
    principal: KodaPrincipal,
    key: string,
    projectId: string,
  ): Promise<void> {
    await this.projectAccess.assertProjectMembership(projectId, principal);
    const decision = await this.permissions.can(principal, key, { projectId });
    if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
  }

  /**
   * Though a write is always made as the caller, a caller holding `memory.update` *globally* may attribute
   * it to another principal (H12). That grant needs a global role — a project-admin binding alone does
   * not reach this check, which is given no project.
   */
  private async mayAttribute(principal: KodaPrincipal): Promise<boolean> {
    return (await this.permissions.can(principal, ATTRIBUTE_KEY)).allowed;
  }

  /**
   * The one principal-driven write path: the item, the replace check the repository runs inside its
   * transaction, and the audit entry it records there (permissions P2 US-002). A refusal is the
   * `permissions` 403 — by then the transaction has rolled back, so nothing of the refused write exists.
   *
   * `key` is the entry point's own permission key: a replacement is an entry of the route that made it
   * (`memory.create`, `memory.extract`), never a key of its own, and the summary names the superseded item.
   * `projectId` is the project the write was authorised in, which is the audit entry's project for a user
   * note — a user row has no project of its own (US-004).
   */
  private async write(
    principal: KodaPrincipal,
    key: MemoryAuditKey,
    projectId: string,
    data: { ownerId: string; ownerType: 'USER' | 'AGENT' | null },
    rest: Omit<MemoryItemInput, 'ownerId' | 'ownerType'>,
  ) {
    try {
      return await this.repository.upsert(
        { ...rest, ownerId: data.ownerId, ownerType: data.ownerType },
        {
          beforeSupersede: this.writeGuard.replaceCheck(principal, projectId),
          onWritten: memoryAuditHook(this.audit, key, projectId),
        },
      );
    } catch (error) {
      if (error instanceof MemoryReplaceRefusedError) throw new ForbiddenAppException({}, 'permissions');
      throw error;
    }
  }

  async extract(principal: KodaPrincipal, event: ExtractEventDto) {
    const projectId = event.projectId;
    if (!projectId) {
      return { items: [] };
    }

    await this.assertMayWrite(principal, 'memory.extract', projectId);

    // The event's ticket must be a live ticket of the same project: extraction turns `ticketId` into the
    // item's subject, so a foreign id would plant a fact about another project's ticket here. MemoryModule
    // does not import the tickets module, so the read goes through the repository.
    if (event.ticketId && !(await this.repository.ticketInProject(projectId, event.ticketId))) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const items = this.extractionService.extractFromEvent(event as unknown as Parameters<typeof this.extractionService.extractFromEvent>[0]);

    // H12 follow-up: extraction of decision_event / agent_event('decision_made')
    // payloads emits DECISION items whose subject is 'agent:<event.agentId>' —
    // a caller-controlled value. Persisting them here would let an authorized
    // caller plant (or supersede, via the KIND:subject:predicate upsert key) a
    // decision shown as another agent's, the exact forgery recordDecision
    // guards against. DECISION memories must only be minted through
    // recordDecision, which forces non-admin self-attribution. The outbox
    // subscriber calls ExtractionService directly and is unaffected.
    const persisted = items.filter((item) => item.kind !== MemoryKind.DECISION);

    // All or nothing: every key is checked before the first item is written, so a request that may not
    // supersede one of its items writes none. Best effort by design — an upsert's own in-transaction
    // `replaceCheck` still refuses a supersede a concurrent write made forbidden.
    for (const item of persisted) {
      try {
        await this.writeGuard.assertMayReplace(principal, projectId, {
          kind: item.kind,
          subject: item.subject,
          predicate: item.predicate,
        });
      } catch (error) {
        if (error instanceof MemoryReplaceRefusedError) throw new ForbiddenAppException({}, 'permissions');
        throw error;
      }
    }

    const ownerType = ownerTypeFor(principal);
    for (const item of persisted) {
      await this.write(principal, 'memory.extract', projectId, { ownerId: principal.id, ownerType }, {
        projectId: item.projectId,
        kind: item.kind,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        sourceType: item.sourceType ?? event.type,
        sourceId: item.sourceId ?? event.id,
        confidence: item.confidence,
        // H12: attribution is always the authenticated caller. The raw event
        // used to carry actorId, letting a caller forge another agent's or
        // user's memory ownership — that field is no longer trusted.
      });
    }

    return { items: persisted };
  }

  async recordDecision(
    principal: KodaPrincipal,
    decision: RecordDecisionDto,
  ): Promise<WriteResult> {
    await this.assertMayWrite(principal, 'memory.decision.record', decision.projectId);

    // Only a caller holding `memory.update` globally may attribute a decision to an arbitrary actor; every
    // other caller can only record decisions as themselves, so a non-admin can't spoof another
    // user/agent's decision history. An attributed owner is not the caller, so its type is unknown (null).
    const actorId = (await this.mayAttribute(principal)) && decision.actorId ? decision.actorId : principal.id;

    try {
      return await this.extractionService.recordDecision(
        {
          projectId: decision.projectId,
          actorId,
          topic: decision.topic,
          decision: decision.decision,
          rationale: decision.rationale,
          sourceId: decision.sourceId,
          ownerType: actorId === principal.id ? ownerTypeFor(principal) : null,
        },
        this.repository,
        {
          beforeSupersede: this.writeGuard.replaceCheck(principal, decision.projectId),
          onWritten: memoryAuditHook(this.audit, 'memory.decision.record'),
        },
      );
    } catch (error) {
      if (error instanceof MemoryReplaceRefusedError) throw new ForbiddenAppException({}, 'permissions');
      throw error;
    }
  }

  /**
   * The row a decision retire names, once every check that needs no row lock has passed.
   *
   * US-004: a user-scoped row is never a decision retire's target — the decision route is not the note retire
   * route (memory-notes US-011), and a user row has no project to authorise its retirement in. It is answered
   * as a row that does not exist, before membership is even asked, so the refusal tells a caller nothing
   * about a note it does not own. The returned row is narrowed to a project row, which is what the callers
   * need for the project they then authorise in.
   */
  private async assertRetireTarget(
    principal: KodaPrincipal,
    item: MemoryItem | null,
  ): Promise<MemoryItem & { projectId: string }> {
    if (!item || item.deletedAt) throw new NotFoundAppException({}, 'memory.notFound');
    if (item.scope === MemoryScope.USER || item.projectId === null) {
      throw new NotFoundAppException({}, 'memory.notFound');
    }
    try {
      await this.projectAccess.assertProjectMembership(item.projectId, principal);
    } catch (error) {
      // Hide only membership refusals, never infrastructure failures.
      if (error instanceof ForbiddenAppException) throw new NotFoundAppException({}, 'memory.notFound');
      throw error;
    }
    if (item.kind !== MemoryKind.DECISION) throw new MemoryRetireException(item.kind);
    if (item.status !== 'active') throw new ConflictAppException({}, 'memory.retireNotActive');
    return item as MemoryItem & { projectId: string };
  }

  async retireTarget(principal: KodaPrincipal, id: string): Promise<{ projectId: string }> {
    const item = await this.assertRetireTarget(principal, await this.repository.findById(id));
    return { projectId: item.projectId };
  }

  async retireDecision(principal: KodaPrincipal, id: string, reason?: string) {
    return this.repository.retire(id, async (target) => {
      const item = await this.assertRetireTarget(principal, target);
      await this.assertMayWrite(principal, 'memory.decision.retire', item.projectId);
      if (!(await this.writeGuard.mayReplace(principal, item.projectId, item))) {
        throw new ForbiddenAppException({}, 'permissions');
      }
    }, async (item) => {
      await this.audit.record({
        key: 'memory.decision.retire', resourceType: 'memory-item', resourceId: item.id,
        projectId: item.projectId, summary: reason ? `retired DECISION: ${reason}` : 'retired DECISION',
      });
    });
  }

  /**
   * memory-notes US-011: the row a note retire names, once every check that needs no row lock has passed.
   *
   * The order is the route's answer order and it is load-bearing: a caller must not learn from a refusal that
   * a row it may not see exists, so the row's existence, a user row's ownership and the membership of the
   * project all answer the same 404 `memory.notFound` before the row's kind (422) and its status (409) are
   * looked at. Every one of them runs before the approval gate, so a bad target never opens a request.
   *
   * The project this answers is the *gate's* project, and the two kinds resolve it differently. A project note
   * is authorised in its own project — a `projectId` in the body is ignored there, so naming a project the
   * caller administers cannot retire another project's note. A user note has no project of its own (US-004), so
   * the body has to name one, and membership of that project is what authorises the retire (a missing
   * `projectId` is a 400 naming it, which is the one refusal a body-only mistake earns).
   */
  private async resolveNoteRetireTarget(
    principal: KodaPrincipal,
    item: MemoryItem | null,
    bodyProjectId: string | null | undefined,
  ): Promise<{ item: MemoryItem; projectId: string }> {
    // 1. the row exists and is not soft-deleted.
    if (!item || item.deletedAt) throw new NotFoundAppException({}, 'memory.notFound');

    let projectId = item.projectId;
    if (item.scope === MemoryScope.USER) {
      // 2. a user row is the caller's own, or it is nothing this route can see.
      if (item.ownerKey !== memoryOwnerKey({ ownerType: ownerTypeFor(principal), ownerId: principal.id })) {
        throw new NotFoundAppException({}, 'memory.notFound');
      }
      // 3. and the caller names the project that authorises the retire. The body is read here, after the
      // ownership check, so no body value is ever inspected for a row this caller may not see.
      const named = namedProjectId(bodyProjectId);
      if (named === undefined) throw new ValidationAppException({ field: 'projectId' }, 'memory');
      projectId = named;
    }
    // A project row always names its project; a null one could not be authorised in anything.
    if (projectId === null) throw new NotFoundAppException({}, 'memory.notFound');

    // 4. membership of the gate's project, refused as a missing row (as a decision retire refuses it).
    try {
      await this.projectAccess.assertProjectMembership(projectId, principal);
    } catch (error) {
      if (error instanceof ForbiddenAppException) throw new NotFoundAppException({}, 'memory.notFound');
      throw error;
    }

    // 5. only a NOTE retires here — the decision route stays decision-only (and vice versa).
    if (item.kind !== MemoryKind.NOTE) throw new MemoryRetireException(item.kind);
    // 6. and only an active one.
    if (item.status !== 'active') throw new ConflictAppException({}, 'memory.retireNotActive');
    return { item, projectId };
  }

  /**
   * The project a note retire is authorised in, for the handler's gate call: the target's own project for a
   * project note, the body's project for a user note. Nothing is written.
   */
  async retireNoteTarget(
    principal: KodaPrincipal,
    id: string,
    projectId?: string | null,
  ): Promise<{ projectId: string }> {
    const resolved = await this.resolveNoteRetireTarget(principal, await this.repository.findById(id), projectId);
    return { projectId: resolved.projectId };
  }

  /**
   * The `memory.create` half of the note retire route's declaration, enforced where the write happens.
   *
   * The route declares `memory.create` and `memory.update` as service-enforced, and this is not a key the row's
   * owner decides: a caller that may replace a row (`memory.update`, the replace check below) but may not create
   * one in the project must not be able to retire it. The gate answers the same key when the caller asks; this
   * answers it when the write runs, which is what covers a deferred execution — an approved request executes
   * later, as the original requester, so a grant revoked after the proposal cannot execute the retirement.
   *
   * Membership is not re-read here: `resolveNoteRetireTarget`, which ran immediately before, already asked it and
   * answered a refusal as `memory.notFound` (the route's step 4). Routing it through `assertMayWrite` would ask
   * again and answer a membership lost since the ask as a `projects` 403 — telling the caller the row exists.
   */
  private async assertMayCreate(principal: KodaPrincipal, projectId: string): Promise<void> {
    if (!(await this.permissions.can(principal, 'memory.create', { projectId })).allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }
  }

  /**
   * memory-notes US-011: retire a NOTE through `PrismaMemoryItemRepository.retire`, whose transaction locks the
   * row, re-runs the same resolution and audits the retirement before it commits.
   *
   * Re-running the whole resolution inside the lock is what keeps a deferred execution honest: an approved
   * request runs later as the original requester, so the row, its owner and the caller's membership are all
   * read again at the moment of the write — a grant or an ownership that changed after the ask cannot
   * silently authorise the execution. The replace check is the one thing added here rather than preflighted:
   * a project note may only be retired by a principal that may replace it (`memory.update` with its owner as
   * the resource), which a Developer's `memory.update.own` does not grant for someone else's row. A user note
   * is the caller's own by then, so there is no one else's row to ask about.
   *
   * The row becomes `rejected` with a null `activeKey`, and the audit entry is the write's own key —
   * `memory.create`, this route's key — with `retired NOTE` (and the reason) as its summary. A user row has no
   * project of its own, so its entry names the project the body named.
   */
  async retireNote(principal: KodaPrincipal, id: string, projectId?: string | null, reason?: string) {
    return this.repository.retire(id, async (target) => {
      const { item, projectId: gateProject } = await this.resolveNoteRetireTarget(principal, target, projectId);
      // Both declared keys, in the project the resolution just proved the caller is a member of: `memory.create`
      // for the write, `memory.update` for replacing someone else's row. A bad target still answers first, so a
      // 422/409/404 never becomes a permission refusal.
      await this.assertMayCreate(principal, gateProject);
      if (item.scope !== MemoryScope.USER && !(await this.writeGuard.mayReplace(principal, gateProject, item))) {
        throw new ForbiddenAppException({}, 'permissions');
      }
    }, async (item) => {
      await this.audit.record({
        key: 'memory.create', resourceType: 'memory-item', resourceId: item.id,
        projectId: item.projectId ?? namedProjectId(projectId) ?? null,
        summary: reason ? `retired NOTE: ${reason}` : 'retired NOTE',
      });
    });
  }

  async create(principal: KodaPrincipal, input: CreateMemoryDto) {
    await this.assertMayWrite(principal, 'memory.create', input.projectId);

    // US-004: a user-scoped item is a principal's own note — it is stored once, with no project of its own,
    // and read in every project that passes the owner. A triple always belongs to a project (its subject can
    // name a ticket), so the combination is refused here, before anything is read or written. The request's
    // project still authorised the write above: membership, `memory.create` and the approval policy were all
    // checked against it, exactly as for a project write. The refusal names `scope`, not `kind`, because it is
    // the scope that is wrong for that kind of item (US-004 AC-13).
    const scope = input.scope ?? MemoryScope.PROJECT;
    if (scope === MemoryScope.USER && input.kind !== MemoryKind.NOTE) {
      throw new ValidationAppException({ field: 'scope' }, 'memory');
    }
    const userScoped = scope === MemoryScope.USER;

    // H12: DECISION items carry agent attribution in their subject; they must
    // go through recordDecision, which forces non-admin callers to record as
    // themselves. The generic route can no longer be used to forge them.
    if (input.kind === MemoryKind.DECISION) {
      throw new ValidationAppException({ field: 'kind' }, 'memory');
    }

    // US-001: a NOTE is validated by the same pure check the assistant tool calls, before anything is read
    // or written, and the refusal names the field (`memory.-2` renders it). Every other kind is refused when
    // it carries a description, which only a note has.
    const noteField = noteFieldError({
      kind: input.kind,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      description: input.description,
    });
    if (noteField) throw new ValidationAppException({ field: noteField }, 'memory');

    // H12: only a global-grant holder may attribute a memory item to an arbitrary owner; every other caller
    // always owns what they write, so a compromised agent/user cannot plant memories under someone else's
    // identity. An item attributed to someone else records no owner type: which table that id names is
    // unknown, so it stays an any-row holder's to replace.
    //
    // US-004: a user-scoped item is owned by the principal that wrote it, always — an `ownerId` in the body
    // is ignored there even for a global admin, because a user note is the caller's own working agreement.
    const ownerId = !userScoped && (await this.mayAttribute(principal)) && input.ownerId ? input.ownerId : principal.id;

    return this.write(principal, 'memory.create', input.projectId, {
      ownerId,
      ownerType: ownerId === principal.id ? ownerTypeFor(principal) : null,
    }, {
      projectId: userScoped ? null : input.projectId,
      kind: input.kind,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      description: input.description,
      scope,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId,
      confidence: input.confidence ?? 0.8,
    });
  }
}

/**
 * The project a note retire body names, or undefined when it names none.
 *
 * A blank value is no name: the DTO accepts any string (the pipe's contract is the shared one), so `''` is
 * answered as a missing `projectId` rather than looked up as a project id. `null` is no name either — the DTO
 * is `@IsOptional()`, which lets an explicit `null` through validation exactly as it lets an absent field
 * through, so it has to mean "absent" here rather than reach `trim()`.
 */
function namedProjectId(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && value.trim().length > 0 ? value : undefined;
}
