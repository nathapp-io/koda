import { Module } from '@nestjs/common';
import { CommentsModule } from '../../comments/comments.module';
import { MemoryModule } from '../../memory/memory.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { TicketLinksModule } from '../../ticket-links/ticket-links.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { LogsModule } from '../logs/logs.module';
import { RunnersModule } from '../runners/runners.module';
import { SyncModule } from '../sync/sync.module';
import { ASSISTANT_TOOL_CALL_REPOSITORY } from './assistant-tool-call.domain';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { PrismaAssistantToolCallRepository } from './prisma-assistant-tool-call.repository';
import { RunnerToolController } from './runner-tool.controller';
import { RunnerToolService } from './runner-tool.service';
import { FleetTools } from './tools/fleet-tools';
import { KnowledgeTools } from './tools/knowledge-tools';
import { TicketTools } from './tools/ticket-tools';

/** Fleet S5b: the API-owned koda tools a THREAD session calls through the runner. Tool groups join as providers. */
@Module({
  imports: [
    ProjectAccessModule, TicketsModule, CommentsModule, TicketLinksModule,
    // US-004: the services the fleet read tools call (each module exports its service only).
    FleetJobsModule, AnalyticsModule, ApprovalsModule, RunnersModule, LogsModule,
    // US-005: the runner tool route fences through the sync module's FenceService (1b-D8).
    SyncModule,
    // US-004: the memory read tool's service. No cycle: nothing reachable from MemoryModule imports a fleet module.
    MemoryModule,
  ],
  controllers: [RunnerToolController],
  providers: [
    AssistantToolRegistry,
    PrismaAssistantToolCallRepository,
    { provide: ASSISTANT_TOOL_CALL_REPOSITORY, useExisting: PrismaAssistantToolCallRepository },
    AssistantToolExecutor,
    RunnerToolService,
    TicketTools,
    FleetTools,
    KnowledgeTools,
  ],
  exports: [AssistantToolRegistry, AssistantToolExecutor],
})
export class AssistantModule {}
