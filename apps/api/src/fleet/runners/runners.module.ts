import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { EnrollmentsController } from './enrollments.controller';
import { RunnerApiController } from './runner-api.controller';
import { EnrollmentService } from './enrollment.service';
import { PrismaRunnerRepository } from './prisma-runner.repository';
import { RUNNER_REPOSITORY } from './domain/runner.domain';

@Module({
  imports: [PrismaModule, FleetActivityModule],
  controllers: [EnrollmentsController, RunnerApiController],
  providers: [PrismaRunnerRepository, { provide: RUNNER_REPOSITORY, useExisting: PrismaRunnerRepository }, EnrollmentService],
  exports: [RUNNER_REPOSITORY],
})
export class RunnersModule {}
