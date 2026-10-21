import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

/**
 * Permissions P1 (US-008): both guards sit at the class level, in order, so
 * `ProjectMembershipGuard` resolves `request.projectContext` and refuses a principal with no access
 * to the project (403 `projects`) once, before `RequiresGuard` reads the route's key. The former
 * `resolveMembership` / `assertProjectAdmin` checks inside `ProjectMembersService` are gone; every
 * handler now declares its own `member.*` key. `member.read` is what lets a plain member list the
 * members; `member.add` alone decides the page's `canManage`.
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
    const { current, size } = parseQuery(ListMembersQuery, rawQuery);
    const { page, canManage, viewerRole } = await this.members.list(slug, principal, { current, size });
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

  @Patch(':userId')
  @Requires('role.binding.manage')
  @ApiOperation({ summary: 'Change a member\'s project role (role.binding.manage)' })
  @ApiResponse({ status: 200, type: ProjectMemberDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or role.binding.manage is missing' })
  @ApiResponse({ status: 404, description: 'Not a member' })
  @ApiResponse({ status: 409, description: 'Would leave the project without an ADMIN' })
  async updateRole(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Principal() principal: KodaPrincipal,
  ) {
    return JsonResponse.Ok(await this.members.updateRole(slug, userId, dto, principal));
  }

  @Delete(':userId')
  @Requires('member.remove')
  @ApiOperation({ summary: 'Remove a member (member.remove)' })
  @ApiResponse({ status: 200, description: 'Removed' })
  @ApiResponse({ status: 403, description: 'Not a project member, or member.remove is missing' })
  @ApiResponse({ status: 404, description: 'Not a member' })
  @ApiResponse({ status: 409, description: 'Would leave the project without an ADMIN' })
  async remove(@Param('slug') slug: string, @Param('userId') userId: string, @Principal() principal: KodaPrincipal) {
    await this.members.remove(slug, userId, principal);
    return JsonResponse.Ok({});
  }
}
