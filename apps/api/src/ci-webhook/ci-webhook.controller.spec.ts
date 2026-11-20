import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WEBHOOK_SIGNATURE_CFG } from '../config/webhook-signature.config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '@nathapp/nestjs-auth';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { PermissionService } from '../permissions/permission.service';
import { AuthException, ValidationAppException } from '@nathapp/nestjs-common';
import { createHmac } from 'node:crypto';
import { currentContext, runWithActionContext, type ActionContext } from '../action-context/action-context';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto } from './ci-webhook.dto';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import { MAX_DELIVERY_ID_BYTES } from '../webhook-security/webhook-signature';
import type { InboundWebhookRequest } from '../webhook-security/inbound-webhook-request';

const SECRET = 'test-secret';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
}

/** A Fastify-shaped request: the raw bytes the sender signed plus the parsed body. */
function requestOf(body: unknown, rawBody: string = JSON.stringify(body)): InboundWebhookRequest {
  return { rawBody: Buffer.from(rawBody), body };
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected the call to reject');
}

describe('CiWebhookController route authorization', () => {
  it('declares the CI intake key behind RequiresGuard while remaining public', () => {
    const handler = CiWebhookController.prototype.handleCiWebhook;
    expect(Reflect.getMetadata(REQUIRES_METADATA, handler)).toMatchObject({
      keys: ['ci.webhook.ingest'],
    });
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RequiresGuard]);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
  });
});

