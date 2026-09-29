import { Module } from '@nestjs/common';
import { VcsModule } from '../../vcs/vcs.module';
import { FleetHttpClient } from './fleet-http-client';
import { GitHubAppClient } from './github-app-client';
import { GitLabAccessChecker } from './gitlab-access-checker';
import { GitLabTokenSource } from './gitlab-token.source';
import { GitTokenBroker } from './git-token.broker';

/** Forge access for fleet (spec §7): repo checks and per-job token minting. */
@Module({
  imports: [VcsModule],
  providers: [FleetHttpClient, GitHubAppClient, GitLabAccessChecker, GitLabTokenSource, GitTokenBroker],
  exports: [GitHubAppClient, GitLabAccessChecker, GitLabTokenSource, GitTokenBroker],
})
export class GitBrokerModule {}
