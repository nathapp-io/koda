import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembersService } from './project-members.service';
import { ListMembersQuery } from './dto/list-members.query';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ProjectMemberDto } from './dto/project-member.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/members')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMembersService) {}

  @Get()
  @ApiOperation({ summary: 'List project members (any member)' })
  @ApiResponse({
    status: 200,
    description: 'Page of members: { total, current, size, hasNext, hasPrev, records, canManage }',
  })
  @ApiResponse({ status: 403, description: 'Not a project member' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string, @Query() rawQuery: ListMembersQuery, @Principal() principal: KodaPrincipal) {
    const { current, size } = parseQuery(ListMembersQuery, rawQuery);
    const { page, canManage } = await this.members.list(slug, principal, { current, size });
    return JsonResponse.Ok({ ...toPageResult(page), canManage });
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Add an existing user by email (project admin)' })
  @ApiResponse({ status: 201, type: ProjectMemberDto })
  @ApiResponse({ status: 403, description: 'Project admin role required' })
  @ApiResponse({ status: 404, description: 'Project or user not found' })
  @ApiResponse({ status: 409, description: 'Already a member' })
  async add(@Param('slug') slug: string, @Body() dto: AddMemberDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.members.add(slug, dto, principal));
  }

  @Patch(':userId')
  @ApiOperation({ summary: 'Change a member\'s project role (project admin)' })
  @ApiResponse({ status: 200, type: ProjectMemberDto })
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
  @ApiOperation({ summary: 'Remove a member (project admin)' })
  @ApiResponse({ status: 200, description: 'Removed' })
  @ApiResponse({ status: 404, description: 'Not a member' })
  @ApiResponse({ status: 409, description: 'Would leave the project without an ADMIN' })
  async remove(@Param('slug') slug: string, @Param('userId') userId: string, @Principal() principal: KodaPrincipal) {
    await this.members.remove(slug, userId, principal);
    return JsonResponse.Ok({});
  }
}
