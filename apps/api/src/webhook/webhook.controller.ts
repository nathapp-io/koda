import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { RequiredPermission } from '@nathapp/nestjs-auth';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto } from './webhook.dto';
import { JsonResponse } from '@nathapp/nestjs-common';

@ApiTags('webhooks')
@Controller()
export class WebhookController {
  constructor(private webhookService: WebhookService) {}

  @Post('projects/:slug/webhooks')
  @HttpCode(201)
  @RequiredPermission('ADMIN')
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
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List all webhooks for a project' })
  @ApiResponse({ status: 200, description: 'List of webhooks' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('slug') slug: string) {
    const data = await this.webhookService.findByProjectSlug(slug);
    return JsonResponse.Ok(data);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Remove a webhook' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async remove(@Param('id') id: string) {
    await this.webhookService.remove(id);
  }
}
