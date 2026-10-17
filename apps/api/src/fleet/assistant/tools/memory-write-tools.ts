import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { addMemoryTool } from './add-memory-tool';

/**
 * Fleet S5b 2b1 US-006 (2b1-D8): the memory write tool group — the tools that propose a durable knowledge item of the
 * thread's project and store it on approval. It registers with the registry at bootstrap, like the other groups;
 * `koda_record_decision` (US-007) joins it here.
 */
@Injectable()
export class MemoryWriteTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly memory: PrismaMemoryItemRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(addMemoryTool({ memory: this.memory }));
  }
}
