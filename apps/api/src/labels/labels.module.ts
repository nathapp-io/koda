import { LabelRouteCommands } from './label-route.commands';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { Module } from '@nestjs/common';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { PrismaLabelRepository } from './prisma-label.repository';
import { LABEL_REPOSITORY } from './domain/label.domain';
import { ProjectAccessModule } from '../projects/project-access.module';

@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, ProjectAccessModule],
  controllers: [LabelsController],
  providers: [
    LabelRouteCommands,
    PrismaLabelRepository,
    { provide: LABEL_REPOSITORY, useExisting: PrismaLabelRepository },
    LabelsService,
  ],
  exports: [LabelsService],
})
export class LabelsModule {}
