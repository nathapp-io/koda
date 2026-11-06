import { Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuditLogModule } from '../../audit/audit-log.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { PrismaFleetFlowRepository } from './prisma-fleet-flow.repository';
import { FLEET_FLOW_REPOSITORY } from './domain/fleet-flow.domain';
import { FleetFlowStartCommand } from './fleet-flow-start.command';

@Module({
  imports: [ApprovalEngineModule, AuditLogModule, FleetActivityModule, PrismaModule],
  providers: [
    PrismaFleetFlowRepository,
    { provide: FLEET_FLOW_REPOSITORY, useExisting: PrismaFleetFlowRepository },
    FleetFlowStartCommand,
  ],
})
export class FlowsModule implements OnModuleInit {
  constructor(private readonly registry: ApprovalCommandRegistry, private readonly start: FleetFlowStartCommand) {}

  onModuleInit(): void {
    if (!this.registry.get(this.start.key)) this.registry.register(this.start);
  }
}
