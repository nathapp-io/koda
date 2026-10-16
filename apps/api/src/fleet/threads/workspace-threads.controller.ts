import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { isUserPrincipal, type KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CreateWorkspaceThreadDto, WorkspaceThreadDto } from './dto/workspace-thread.dto';
import { WorkspaceThreadsService } from './workspace-threads.service';

@ApiTags('fleet threads')
@ApiBearerAuth()
@Controller('threads')
export class WorkspaceThreadsController {
  constructor(private readonly threads: WorkspaceThreadsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a personal workspace chat thread' })
  @ApiResponse({ status: 201, type: WorkspaceThreadDto })
  async create(@Body() dto: CreateWorkspaceThreadDto, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'threads.principal');
    return JsonResponse.Ok(await this.threads.create(principal, dto));
  }
}
