import { Module } from '@nestjs/common';
import { ProjectAccessModule } from '../projects/project-access.module';
import { ApprovalEngineModule } from './approval-engine.module';
import { ApprovalRequestsController } from './approval-requests.controller';

@Module({
  imports: [ApprovalEngineModule, ProjectAccessModule],
  controllers: [ApprovalRequestsController],
})
export class ApprovalApiModule {}
