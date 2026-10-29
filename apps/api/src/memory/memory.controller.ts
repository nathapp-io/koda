import { Controller, Post, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { Requires } from '../permissions/requires.decorator';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { CreateMemoryDto } from './dto/create-memory.dto';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { ExtractEventDto } from './dto/extract-event.dto';
import { MemoryWriteService } from './memory-write.service';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { MEMORY_ROUTE_VARIANTS } from './memory-route.commands';
import { JsonResponse } from '@nathapp/nestjs-common';

@ApiTags('memory')
@ApiBearerAuth()
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly memoryWrites: MemoryWriteService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Post('extract')
  @ApprovalGated()
  @Requires('memory.extract', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Extract memory items from a canonical event (memory.extract)' })
  @ApiResponse({ status: 201, description: 'Memory items extracted' })
  @ApiResponse({ status: 403, description: 'memory.extract is missing, or an extracted item may not replace its active item' })
  @ApiResponse({ status: 404, description: 'A named ticket does not belong to the event\'s project' })
  async extractFromEvent(@Body() event: ExtractEventDto, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<Awaited<ReturnType<MemoryWriteService['extract']>>>({
      key: 'memory.extract', variant: MEMORY_ROUTE_VARIANTS.extract, projectId: event.projectId,
      input: { event },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post('decisions')
  @ApprovalGated()
  @Requires(['memory.decision.record', 'memory.update'], { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Record a decision (memory.decision.record)' })
  @ApiResponse({ status: 201, description: 'Decision recorded' })
  @ApiResponse({ status: 403, description: 'memory.decision.record is missing, or it may not replace its active decision' })
  async recordDecision(@Body() decision: RecordDecisionDto, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<Awaited<ReturnType<MemoryWriteService['recordDecision']>>>({
      key: 'memory.decision.record', variant: MEMORY_ROUTE_VARIANTS.recordDecision, projectId: decision.projectId,
      input: { decision },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post()
  @ApprovalGated()
  @Requires(['memory.create', 'memory.update'], { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Create a memory item (memory.create)' })
  @ApiResponse({ status: 201, description: 'Memory item created' })
  @ApiResponse({ status: 403, description: 'memory.create is missing, or the item may not replace its active item' })
  async createMemory(@Body() input: CreateMemoryDto, @Principal() principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<Awaited<ReturnType<MemoryWriteService['create']>>>({
      key: 'memory.create', variant: MEMORY_ROUTE_VARIANTS.create, projectId: input.projectId,
      input: { memory: input },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
