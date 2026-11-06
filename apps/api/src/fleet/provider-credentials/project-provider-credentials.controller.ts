import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRedeemHeader } from '../../approvals/route/approval-redeem-header.decorator';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { ProjectContext } from '../../projects/project-context';
import {
  CreateProjectProviderCredentialDto,
  ListProviderCredentialsQuery,
  ProviderCredentialDto,
  UpdateProviderCredentialDto,
} from './dto/provider-credential.dto';
import { PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS } from './provider-credential-route.commands';
import { ProviderCredentialsService } from './provider-credentials.service';

/**
 * A project's own provider keys (spec §"US-005"): PROJECT defaults and per-REPO overrides.
 *
 * The routes are the mirror of the GLOBAL ones, one scope down: `project.credential.read|create|update|
 * delete` are project keys, so a project grant manages this project's rows and nothing else. Visibility
 * is the filter — every read and every write is scoped by the resolved project, and another project's
 * credential or a GLOBAL one answers the same 404, so an id never reveals that a row it may not touch
 * exists. Every answer is write-only metadata; the key leaves the server neither now nor after a rotation.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/provider-credentials')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectProviderCredentialsController {
  constructor(
    private readonly credentials: ProviderCredentialsService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @Requires('project.credential.read')
  @ApiOperation({ summary: "List the project's provider keys as metadata only (project.credential.read)" })
  @ApiResponse({ status: 200, description: 'Page of ProviderCredentialDto; never carries a key' })
  @ApiResponse({ status: 403, description: 'project.credential.read is missing in this project' })
  async list(@Query() rawQuery: ListProviderCredentialsQuery, @CurrentProject() project: ProjectContext) {
    const { current, size } = parseQuery(ListProviderCredentialsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.credentials.listProject(project.project.id, { current, size })));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Requires('project.credential.create')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Create a PROJECT key, or a REPO key when repoId names one of its repos' })
  @ApiResponse({ status: 201, type: ProviderCredentialDto })
  @ApiResponse({ status: 400, description: 'Invalid providerId, name or key' })
  @ApiResponse({ status: 403, description: 'project.credential.create is missing in this project' })
  @ApiResponse({ status: 404, description: 'The repo is not one of this project (fleet.repos)' })
  @ApiResponse({ status: 409, description: 'A key for this provider already exists at this scope (fleet.providerCredentials.duplicate)' })
  @ApiResponse({ status: 503, description: 'The credential vault is off (fleet.providerCredentials.vaultOff)' })
  async create(
    @Body() dto: CreateProjectProviderCredentialDto,
    @CurrentProject() project: ProjectContext,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    // A write that cannot seal must not open an approval request: the vault is read before the gate,
    // and the repo before it too, so a request is never opened for a call that cannot run. A `null`
    // repoId is the caller saying "project scope", exactly like leaving it out.
    const repoId = dto.repoId ?? null;
    this.credentials.assertEnabled();
    if (repoId !== null) await this.credentials.assertRepoInProject(project.project.id, repoId);
    const outcome = await this.routeGate.run<ProviderCredentialDto>({
      key: 'project.credential.create',
      variant: PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create,
      projectId: project.project.id,
      input: {
        projectId: project.project.id,
        providerId: dto.providerId,
        name: dto.name,
        key: dto.key,
        repoId,
      },
      redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Patch(':id')
  @Requires('project.credential.update')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Rotate or update one of the project provider keys (metadata only)' })
  @ApiResponse({ status: 200, type: ProviderCredentialDto })
  @ApiResponse({ status: 403, description: 'project.credential.update is missing in this project' })
  @ApiResponse({ status: 404, description: "No credential of this project has that id" })
  async update(
    @Param('id') id: string,
    @Body() patch: UpdateProviderCredentialDto,
    @CurrentProject() project: ProjectContext,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    this.credentials.assertEnabled();
    await this.credentials.assertProject(project.project.id, id);
    const outcome = await this.routeGate.run<ProviderCredentialDto>({
      key: 'project.credential.update',
      variant: PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update,
      projectId: project.project.id,
      input: { projectId: project.project.id, id, patch },
      redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Requires('project.credential.delete')
  @ApprovalGated({ redeem: true })
  @ApiOperation({ summary: 'Delete one of the project provider keys' })
  @ApiResponse({ status: 200, description: 'Credential deleted' })
  @ApiResponse({ status: 403, description: 'project.credential.delete is missing in this project' })
  @ApiResponse({ status: 404, description: "No credential of this project has that id" })
  async remove(
    @Param('id') id: string,
    @CurrentProject() project: ProjectContext,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    this.credentials.assertEnabled();
    await this.credentials.assertProject(project.project.id, id);
    const outcome = await this.routeGate.run<null>({
      key: 'project.credential.delete',
      variant: PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.delete,
      projectId: project.project.id,
      input: { projectId: project.project.id, id },
      redeem,
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({ deleted: true });
  }
}
