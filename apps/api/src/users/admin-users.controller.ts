import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { UsersAdminService } from './users-admin.service';
import { ListUsersQuery } from './dto/list-users.query';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAdminDto } from './dto/user-admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersAdminService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List users (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of users: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 403, description: 'Global admin role required' })
  async list(@Query() rawQuery: ListUsersQuery) {
    const { current, size, email } = parseQuery(ListUsersQuery, rawQuery);
    const page = await this.users.list({ email }, { current, size });
    return JsonResponse.Ok(toPageResult(page));
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Create a user with a temporary password (global admin)' })
  @ApiResponse({ status: 201, type: UserAdminDto })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async create(@Body() dto: CreateUserDto) {
    return JsonResponse.Ok(await this.users.create(dto));
  }

  @Patch(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Change a user\'s global role or disable/enable them (global admin)' })
  @ApiResponse({ status: 200, type: UserAdminDto })
  @ApiResponse({ status: 403, description: 'Cannot demote or disable yourself' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Would leave no active global admin' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.users.update(principal.id, id, dto));
  }
}
