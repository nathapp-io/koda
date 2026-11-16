import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { VcsModule } from '../../vcs/vcs.module';
import { VCS_CFG } from '../../config/vcs.config';
import { GitBrokerModule } from './git-broker.module';
import { GitHubAppClient } from './github-app-client';
import { GitLabAccessChecker } from './gitlab-access-checker';
import { GitLabRepoCredentials } from './gitlab-repo-credentials';
import { FleetHttpClient } from './fleet-http-client';
import { GitTokenBroker } from './git-token.broker';

@Module({})
class EmptyVcsModule {}

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: TRANSACTION_MANAGER, useValue: {} },
    { provide: VCS_CFG, useValue: { encryptionKey: 'a'.repeat(64) } },
    { provide: 'fleet', useValue: {} },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, VCS_CFG, 'fleet'],
})
class TestCollaboratorsModule {}

describe('GitBrokerModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [TestCollaboratorsModule, GitBrokerModule] })
      .overrideModule(VcsModule)
      .useModule(EmptyVcsModule)
      .overrideProvider(FleetHttpClient)
      .useValue({})
      .overrideProvider(GitHubAppClient)
      .useValue({})
      .overrideProvider(GitLabAccessChecker)
      .useValue({})
      .compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('AC-1: compiles with the repo credential store and broker but no legacy token source', () => {
    expect(module.get(GitLabRepoCredentials)).toBeInstanceOf(GitLabRepoCredentials);
    expect(module.get(GitTokenBroker)).toBeInstanceOf(GitTokenBroker);
    const providers = Reflect.getMetadata('providers', GitBrokerModule) as unknown[];
    expect(providers.some((provider) => typeof provider === 'function' && provider.name === 'GitLabTokenSource')).toBe(false);
  });
});
