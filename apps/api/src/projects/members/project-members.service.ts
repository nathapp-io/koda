import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { MembershipService } from '../../permissions/membership.service';
import { RoleAdminService } from '../../permissions/role-admin.service';
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
 * resolves the caller's membership — the 403 `projects` a non-member gets — and answers the page alone
 * (Permissions P1l US-006): the display `role`, the page-level `viewerRole` and `canManage` are gone,
 * because `bindings` says what a member holds and `member.add` is the add route's own key.
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
    private readonly roles: RoleAdminService,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * The project's members, and nothing else (Permissions P1l US-006).
   *
   * US-003: `principals` decides whether the page also holds the project's agent principals —
   * `'users'` (the default) is the user rows alone, `'all'` appends them.
   *
   * Access is still decided here, before any row is read: `resolveMembership` refuses a principal
   * without `project.read` in the project with the 403 `projects` the route has always answered. The
   * route's `member.read` key is the rest of the gate.
   */
  async list(
    slug: string,
    principal: KodaPrincipal,
    page: IPageOption,
    principals: MemberPrincipalFilter = DEFAULT_MEMBER_PRINCIPAL_FILTER,
  ): Promise<IPageResult<ProjectMemberDto>> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.resolveMembership(projectId, principal);
    return remapPage(await this.membersRepo.findMemberPage(projectId, page, principals), ProjectMemberDto.from);
  }

  /** The route's `member.add` key is the gate: the caller may add anyone the project can hold. */
  async add(slug: string, dto: AddMemberDto, principal: KodaPrincipal): Promise<ProjectMemberDto> {
    // US-004 (P1l): `roleKey` is the only role field; the pipe strips a legacy `role`, so an add that
    // sends one and no key grants the least-privileged `viewer`, exactly as an omitted key does.
    const roleKey = dto.roleKey ?? 'viewer';
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
      const binding = await this.membership.createBinding(
        { principal: { type: 'USER', id: user.id }, projectId, roleKey },
        { type: 'USER', id: principal.id },
      );
      await this.audit.record({
        key: 'member.add', resourceType: 'role-binding', resourceId: binding.id, projectId,
        summary: `${binding.roleKey} to ${binding.principalType} ${binding.principalId}`,
      });
      return ProjectMemberDto.from(await this.findRequiredMember(projectId, user.id));
    }));
  }

  private async findRequiredMember(projectId: string, userId: string): Promise<ProjectMemberRecord> {
    const current = await this.membersRepo.findMember(projectId, userId);
    if (!current) throw new NotFoundAppException({}, 'members');
    return current;
  }
}
