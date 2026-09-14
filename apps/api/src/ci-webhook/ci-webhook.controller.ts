import { Controller, Post, Body, Param, HttpCode, Headers, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto, CiWebhookResponseDto } from './ci-webhook.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import { createHmac, timingSafeEqual } from 'node:crypto';

type RawBodyRequest = { rawBody?: Buffer };

@ApiTags('ci-webhooks')
@Controller()
export class CiWebhookController {
  constructor(
    private ciWebhookService: CiWebhookService,
    private readonly replayGuard: WebhookReplayGuard,
  ) {}

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
    @Req() request: RawBodyRequest,
    @Headers('x-ci-signature') signature?: string,
    @Headers('x-ci-delivery') deliveryId?: string,
    @Headers('date') dateHeader?: string,
  ) {
    const project = await this.ciWebhookService.resolveProject(slug);
    if (!project) {
      throw new NotFoundAppException({}, 'projects');
    }

    const secret = await this.ciWebhookService.getWebhookSecret(slug);
    if (!secret) {
      throw new AuthException({}, 'ci_webhook');
    }

    const rawBody = request.rawBody;
    // Prefer the raw bytes captured by the Fastify preParsing hook (KODA-02).
    // Fall back to the re-serialized JSON when the hook is unavailable (e.g.
    // older test setups using Express, where the JSON body is round-tripped
    // by the platform anyway).
    const bodyBytes = rawBody ? rawBody.toString('utf8') : JSON.stringify(payload);

    const isValid = this.verifySignature(bodyBytes, signature ?? '', secret);
    if (!isValid) {
      throw new AuthException({}, 'ci_webhook');
    }

    // SEC-1: reject replayed deliveries; forget on failure so the sender's
    // retry with the same delivery id is accepted.
    await this.replayGuard.assertFresh({ projectId: project.id, source: 'ci', deliveryId, dateHeader });

    try {
      const result = await this.ciWebhookService.processCiWebhook(slug, payload);
      return JsonResponse.Ok(result);
    } catch (err) {
      await this.replayGuard.forget({ projectId: project.id, source: 'ci', deliveryId });
      throw err;
    }
  }

  private verifySignature(payload: string, signature: string, secret: string): boolean {
    try {
      const expectedSignature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
      const expected = Buffer.from(expectedSignature);
      const received = Buffer.from(signature);

      if (expected.length !== received.length) {
        return false;
      }

      return timingSafeEqual(expected, received);
    } catch {
      return false;
    }
  }
}
