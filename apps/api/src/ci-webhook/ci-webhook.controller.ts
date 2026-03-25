import { Controller, Post, Body, Param, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto, CiWebhookResponseDto } from './ci-webhook.dto';
import { JsonResponse } from '@nathapp/nestjs-common';

@ApiTags('ci-webhooks')
@Controller()
export class CiWebhookController {
  constructor(private ciWebhookService: CiWebhookService) {}

  @Post('projects/:slug/ci-webhook')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'Receive CI pipeline failure webhook and auto-create ticket' })
  @ApiResponse({ status: 200, type: CiWebhookResponseDto, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async handleCiWebhook(
    @Param('slug') slug: string,
    @Body() payload: CiWebhookPayloadDto,
  ) {
    const result = await this.ciWebhookService.processCiWebhook(slug, payload);
    return JsonResponse.Ok(result);
  }
}
