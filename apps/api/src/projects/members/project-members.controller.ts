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
 * to the project (403 `projects`) once, before `RequiresGuard` reads the route's key. The former
 * `resolveMembership` / `assertProjectAdmin` checks inside `ProjectMembersService` are gone; every
 * handler now declares its own `member.*` key. `member.read` is what lets a plain member list the
 * members; `member.add` alone decides the page's `canManage`.
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
  constructor(private readonly members: ProjectMembersService) {}

  @Get()
  @Requires('member.read')
  @ApiOperation({ summary: 'List project members (any member)' })
  @ApiResponse({
    status: 200,
    description: 'Page of members: { total, current, size, hasNext, hasPrev, records, canManage, viewerRole }',
  })
  @ApiResponse({ status: 403, description: 'Not a project member, or member.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string, @Query() rawQuery: ListMembersQuery, @Principal() principal: KodaPrincipal) {
    const { current, size, principals } = parseQuery(ListMembersQuery, rawQuery);
    const { page, canManage, viewerRole } = await this.members.list(slug, principal, { current, size }, principals);
    return JsonResponse.Ok({ ...toPageResult(page), canManage, viewerRole });
  }

  @Post()
  @HttpCode(201)
  @Requires('member.add')
  @ApiOperation({ summary: 'Add an existing user by email (member.add)' })
  @ApiResponse({ status: 201, type: ProjectMemberDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or member.add is missing' })
  @ApiResponse({ status: 404, description: 'Project or user not found' })
  @ApiResponse({ status: 409, description: 'Already a member' })
  async add(@Param('slug') slug: string, @Body() dto: AddMemberDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.members.add(slug, dto, principal));
  }
}
