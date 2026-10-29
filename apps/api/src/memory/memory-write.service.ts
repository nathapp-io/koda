import { Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ExtractionService, WriteResult } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';
import { MemoryKind } from '../common/enums';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { MemoryReplaceRefusedError, MemoryWriteGuard, ownerTypeFor } from './memory-write.guard';
import { memoryAuditHook, type MemoryAuditKey } from './memory-audit';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { CreateMemoryDto } from './dto/create-memory.dto';
import { ExtractEventDto } from './dto/extract-event.dto';

/** `memory.update`: holding it without a project is the global grant that lets a caller attribute a write. */
const ATTRIBUTE_KEY = 'memory.update';

/**
 * The three memory write routes (permissions P1 US-008).
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
          onWritten: memoryAuditHook(this.audit, key),
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

  async create(principal: KodaPrincipal, input: CreateMemoryDto) {
    await this.assertMayWrite(principal, 'memory.create', input.projectId);

    // H12: DECISION items carry agent attribution in their subject; they must
    // go through recordDecision, which forces non-admin callers to record as
    // themselves. The generic route can no longer be used to forge them.
    if (input.kind === MemoryKind.DECISION) {
      throw new ValidationAppException(
        { kind: 'DECISION memory items must be recorded via POST /memory/decisions' },
        'memory',
      );
    }

    // H12: only a global-grant holder may attribute a memory item to an arbitrary owner; every other caller
    // always owns what they write, so a compromised agent/user cannot plant memories under someone else's
    // identity. An item attributed to someone else records no owner type: which table that id names is
    // unknown, so it stays an any-row holder's to replace.
    const ownerId = (await this.mayAttribute(principal)) && input.ownerId ? input.ownerId : principal.id;

    return this.write(principal, 'memory.create', input.projectId, {
      ownerId,
      ownerType: ownerId === principal.id ? ownerTypeFor(principal) : null,
    }, {
      projectId: input.projectId,
      kind: input.kind,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId,
      confidence: input.confidence ?? 0.8,
    });
  }
}
