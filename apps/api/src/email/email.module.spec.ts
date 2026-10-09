import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { EmailAvailability } from './email-availability';
import { EmailCoreModule } from './email.module';
import { EmailScheduleRepository } from './schedule/email-schedule.repository';
import { EmailScheduleService } from './schedule/email-schedule.service';

const EMAIL_CFG_VALUE = {
  smtpUrl: null, from: null, webPublicUrl: null, delaySec: 300, approvalDelaySec: 60, maxAttempts: 5, inviteTtlDays: 7,
};

/** S4b US-001: EmailCoreModule's collaborators (ConfigService, PrismaService) without a database. */
@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: { get: () => EMAIL_CFG_VALUE } },
    { provide: PrismaService, useValue: { client: {} } },
  ],
  exports: [ConfigService, PrismaService],
})
class EmailCoreStubsModule {}

describe('EmailCoreModule (S4b US-001 DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [EmailCoreStubsModule, EmailCoreModule] }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('provides the EmailScheduleService globally', () => {
    expect(moduleRef.get(EmailScheduleService)).toBeInstanceOf(EmailScheduleService);
  });

  it('resolves the private repository behind the service', () => {
    expect(moduleRef.select(EmailCoreModule).get(EmailScheduleRepository)).toBeInstanceOf(EmailScheduleRepository);
  });

  it('keeps EmailAvailability available to every module', () => {
    expect(moduleRef.get(EmailAvailability)).toBeInstanceOf(EmailAvailability);
  });
});
