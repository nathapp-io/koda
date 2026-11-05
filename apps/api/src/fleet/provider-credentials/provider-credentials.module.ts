import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ApprovalEngineModule } from '../../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../../auth/auth-repository.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetProviderCredentialsController } from './fleet-provider-credentials.controller';
import { PrismaProviderCredentialRepository } from './prisma-provider-credential.repository';
import { ProjectProviderCredentialsController } from './project-provider-credentials.controller';
import { PROVIDER_CREDENTIAL_REPOSITORY } from './provider-credential.domain';
import { ProviderCredentialRouteCommands } from './provider-credential-route.commands';
import { ProviderCredentialsService } from './provider-credentials.service';
import { LocalSecretStore } from './secret-store';

/**
 * Provider credential vault (spec §"US-001", management routes from §"US-003" and §"US-005").
 *
 * Registers the secret store and the repository behind {@link PROVIDER_CREDENTIAL_REPOSITORY}.
 * The service is the public face; the repository remains module-private. The module compiles with
 * no master key set — the vault is then simply off. `ProjectAccessModule` is here for the project
 * routes' `ProjectMembershipGuard`, which is the project key's authorisation boundary.
 */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule, ProjectAccessModule, FleetActivityModule],
  controllers: [FleetProviderCredentialsController, ProjectProviderCredentialsController],
  providers: [
    LocalSecretStore,
    PrismaProviderCredentialRepository,
    { provide: PROVIDER_CREDENTIAL_REPOSITORY, useExisting: PrismaProviderCredentialRepository },
    ProviderCredentialsService,
    ProviderCredentialRouteCommands,
  ],
  exports: [ProviderCredentialsService],
})
export class ProviderCredentialsModule {}
