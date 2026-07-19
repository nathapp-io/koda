import { Injectable } from '@nestjs/common';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaProjectRepository } from './prisma-project.repository';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ActorRole } from '../common/enums';

@Injectable()
export class ProjectAccessService {
  constructor(private projectRepo: PrismaProjectRepository) {}

  async findProjectIdBySlug(slug: string): Promise<string> {
    const project = await this.projectRepo.findBySlug(slug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');
    return project.id;
  }

  async assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void> {
    if (!isUserPrincipal(principal)) return;
    if (principal.role === 'ADMIN') return;
    const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
    const allowed = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT, ActorRole.VIEWER] as const;
    if (!role || !allowed.includes(role as typeof allowed[number])) {
      throw new ForbiddenAppException({}, 'projects');
    }
  }
}
