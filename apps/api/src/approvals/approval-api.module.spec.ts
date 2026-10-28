import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { ApprovalApiModule } from './approval-api.module';
import { ApprovalRequestsController } from './approval-requests.controller';
import { ApprovalPoliciesController } from './approval-policies.controller';
import { ApprovalRouteCommands } from './approval-route.commands';

describe('ApprovalApiModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });
  it('AC-9: resolves ApprovalRequestsController without a database', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalApiModule] }).compile();
    expect(moduleRef.get(ApprovalRequestsController)).toBeInstanceOf(ApprovalRequestsController);
    expect(moduleRef.get(ApprovalPoliciesController)).toBeInstanceOf(ApprovalPoliciesController);
    expect(moduleRef.get(ApprovalRouteCommands)).toBeInstanceOf(ApprovalRouteCommands);
  });
});
