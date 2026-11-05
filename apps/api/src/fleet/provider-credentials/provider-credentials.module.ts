import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaProviderCredentialRepository } from './prisma-provider-credential.repository';
import { PROVIDER_CREDENTIAL_REPOSITORY } from './provider-credential.domain';
import { LocalSecretStore } from './secret-store';
import { ProviderCredentialsService } from './provider-credentials.service';

/**
 * Provider credential vault (spec §"US-001").
 *
 * Registers the secret store and the repository behind {@link PROVIDER_CREDENTIAL_REPOSITORY}.
 * The service is the public face; the repository remains module-private. The module compiles with
 * no master key set — the vault is then simply off.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    LocalSecretStore,
    PrismaProviderCredentialRepository,
    { provide: PROVIDER_CREDENTIAL_REPOSITORY, useExisting: PrismaProviderCredentialRepository },
    ProviderCredentialsService,
  ],
  exports: [ProviderCredentialsService],
})
export class ProviderCredentialsModule {}
