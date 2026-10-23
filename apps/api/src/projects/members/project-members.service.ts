import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { MembershipService } from '../../permissions/membership.service';
import { PermissionService } from '../../permissions/permission.service';
import { RoleAdminService } from '../../permissions/role-admin.service';
import { ROLE_KEY_FOR_LEGACY_ROLE } from '../../permissions/legacy-project-roles';
import { ProjectAccessService } from '../project-access.service';
import { PrismaProjectMembersRepository } from './prisma-project-members.repository';
import { ProjectMemberRecord } from './domain/project-member.domain';
import { AddMemberDto } from './dto/add-member.dto';
import { ProjectMemberDto } from './dto/project-member.dto';
import { DEFAULT_MEMBER_PRINCIPAL_FILTER, MemberPrincipalFilter } from './dto/list-members.query';

/**
 * Project membership management over the role bindings (Permissions P1a US-004).
 *
 * US-008: the routes carry the `member.*` keys, so this service keeps no admin assertion. `list` still
 * resolves the caller's membership (its `viewerRole`, and the 403 `projects` a non-member gets), and it
 * derives `canManage` from `member.add` so the button the UI renders and the write the API accepts
 * answer to the same key.
 *
 * US-004 (P1 web): `add` grants through `RoleAdminService.assertMayGrant`, so a member without the keys
 * of the role it is handing out is refused before any binding is written.
 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly membersRepo: PrismaProjectMembersRepository,
    private readonly access: ProjectAccessService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly membership: MembershipService,
    private readonly permissions: PermissionService,
    private readonly roles: RoleAdminService,
  ) {}

  /**
   * `canManage` travels with the page so the UI does not have to guess from the
   * rows it happens to have loaded (a project ADMIN can be on a later page).
   *
   * US-003: `principals` decides whether the page also holds the project's agent principals —
   * `'users'` (the default) is the user rows alone, `'all'` appends them.
   */
  async list(
    slug: string,
    principal: KodaPrincipal,
    page: IPageOption,
    principals: MemberPrincipalFilter = DEFAULT_MEMBER_PRINCIPAL_FILTER,
  ): Promise<{ page: IPageResult<ProjectMemberDto>; canManage: boolean; viewerRole: string | null }> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    // One membership read serves the gate and viewerRole; the key decides canManage, so a role
    // binding that grants `member.read` without `member.add` lists members without managing them.
    const viewerRole = await this.access.resolveMembership(projectId, principal);
    const [memberPage, decision] = await Promise.all([
      this.membersRepo.findMemberPage(projectId, page, principals),
      this.permissions.can(principal, 'member.add', { projectId }),
    ]);
    return { page: remapPage(memberPage, ProjectMemberDto.from), canManage: decision.allowed, viewerRole };
  }

  /** The route's `member.add` key is the gate: the caller may add anyone the project can hold. */
  async add(slug: string, dto: AddMemberDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    // US-004: two ways to name the role is a client bug, not a precedence question.
    if (dto.role !== undefined && dto.roleKey !== undefined) {
      throw new ValidationAppException({}, 'members.roleAndRoleKey');
    }
    const roleKey = dto.roleKey ?? ROLE_KEY_FOR_LEGACY_ROLE[dto.role ?? 'VIEWER'];
    const projectId = await this.access.findProjectIdBySlug(slug);
    const user = await this.membersRepo.findUserByEmail(dto.email);
    if (!user) throw new NotFoundAppException({}, 'members.user');
    // A disabled account cannot act on the project, so it is never granted
    // membership — the S4b invite path refuses one the same way.
    if (user.disabled) throw new ConflictAppException({}, 'members.userDisabled');
    // US-004: the same grant rules `POST /role-bindings` applies — role, scope, principal type,
    // self-binding, escalation — before anything is written. Run outside the transaction so a refusal
    // never opens one.
    await this.roles.assertMayGrant(principal, {
      roleKey,
      projectId,
      principalType: 'USER',
      principalId: user.id,
    });
    return this.membership.afterCommit(() => this.txManager.run(async () => {
      await this.membersRepo.lockMembers(projectId);
      if (await this.membersRepo.findMember(projectId, user.id)) throw new ConflictAppException({}, 'members');
      await this.membership.createBinding(
        { principal: { type: 'USER', id: user.id }, projectId, roleKey },
        { type: 'USER', id: principal.id },
      );
      return ProjectMemberDto.from(await this.findRequiredMember(projectId, user.id));
    }));
  }

  private async findRequiredMember(projectId: string, userId: string): Promise<ProjectMemberRecord> {
    const current = await this.membersRepo.findMember(projectId, userId);
    if (!current) throw new NotFoundAppException({}, 'members');
    return current;
  }
}
