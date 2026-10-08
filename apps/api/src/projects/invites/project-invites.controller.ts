import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InviteCreateResultDto, InviteDto } from './dto/invite.dto';
import { ProjectInvitesService } from './project-invites.service';

/** Fleet S4b US-004: invite email is the only localized email; everything else renders in `en`. */
const inviteLocale = (acceptLanguage: string | undefined): string =>
  acceptLanguage?.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:slug/invites')
export class ProjectInvitesController {
  constructor(private readonly invites: ProjectInvitesService) {}

  @Get()
  @ApiOperation({ summary: 'List project invites (project admin)' })
  @ApiResponse({ status: 200, type: [InviteDto] })
  @ApiResponse({ status: 403, description: 'Project admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.invites.list(slug, principal));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Add an existing user or invite a new address (project admin)' })
  @ApiResponse({ status: 201, type: InviteCreateResultDto })
  @ApiResponse({ status: 403, description: 'Project admin role required' })
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
}
