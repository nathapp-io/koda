import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalAskService } from '../../approvals/approval-ask.service';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { ApprovalCloser } from './approval-closer';
import { FLEET_APPROVAL_ASK_REPOSITORY } from './domain/fleet-approval-ask.domain';
import { ApprovalStoreModule } from './approval-store.module';
import { FleetApprovalAskStore } from './fleet-approval-ask.store';

/**
 * DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`.
 * `moduleRef.get` is non-strict and resolves from the whole container, so this catches an import cycle
 * or a provider that is no longer declared at all, not one merely dropped from `exports`.
 */

/** US-009 AC-11: a consumer that only sees what ApprovalStoreModule exports. */
@Injectable()
class AskStoreConsumer {
  constructor(readonly store: FleetApprovalAskStore) {}
}

@Module({ imports: [GlobalStubsModule, ApprovalStoreModule], providers: [AskStoreConsumer] })
class AskStoreConsumerModule {}

/** US-009 AC-12: the legacy exports a consumer injected before the ask store existed (US-012 pin). */
@Injectable()
class LegacyApprovalConsumer {
  constructor(
    readonly closer: ApprovalCloser,
  ) {}
}

@Module({ imports: [GlobalStubsModule, ApprovalStoreModule], providers: [LegacyApprovalConsumer] })
class LegacyApprovalConsumerModule {}

/**
 * Every provider or export of the module, named the way its metadata shows it: a class by its name, a DI token by
 * its description (`Symbol(APPROVAL_REPOSITORY)`). US-012 asserts on the absence of the legacy names this way, since
 * the token and the class no longer exist to be referenced.
 */
const memberNames = (key: 'providers' | 'exports'): string[] =>
  ((Reflect.getMetadata(key, ApprovalStoreModule) ?? []) as unknown[]).map((member) => {
    const target = typeof member === 'object' && member !== null && 'provide' in member
      ? (member as { provide: unknown }).provide
      : member;
    return typeof target === 'function' ? target.name : String(target);
  });

describe('ApprovalStoreModule', () => {
  it('compiles and resolves the closer only', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalStoreModule] }).compile();
    try {
      expect(moduleRef.get(ApprovalCloser)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });

  it('US-006: imports the approval engine, so the closer can open and close bash asks on it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalStoreModule] }).compile();
    try {
      const imported = (Reflect.getMetadata('imports', ApprovalStoreModule) ?? []) as unknown[];
      expect(imported).toContain(ApprovalEngineModule);
      // The closer's engine collaborator resolves through that import; without it the module does not compile.
      expect(moduleRef.get(ApprovalAskService, { strict: false })).toBeInstanceOf(ApprovalAskService);
    } finally {
      await moduleRef.close();
    }
  });

  it('AC-11: a consumer importing the module injects FleetApprovalAskStore, which stays its only public face', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AskStoreConsumerModule] }).compile();
    try {
      const consumer = moduleRef.get(AskStoreConsumer);
      expect(consumer.store).toBeInstanceOf(FleetApprovalAskStore);
      const exported = (Reflect.getMetadata('exports', ApprovalStoreModule) ?? []) as unknown[];
      // The store is the public face; the token it injects stays inside the module.
      expect(exported).toContain(FleetApprovalAskStore);
      expect(exported).not.toContain(FLEET_APPROVAL_ASK_REPOSITORY);
    } finally {
      await moduleRef.close();
    }
  });

  it('AC-12: a consumer still injects the closer only', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [LegacyApprovalConsumerModule] }).compile();
    try {
      const consumer = moduleRef.get(LegacyApprovalConsumer);
      expect(consumer.closer).toBeInstanceOf(ApprovalCloser);
    } finally {
      await moduleRef.close();
    }
  });

  it('US-012: neither provides nor exports the legacy FleetApproval repository or its token', () => {
    // The `FleetApproval` table is gone, so nothing may still resolve the repository that read it.
    for (const name of ['PrismaApprovalRepository', 'Symbol(APPROVAL_REPOSITORY)', 'ApprovalLivePublisher']) {
      expect(memberNames('providers')).not.toContain(name);
      expect(memberNames('exports')).not.toContain(name);
    }
  });
});