describe('CiWebhookController', () => {
  let controller: CiWebhookController;
  // Retained and closed per test: the injector graph is not garbage-collected on its own, and this
  // file compiles a module for every case (`.nax/rules/api-testing.md`).
  let moduleRef: TestingModule | undefined;

  const mockCiWebhookService = {
    findInboundTarget: vi.fn(),
    processCiWebhook: vi.fn(),
  };

  const mockReplayGuard = {
    assertFresh: vi.fn(),
    forget: vi.fn(),
  };
  const mockConfig = { get: vi.fn() };

  const validPayload: CiWebhookPayloadDto = {
    event: 'pipeline_failed',
    pipeline: { id: '12345', url: 'https://github.com/org/repo/actions/runs/12345' },
    commit: { sha: 'abc123def456', message: 'feat: add dark mode' },
    failures: [
      { test: 'AuthService.validateToken', file: 'apps/api/src/auth/auth.service.ts', line: 87 },
    ],
  };

  beforeEach(async () => {
    mockCiWebhookService.findInboundTarget.mockReset().mockResolvedValue({ projectId: 'proj-1', secret: SECRET });
    mockCiWebhookService.processCiWebhook.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    mockReplayGuard.assertFresh.mockReset().mockResolvedValue(undefined);
    mockReplayGuard.forget.mockReset().mockResolvedValue(undefined);
    mockConfig.get.mockReset().mockImplementation((key: string) => key === WEBHOOK_SIGNATURE_CFG ? undefined : undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [
        { provide: CiWebhookService, useValue: mockCiWebhookService },
        { provide: WebhookReplayGuard, useValue: mockReplayGuard },
        { provide: ConfigService, useValue: mockConfig },
        { provide: PermissionService, useValue: { can: vi.fn() } },
        RequiresGuard,
      ],
    }).compile();
    moduleRef = module;

    controller = module.get<CiWebhookController>(CiWebhookController);
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  /** The 401 a caller gets for a bad signature on an existing project: the reference shape. */
  async function badSignatureRejection(): Promise<HttpException> {
    return rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload), 'sha256=bad'));
  }

  describe('happy path', () => {
    it('resolves the target once, verifies, and forwards the validated payload', async () => {
      const expectedResult = {
        success: true,
        ticketRef: 'KODA-1',
        message: 'Created ticket for CI failure: AuthService.validateToken',
      };
      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      const result = await controller.handleCiWebhook('koda', request, sign(rawBytes.toString('utf8')));

      expect(result.data).toEqual(expectedResult);
      expect(mockCiWebhookService.findInboundTarget).toHaveBeenCalledTimes(1);
      expect(mockCiWebhookService.findInboundTarget).toHaveBeenCalledWith('koda');
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('passes a class instance to the service (validated, with @Type conversions applied)', async () => {
      const payload = { ...validPayload, failures: [{ test: 'T', line: '87' }] };
      const raw = JSON.stringify(payload);

      await controller.handleCiWebhook('koda', requestOf(payload, raw), sign(raw));

      const forwarded = mockCiWebhookService.processCiWebhook.mock.calls[0][1];
      expect(forwarded).toBeInstanceOf(CiWebhookPayloadDto);
      expect(forwarded.failures[0].line).toBe(87);
    });

    it('verifies against the raw bytes, not JSON.stringify of the parsed body (KODA-02)', async () => {
      const raw = '{"failures":[{"test":"T"}],"commit":{"sha":"abc"},"pipeline":{"id":"1"},"event":"pipeline_failed"}';

      await controller.handleCiWebhook('koda', requestOf(JSON.parse(raw), raw), sign(raw));

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalled();
    });

    it('falls back to JSON.stringify(body) when rawBody is absent (Express test setups)', async () => {
      await controller.handleCiWebhook('koda', { body: validPayload }, sign(JSON.stringify(validPayload)));

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('B2: accepts the largest line that fits the ticket column', async () => {
      const body = { ...validPayload, failures: [{ test: 'T', line: 2147483647 }] };
      const raw = JSON.stringify(body);

      await controller.handleCiWebhook('koda', requestOf(body, raw), sign(raw));

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledTimes(1);
      expect(mockCiWebhookService.processCiWebhook.mock.calls[0][1].failures[0].line).toBe(2147483647);
    });
  });

  describe('every inbound auth failure is the same 401 (no slug enumeration)', () => {
    it('a bad signature is an AuthException 401 and processes nothing', async () => {
      const err = await badSignatureRejection();

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it('an unknown slug (or deleted project, or no token) gets the identical 401', async () => {
      const reference = await badSignatureRejection();
      mockCiWebhookService.findInboundTarget.mockResolvedValueOnce(null);
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      const err = await rejectionOf(
        controller.handleCiWebhook('nonexistent', request, sign(rawBytes.toString('utf8'))),
      );

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(err.getResponse()).toEqual(reference.getResponse());
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('a missing signature header gets the identical 401', async () => {
      const reference = await badSignatureRejection();

      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload), undefined));

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getResponse()).toEqual(reference.getResponse());
    });
  });

  describe('validation runs only after a valid signature', () => {
    const invalidPayload = { event: 'invalid_event', pipeline: { id: '1' }, commit: { sha: 'abc' }, failures: [] };

    it('an unsigned invalid payload gets the 401, not a validation error', async () => {
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(invalidPayload), 'sha256=bad'));

      expect(err).toBeInstanceOf(AuthException);
    });

    it('an unknown slug with an invalid payload gets the 401, not a validation error', async () => {
      mockCiWebhookService.findInboundTarget.mockResolvedValueOnce(null);

      const err = await rejectionOf(controller.handleCiWebhook('nonexistent', requestOf(invalidPayload), undefined));

      expect(err).toBeInstanceOf(AuthException);
    });

    it.each([
      ['an unknown event', invalidPayload],
      ['a zero line', { ...validPayload, failures: [{ test: 'T', line: 0 }] }],
      ['a fractional line', { ...validPayload, failures: [{ test: 'T', line: 1.5 }] }],
      ['a non-numeric line', { ...validPayload, failures: [{ test: 'T', line: 'abc' }] }],
      // Review B2: `Ticket.gitRefLine` is a PostgreSQL INTEGER, so one past the 32-bit maximum must
      // be a 400 here rather than a failed insert (a 500) for a correctly signed delivery.
      ['B2 a line one past the PostgreSQL INTEGER maximum', { ...validPayload, failures: [{ test: 'T', line: 2147483648 }] }],
      ['AC-1 missing pipeline', (({ pipeline: _pipeline, ...body }) => body)(validPayload)],
      ['AC-2 missing commit', (({ commit: _commit, ...body }) => body)(validPayload)],
      ['AC-3 null pipeline', { ...validPayload, pipeline: null }],
      ['AC-4 string pipeline', { ...validPayload, pipeline: '12345' }],
      ['AC-5 array commit', { ...validPayload, commit: [] }],
      ['an array body', [validPayload]],
      ['a null body', null],
    ])('a signed payload with %s is a 400 that neither processes nor records the delivery', async (_label, body) => {
      const raw = JSON.stringify(body);

      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(body, raw), sign(raw), 'delivery-invalid'));

      expect(err).toBeInstanceOf(ValidationAppException);
      expect(err.getStatus()).toBe(400);
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    /**
     * Permissions P2 US-006 AC-6: `pipeline_succeeded` is one of the events the endpoint accepts. It is
     * not a better-ticket event, so the service answers the "ignored" branch — but the delivery is
     * validated, recorded as a delivery and processed, not refused as a bad payload.
     */
    it.each(['pipeline_success', 'pipeline_succeeded'])('a signed %s event is accepted, not a 400', async (event) => {
      const body = { ...validPayload, event, failures: [] };
      const raw = JSON.stringify(body);

      await controller.handleCiWebhook('koda', requestOf(body, raw), sign(raw), `delivery-${event}`);

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledTimes(1);
      const forwarded = mockCiWebhookService.processCiWebhook.mock.calls[0][1];
      expect(forwarded).toBeInstanceOf(CiWebhookPayloadDto);
      expect(forwarded.event).toBe(event);
      expect(mockReplayGuard.assertFresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('v2 signature decisions', () => {
    const rawBody = JSON.stringify(validPayload);
    const nowTimestamp = () => String(Math.floor(Date.now() / 1000));
    const independentlySignV2 = (secret: string, timestamp: string, deliveryId: string, body = rawBody) =>
      `sha256=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;
    /** The same scheme over explicit bytes, as a sender holding a non-UTF-8 body would compute it. */
    const independentlySignV2Bytes = (secret: string, timestamp: string, deliveryId: string, body: Buffer) =>
      `sha256=${createHmac('sha256', secret)
        .update(Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8'))
        .update(body)
        .digest('hex')}`;
    /** A wire body that is not valid UTF-8: `0xff` continues no UTF-8 sequence. */
    const nonUtf8Bytes = () => Buffer.concat([Buffer.from('{"failures":['), Buffer.from([0xff]), Buffer.from(']}')]);

    it('AC-1: accepts v2-only and forwards the validated payload', async () => {
      const timestamp = nowTimestamp();
      const delivery = 'd-1';
      await controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), undefined, delivery, undefined,
        timestamp, independentlySignV2(SECRET, timestamp, delivery));
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', expect.any(CiWebhookPayloadDto));
    });

    it('AC-2: valid v2 controls even when v1 is wrong and required', async () => {
      mockConfig.get.mockImplementation((key: string) => key === WEBHOOK_SIGNATURE_CFG ? { v1Enabled: true, ciRequireV2: true } : undefined);
      const timestamp = nowTimestamp();
      await controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), 'sha256=wrong', 'd-2', undefined,
        timestamp, independentlySignV2(SECRET, timestamp, 'd-2'));
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledTimes(1);
    });

    it('AC-3/13: bad v2 matches bad-v1 refusal and does not touch replay protection', async () => {
      const reference = await badSignatureRejection();
      const timestamp = nowTimestamp();
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), sign(rawBody), 'd-3', undefined,
        timestamp, independentlySignV2('other-secret', timestamp, 'd-3')));
      expect(err.getResponse()).toEqual(reference.getResponse());
      expect(err.getStatus()).toBe(401);
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each([['AC-4', -301], ['AC-5', 301]])('%s: rejects timestamp outside tolerance', async (_ac, offset) => {
      const timestamp = String(Math.floor(Date.now() / 1000) + Number(offset));
      const delivery = 'd-time';
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), undefined, delivery, undefined,
        timestamp, independentlySignV2(SECRET, timestamp, delivery)));
      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
    });

    it('AC-6: rejects malformed timestamp', async () => {
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), undefined, 'd-invalid', undefined,
        'abc', independentlySignV2(SECRET, 'abc', 'd-invalid')));
      expect(err).toBeInstanceOf(AuthException);
    });

    it.each([['AC-7', 'delivery', undefined, '1700000000'], ['AC-8', 'timestamp', 'd-missing-time', undefined]])('%s: rejects missing %s', async (_ac, _name, delivery, timestamp) => {
      const ts = timestamp ?? '1700000000';
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), undefined, delivery, undefined,
        timestamp, independentlySignV2(SECRET, ts, delivery ?? '')));
      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
    });

    it('AC-9/14: require-v2 rejects v1-only before replay check', async () => {
      mockConfig.get.mockImplementation((key: string) => key === WEBHOOK_SIGNATURE_CFG ? { v1Enabled: true, ciRequireV2: true } : undefined);
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), sign(rawBody), 'd-v1'));
      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it('AC-10: defaults to v1 when signature config is undefined', async () => {
      await controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), sign(rawBody));
      expect(mockConfig.get).toHaveBeenCalledWith(WEBHOOK_SIGNATURE_CFG);
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledTimes(1);
    });

    it('AC-11: treats empty v2 as present and refuses fallback', async () => {
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), sign(rawBody), 'd-empty', undefined,
        nowTimestamp(), ''));
      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
    });

    it('AC-12: binds v2 signature to the received delivery id', async () => {
      const timestamp = nowTimestamp();
      const err = await rejectionOf(controller.handleCiWebhook('koda', requestOf(validPayload, rawBody), undefined, 'd-2', undefined,
        timestamp, independentlySignV2(SECRET, timestamp, 'd-1')));
      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
    });

    it('review B1: signs the raw body bytes, so a non-UTF-8 body verifies as received', async () => {
      const timestamp = nowTimestamp();
      const delivery = 'd-raw-bytes';
      const bytes = nonUtf8Bytes();
      const request: InboundWebhookRequest = { rawBody: bytes, body: validPayload };

      await controller.handleCiWebhook(
        'koda',
        request,
        undefined,
        delivery,
        undefined,
        timestamp,
        independentlySignV2Bytes(SECRET, timestamp, delivery, bytes),
      );

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', expect.any(CiWebhookPayloadDto));
    });

    it('review B1: refuses a signature computed over the UTF-8 decoding of a non-UTF-8 body', async () => {
      const timestamp = nowTimestamp();
      const delivery = 'd-decoded-bytes';
      const bytes = nonUtf8Bytes();
      const request: InboundWebhookRequest = { rawBody: bytes, body: validPayload };
      const decodedBytes = Buffer.from(bytes.toString('utf8'), 'utf8');
      // The decoded text is different bytes (`0xff` became the U+FFFD replacement), so this signature
      // matches the body only if the controller decodes before hashing.
      expect(decodedBytes.equals(bytes)).toBe(false);

      const err = await rejectionOf(controller.handleCiWebhook(
        'koda',
        request,
        undefined,
        delivery,
        undefined,
        timestamp,
        independentlySignV2Bytes(SECRET, timestamp, delivery, decodedBytes),
      ));

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it('review B1: refuses v2 when the raw bytes were not captured instead of re-serializing the payload', async () => {
      const timestamp = nowTimestamp();
      const delivery = 'd-no-raw-body';

      const err = await rejectionOf(controller.handleCiWebhook(
        'koda',
        { body: validPayload },
        undefined,
        delivery,
        undefined,
        timestamp,
        independentlySignV2(SECRET, timestamp, delivery),
      ));

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it('review B2: refuses an oversized delivery id that is correctly signed, before the replay guard', async () => {
      const timestamp = nowTimestamp();
      const delivery = 'd'.repeat(MAX_DELIVERY_ID_BYTES + 1);

      const err = await rejectionOf(controller.handleCiWebhook(
        'koda',
        requestOf(validPayload, rawBody),
        undefined,
        delivery,
        undefined,
        timestamp,
        independentlySignV2(SECRET, timestamp, delivery),
      ));

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('review B2: accepts a delivery id exactly at the byte limit', async () => {
      const timestamp = nowTimestamp();
      const delivery = 'd'.repeat(MAX_DELIVERY_ID_BYTES);

      await controller.handleCiWebhook(
        'koda',
        requestOf(validPayload, rawBody),
        undefined,
        delivery,
        undefined,
        timestamp,
        independentlySignV2(SECRET, timestamp, delivery),
      );

      expect(mockReplayGuard.assertFresh).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: delivery }),
      );
    });

    it('review B2: refuses an empty delivery id instead of failing later in the replay guard', async () => {
      const timestamp = nowTimestamp();

      const err = await rejectionOf(controller.handleCiWebhook(
        'koda',
        requestOf(validPayload, rawBody),
        undefined,
        '',
        undefined,
        timestamp,
        independentlySignV2(SECRET, timestamp, ''),
      ));

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });
  });

  describe('replay protection (SEC-1)', () => {
    it('checks replay after verification and validation, with the resolved project id', async () => {
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      await controller.handleCiWebhook('koda', request, sign(rawBytes.toString('utf8')), 'delivery-abc-123');

      expect(mockReplayGuard.assertFresh).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'ci',
        deliveryId: 'delivery-abc-123',
        dateHeader: undefined,
      });
    });

    it('rejects a replayed delivery with 409 and does not process it', async () => {
      mockReplayGuard.assertFresh.mockRejectedValueOnce(new HttpException('Webhook already processed', HttpStatus.CONFLICT));
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      await expect(
        controller.handleCiWebhook('koda', request, sign(rawBytes.toString('utf8')), 'delivery-dup'),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('forgets the delivery when processing fails so sender retries are accepted', async () => {
      mockCiWebhookService.processCiWebhook.mockRejectedValueOnce(new Error('boom'));
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      await expect(
        controller.handleCiWebhook('koda', request, sign(rawBytes.toString('utf8')), 'delivery-retry-1'),
      ).rejects.toThrow('boom');

      expect(mockReplayGuard.forget).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'ci',
        deliveryId: 'delivery-retry-1',
      });
    });

    /**
     * Permissions P2 US-006 AC-16/AC-17: the replay rows are the CI component's own bookkeeping. The
     * route is public, so the request enters as `SYSTEM/anonymous`; both guard calls must run as
     * `SYSTEM/ci` inside that context.
     */
    const captureActorDuring = (method: 'assertFresh' | 'forget'): Array<ActionContext | undefined> => {
      const captured: Array<ActionContext | undefined> = [];
      mockReplayGuard[method].mockImplementation(async () => {
        captured.push(currentContext());
      });
      return captured;
    };

    const anonymousRestContext = { actor: { type: 'SYSTEM' as const, id: 'anonymous' }, origin: 'rest' as const };

    it('AC-16: assertFresh runs as SYSTEM/ci even when the request entered as SYSTEM/anonymous', async () => {
      const captured = captureActorDuring('assertFresh');
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      await runWithActionContext(anonymousRestContext, () =>
        controller.handleCiWebhook('koda', request, sign(rawBytes.toString('utf8')), 'delivery-ci-actor'));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.actor).toEqual({ type: 'SYSTEM', id: 'ci' });
    });

    it('AC-17: forget runs as SYSTEM/ci when the intake throws', async () => {
      mockCiWebhookService.processCiWebhook.mockRejectedValueOnce(new Error('boom'));
      const captured = captureActorDuring('forget');
      const request = requestOf(validPayload);
      const rawBytes = request.rawBody ?? Buffer.alloc(0);

      await expect(runWithActionContext(anonymousRestContext, () =>
        controller.handleCiWebhook('koda', request, sign(rawBytes.toString('utf8')), 'delivery-ci-forget'),
      )).rejects.toThrow('boom');

      expect(captured).toHaveLength(1);
      expect(captured[0]?.actor).toEqual({ type: 'SYSTEM', id: 'ci' });
    });
  });
});
