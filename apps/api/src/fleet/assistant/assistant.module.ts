import { Module } from '@nestjs/common';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { ASSISTANT_TOOL_CALL_REPOSITORY } from './assistant-tool-call.domain';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { PrismaAssistantToolCallRepository } from './prisma-assistant-tool-call.repository';

/** Fleet S5b: the API-owned koda tools a THREAD session calls through the runner. Tool groups join as providers. */
@Module({
  imports: [ProjectAccessModule],
  providers: [
    AssistantToolRegistry,
    PrismaAssistantToolCallRepository,
    { provide: ASSISTANT_TOOL_CALL_REPOSITORY, useExisting: PrismaAssistantToolCallRepository },
    AssistantToolExecutor,
  ],
  exports: [AssistantToolRegistry, AssistantToolExecutor],
})
export class AssistantModule {}
