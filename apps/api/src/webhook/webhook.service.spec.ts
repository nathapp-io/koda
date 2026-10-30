import type { Mock, Mocked } from 'vitest';
/**
 * US-003 — validate create URLs and add the ADMIN-only update path to WebhookService.
 *
 * ACs covered here (service level):
 *  AC1  create: an OutboundUrlRejection becomes ValidationAppException args { reason } and nothing is written
 *  AC2  create: a resolving guard leads to exactly one createWebhook with the given url
 *  AC3  update: the new url is checked with the guard before the repository update
 *  AC4  update: { active } alone never checks the url
 *  AC5  update: events are serialized to the JSON string the column stores
 *  AC6  update: a webhook of another project is NotFoundAppException and is not written
 *  AC7  update: a missing webhook is NotFoundAppException
 *  AC8  update: returns the secret-free WebhookView
 *  AC16 unresolvable hostnames become ValidationAppException args { reason: 'unresolvable' }
 *
 * The `DnsResolver` seam is stubbed (never a real lookup) exactly as US-002 does, so the
 * "real guard" cases below run the production `OutboundUrlGuard` with no network access.
 */
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../generated/prisma/client';
import type { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WebhookService } from './webhook.service';
import { DnsResolver } from './outbound/dns-resolver';
import { OutboundUrlGuard, OutboundUrlRejection } from './outbound/outbound-url-guard';
import type { IWebhookConfig } from '../config/webhook.config';
import type { WebhookDomain, WebhookListItem, WebhookView } from './domain/webhook.domain';
import type { AuditRecorder } from '../audit/audit-recorder.service';

const mockAuditRecorder = {
  audited: vi.fn(async <T>(fn: () => Promise<T>, entriesOf: (result: T) => unknown) => {
    const result = await fn();
    entriesOf(result);
    return result;
  }),
  record: vi.fn(),
} as unknown as AuditRecorder;

interface UrlGuardStub {
  checkUrl: Mock<(...args: [string]) => Promise<void>>;
}

function makeUrlGuardStub(): UrlGuardStub {
  return { checkUrl: vi.fn<(...args: [string]) => Promise<void>>().mockResolvedValue(undefined) };
}

function makeWebhookRepo(): Mocked<PrismaWebhookRepository> {
  return {
    createWebhook: vi.fn(),
    findByProject: vi.fn(),
    findActiveByProject: vi.fn(),
    findById: vi.fn(),
    deleteWebhook: vi.fn(),
    findProjectBySlug: vi.fn(),
    update: vi.fn(),
  } as unknown as Mocked<PrismaWebhookRepository>;
}

const mockWebhook: WebhookDomain = {
  id: 'wh-1',
  projectId: 'proj-1',
  url: 'https://example.com/hook',
  secret: 'abc123',
  events: '["ticket.created"]',
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const mockListItem: WebhookListItem = {
  id: 'wh-1',
  projectId: 'proj-1',
  url: 'https://example.com/hook',
  events: '["ticket.created"]',
  createdAt: mockWebhook.createdAt,
};

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  deletedAt: null,
};

/** Resolves to the rejection of `promise` instead of throwing, so the error can be inspected. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Asserts the observable shape of an OutboundUrlRejection surfaced as a validation error. */
async function expectValidationRejection(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await captureError(promise);

  expect(error).toBeInstanceOf(ValidationAppException);
  expect((error as ValidationAppException).args).toEqual({ reason });
}

const webhookConfig: IWebhookConfig = {
  allowedHostnames: [],
  allowedCidrs: [],
  deliveryTimeoutMs: 5000,
};

/** The US-002 failure mode: the hostname does not resolve (ENOTFOUND), never a real lookup. */
function makeUnresolvableResolver(): DnsResolver {
  return {
    resolve: async (hostname: string): Promise<string[]> => {
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    },
  };
}

