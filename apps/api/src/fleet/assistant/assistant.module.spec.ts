import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { AssistantModule } from './assistant.module';
import { AssistantToolExecutor } from './assistant-tool.executor';

describe('AssistantModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [GlobalStubsModule, AssistantModule] }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('AC-15: compiles and resolves AssistantToolExecutor', () => {
    expect(module.get(AssistantToolExecutor)).toBeDefined();
  });
});
