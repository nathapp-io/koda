import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaProviderCredentialRepository } from './prisma-provider-credential.repository';
import { PROVIDER_CREDENTIAL_REPOSITORY } from './provider-credential.domain';
import { LocalSecretStore } from './secret-store';

/**
 * Provider credential vault (spec §"US-001").
 *
 * Registers the secret store and the repository behind {@link PROVIDER_CREDENTIAL_REPOSITORY}.
 * Nothing is exported yet: the repository is module-private, and the service that becomes this
 * module's public face arrives with US-002. The module compiles with no master key set — the vault
 * is then simply off.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    LocalSecretStore,
    PrismaProviderCredentialRepository,
    { provide: PROVIDER_CREDENTIAL_REPOSITORY, useExisting: PrismaProviderCredentialRepository },
  ],
  exports: [],
})
export class ProviderCredentialsModule {}
