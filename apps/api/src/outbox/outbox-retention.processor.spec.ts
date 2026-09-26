import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxRetentionProcessor } from './outbox-retention.processor';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { IOutboxConfig, OUTBOX_CFG } from '../config/outbox.config';

const createMockRepository = () => ({
  deleteTerminalBefore: jest.fn(),
});

const createMockConfig = (config: IOutboxConfig) => ({
  get: jest.fn().mockReturnValue(config),
});

const baseConfig = (days: number | null): IOutboxConfig => ({
  relay: {
    enabled: false,
    pollIntervalMs: 1000,
    batchSize: 20,
    leaseMs: 30000,
    maxAttempts: 8,
    backoffBaseMs: 2000,
    backoffCapMs: 300000,
  },
  retention: { days },
});

describe('OutboxRetentionProcessor', () => {
  let processor: OutboxRetentionProcessor;
  let mockRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    mockRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        OutboxRetentionProcessor,
        { provide: PrismaOutboxRepository, useValue: mockRepository },
        { provide: ConfigService, useValue: createMockConfig(baseConfig(30)) },
        SchedulerRegistry,
        Reflector,
      ],
    }).compile();

    processor = module.get<OutboxRetentionProcessor>(OutboxRetentionProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('runs daily at 04:00 (03:00 belongs to memory governance)', () => {
    const reflector = new Reflector();
    const cronOptions = reflector.get('SCHEDULE_CRON_OPTIONS', processor.scheduledPurge);
    expect(cronOptions).toMatchObject({ cronTime: '0 4 * * *' });
  });

  it('purges published and dead rows older than the retention window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-26T04:00:00.000Z'));
    mockRepository.deleteTerminalBefore.mockResolvedValue(12);

    await processor.scheduledPurge();

    expect(mockRepository.deleteTerminalBefore).toHaveBeenCalledWith(
      [OutboxStatus.PUBLISHED, OutboxStatus.DEAD],
      new Date('2026-08-27T04:00:00.000Z'),
    );
  });

  it('is a no-op when the retention window is unset (repo never called)', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        OutboxRetentionProcessor,
        { provide: PrismaOutboxRepository, useValue: mockRepository },
        { provide: ConfigService, useValue: createMockConfig(baseConfig(null)) },
        SchedulerRegistry,
        Reflector,
      ],
    }).compile();
    const disabled = module.get<OutboxRetentionProcessor>(OutboxRetentionProcessor);

    await disabled.scheduledPurge();

    expect(mockRepository.deleteTerminalBefore).not.toHaveBeenCalled();
  });

  it('never throws when the purge fails', async () => {
    mockRepository.deleteTerminalBefore.mockRejectedValue(new Error('deadlock detected'));

    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
  });
});
