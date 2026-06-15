import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaProjectRepository } from '../../projects/prisma-project.repository';

export const mockPrismaService = {
  client: {},
} as unknown as PrismaService;

export const mockTransactionManager: ITransactionManager = {
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  getClient: () => undefined,
  isInTransaction: () => false,
};

export const mockConfigService = {
  get: <T = unknown>(key?: string): T | undefined => key as unknown as T,
} as unknown as ConfigService;

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: mockPrismaService },
    { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
    { provide: ConfigService, useValue: mockConfigService },
    PrismaProjectRepository,
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, ConfigService, PrismaProjectRepository],
})
export class GlobalStubsModule {}
