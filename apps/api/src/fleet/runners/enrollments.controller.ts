import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { EnrollmentCreatedDto } from './dto/enrollment.dto';
import { ListEnrollmentsQuery } from './dto/list-enrollments.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Issue a single-use runner enrollment token (global admin); the token is shown once' })
  @ApiResponse({ status: 201, type: EnrollmentCreatedDto })
  async create(@Body() dto: CreateEnrollmentDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.enrollments.create(principal.id, dto.labels ?? []));
  }

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List enrollment tokens (global admin); tokens are never returned' })
  @ApiResponse({ status: 200, description: 'Page of EnrollmentDto' })
  async list(@Query() rawQuery: ListEnrollmentsQuery) {
    const { current, size } = parseQuery(ListEnrollmentsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.enrollments.list({ current, size })));
  }
}
