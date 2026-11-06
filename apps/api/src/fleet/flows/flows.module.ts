import { Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { AuditLogModule } from '../../audit/audit-log.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetReposModule } from '../repos/fleet-repos.module';
import { ThreadsModule } from '../threads/threads.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { PrismaFleetFlowRepository } from './prisma-fleet-flow.repository';
import { FLEET_FLOW_REPOSITORY } from './domain/fleet-flow.domain';
import { FleetFlowStartCommand } from './fleet-flow-start.command';
import { FleetFlowsService } from './fleet-flows.service';
import { FleetFlowPublishListener } from './fleet-flow-publish.listener';
import { ThreadPreApprovalController } from './thread-preapproval.controller';
import { ThreadFlowsController } from './thread-flows.controller';
import { FlowRouteCommands } from './flow-route.commands';
import { FleetFlowsController } from './fleet-flows.controller';
import { ProjectFlowsController } from './project-flows.controller';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { ProjectsModule } from '../../projects/projects.module';

@Module({
  controllers: [ThreadPreApprovalController, ThreadFlowsController, FleetFlowsController, ProjectFlowsController],
  // ThreadsModule owns the thread-entry guards (`lockForFlow`); FleetReposModule owns the repo row lock
  // the nax entry serialises on; ApprovalEngineModule owns the ask both entries open.
  imports: [ApprovalEngineModule, AuthRepositoryModule, AuditLogModule, FleetActivityModule, FleetReposModule, GitBrokerModule, ProjectsModule, ProjectAccessModule, ThreadsModule, PrismaModule],
  providers: [
    PrismaFleetFlowRepository,
    { provide: FLEET_FLOW_REPOSITORY, useExisting: PrismaFleetFlowRepository },
    FleetFlowStartCommand,
    FlowRouteCommands,
    FleetFlowsService,
    FleetFlowPublishListener,
  ],
  exports: [FleetFlowsService],
})
export class FlowsModule implements OnModuleInit {
  constructor(private readonly registry: ApprovalCommandRegistry, private readonly start: FleetFlowStartCommand) {}

  onModuleInit(): void {
    if (!this.registry.get(this.start.key)) this.registry.register(this.start);
  }
}
