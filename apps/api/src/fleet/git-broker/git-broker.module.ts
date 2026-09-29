import { Module } from '@nestjs/common';
import { FleetHttpClient } from './fleet-http-client';
import { GitHubAppClient } from './github-app-client';
import { GitLabAccessChecker } from './gitlab-access-checker';

/** Forge access for fleet (spec §7). Slice 2 adds per-job token minting here. */
@Module({
  providers: [FleetHttpClient, GitHubAppClient, GitLabAccessChecker],
  exports: [GitHubAppClient, GitLabAccessChecker],
})
export class GitBrokerModule {}
