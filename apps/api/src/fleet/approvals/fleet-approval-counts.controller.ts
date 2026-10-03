import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalsService } from './approvals.service';
import { ApprovalCountsDto } from './dto/approval-counts.dto';

/** Plan D235: the web badge's count, for any signed-in user over their memberships. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/approval-counts')
export class FleetApprovalCountsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @ApiOperation({ summary: 'Pending approvals per member project; no-project ones for a global admin' })
  @ApiResponse({ status: 200, type: ApprovalCountsDto })
  async get(@Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.approvals.counts({ id: principal.id, globalAdmin: principal.role === 'ADMIN' }));
  }
}
