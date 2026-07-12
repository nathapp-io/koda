import { Controller, Post, Get, Body, Query, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ExtractionService, WriteResult } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';
import { ActorRole } from '../common/enums';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { CreateMemoryDto } from './dto/create-memory.dto';

const MEMORY_WRITE_ROLES: readonly string[] = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT];

function principalRole(principal: KodaPrincipal): string | null {
  return isAgentPrincipal(principal)
    ? 'AGENT'
    : (isUserPrincipal(principal) ? principal.role : null);
}

@ApiTags('memory')
@ApiBearerAuth()
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly extractionService: ExtractionService,
    private readonly repository: PrismaMemoryItemRepository,
  ) {}

  @Post('extract')
  @ApiOperation({ summary: 'Extract memory items from a canonical event (internal)' })
  @ApiResponse({ status: 201, description: 'Memory items extracted' })
  async extractFromEvent(@Body() event: Record<string, unknown>, @Principal() principal: KodaPrincipal) {
    const projectId = event.projectId as string | undefined;
    if (!projectId) {
      return { items: [] };
    }

    const role = principalRole(principal);
    if (!role || !MEMORY_WRITE_ROLES.includes(role)) {
      return { items: [] };
    }

    const items = this.extractionService.extractFromEvent(event as unknown as Parameters<typeof this.extractionService.extractFromEvent>[0]);

    for (const item of items) {
      const input: MemoryItemInput = {
        projectId: item.projectId,
        kind: item.kind,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        sourceType: item.sourceType ?? (event.type as string),
        sourceId: item.sourceId ?? (event.id as string),
        confidence: item.confidence,
        ownerId: (event.actorId as string) ?? principal.id,
      };
      await this.repository.upsert(input);
    }

    return { items };
  }

  @Post('decisions')
  @ApiOperation({ summary: 'Record a decision' })
  @ApiResponse({ status: 201, description: 'Decision recorded' })
  async recordDecision(
    @Body() decision: RecordDecisionDto,
    @Principal() principal: KodaPrincipal,
  ): Promise<WriteResult> {
    const role = principalRole(principal);
    if (!role || !MEMORY_WRITE_ROLES.includes(role)) {
      throw new ForbiddenAppException({}, 'memory');
    }

    // Only admins may attribute a decision to an arbitrary actor; every other
    // caller can only record decisions as themselves, so a non-admin can't
    // spoof another user/agent's decision history.
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
  async createMemory(@Body() input: CreateMemoryDto, @Principal() principal: KodaPrincipal) {
    const role = principalRole(principal);
    if (!role || !MEMORY_WRITE_ROLES.includes(role)) {
      throw new ForbiddenAppException({}, 'memory');
    }

    const memory = await this.repository.upsert({
      projectId: input.projectId,
      kind: input.kind,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId,
      confidence: input.confidence ?? 0.8,
      ownerId: input.ownerId ?? principal.id,
    });

    return memory;
  }
}