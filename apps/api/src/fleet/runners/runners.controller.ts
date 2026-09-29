import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { RunnersService } from './runners.service';
import { RunnerDto } from './dto/runner.dto';
import { UpdateRunnerDto } from './dto/update-runner.dto';
import { ListRunnersQuery } from './dto/list-runners.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/runners')
export class RunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List runners (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of RunnerDto' })
  async list(@Query() rawQuery: ListRunnersQuery) {
    const { current, size } = parseQuery(ListRunnersQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.runners.list({ current, size })));
  }

  @Get(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Get a runner (global admin)' })
  @ApiResponse({ status: 200, type: RunnerDto })
  async get(@Param('id') id: string) {
    return JsonResponse.Ok(await this.runners.get(id));
  }

  @Patch(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Enable/disable a runner or change its labels or capacity (global admin)' })
  @ApiResponse({ status: 200, type: RunnerDto })
  async update(@Param('id') id: string, @Body() dto: UpdateRunnerDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.runners.update(principal.id, id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: "Delete a runner; revokes its key (global admin)" })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.runners.remove(principal.id, id);
  }
}
