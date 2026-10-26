import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { ApprovalApiModule } from './approval-api.module';
import { ApprovalRequestsController } from './approval-requests.controller';

describe('ApprovalApiModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });
  it('AC-9: resolves ApprovalRequestsController without a database', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalApiModule] }).compile();
    expect(moduleRef.get(ApprovalRequestsController)).toBeInstanceOf(ApprovalRequestsController);
  });
});
