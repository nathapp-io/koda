import { Module } from '@nestjs/common';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { PrismaLabelRepository } from './prisma-label.repository';
import { LABEL_REPOSITORY } from './domain/label.domain';

@Module({
  controllers: [LabelsController],
  providers: [
    PrismaLabelRepository,
    { provide: LABEL_REPOSITORY, useExisting: PrismaLabelRepository },
    LabelsService,
  ],
  exports: [LabelsService],
})
export class LabelsModule {}
