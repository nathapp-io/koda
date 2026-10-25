import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExtractionService } from '../../../memory/extraction.service';
import { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import { MemoryWriteGuard } from '../../../memory/memory-write.guard';
import { AuditRecorder } from '../../../audit/audit-recorder.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { addMemoryTool } from './add-memory-tool';
import { recordDecisionTool } from './record-decision-tool';

/**
 * Fleet S5b 2b1 US-006 (2b1-D8): the memory write tool group — the tools that propose a durable knowledge item of the
 * thread's project and store it on approval. It registers with the registry at bootstrap, like the other groups;
 * `koda_record_decision` (US-007) joins it here, because a decision is a memory item too but goes through
 * `ExtractionService` so its subject is the requester.
 *
 * Permissions P1 US-008: both tools take `MemoryWriteGuard` — the same replace check the REST write routes run — so a
 * proposal that would supersede another principal's item is refused in the preview, and an approval that a concurrent
 * write forbade is refused inside the store.
 *
 * Permissions P2 US-003: both tools also take the `AuditRecorder`, so the write each one makes records one entry
 * under that tool's own key. The recorder is passed in rather than reached for, the same way the REST routes take it.
 */
@Injectable()
export class MemoryWriteTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly memory: PrismaMemoryItemRepository,
    private readonly extraction: ExtractionService,
    private readonly guard: MemoryWriteGuard,
    private readonly audit: AuditRecorder,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      addMemoryTool({ memory: this.memory, guard: this.guard, audit: this.audit }),
      recordDecisionTool({ memory: this.memory, extraction: this.extraction, guard: this.guard, audit: this.audit }),
    );
  }
}
