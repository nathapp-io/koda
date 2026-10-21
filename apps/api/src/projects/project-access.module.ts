import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessService } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { PROJECT_REPOSITORY } from './domain/project.domain';
import { ProjectMembershipGuard } from './project-membership.guard';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';

@Module({
  imports: [PrismaModule],
  providers: [
    ProjectAccessService,
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    KodaCaslAbilityFactory,
    ProjectMembershipGuard,
  ],
  exports: [
    ProjectAccessService,
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    ProjectMembershipGuard,
    // Kept registered and exported for the remaining `@Optional()` consumer
    // (TicketTransitionsService). Permissions P1 US-004 removed the guard's own
    // dependency on it, and US-005 deletes the factory with its last consumer.
    KodaCaslAbilityFactory,
  ],
})
export class ProjectAccessModule {}
