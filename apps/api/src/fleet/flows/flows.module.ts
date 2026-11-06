import { Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuditLogModule } from '../../audit/audit-log.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { ThreadsModule } from '../threads/threads.module';
import { PrismaFleetFlowRepository } from './prisma-fleet-flow.repository';
import { FLEET_FLOW_REPOSITORY } from './domain/fleet-flow.domain';
import { FleetFlowStartCommand } from './fleet-flow-start.command';
import { FleetFlowsService } from './fleet-flows.service';

@Module({
  // ThreadsModule owns the thread-entry guards (`lockForFlow`); FleetReposModule owns the repo row lock
  // the nax entry serialises on; ApprovalEngineModule owns the ask both entries open.
  imports: [ApprovalEngineModule, AuditLogModule, FleetActivityModule, FleetReposModule, ThreadsModule, PrismaModule],
  providers: [
    PrismaFleetFlowRepository,
    { provide: FLEET_FLOW_REPOSITORY, useExisting: PrismaFleetFlowRepository },
    FleetFlowStartCommand,
    FleetFlowsService,
  ],
  exports: [FleetFlowsService],
})
export class FlowsModule implements OnModuleInit {
  constructor(private readonly registry: ApprovalCommandRegistry, private readonly start: FleetFlowStartCommand) {}

  onModuleInit(): void {
    if (!this.registry.get(this.start.key)) this.registry.register(this.start);
  }
}
