import { HttpException, HttpStatus } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxAdminService } from './outbox-admin.service';

describe('OutboxAdminService', () => {
  const repo = {
    findByStatus: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    resetForRetry: jest.fn().mockResolvedValue(1),
  };
  const service = new OutboxAdminService(repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('lists pending events by default, 100 at most', async () => {
    await service.list();
    expect(repo.findByStatus).toHaveBeenCalledWith(OutboxStatus.PENDING, 100);
  });

  it('lists the requested status', async () => {
    await service.list(OutboxStatus.DEAD);
    expect(repo.findByStatus).toHaveBeenCalledWith(OutboxStatus.DEAD, 100);
  });

  it.each([OutboxStatus.DEAD, OutboxStatus.PENDING])('retries a %s event', async (status) => {
    repo.findById.mockResolvedValue({ id: 'e1', status });
    await service.retry('e1');
    expect(repo.resetForRetry).toHaveBeenCalledWith('e1', expect.any(Date));
  });

  it('404s an unknown event', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.retry('missing')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.resetForRetry).not.toHaveBeenCalled();
  });

  it.each([OutboxStatus.PROCESSING, OutboxStatus.PUBLISHED])('409s a %s event (no double delivery)', async (status) => {
    repo.findById.mockResolvedValue({ id: 'e1', status });
    const result = service.retry('e1');
    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    expect(repo.resetForRetry).not.toHaveBeenCalled();
  });

  it('409s when the row changed status between the read and the reset', async () => {
    repo.findById.mockResolvedValue({ id: 'e1', status: OutboxStatus.DEAD });
    repo.resetForRetry.mockResolvedValueOnce(0);
    await expect(service.retry('e1')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });
});
