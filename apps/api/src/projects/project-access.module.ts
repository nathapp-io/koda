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
    // Must stay exported: ProjectMembershipGuard's KodaCaslAbilityFactory
    // dependency is @Optional(). When a host module (e.g. LabelsModule) has no
    // resolvable KodaCaslAbilityFactory token, Nest instantiates a second guard
    // with `undefined` and every @ProjectPermission route fails closed with 403
    // (e2e: label creation as global admin).
    KodaCaslAbilityFactory,
  ],
})
export class ProjectAccessModule {}
