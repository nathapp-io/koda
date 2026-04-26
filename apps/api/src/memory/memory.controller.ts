import { Controller, Post, Get, Body, Query, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, CurrentActor } from '../auth/decorators/current-user.decorator';
import { ExtractionService, WriteResult } from './extraction.service';
import { MemoryItemRepository } from './memory-item-repository';
import { MemoryKind, ActorRole } from '../common/enums';

interface MemoryWriteInput {
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  sourceType?: string;
  sourceId?: string;
  confidence?: number;
  ownerId?: string;
}

interface CurrentUser {
  id?: string;
  sub?: string;
  extra?: {
    sub?: string;
    email?: string;
    role?: string;
    actorType?: string;
  };
  actorType?: string;
}

@ApiTags('memory')
@ApiBearerAuth()
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly extractionService: ExtractionService,
    private readonly repository: MemoryItemRepository,
  ) {}

  @Post('extract')
  @ApiOperation({ summary: 'Extract memory items from a canonical event (internal)' })
  @ApiResponse({ status: 201, description: 'Memory items extracted' })
  async extractFromEvent(@Body() event: Record<string, unknown>, @CurrentUser() currentUser?: CurrentUser | null, @CurrentActor() actor?: { actorType?: string } | null) {
    const projectId = event.projectId as string | undefined;
    if (!projectId) {
      return { items: [] };
    }

    const role = currentUser?.extra?.role ?? (actor?.actorType === 'agent' ? 'AGENT' : null);
    const allowedRoles: readonly string[] = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT];
    if (!role || !allowedRoles.includes(role)) {
      return { items: [] };
    }

    const items = this.extractionService.extractFromEvent(event as unknown as Parameters<typeof this.extractionService.extractFromEvent>[0]);

    for (const item of items) {
      const input: Parameters<MemoryItemRepository['upsert']>[0] = {
        projectId: item.projectId,
        kind: item.kind,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        sourceType: item.sourceType ?? (event.type as string),
        sourceId: item.sourceId ?? (event.id as string),
        confidence: item.confidence,
        ownerId: (event.actorId as string) ?? currentUser?.extra?.sub,
      };
      await this.repository.upsert(input);
    }

    return { items };
  }

  @Post('decisions')
  @ApiOperation({ summary: 'Record a decision' })
  @ApiResponse({ status: 201, description: 'Decision recorded' })
  async recordDecision(
    @Body() decision: { projectId: string; actorId: string; topic: string; decision: string; rationale?: string; sourceId?: string },
    @CurrentUser() currentUser?: CurrentUser | null,
  ): Promise<WriteResult> {
    return this.extractionService.recordDecision(
      {
        projectId: decision.projectId,
        actorId: decision.actorId,
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
  async createMemory(@Body() input: MemoryWriteInput, @CurrentUser() currentUser?: CurrentUser | null) {
    const role = currentUser?.extra?.role ?? null;
    const allowedRoles: readonly string[] = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT];
    if (!role || !allowedRoles.includes(role)) {
      return { error: 'ACCESS_DENIED' };
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
      ownerId: input.ownerId ?? currentUser?.extra?.sub,
    });

    return memory;
  }
}