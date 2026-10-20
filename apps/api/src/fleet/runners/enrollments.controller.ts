import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { EnrollmentCreatedDto } from './dto/enrollment.dto';
import { ListEnrollmentsQuery } from './dto/list-enrollments.query';

/**
 * Fleet S1: the enrollment admin routes, migrated onto permission keys by permissions P1d (US-008).
 * Both keys are global, checked with no project — which is what `@RequiredPermission('ADMIN')` meant.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(RequiresGuard)
  @Requires('fleet.enrollment.create')
  @ApiOperation({ summary: 'Issue a single-use runner enrollment token (fleet.enrollment.create, global); the token is shown once' })
  @ApiResponse({ status: 201, type: EnrollmentCreatedDto })
  @ApiResponse({ status: 403, description: 'fleet.enrollment.create is missing globally' })
  async create(@Body() dto: CreateEnrollmentDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.enrollments.create(principal.id, dto.labels ?? []));
  }

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.enrollment.read')
  @ApiOperation({ summary: 'List enrollment tokens (fleet.enrollment.read, global); tokens are never returned' })
  @ApiResponse({ status: 200, description: 'Page of EnrollmentDto' })
  @ApiResponse({ status: 403, description: 'fleet.enrollment.read is missing globally' })
  async list(@Query() rawQuery: ListEnrollmentsQuery) {
    const { current, size } = parseQuery(ListEnrollmentsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.enrollments.list({ current, size })));
  }
}
