import { ActionTools } from '../tools/action-tools';
import { TicketWriteTools } from '../tools/ticket-write-tools';
import { FleetWriteTools } from '../tools/fleet-write-tools';
import { MemoryWriteTools } from '../tools/memory-write-tools';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../../approvals/approval-command.registry';
import { PermissionService } from '../../../permissions/permission.service';
import { ProjectAccessService } from '../../../projects/project-access.service';
import { ASSISTANT_TOOL_CALL_REPOSITORY, type AssistantToolCallRepository } from '../assistant-tool-call.domain';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { assistantToolCommand } from './assistant-tool.command';

/** Registered after the tool groups so their lifecycle registrations are available. */
@Injectable()
export class AssistantToolCommands implements OnModuleInit {
  constructor(
    private readonly tools: AssistantToolRegistry,
    private readonly commands: ApprovalCommandRegistry,
    @Inject(ASSISTANT_TOOL_CALL_REPOSITORY) private readonly calls: AssistantToolCallRepository,
    private readonly access: ProjectAccessService,
    private readonly permissions: PermissionService,
    // Nest 12 orders lifecycle hooks by dependency level, not just provider-array position.
    // These dependencies ensure all four write-tool groups have registered before this hook runs.
    _actionTools: ActionTools,
    _ticketTools: TicketWriteTools,
    _fleetTools: FleetWriteTools,
    _memoryTools: MemoryWriteTools,
  ) {}
  onModuleInit(): void {
    for (const tool of this.tools.list()) {
      if (tool.kind === 'write') this.commands.register(assistantToolCommand(tool, { calls: this.calls, access: this.access, permissions: this.permissions }));
    }
  }
}
