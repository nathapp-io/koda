import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ActorRole } from '../../common/enums';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';
import { ProjectMemberRecord, ProjectMemberRole } from './domain/project-member.domain';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

const isGlobalAdmin = (principal: KodaPrincipal): boolean =>
  isUserPrincipal(principal) && principal.role === 'ADMIN';

@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly membersRepo: PrismaProjectMembersRepository,
    private readonly access: ProjectAccessService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async list(slug: string, principal: KodaPrincipal, page: IPageOption): Promise<IPageResult<ProjectMemberDto>> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectMembership(projectId, principal);
    return remapPage(await this.membersRepo.findMemberPage(projectId, page), ProjectMemberDto.from);
  }

  async add(slug: string, dto: AddMemberDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);
    const userId = await this.membersRepo.findUserIdByEmail(dto.email);
    if (!userId) throw new NotFoundAppException({}, 'members.user');
    try {
      return ProjectMemberDto.from(await this.membersRepo.createMember(projectId, userId, dto.role));
    } catch (error) {
      if (isUniqueViolation(error, 'userId')) throw new ConflictAppException({}, 'members');
      throw error;
    }
  }

  async updateRole(slug: string, userId: string, dto: UpdateMemberRoleDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);
    const updated = await this.txManager.run(async () => {
      const current = await this.lockAndFind(projectId, userId);
      await this.assertKeepsAnAdmin(projectId, current, dto.role, principal);
      return this.membersRepo.updateMemberRole(projectId, userId, dto.role);
    });
    return ProjectMemberDto.from(updated);
  }

  async remove(slug: string, userId: string, principal: KodaPrincipal): Promise<void> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectAdmin(projectId, principal);
    await this.txManager.run(async () => {
      const current = await this.lockAndFind(projectId, userId);
      await this.assertKeepsAnAdmin(projectId, current, null, principal);
      await this.membersRepo.deleteMember(projectId, userId);
    });
  }

  private async lockAndFind(projectId: string, userId: string): Promise<ProjectMemberRecord> {
    await this.membersRepo.lockMembers(projectId);
    const current = await this.membersRepo.findMember(projectId, userId);
    if (!current) throw new NotFoundAppException({}, 'members');
    return current;
  }

  /** A change that drops the last project ADMIN is refused unless a global ADMIN makes it. */
  private async assertKeepsAnAdmin(
    projectId: string,
    current: ProjectMemberRecord,
    nextRole: ProjectMemberRole | null,
    principal: KodaPrincipal,
  ): Promise<void> {
    const losesAdmin = current.role === ActorRole.ADMIN && nextRole !== ActorRole.ADMIN;
    if (!losesAdmin || isGlobalAdmin(principal)) return;
    if ((await this.membersRepo.countProjectAdmins(projectId)) <= 1) {
      throw new ConflictAppException({}, 'members.lastAdmin');
    }
  }
}
