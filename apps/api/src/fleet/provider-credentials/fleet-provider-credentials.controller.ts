import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRedeemHeader } from '../../approvals/route/approval-redeem-header.decorator';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CreateProviderCredentialDto, ListProviderCredentialsQuery, ProviderCredentialDto, UpdateProviderCredentialDto } from './dto/provider-credential.dto';
import { PROVIDER_CREDENTIAL_ROUTE_VARIANTS } from './provider-credential-route.commands';
import { ProviderCredentialsService } from './provider-credentials.service';

/**
 * GLOBAL provider credential management (spec §"US-003").
 *
 * `fleet.credential.read|create` are global keys, so only a global grant passes — which is what
 * "Owner/Admin manage GLOBAL keys" means here. Every answer is write-only metadata: the key leaves the
 * server neither now nor after a rotation.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/provider-credentials')
export class FleetProviderCredentialsController {
  constructor(
    private readonly credentials: ProviderCredentialsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('fleet.credential.read')
  @ApiOperation({ summary: 'List the GLOBAL provider keys as metadata only (fleet.credential.read, global)' })
  @ApiResponse({ status: 200, description: 'Page of ProviderCredentialDto; never carries a key' })
  @ApiResponse({ status: 403, description: 'fleet.credential.read is missing globally' })
  async list(@Query() rawQuery: ListProviderCredentialsQuery) {
    const { current, size } = parseQuery(ListProviderCredentialsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.credentials.listGlobal({ current, size })));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RequiresGuard)
  @Requires('fleet.credential.create')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Create a GLOBAL provider key; the key is never returned (fleet.credential.create, global)' })
  @ApiResponse({ status: 201, type: ProviderCredentialDto })
  @ApiResponse({ status: 400, description: 'Invalid providerId, name or key' })
  @ApiResponse({ status: 403, description: 'fleet.credential.create is missing globally' })
  @ApiResponse({ status: 409, description: 'A key for this provider already exists (fleet.providerCredentials.duplicate)' })
  @ApiResponse({ status: 503, description: 'The credential vault is off (fleet.providerCredentials.vaultOff)' })
  async create(@Body() dto: CreateProviderCredentialDto, @ApprovalRedeemHeader() redeem?: string) {
    // A write that cannot seal must not open an approval request: the vault is read before the gate,
    // exactly as the VCS routes refuse a missing encryption key before theirs.
    this.credentials.assertEnabled();
    const outcome = await this.routeGate.run<ProviderCredentialDto>({
      key: 'fleet.credential.create',
      variant: PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create,
      projectId: null,
      input: dto,
      redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':id')
  @UseGuards(RequiresGuard)
  @Requires('fleet.credential.update')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Rotate or update a GLOBAL provider key (metadata only)' })
  @ApiResponse({ status: 200, type: ProviderCredentialDto })
  @ApiResponse({ status: 404, description: 'GLOBAL credential not found' })
  async update(@Param('id') id: string, @Body() patch: UpdateProviderCredentialDto, @ApprovalRedeemHeader() redeem?: string) {
    this.credentials.assertEnabled();
    const outcome = await this.routeGate.run<ProviderCredentialDto>({
      key: 'fleet.credential.update', variant: PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update,
      projectId: null, input: { id, patch }, redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RequiresGuard)
  @Requires('fleet.credential.delete')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Delete a GLOBAL provider key' })
  @ApiResponse({ status: 200, description: 'Credential deleted' })
  @ApiResponse({ status: 404, description: 'GLOBAL credential not found' })
  async remove(@Param('id') id: string, @ApprovalRedeemHeader() redeem?: string) {
    this.credentials.assertEnabled();
    const outcome = await this.routeGate.run<null>({
      key: 'fleet.credential.delete', variant: PROVIDER_CREDENTIAL_ROUTE_VARIANTS.delete,
      projectId: null, input: { id }, redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({ deleted: true });
  }
}
