import { Controller, Post, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { Requires } from '../permissions/requires.decorator';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { CreateMemoryDto } from './dto/create-memory.dto';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { ExtractEventDto } from './dto/extract-event.dto';
import { MemoryWriteService } from './memory-write.service';

@ApiTags('memory')
@ApiBearerAuth()
@Controller('memory')
export class MemoryController {
  constructor(private readonly memoryWrites: MemoryWriteService) {}

  @Post('extract')
  @Requires('memory.extract', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Extract memory items from a canonical event (memory.extract)' })
  @ApiResponse({ status: 201, description: 'Memory items extracted' })
  @ApiResponse({ status: 403, description: 'memory.extract is missing, or an extracted item may not replace its active item' })
  @ApiResponse({ status: 404, description: 'A named ticket does not belong to the event\'s project' })
  async extractFromEvent(@Body() event: ExtractEventDto, @Principal() principal: KodaPrincipal) {
    return this.memoryWrites.extract(principal, event);
  }

  @Post('decisions')
  @Requires(['memory.decision.record', 'memory.update'], { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Record a decision (memory.decision.record)' })
  @ApiResponse({ status: 201, description: 'Decision recorded' })
  @ApiResponse({ status: 403, description: 'memory.decision.record is missing, or it may not replace its active decision' })
  async recordDecision(@Body() decision: RecordDecisionDto, @Principal() principal: KodaPrincipal) {
    return this.memoryWrites.recordDecision(principal, decision);
  }

  @Post()
  @Requires(['memory.create', 'memory.update'], { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Create a memory item (memory.create)' })
  @ApiResponse({ status: 201, description: 'Memory item created' })
  @ApiResponse({ status: 403, description: 'memory.create is missing, or the item may not replace its active item' })
  async createMemory(@Body() input: CreateMemoryDto, @Principal() principal: KodaPrincipal) {
    return this.memoryWrites.create(principal, input);
  }
}
