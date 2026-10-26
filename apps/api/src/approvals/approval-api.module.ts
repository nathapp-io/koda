import { Module } from '@nestjs/common';
import { ProjectAccessModule } from '../projects/project-access.module';
import { ApprovalEngineModule } from './approval-engine.module';
import { ApprovalRequestsController } from './approval-requests.controller';
import { ApprovalPoliciesController } from './approval-policies.controller';

@Module({
  imports: [ApprovalEngineModule, ProjectAccessModule],
  controllers: [ApprovalRequestsController, ApprovalPoliciesController],
})
export class ApprovalApiModule {}
