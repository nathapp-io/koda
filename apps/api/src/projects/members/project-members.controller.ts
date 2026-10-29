import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { CurrentProject } from '../current-project.decorator';
import { ProjectContext } from '../project-context';
import { MEMBER_ROUTE_VARIANTS } from './member-route.commands';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../project-membership.guard';
import { ProjectMembersService } from './project-members.service';
import { ListMembersQuery } from './dto/list-members.query';
import { AddMemberDto } from './dto/add-member.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

/**
 * Permissions P1 (US-008): both guards sit at the class level, in order, so
 * `ProjectMembershipGuard` resolves `request.projectContext` and refuses a principal with no access
 * to the project (403 `projects`) once, before `RequiresGuard` reads the route's key. Every handler
 * declares its own `member.*` key: `member.read` is what lets a plain member list the members, and
 * `member.add` is what lets one add. The listing answers the page alone (Permissions P1l US-006) — the
 * former `canManage` and `viewerRole` described a UI state no endpoint decides any more.
 *
 * Permissions P1 (US-003): a member's role change and removal are no longer routes here. They are a
 * binding grant and a binding delete on `/role-bindings`, which `role.binding.manage` gates and
 * whose last-Project-Admin and open-ticket refusals live in `MembershipService.removeBinding`. This
 * controller keeps the listing and the add; `PATCH`/`DELETE` answer 404.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/members')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectMembersController {
  constructor(
    private readonly members: ProjectMembersService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @Requires('member.read')
  @ApiOperation({ summary: 'List project members (any member)' })
  @ApiResponse({
    status: 200,
    description: 'Page of members: { total, current, size, hasNext, hasPrev, records }',
  })
  @ApiResponse({ status: 403, description: 'Not a project member, or member.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string, @Query() rawQuery: ListMembersQuery, @Principal() principal: KodaPrincipal) {
    const { current, size, principals } = parseQuery(ListMembersQuery, rawQuery);
    const page = await this.members.list(slug, principal, { current, size }, principals);
    return JsonResponse.Ok(toPageResult(page));
  }

  @Post()
  @HttpCode(201)
  @ApprovalGated()
  @Requires('member.add')
  @ApiOperation({ summary: 'Add an existing user by email (member.add)' })
  @ApiResponse({ status: 201, type: ProjectMemberDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or member.add is missing' })
  @ApiResponse({ status: 404, description: 'Project or user not found' })
  @ApiResponse({ status: 409, description: 'Already a member' })
  async add(
    @Param('slug') slug: string,
    @Body() dto: AddMemberDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<ProjectMemberDto>({ key: 'member.add', variant: MEMBER_ROUTE_VARIANTS.add, projectId: project.project.id, input: { slug, member: dto } });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
