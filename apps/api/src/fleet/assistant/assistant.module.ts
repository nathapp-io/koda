import { Module } from '@nestjs/common';
import { CommentsModule } from '../../comments/comments.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { TicketLinksModule } from '../../ticket-links/ticket-links.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { ASSISTANT_TOOL_CALL_REPOSITORY } from './assistant-tool-call.domain';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { PrismaAssistantToolCallRepository } from './prisma-assistant-tool-call.repository';
import { TicketTools } from './tools/ticket-tools';

/** Fleet S5b: the API-owned koda tools a THREAD session calls through the runner. Tool groups join as providers. */
@Module({
  imports: [ProjectAccessModule, TicketsModule, CommentsModule, TicketLinksModule],
  providers: [
    AssistantToolRegistry,
    PrismaAssistantToolCallRepository,
    { provide: ASSISTANT_TOOL_CALL_REPOSITORY, useExisting: PrismaAssistantToolCallRepository },
    AssistantToolExecutor,
    TicketTools,
  ],
  exports: [AssistantToolRegistry, AssistantToolExecutor],
})
export class AssistantModule {}
