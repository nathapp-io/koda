import { Controller, Post, Param, HttpCode, Headers, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto, CiWebhookResponseDto } from './ci-webhook.dto';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import { runAsSystem } from '../action-context/action-context';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import {
  InboundWebhookRequest,
  parseInboundPayload,
  signedBytesOf,
} from '../webhook-security/inbound-webhook-request';
import { WEBHOOK_SIGNATURE_CFG } from '../config/webhook-signature.config';
import { isFreshTimestamp, signatureV1, signatureV2, signaturesMatch } from '../webhook-security/webhook-signature';

@ApiTags('ci-webhooks')
@Controller()
export class CiWebhookController {
  constructor(
    private ciWebhookService: CiWebhookService,
    private readonly replayGuard: WebhookReplayGuard,
    private readonly config: ConfigService,
  ) {}

  @Post('projects/:slug/ci-webhook')
  @HttpCode(200)
  @Public()
  @UseGuards(RequiresGuard)
  @Requires('ci.webhook.ingest')
  @ApiOperation({ summary: 'Receive CI pipeline failure webhook and auto-create ticket' })
  @ApiBody({ type: CiWebhookPayloadDto })
  @ApiResponse({ status: 200, type: CiWebhookResponseDto, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid payload (checked only after a valid signature)' })
  @ApiResponse({ status: 401, description: 'Unknown project, no CI webhook token, or invalid signature' })
  async handleCiWebhook(
    @Param('slug') slug: string,
    @Req() request: InboundWebhookRequest,
    @Headers('x-ci-signature') signature?: string,
    @Headers('x-ci-delivery') deliveryId?: string,
    @Headers('date') dateHeader?: string,
    @Headers('x-ci-timestamp') timestamp?: string,
    @Headers('x-ci-signature-v2') signatureV2Header?: string,
  ) {
    // One lookup. An unknown slug, a missing token and a bad signature all get
    // the same 401, so the route does not reveal which slugs exist.
    const target = await this.ciWebhookService.findInboundTarget(slug);
    const rawBody = signedBytesOf(request);
    const config = this.config.get<{ ciRequireV2: boolean }>(WEBHOOK_SIGNATURE_CFG);
    const validSignature = signatureV2Header !== undefined
      ? Boolean(deliveryId !== undefined && timestamp !== undefined && isFreshTimestamp(timestamp, Date.now()) &&
        signaturesMatch(signatureV2(target?.secret ?? '', timestamp, deliveryId, rawBody), signatureV2Header))
      : !config?.ciRequireV2 && Boolean(target && this.verifySignature(rawBody, signature ?? '', target.secret));
    if (!target || !validSignature) {
      throw new AuthException({}, 'ci_webhook');
    }

    // Validate only after the signature, and before the replay record, so an
    // invalid delivery does not consume its id.
    const payload = await parseInboundPayload(CiWebhookPayloadDto, request.body);

    // SEC-1: reject replayed deliveries; forget on failure so the sender's
    // retry with the same delivery id is accepted. Both rows are the CI
    // component's own bookkeeping, so they are written as SYSTEM/ci rather
    // than as the public route's SYSTEM/anonymous (Permissions P2 US-006).
    await runAsSystem('ci', async () => {
      await this.replayGuard.assertFresh({ projectId: target.projectId, source: 'ci', deliveryId, dateHeader });
    });

    try {
      const result = await this.ciWebhookService.processCiWebhook(slug, payload);
      return JsonResponse.Ok(result);
    } catch (err) {
      await runAsSystem('ci', async () => {
        await this.replayGuard.forget({ projectId: target.projectId, source: 'ci', deliveryId });
      });
      throw err;
    }
  }

  private verifySignature(payload: string, signature: string, secret: string): boolean {
    try {
      return signaturesMatch(signatureV1(secret, payload), signature);
    } catch {
      return false;
    }
  }
}
