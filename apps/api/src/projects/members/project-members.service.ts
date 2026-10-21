import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ActorRole } from '../../common/enums';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { MembershipService } from '../../permissions/membership.service';
import { PermissionService } from '../../permissions/permission.service';
import { ROLE_KEY_FOR_LEGACY_ROLE } from '../../permissions/legacy-project-roles';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';
import { ProjectMemberRecord, ProjectMemberRole } from './domain/project-member.domain';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

const isGlobalAdmin = (principal: KodaPrincipal): boolean =>
  isUserPrincipal(principal) && principal.role === 'ADMIN';

/**
 * Project membership management over the role bindings (Permissions P1a US-004).
 *
 * US-008: the routes carry the `member.*` keys, so this service keeps no admin assertion. `list` still
 * resolves the caller's membership (its `viewerRole`, and the 403 `projects` a non-member gets), and it
 * derives `canManage` from `member.add` so the button the UI renders and the write the API accepts
 * answer to the same key.
 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly membersRepo: PrismaProjectMembersRepository,
    private readonly access: ProjectAccessService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly membership: MembershipService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * `canManage` travels with the page so the UI does not have to guess from the
   * rows it happens to have loaded (a project ADMIN can be on a later page).
   */
  async list(
    slug: string,
    principal: KodaPrincipal,
    page: IPageOption,
  ): Promise<{ page: IPageResult<ProjectMemberDto>; canManage: boolean; viewerRole: string | null }> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    // One membership read serves the gate and viewerRole; the key decides canManage, so a role
    // binding that grants `member.read` without `member.add` lists members without managing them.
    const viewerRole = await this.access.resolveMembership(projectId, principal);
    const [memberPage, decision] = await Promise.all([
      this.membersRepo.findMemberPage(projectId, page),
      this.permissions.can(principal, 'member.add', { projectId }),
    ]);
    return { page: remapPage(memberPage, ProjectMemberDto.from), canManage: decision.allowed, viewerRole };
  }

  /** The route's `member.add` key is the gate: the caller may add anyone the project can hold. */
  async add(slug: string, dto: AddMemberDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    const user = await this.membersRepo.findUserByEmail(dto.email);
    if (!user) throw new NotFoundAppException({}, 'members.user');
    // A disabled account cannot act on the project, so it is never granted
    // membership — the S4b invite path refuses one the same way.
    if (user.disabled) throw new ConflictAppException({}, 'members.userDisabled');
    return this.membership.afterCommit(() => this.txManager.run(async () => {
      await this.membersRepo.lockMembers(projectId);
      if (await this.membersRepo.findMember(projectId, user.id)) throw new ConflictAppException({}, 'members');
      await this.membership.createBinding(
        { principal: { type: 'USER', id: user.id }, projectId, roleKey: ROLE_KEY_FOR_LEGACY_ROLE[dto.role ?? 'VIEWER'] },
        { type: 'USER', id: principal.id },
      );
      return ProjectMemberDto.from(await this.findRequiredMember(projectId, user.id));
    }));
  }

  /** The route's `role.binding.manage` key is the gate; the last-admin rule still applies. */
  async updateRole(slug: string, userId: string, dto: UpdateMemberRoleDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    const updated = await this.membership.afterCommit(() => this.txManager.run(async () => {
      const current = await this.lockAndFind(projectId, userId);
      await this.assertKeepsAnAdmin(projectId, current, dto.role, principal);
      await this.membership.removeProjectBindings({ type: 'USER', id: userId }, projectId, ['project-admin', 'developer', 'viewer']);
      await this.membersRepo.deleteMemberIfPresent(projectId, userId);
      await this.membership.createBinding(
        { principal: { type: 'USER', id: userId }, projectId, roleKey: ROLE_KEY_FOR_LEGACY_ROLE[dto.role] },
        { type: 'USER', id: principal.id },
      );
      return this.findRequiredMember(projectId, userId);
    }));
    return ProjectMemberDto.from(updated);
  }

  /** The route's `member.remove` key is the gate; the last-admin rule still applies. */
  async remove(slug: string, userId: string, principal: KodaPrincipal): Promise<void> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.membership.afterCommit(() => this.txManager.run(async () => {
      const current = await this.lockAndFind(projectId, userId);
      await this.assertKeepsAnAdmin(projectId, current, null, principal);
      await this.membership.removeProjectBindings({ type: 'USER', id: userId }, projectId);
      await this.membersRepo.deleteMemberIfPresent(projectId, userId);
    }));
  }

  private async lockAndFind(projectId: string, userId: string): Promise<ProjectMemberRecord> {
    await this.membersRepo.lockMembers(projectId);
    return this.findRequiredMember(projectId, userId);
  }

  private async findRequiredMember(projectId: string, userId: string): Promise<ProjectMemberRecord> {
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
    // A disabled member is not an active admin: removing them cannot lock the
    // project out, so they do not trigger the guard.
    const losesAdmin = current.role === ActorRole.ADMIN && !current.disabled && nextRole !== ActorRole.ADMIN;
    if (!losesAdmin || isGlobalAdmin(principal)) return;
    if ((await this.membersRepo.countProjectAdmins(projectId)) <= 1) {
      throw new ConflictAppException({}, 'members.lastAdmin');
    }
  }
}
