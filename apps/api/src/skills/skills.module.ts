import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../projects/project-access.module';
import { GitBrokerModule } from '../fleet/git-broker/git-broker.module';
import { AdminSkillsController } from './admin-skills.controller';
import { ProjectSkillsController } from './project-skills.controller';
import { GitHubSkillResolver } from './github-skill-resolver';
import { PrismaSkillCatalogRepository } from './prisma-skill-catalog.repository';
import { SKILL_CATALOG_REPOSITORY } from './skill-catalog.domain';
import { SKILL_RESOLVER } from './skill-resolver';
import { SkillsService } from './skills.service';

@Module({
  imports: [PrismaModule, GitBrokerModule, ProjectAccessModule],
  controllers: [AdminSkillsController, ProjectSkillsController],
  providers: [
    PrismaSkillCatalogRepository,
    { provide: SKILL_CATALOG_REPOSITORY, useExisting: PrismaSkillCatalogRepository },
    { provide: SKILL_RESOLVER, useClass: GitHubSkillResolver },
    SkillsService,
  ],
  exports: [SkillsService],
})
export class SkillsModule {}
