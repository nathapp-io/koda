import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectContext } from '../projects/project-context';
import { WEBHOOK_ROUTE_VARIANTS } from './webhook-route.commands';
import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';
import { JsonResponse } from '@nathapp/nestjs-common';

@ApiTags('webhooks')
@Controller()
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  @Post('projects/:slug/webhooks')
  @HttpCode(201)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('webhook.create')
  @ApiOperation({ summary: 'Register a webhook for a project' })
  @ApiResponse({ status: 201, description: 'Webhook registered' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async register(
    @Param('slug') slug: string,
    @Body() createWebhookDto: CreateWebhookDto,
  ) {
    const project = await this.webhookService.getProjectBySlug(slug);
    const data = await this.webhookService.create(project.id, createWebhookDto);
    return JsonResponse.Ok(data);
  }

  @Get('projects/:slug/webhooks')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('webhook.read')
  @ApiOperation({ summary: 'List all webhooks for a project' })
  @ApiResponse({ status: 200, description: 'List of webhooks' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string) {
    const data = await this.webhookService.findByProjectSlug(slug);
    return JsonResponse.Ok(data);
  }

  @Patch('projects/:slug/webhooks/:id')
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('webhook.update')
  @ApiOperation({ summary: 'Update a webhook for a project' })
  @ApiResponse({ status: 200, description: 'Webhook updated' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async update(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() updateWebhookDto: UpdateWebhookDto,
  ) {
    const project = await this.webhookService.getProjectBySlug(slug);
    const data = await this.webhookService.update(project.id, id, updateWebhookDto);
    return JsonResponse.Ok(data);
  }

  /** Deliberate cross-project admin route (global ADMIN only); see the project-scoped route below. */
  @Delete('webhooks/:id')
  @HttpCode(204)
  @UseGuards(RequiresGuard)
  @Requires('webhook.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Remove a webhook' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async remove(@Param('id') id: string) {
    const outcome = await this.routeGate.run({
      key: 'webhook.delete',
      variant: WEBHOOK_ROUTE_VARIANTS.globalDelete,
      projectId: null,
      input: { id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }

  @Delete('projects/:slug/webhooks/:id')
  @HttpCode(204)
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('webhook.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Remove a webhook (project-scoped)' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Project or webhook not found, or the webhook belongs to another project' })
  async removeByProject(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentProject() ctx: ProjectContext,
  ) {
    const projectId = ctx.project.id;
    const outcome = await this.routeGate.run({
      key: 'webhook.delete',
      variant: WEBHOOK_ROUTE_VARIANTS.projectDelete,
      projectId,
      input: { projectId, id },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }
}
