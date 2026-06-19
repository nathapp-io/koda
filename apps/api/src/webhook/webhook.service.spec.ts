import { WebhookService } from './webhook.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { PrismaWebhookRepository } from './prisma-webhook.repository';

function makeWebhookRepo(): jest.Mocked<PrismaWebhookRepository> {
  return {
    createWebhook: jest.fn(),
    findByProject: jest.fn(),
    findById: jest.fn(),
    deleteWebhook: jest.fn(),
    findProjectBySlug: jest.fn(),
  } as unknown as jest.Mocked<PrismaWebhookRepository>;
}

const mockWebhook = {
  id: 'wh-1',
  projectId: 'proj-1',
  url: 'https://example.com/hook',
  secret: 'abc123',
  events: '["ticket.created"]',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  deletedAt: null,
};

describe('WebhookService', () => {
  let service: WebhookService;
  let webhookRepo: jest.Mocked<PrismaWebhookRepository>;

  beforeEach(() => {
    webhookRepo = makeWebhookRepo();
    service = new WebhookService(webhookRepo);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a webhook with the provided secret', async () => {
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook as any);

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
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook as any);

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
      webhookRepo.createWebhook.mockResolvedValue(mockWebhook as any);

      await service.create('proj-1', {
        url: 'https://example.com/hook',
        events: ['ticket.created', 'ticket.updated'],
      });

      const callArg = webhookRepo.createWebhook.mock.calls[0][0];
      expect(callArg.events).toBe('["ticket.created","ticket.updated"]');
    });
  });

  describe('findAll', () => {
    it('returns webhooks for a project', async () => {
      const list = [{ id: 'wh-1', url: 'https://a.com' }];
      webhookRepo.findByProject.mockResolvedValue(list as any);

      const result = await service.findAll('proj-1');

      expect(webhookRepo.findByProject).toHaveBeenCalledWith('proj-1');
      expect(result).toEqual(list);
    });
  });

  describe('findById', () => {
    it('returns the webhook when found', async () => {
      webhookRepo.findById.mockResolvedValue(mockWebhook as any);

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
      webhookRepo.findById.mockResolvedValue(mockWebhook as any);
      webhookRepo.deleteWebhook.mockResolvedValue(undefined);

      await service.remove('wh-1');

      expect(webhookRepo.deleteWebhook).toHaveBeenCalledWith('wh-1');
    });

    it('throws NotFoundAppException when webhook does not exist', async () => {
      webhookRepo.findById.mockResolvedValue(null);

      await expect(service.remove('wh-missing')).rejects.toThrow(NotFoundAppException);
      expect(webhookRepo.deleteWebhook).not.toHaveBeenCalled();
    });
  });

  describe('findByProjectSlug', () => {
    it('returns webhooks when project exists', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(mockProject as any);
      webhookRepo.findByProject.mockResolvedValue([mockWebhook] as any);

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
      webhookRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() } as any);

      await expect(service.findByProjectSlug('alpha')).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('getProjectBySlug', () => {
    it('returns project id when project exists', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(mockProject as any);

      const result = await service.getProjectBySlug('alpha');

      expect(result).toEqual({ id: 'proj-1' });
    });

    it('throws NotFoundAppException when project not found', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.getProjectBySlug('missing')).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      webhookRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() } as any);

      await expect(service.getProjectBySlug('alpha')).rejects.toThrow(NotFoundAppException);
    });
  });
});
