import { Module } from '@nestjs/common';
import { CommentsModule } from '../../comments/comments.module';
import { MemoryModule } from '../../memory/memory.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { ProjectsModule } from '../../projects/projects.module';
import { TicketLinksModule } from '../../ticket-links/ticket-links.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { LiveModule } from '../../live/live.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ApprovalStoreModule } from '../approvals/approval-store.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LogsModule } from '../logs/logs.module';
import { RunnersModule } from '../runners/runners.module';
import { SyncModule } from '../sync/sync.module';
import { AssistantActionDecisions } from './actions/assistant-action-decisions';
import { AssistantActionService } from './actions/assistant-action.service';
import { PENDING_ACTION_REPOSITORY } from './actions/pending-action.domain';
import { PrismaPendingActionRepository } from './actions/prisma-pending-action.repository';
import { ASSISTANT_TOOL_CALL_REPOSITORY, PROJECT_COUNTS_READER } from './assistant-tool-call.domain';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { PrismaAssistantToolCallRepository } from './prisma-assistant-tool-call.repository';
import { RunnerToolController } from './runner-tool.controller';
import { RunnerToolService } from './runner-tool.service';
import { ActionTools } from './tools/action-tools';
import { FleetTools } from './tools/fleet-tools';
import { KnowledgeTools } from './tools/knowledge-tools';
import { TicketTools } from './tools/ticket-tools';
import { WorkspaceTools } from './tools/workspace-tools';

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
    // US-006: the documentation tools read the project's knowledge index and its indexed chunks (1c-c-D13).
    KnowledgeModule,
    // US-003: `koda_my_projects` reaches its projects through ProjectsService (already in this graph via
    // MemoryModule); the import is what makes the service injectable here.
    ProjectsModule,
    // S5b 2a: the propose service publishes on ThreadEventBus (LiveModule) and opens its summary approval
    // through ApprovalCloser (ApprovalStoreModule, one shared instance for both importers — 2a-D1).
    LiveModule, ApprovalStoreModule,
  ],
  controllers: [RunnerToolController],
  providers: [
    AssistantToolRegistry,
    PrismaAssistantToolCallRepository,
    { provide: ASSISTANT_TOOL_CALL_REPOSITORY, useExisting: PrismaAssistantToolCallRepository },
    // 1d2-D7: the same repository answers the workspace tool's counts through its own interface.
    { provide: PROJECT_COUNTS_READER, useExisting: PrismaAssistantToolCallRepository },
    AssistantToolExecutor,
    RunnerToolService,
    TicketTools,
    FleetTools,
    KnowledgeTools,
    WorkspaceTools,
    // S5b 2a US-003: the pilot write tool and the scoped action read. It registers on init, like the other groups.
    ActionTools,
    // S5b 2a US-001: propose storage. The repository stays module-private behind its token.
    PrismaPendingActionRepository,
    { provide: PENDING_ACTION_REPOSITORY, useExisting: PrismaPendingActionRepository },
    AssistantActionService,
    // S5b 2a US-005: the creator-only decide handler; it registers with AssistantActionPort on init (2a-D1).
    AssistantActionDecisions,
  ],
  exports: [AssistantToolRegistry, AssistantToolExecutor],
})
export class AssistantModule {}
