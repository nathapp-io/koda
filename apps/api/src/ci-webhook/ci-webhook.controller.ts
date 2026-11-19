import { Controller, Post, Param, HttpCode, Headers, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiHeader } from '@nestjs/swagger';
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
import {
  isAcceptableDeliveryId,
  isFreshTimestamp,
  signatureV1,
  signatureV2Bytes,
  signaturesMatch,
} from '../webhook-security/webhook-signature';

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
  // The three signature headers are optional (webhook signature v2, US-005): a v2-only sender omits
  // `x-ci-signature`, and `x-ci-timestamp` / `x-ci-signature-v2` only exist on a v2 delivery. Declared
  // explicitly with the reflected `@Headers` names, so swagger merges the two into one optional parameter
  // per header instead of documenting a required one.
  @ApiHeader({
    name: 'x-ci-signature',
    required: false,
    description: 'v1 signature, `sha256=<hex>` over the raw body. Deprecated: omit it on a v2-only delivery.',
  })
  @ApiHeader({
    name: 'x-ci-timestamp',
    required: false,
    description: 'Decimal Unix seconds covered by `x-ci-signature-v2`; must be within 300 seconds of now.',
  })
  @ApiHeader({
    name: 'x-ci-signature-v2',
    required: false,
    description: 'v2 signature, `sha256=<hex>` over `<x-ci-timestamp>.<x-ci-delivery>.<raw body>`.',
  })
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
    const config = this.config.get<{ ciRequireV2: boolean }>(WEBHOOK_SIGNATURE_CFG);
    const validSignature = signatureV2Header !== undefined
      ? this.verifySignatureV2(target?.secret ?? '', request.rawBody, timestamp, deliveryId, signatureV2Header)
      : !config?.ciRequireV2 &&
        Boolean(target && this.verifySignature(signedBytesOf(request), signature ?? '', target.secret));
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

  /**
   * v2 decides alone when `x-ci-signature-v2` is present (webhook signature v2 US-004).
   *
   * It signs the bytes the sender signed: the raw body buffer the `preParsing` hook captured, hashed
   * as received. A body that is not valid UTF-8 is never decoded first (a decode replaces the invalid
   * bytes and would verify the replacement text), and a delivery without a captured buffer is refused
   * rather than re-serialized from the parsed payload (review B1).
   *
   * The delivery id must also be short enough for the replay table's unique index: a longer one would
   * authenticate and then fail the replay insert with a 5xx, so it is refused here, before the guard,
   * and never consumes a delivery id (review B2).
   */
  private verifySignatureV2(
    secret: string,
    rawBody: Buffer | undefined,
    timestamp: string | undefined,
    deliveryId: string | undefined,
    signature: string,
  ): boolean {
    if (
      !rawBody ||
      timestamp === undefined ||
      !isAcceptableDeliveryId(deliveryId) ||
      !isFreshTimestamp(timestamp, Date.now())
    ) {
      return false;
    }

    try {
      return signaturesMatch(signatureV2Bytes(secret, timestamp, deliveryId, rawBody), signature);
    } catch {
      return false;
    }
  }
}
