import { Controller, Post, Get, Body, Query, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ExtractionService, WriteResult } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';
import { ActorRole, MemoryKind } from '../common/enums';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ProjectAccessService } from '../projects/project-access.service';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { CreateMemoryDto } from './dto/create-memory.dto';
import { ExtractEventDto } from './dto/extract-event.dto';

function principalRole(principal: KodaPrincipal): string | null {
  return isAgentPrincipal(principal)
    ? ActorRole.AGENT
    : (isUserPrincipal(principal) ? principal.role : null);
}

@ApiTags('memory')
@ApiBearerAuth()
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly extractionService: ExtractionService,
    private readonly repository: PrismaMemoryItemRepository,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  private async assertWriteAuthorized(
    projectId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    if (!isUserPrincipal(principal) && !isAgentPrincipal(principal)) {
      throw new ForbiddenAppException({}, 'memory');
    }
    // Agents qualify as today. For users, assertProjectMembership lets global
    // admins through and requires a ProjectMember row (any role) for everyone
    // else — the previous MEMORY_WRITE_ROLES check compared the GLOBAL role,
    // locking out users whose write access was only granted at project level.
    // It also closes the cross-project write path (member of project A writing
    // to project B).
    await this.projectAccess.assertProjectMembership(projectId, principal);
  }

  @Post('extract')
  @ApiOperation({ summary: 'Extract memory items from a canonical event (internal)' })
  @ApiResponse({ status: 201, description: 'Memory items extracted' })
  async extractFromEvent(@Body() event: ExtractEventDto, @Principal() principal: KodaPrincipal) {
    const projectId = event.projectId;
    if (!projectId) {
      return { items: [] };
    }

    await this.assertWriteAuthorized(projectId, principal);

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

    for (const item of persisted) {
      const input: MemoryItemInput = {
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
        ownerId: principal.id,
      };
      await this.repository.upsert(input);
    }

    return { items: persisted };
  }

  @Post('decisions')
  @ApiOperation({ summary: 'Record a decision' })
  @ApiResponse({ status: 201, description: 'Decision recorded' })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  async recordDecision(
    @Body() decision: RecordDecisionDto,
    @Principal() principal: KodaPrincipal,
  ): Promise<WriteResult> {
    await this.assertWriteAuthorized(decision.projectId, principal);

    // Only admins may attribute a decision to an arbitrary actor; every other
    // caller can only record decisions as themselves, so a non-admin can't
    // spoof another user/agent's decision history.
    const role = principalRole(principal);
    const actorId = role === ActorRole.ADMIN && decision.actorId ? decision.actorId : principal.id;

    return this.extractionService.recordDecision(
      {
        projectId: decision.projectId,
        actorId,
        topic: decision.topic,
        decision: decision.decision,
        rationale: decision.rationale,
        sourceId: decision.sourceId,
      },
      this.repository,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a memory item' })
  @ApiResponse({ status: 201, description: 'Memory item created' })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  async createMemory(@Body() input: CreateMemoryDto, @Principal() principal: KodaPrincipal) {
    await this.assertWriteAuthorized(input.projectId, principal);

    // H12: DECISION items carry agent attribution in their subject; they must
    // go through recordDecision, which forces non-admin callers to record as
    // themselves. The generic route can no longer be used to forge them.
    if (input.kind === MemoryKind.DECISION) {
      throw new ValidationAppException(
        { kind: 'DECISION memory items must be recorded via POST /memory/decisions' },
        'memory',
      );
    }

    // H12: only global admins may attribute a memory item to an arbitrary
    // owner; every other caller always owns what they write, so a compromised
    // agent/user cannot plant memories under someone else's identity.
    const isGlobalAdmin = isUserPrincipal(principal) && principal.role === ActorRole.ADMIN;
    const ownerId = isGlobalAdmin ? (input.ownerId ?? principal.id) : principal.id;

    const memory = await this.repository.upsert({
      projectId: input.projectId,
      kind: input.kind,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId,
      confidence: input.confidence ?? 0.8,
      ownerId,
    });

    return memory;
  }
}
