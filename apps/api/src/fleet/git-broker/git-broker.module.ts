import { Module } from '@nestjs/common';
import { VcsModule } from '../../vcs/vcs.module';
import { FleetHttpClient } from './fleet-http-client';
import { GitHubAppClient } from './github-app-client';
import { GitLabAccessChecker } from './gitlab-access-checker';
import { GitLabRepoCredentials } from './gitlab-repo-credentials';
import { GitTokenBroker } from './git-token.broker';
import { GITLAB_CREDENTIAL_REPOSITORY, PrismaGitlabCredentialRepository } from './prisma-gitlab-credential.repository';

/** Forge access for fleet (spec §7): repo checks and per-job token minting. */
@Module({
  imports: [VcsModule],
  providers: [
    FleetHttpClient, GitHubAppClient, GitLabAccessChecker, GitTokenBroker,
    // The credential store and the module-private repository behind it. The repository stays
    // inside this module; the store is what the rest of koda uses.
    PrismaGitlabCredentialRepository,
    { provide: GITLAB_CREDENTIAL_REPOSITORY, useExisting: PrismaGitlabCredentialRepository },
    GitLabRepoCredentials,
  ],
  exports: [FleetHttpClient, GitHubAppClient, GitLabAccessChecker, GitTokenBroker, GitLabRepoCredentials],
})
export class GitBrokerModule {}
