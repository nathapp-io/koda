import { Module } from '@nestjs/common';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { ApprovalEngineModule } from './approval-engine.module';
import { ApprovalRequestsController } from './approval-requests.controller';
import { ApprovalPoliciesController } from './approval-policies.controller';
import { ProjectApprovalPoliciesController } from './project-approval-policies.controller';
import { ApprovalRouteCommands } from './approval-route.commands';

@Module({
  imports: [ApprovalEngineModule, ProjectAccessModule, AuthRepositoryModule],
  controllers: [ApprovalRequestsController, ApprovalPoliciesController, ProjectApprovalPoliciesController],
  providers: [ApprovalRouteCommands],
})
export class ApprovalApiModule {}
