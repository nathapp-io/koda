import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../auth/principal/koda-principal.types';
import { HomeService } from './home.service';
import { HomeActivityDto, HomeDashboardDto } from './dto/home-dashboard.dto';

/** The home dashboard is for people; agent keys get 403, like the fleet read controllers. */
@ApiTags('home')
@ApiBearerAuth()
@ApiExtraModels(HomeActivityDto)
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get()
  @ApiOperation({ summary: "The signed-in user's cross-project dashboard: assigned tickets, pending approvals, attention jobs, projects, recent activity" })
  @ApiResponse({ status: 200, type: HomeDashboardDto })
  async get(@Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.home.snapshot({ id: principal.id, globalAdmin: principal.role === 'ADMIN' }, new Date()));
  }
}
