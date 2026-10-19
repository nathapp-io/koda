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
  constructor(private readonly invites: ProjectInvitesService) {}

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
  @Requires('invite.create')
  @ApiOperation({ summary: 'Add an existing user or invite a new address (invite.create)' })
  @ApiResponse({ status: 201, type: InviteCreateResultDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.create is missing' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Already a member, or the account is disabled' })
  async create(
    @Param('slug') slug: string,
    @Body() dto: CreateInviteDto,
    @Principal() principal: KodaPrincipal,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return JsonResponse.Ok(await this.invites.create(slug, dto, principal, inviteLocale(acceptLanguage)));
  }

  @Post(':id/resend')
  @HttpCode(200)
  @Requires('invite.resend')
  @ApiOperation({ summary: 'Rotate a pending invite token and resend the invite email (invite.resend)' })
  @ApiResponse({ status: 200, type: InviteResendResultDto })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.resend is missing' })
  @ApiResponse({ status: 404, description: 'Project or invite not found' })
  @ApiResponse({ status: 409, description: 'Invite is already accepted or cancelled' })
  async resend(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Principal() principal: KodaPrincipal,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return JsonResponse.Ok(await this.invites.resend(slug, id, principal, inviteLocale(acceptLanguage)));
  }

  @Delete(':id')
  @HttpCode(200)
  @Requires('invite.cancel')
  @ApiOperation({ summary: 'Cancel a pending invite (invite.cancel)' })
  @ApiResponse({ status: 200, description: 'Invite cancelled' })
  @ApiResponse({ status: 403, description: 'Not a project member, or invite.cancel is missing' })
  @ApiResponse({ status: 404, description: 'Project or invite not found' })
  @ApiResponse({ status: 409, description: 'Invite is already accepted or cancelled' })
  async cancel(@Param('slug') slug: string, @Param('id') id: string, @Principal() principal: KodaPrincipal) {
    await this.invites.cancel(slug, id, principal);
    return JsonResponse.Ok({});
  }
}
