import { Global, Inject, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AUDIT_STORAGE } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { AUDIT_ENTRY_REPOSITORY } from './domain/audit-entry.domain';
import { AuditLogModule } from './audit-log.module';
import { PrismaAuditEntryRepository } from './prisma-audit-entry.repository';
import { PrismaAuditStorage } from './prisma-audit.storage';
import { AuditLogService } from './audit-log.service';
import { PermissionService } from '../permissions/permission.service';
import { AuditRecorder } from './audit-recorder.service';
import { GlobalStubsModule, mockAuditRecorder } from '../common/test-helpers/global-stubs.module';

class RecorderConsumer { constructor(@Inject(AuditRecorder) readonly recorder: AuditRecorder) {} }
@Module({ providers: [RecorderConsumer], exports: [RecorderConsumer] })
class ConsumerModule {}

@Global()
@Module({ providers: [
  { provide: PermissionService, useValue: { can: vi.fn() } },
  { provide: PrismaService, useValue: { client: {} } },
  { provide: TRANSACTION_MANAGER, useValue: { run: vi.fn(), getClient: vi.fn(), isInTransaction: vi.fn() } },
], exports: [PrismaService, TRANSACTION_MANAGER, PermissionService] })
class GlobalMocksModule {}

describe('AuditLogModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });
  const compile = () => Test.createTestingModule({ imports: [GlobalMocksModule, AuditLogModule] }).compile();

  it('AC-14: resolves AUDIT_STORAGE as the PrismaAuditStorage singleton', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(AUDIT_STORAGE)).toBe(moduleRef.get(PrismaAuditStorage));
  });
  it('AC-15: resolves AUDIT_ENTRY_REPOSITORY as the repository singleton', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(AUDIT_ENTRY_REPOSITORY)).toBe(moduleRef.get(PrismaAuditEntryRepository));
  });
  it('exports AuditLogService as a public service', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(AuditLogService)).toBeInstanceOf(AuditLogService);
  });

  it('AC-19: makes AuditRecorder available to a sibling consumer module', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalMocksModule, AuditLogModule, ConsumerModule] }).compile();
    expect(moduleRef.get(RecorderConsumer).recorder).toBeInstanceOf(AuditRecorder);
  });

  it('AC-18: GlobalStubsModule injects its exported audit recorder mock', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ConsumerModule] }).compile();
    expect(moduleRef.get(RecorderConsumer).recorder).toBe(mockAuditRecorder);
  });
});
