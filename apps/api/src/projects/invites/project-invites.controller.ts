import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalRedeemHeader } from '../../approvals/route/approval-redeem-header.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { CurrentProject } from '../current-project.decorator';
import { ProjectContext } from '../project-context';
import { INVITE_ROUTE_VARIANTS } from './invite-route.commands';
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../project-membership.guard';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InviteCreateResultDto, InviteDto, InviteResendResultDto } from './dto/invite.dto';
import { ProjectInvitesService } from './project-invites.service';

/** Fleet S4b US-004: invite email is the only localized email; everything else renders in `en`. */
const inviteLocale = (acceptLanguage: string | undefined): string =>
  acceptLanguage?.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';

/**
 * Permissions P1 (US-008): both guards sit at the class level, in order, so a principal with no access
 * to the project is refused with 403 `projects` before any key is read, and each handler declares its
 * own `invite.*` key. The six non-admin seeded project roles exclude `invite.read`, so the invite
 * surface stays project-admin only without a service-level admin assertion.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/invites')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class ProjectInvitesController {
  constructor(
    private readonly invites: ProjectInvitesService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Get()
  @Requires('invite.read')
  @ApiOperation({ summary: 'List project invites (invite.read)' })
  @ApiResponse({ status: 200, type: [InviteDto] })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.read is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.invites.list(slug, principal));
  }

  @Post()
  @HttpCode(201)
  @ApprovalGated({ redeem: true })
  @Requires('invite.create')
  @ApiOperation({ summary: 'Add an existing user or invite a new address (invite.create)' })
  @ApiResponse({ status: 201, type: InviteCreateResultDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.create is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Already a member, or the account is disabled' })
  async create(
    @Param('slug') slug: string,
    @Body() dto: CreateInviteDto,
    @CurrentProject() project: ProjectContext,
    @Headers('accept-language') acceptLanguage?: string,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    const input = { slug, projectId: project.project.id, invite: dto, locale: inviteLocale(acceptLanguage) };
    const outcome = await this.routeGate.run({ key: 'invite.create', variant: INVITE_ROUTE_VARIANTS.create, projectId: project.project.id, input, redeem });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @ApprovalGated({ redeem: true })
  @Requires('invite.resend')
  @ApiOperation({ summary: 'Rotate a pending invite token and resend the invite email (invite.resend)' })
  @ApiResponse({ status: 200, type: InviteResendResultDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.resend is missing' })
  @ApiResponse({ status: 404, description: 'Project or invite not found' })
  @ApiResponse({ status: 409, description: 'Invite is already accepted or cancelled' })
  async resend(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentProject() project: ProjectContext,
    @Headers('accept-language') acceptLanguage?: string,
    @ApprovalRedeemHeader() redeem?: string,
  ) {
    const input = { slug, projectId: project.project.id, id, locale: inviteLocale(acceptLanguage) };
    const outcome = await this.routeGate.run({ key: 'invite.resend', variant: INVITE_ROUTE_VARIANTS.resend, projectId: project.project.id, input, redeem });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApprovalGated()
  @Requires('invite.cancel')
  @ApiOperation({ summary: 'Cancel a pending invite (invite.cancel)' })
  @ApiResponse({ status: 200, description: 'Invite cancelled' })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.cancel is missing' })
  @ApiResponse({ status: 404, description: 'Project or invite not found' })
  @ApiResponse({ status: 409, description: 'Invite is already accepted or cancelled' })
  async cancel(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const outcome = await this.routeGate.run<null>({ key: 'invite.cancel', variant: INVITE_ROUTE_VARIANTS.cancel, projectId: project.project.id, input: { slug, id } });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok({});
  }
}
