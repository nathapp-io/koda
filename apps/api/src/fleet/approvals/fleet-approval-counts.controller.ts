import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ApprovalsService } from './approvals.service';
import { ApprovalCountsDto } from './dto/approval-counts.dto';

/**
 * Plan D235: the web badge's count. Permissions P1d (US-006) filters it by the key instead of by
 * membership: `projectIdsWithKey` answers `{ all: true }` for a global `fleet.approval.read` grant and
 * otherwise exactly the projects where the caller holds it, so an agent rostered in a project counts
 * that project and a runner counts nothing.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/approval-counts')
export class FleetApprovalCountsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  // The key is answered by `projectIdsWithKey` (it filters the rows), so the guard only records it.
  @Requires('fleet.approval.read', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Pending approvals per project where the caller holds fleet.approval.read' })
  @ApiResponse({ status: 200, type: ApprovalCountsDto })
  async get(@Principal() principal: KodaPrincipal) {
    const scope = await this.permissions.projectIdsWithKey(principal, 'fleet.approval.read');
    return JsonResponse.Ok(await this.approvals.counts(scope));
  }
}
