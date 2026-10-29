import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery, toPageResult } from '../common/dto/koda-page.query';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { USER_ROUTE_VARIANTS } from './user-route.commands';
import { UsersAdminService } from './users-admin.service';
import { ListUsersQuery } from './dto/list-users.query';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAdminDto } from './dto/user-admin.dto';

// Permissions P1 (US-010): a global route with no project slug, so each handler states its catalog
// key and lists `RequiresGuard` alone. `user.*` are GLOBAL-scope role keys, so a project-admin
// binding does not satisfy them. The self-demotion refusal stays in the handler (403 `users.self`).
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersAdminService, private readonly routeGate: ApprovalRouteGate) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('user.read')
  @ApiOperation({ summary: 'List users (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of users: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 403, description: 'Forbidden - user.read is missing' })
  async list(@Query() rawQuery: ListUsersQuery) {
    const { current, size, email } = parseQuery(ListUsersQuery, rawQuery);
    const page = await this.users.list({ email }, { current, size });
    return JsonResponse.Ok(toPageResult(page));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('user.create')
  @ApiOperation({ summary: 'Create a user with a temporary password (global admin)' })
  @ApiResponse({ status: 201, type: UserAdminDto })
  @ApiResponse({ status: 403, description: 'Forbidden - user.create is missing' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async create(@Body() dto: CreateUserDto) {
    return JsonResponse.Ok(await this.users.create(dto));
  }

  @Patch(':id')
  @ApprovalGated()
  @UseGuards(RequiresGuard)
  @Requires('user.update')
  @ApiOperation({ summary: 'Change a user\'s global role or disable/enable them (global admin)' })
  @ApiResponse({ status: 200, type: UserAdminDto })
  @ApiResponse({ status: 403, description: 'Forbidden - user.update is missing, or the caller cannot demote or disable themselves' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Would leave no active global admin' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Principal() _principal: KodaPrincipal) {
    const outcome = await this.routeGate.run<UserAdminDto>({
      key: 'user.update', variant: USER_ROUTE_VARIANTS.update, projectId: null, input: { id, patch: dto },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }
}
