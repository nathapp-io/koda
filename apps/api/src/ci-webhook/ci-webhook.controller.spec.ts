import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AuthException, ValidationAppException } from '@nathapp/nestjs-common';
import { createHmac } from 'node:crypto';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto } from './ci-webhook.dto';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
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

describe('CiWebhookController', () => {
  let controller: CiWebhookController;

  const mockCiWebhookService = {
    findInboundTarget: jest.fn(),
    processCiWebhook: jest.fn(),
  };

  const mockReplayGuard = {
    assertFresh: jest.fn(),
    forget: jest.fn(),
  };

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [
        { provide: CiWebhookService, useValue: mockCiWebhookService },
        { provide: WebhookReplayGuard, useValue: mockReplayGuard },
      ],
    }).compile();

    controller = module.get<CiWebhookController>(CiWebhookController);
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
  });
});