describe('WebhookService', () => {
  let service: WebhookService;
  let webhookRepo: Mocked<PrismaWebhookRepository>;
  let urlGuard: UrlGuardStub;

  beforeEach(() => {
    webhookRepo = makeWebhookRepo();
    urlGuard = makeUrlGuardStub();
    service = new WebhookService(webhookRepo, urlGuard as unknown as OutboundUrlGuard, mockAuditRecorder);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('audits created webhook configuration without exposing values', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      await service.create('proj-1', {
        url: 'https://example.com/hook', events: ['ticket.created'], secret: 'sensitive',
      });

      expect(mockAuditRecorder.audited).toHaveBeenCalled();
      const entriesOf = vi.mocked(mockAuditRecorder.audited).mock.calls.at(-1)?.[1];
      expect(entriesOf?.(mockWebhook)).toMatchObject({
        key: 'webhook.create', resourceType: 'webhook', resourceId: 'wh-1',
        projectId: 'proj-1', summary: 'created',
      });
      expect(JSON.stringify(entriesOf?.(mockWebhook))).not.toContain('sensitive');
    });

    it('creates a webhook with the provided secret', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      const result = await service.create('proj-1', {
        url: 'https://example.com/hook',
        events: ['ticket.created'],
        secret: 'my-secret',
      });

      expect(webhookRepo.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ secret: 'my-secret', url: 'https://example.com/hook' }),
      );
      expect(result).toEqual(mockWebhook);
    });

    it('generates a random secret when none is provided', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      await service.create('proj-1', {
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      });

      expect(webhookRepo.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ secret: expect.any(String) }),
      );
      const callArg = webhookRepo.createWebhook.mock.calls[0][0];
      expect(callArg.secret).toHaveLength(40); // 20 bytes in hex
    });

    it('serializes events array to JSON string', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      await service.create('proj-1', {
        url: 'https://example.com/hook',
        events: ['ticket.created', 'ticket.updated'],
      });

      const callArg = webhookRepo.createWebhook.mock.calls[0][0];
      expect(callArg.events).toBe('["ticket.created","ticket.updated"]');
    });

    it('AC1: throws ValidationAppException with args { reason: "blocked_destination" } and does not create the webhook', async () => {
      urlGuard.checkUrl.mockRejectedValue(new OutboundUrlRejection('blocked_destination'));

      await expectValidationRejection(
        service.create('proj-1', { url: 'https://10.0.0.5/hook', events: ['STATUS_CHANGE'] }),
        'blocked_destination',
      );

      expect(webhookRepo.createWebhook).not.toHaveBeenCalled();
    });

    it('AC1 boundary: reports the guard reason it was given (credentials_not_allowed)', async () => {
      urlGuard.checkUrl.mockRejectedValue(new OutboundUrlRejection('credentials_not_allowed'));

      await expectValidationRejection(
        service.create('proj-1', { url: 'https://user:pw@hooks.example/', events: ['STATUS_CHANGE'] }),
        'credentials_not_allowed',
      );

      expect(webhookRepo.createWebhook).not.toHaveBeenCalled();
    });

    it('AC2: calls createWebhook once with the given url when the guard resolves', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      await service.create('proj-1', {
        url: 'https://hooks.example/hook',
        events: ['STATUS_CHANGE'],
      });

      expect(urlGuard.checkUrl).toHaveBeenCalledWith('https://hooks.example/hook');
      expect(webhookRepo.createWebhook).toHaveBeenCalledTimes(1);
      expect(webhookRepo.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1', url: 'https://hooks.example/hook' }),
      );
    });

    it('US-003: create checks the url with the guard before creating the webhook', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      await service.create('proj-1', {
        url: 'https://hooks.example/hook',
        events: ['STATUS_CHANGE'],
      });

      expect(urlGuard.checkUrl).toHaveBeenCalledWith('https://hooks.example/hook');
      expect(urlGuard.checkUrl.mock.invocationCallOrder[0]).toBeLessThan(
        webhookRepo.createWebhook.mock.invocationCallOrder[0],
      );
    });

    it('AC16: throws ValidationAppException with args { reason: "unresolvable" } and creates no webhook', async () => {
      urlGuard.checkUrl.mockRejectedValue(new OutboundUrlRejection('unresolvable'));

      await expectValidationRejection(
        service.create('proj-1', { url: 'https://unresolvable.example/hook', events: ['STATUS_CHANGE'] }),
        'unresolvable',
      );

      expect(webhookRepo.createWebhook).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('AC3: checks the new url with the guard before updating the webhook', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, url: 'https://hooks.example/new' });

      await service.update('proj-1', 'wh-1', { url: 'https://hooks.example/new' });

      expect(urlGuard.checkUrl).toHaveBeenCalledWith('https://hooks.example/new');
      expect(urlGuard.checkUrl.mock.invocationCallOrder[0]).toBeLessThan(
        webhookRepo.update.mock.invocationCallOrder[0],
      );
    });

    it('AC4: does not check the url when only active is provided', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, active: false });

      await service.update('proj-1', 'wh-1', { active: false });

      expect(urlGuard.checkUrl).not.toHaveBeenCalled();
    });

    it('AC4: passes only the provided active field to the repository update', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, active: false });

      await service.update('proj-1', 'wh-1', { active: false });

      expect(webhookRepo.update).toHaveBeenCalledTimes(1);
      expect(webhookRepo.update).toHaveBeenCalledWith('wh-1', { active: false });
    });

    it('AC5: serializes events to the JSON string the repository stores', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, events: '["STATUS_CHANGE"]' });

      await service.update('proj-1', 'wh-1', { events: ['STATUS_CHANGE'] });

      expect(webhookRepo.update).toHaveBeenCalledTimes(1);
      expect(webhookRepo.update).toHaveBeenCalledWith('wh-1', { events: '["STATUS_CHANGE"]' });
    });

    it('AC6: throws NotFoundAppException for a webhook owned by another project and does not update it', async () => {
      webhookRepo.findById.mockResolvedValue({ ...mockWebhook, projectId: 'p2' });

      await expect(service.update('p1', 'wh-1', { active: false })).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.update).not.toHaveBeenCalled();
      expect(urlGuard.checkUrl).not.toHaveBeenCalled();
    });

    it('AC7: throws NotFoundAppException when the webhook does not exist and does not update anything', async () => {
      webhookRepo.findById.mockResolvedValue(null);

      await expect(service.update('proj-1', 'wh-missing', { active: false })).rejects.toThrow(
        NotFoundAppException,
      );
      expect(webhookRepo.update).not.toHaveBeenCalled();
    });

    it('AC8: returns the view with id, projectId, url, events, active and createdAt and no secret', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, active: false });

      const view: WebhookView = await service.update('proj-1', 'wh-1', { active: false });

      expect(view).toEqual({
        id: 'wh-1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: '["ticket.created"]',
        active: false,
        createdAt: mockWebhook.createdAt,
      });
      expect(view).not.toHaveProperty('secret');
    });

    it('AC8 boundary: returns the view of the updated url after a url change', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, url: 'https://hooks.example/new' });

      const view: WebhookView = await service.update('proj-1', 'wh-1', {
        url: 'https://hooks.example/new',
      });

      expect(view.url).toBe('https://hooks.example/new');
      expect(view).not.toHaveProperty('secret');
    });

    it('AC16: throws ValidationAppException with args { reason: "unresolvable" } and leaves the webhook unchanged', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      urlGuard.checkUrl.mockRejectedValue(new OutboundUrlRejection('unresolvable'));

      await expectValidationRejection(
        service.update('proj-1', 'wh-1', { url: 'https://unresolvable.example/hook' }),
        'unresolvable',
      );

      expect(webhookRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('prepareCreate', () => {
    const dto = { url: 'https://hooks.example/hook', events: ['STATUS_CHANGE'] };

    it('AC-10: checks the url once and writes nothing until the returned callback runs', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      const write = await service.prepareCreate('proj-1', dto);

      expect(urlGuard.checkUrl).toHaveBeenCalledExactlyOnceWith('https://hooks.example/hook');
      expect(webhookRepo.createWebhook).not.toHaveBeenCalled();

      const created = await write();

      expect(webhookRepo.createWebhook).toHaveBeenCalledTimes(1);
      expect(created).toEqual(mockWebhook);
    });

    it('AC-10 boundary: the callback generates the same 40-character secret create would', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      await (await service.prepareCreate('proj-1', dto))();

      expect(webhookRepo.createWebhook.mock.calls[0][0].secret).toHaveLength(40);
    });

    it('AC-11: answers a webhooks validation error and no callback for a blocked destination', async () => {
      urlGuard.checkUrl.mockRejectedValue(new OutboundUrlRejection('blocked_destination'));

      const error = await captureError(service.prepareCreate('proj-1', { url: 'https://10.0.0.5/hook', events: ['STATUS_CHANGE'] }));

      expect(error).toBeInstanceOf(ValidationAppException);
      expect((error as ValidationAppException).args).toEqual({ reason: 'blocked_destination' });
      expect((error as ValidationAppException).prefix).toBe('webhooks');
      expect(webhookRepo.createWebhook).not.toHaveBeenCalled();
    });

    it('AC-11 boundary: a guard the url check does not own is rethrown unchanged', async () => {
      const failure = new Error('resolver exploded');
      urlGuard.checkUrl.mockRejectedValue(failure);

      await expect(service.prepareCreate('proj-1', dto)).rejects.toBe(failure);
    });

    it('create prepares and runs the same write', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook);

      const created = await service.create('proj-1', dto);

      expect(urlGuard.checkUrl).toHaveBeenCalledExactlyOnceWith('https://hooks.example/hook');
      expect(webhookRepo.createWebhook).toHaveBeenCalledTimes(1);
      expect(created).toEqual(mockWebhook);
    });
  });

  describe('prepareUpdate', () => {
    it('AC-12: answers 404 webhooks for another project and checks no url', async () => {
      webhookRepo.findById.mockResolvedValue({ ...mockWebhook, projectId: 'p2' });

      const error = await captureError(
        service.prepareUpdate('p1', 'wh-1', { active: false, url: 'https://hooks.example/new' }),
      );

      expect(error).toBeInstanceOf(NotFoundAppException);
      expect((error as NotFoundAppException).prefix).toBe('webhooks');
      expect(urlGuard.checkUrl).not.toHaveBeenCalled();
      expect(webhookRepo.update).not.toHaveBeenCalled();
    });

    it('AC-12: the prepared update answers 404 and calls no update when the webhook is deleted first', async () => {
      webhookRepo.findById.mockResolvedValueOnce(mockWebhook).mockResolvedValueOnce(null);

      const write = await service.prepareUpdate('proj-1', 'wh-1', { active: false });

      await expect(write()).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.update).not.toHaveBeenCalled();
    });

    it('AC-12 boundary: the callback answers 404 when the webhook moved to another project', async () => {
      webhookRepo.findById
        .mockResolvedValueOnce(mockWebhook)
        .mockResolvedValueOnce({ ...mockWebhook, projectId: 'p2' });

      const write = await service.prepareUpdate('proj-1', 'wh-1', { active: false });

      await expect(write()).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.update).not.toHaveBeenCalled();
    });

    it('checks an optional url once and writes only when the callback runs', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockResolvedValue({ ...mockWebhook, url: 'https://hooks.example/new' });

      const write = await service.prepareUpdate('proj-1', 'wh-1', { url: 'https://hooks.example/new' });

      expect(urlGuard.checkUrl).toHaveBeenCalledExactlyOnceWith('https://hooks.example/new');
      expect(webhookRepo.update).not.toHaveBeenCalled();

      const view = await write();

      expect(webhookRepo.update).toHaveBeenCalledExactlyOnceWith('wh-1', { url: 'https://hooks.example/new' });
      expect(view.url).toBe('https://hooks.example/new');
      expect(view).not.toHaveProperty('secret');
    });

    it('answers 404 instead of a 500 when the row vanishes between the re-read and the write', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' }),
      );

      const write = await service.prepareUpdate('proj-1', 'wh-1', { active: false });

      await expect(write()).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('with the real OutboundUrlGuard over an unresolvable hostname', () => {
    let realGuardService: WebhookService;

    beforeEach(() => {
      realGuardService = new WebhookService(
        webhookRepo,
        new OutboundUrlGuard(webhookConfig, makeUnresolvableResolver()),
        mockAuditRecorder,
      );
    });

    it('AC16: create throws ValidationAppException with args { reason: "unresolvable" } for an unresolvable hostname', async () => {
      await expectValidationRejection(
        realGuardService.create('proj-1', {
          url: 'https://unresolvable.example/hook',
          events: ['STATUS_CHANGE'],
        }),
        'unresolvable',
      );

      expect(webhookRepo.createWebhook).not.toHaveBeenCalled();
    });

    it('AC16: update throws ValidationAppException with args { reason: "unresolvable" } for an unresolvable hostname', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);

      await expectValidationRejection(
        realGuardService.update('proj-1', 'wh-1', { url: 'https://unresolvable.example/hook' }),
        'unresolvable',
      );

      expect(webhookRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns webhooks for a project', async () => {
      webhookRepo.findByProject.mockResolvedValue([mockListItem]);

      const result = await service.findAll('proj-1');

      expect(webhookRepo.findByProject).toHaveBeenCalledWith('proj-1');
      expect(result).toEqual([mockListItem]);
    });
  });

  describe('findById', () => {
    it('returns the webhook when found', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);

      const result = await service.findById('wh-1');

      expect(result).toEqual(mockWebhook);
    });

    it('returns null when not found', async () => {
      webhookRepo.findById.mockResolvedValue(null);

      const result = await service.findById('wh-missing');

      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('deletes webhook when it exists', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.deleteWebhook.mockResolvedValue(mockWebhook);

      await service.remove('wh-1');

      expect(webhookRepo.deleteWebhook).toHaveBeenCalledWith('wh-1');
    });

    it('throws NotFoundAppException when webhook does not exist', async () => {
      webhookRepo.findById.mockResolvedValue(null);

      await expect(service.remove('wh-missing')).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.deleteWebhook).not.toHaveBeenCalled();
    });
  });

  describe('removeForProject', () => {
    it("deletes the project's own webhook", async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);
      webhookRepo.deleteWebhook.mockResolvedValue(mockWebhook);

      await service.removeForProject('proj-1', 'wh-1');

      expect(webhookRepo.deleteWebhook).toHaveBeenCalledWith('wh-1');
    });

    it("throws NotFoundAppException for another project's webhook and deletes nothing", async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook);

      await expect(service.removeForProject('proj-other', 'wh-1')).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.deleteWebhook).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppException when the webhook does not exist', async () => {
      webhookRepo.findById.mockResolvedValue(null);

      await expect(service.removeForProject('proj-1', 'wh-missing')).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.deleteWebhook).not.toHaveBeenCalled();
    });
  });

  describe('findByProjectSlug', () => {
    it('returns webhooks when project exists', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(mockProject);
      webhookRepo.findByProject.mockResolvedValue([mockListItem]);

      const result = await service.findByProjectSlug('alpha');

      expect(webhookRepo.findProjectBySlug).toHaveBeenCalledWith('alpha');
      expect(webhookRepo.findByProject).toHaveBeenCalledWith('proj-1');
      expect(result).toHaveLength(1);
    });

    it('throws NotFoundAppException when project not found', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.findByProjectSlug('missing')).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });

      await expect(service.findByProjectSlug('alpha')).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('getProjectBySlug', () => {
    it('returns project id when project exists', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(mockProject);

      const result = await service.getProjectBySlug('alpha');

      expect(result).toEqual({ id: 'proj-1' });
    });

    it('throws NotFoundAppException when project not found', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.getProjectBySlug('missing')).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });

      await expect(service.getProjectBySlug('alpha')).rejects.toThrow(NotFoundAppException);
    });
  });
});
