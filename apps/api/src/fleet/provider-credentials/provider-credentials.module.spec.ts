import { Test, type TestingModule } from '@nestjs/testing';
import { PROVIDER_CREDENTIALS_CFG } from '../../config/provider-credentials.config';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { PrismaProviderCredentialRepository } from './prisma-provider-credential.repository';
import {
  IProviderCredentialRepository,
  PROVIDER_CREDENTIAL_REPOSITORY,
} from './provider-credential.domain';
import { ProviderCredentialsModule } from './provider-credentials.module';
import { LocalSecretStore } from './secret-store';
import { ProviderCredentialsService } from './provider-credentials.service';

const MASTER_KEY = '0123456789abcdef'.repeat(4);

/**
 * AC-13: the vault module must compile on a database-free unit run (no Postgres) and must not hand
 * its repository to other modules — repositories stay module-private, services are the public face
 * (api-data rule). `GlobalStubsModule` stands in for the global PrismaModule and the config
 * namespaces, which is why the mocks are provided globally rather than per test module.
 */
describe('ProviderCredentialsModule', () => {
  let module: TestingModule | undefined;

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  const compile = async (encryptionKey?: string) => {
    const builder = Test.createTestingModule({
      imports: [GlobalStubsModule, ProviderCredentialsModule],
    });
    if (encryptionKey) {
      builder.overrideProvider(PROVIDER_CREDENTIALS_CFG).useValue({ encryptionKey });
    }
    return builder.compile();
  };

  it('AC-15: resolves the service with mocked PrismaService, TRANSACTION_MANAGER and config', async () => {
    module = await compile();

    expect(module.get(LocalSecretStore)).toBeInstanceOf(LocalSecretStore);
    expect(module.get<IProviderCredentialRepository>(PROVIDER_CREDENTIAL_REPOSITORY))
      .toBeInstanceOf(PrismaProviderCredentialRepository);
  });

  it('AC-15: keeps the repository token private to the module', async () => {
    module = await compile();

    expect(module.get(ProviderCredentialsService)).toBeInstanceOf(ProviderCredentialsService);
    expect(() => module.get(PROVIDER_CREDENTIAL_REPOSITORY, { strict: true })).toThrow();
    expect(module.select(ProviderCredentialsModule).get(PROVIDER_CREDENTIAL_REPOSITORY, { strict: true })).toBe(
      module.select(ProviderCredentialsModule).get(PrismaProviderCredentialRepository, { strict: true }),
    );
  });

  it('AC-13: compiles without a master key (the vault is off, not broken)', async () => {
    module = await compile();

    expect(() => module?.get(LocalSecretStore).seal('sk-test-abcdef123456')).toThrow(/not configured/i);
  });

  it('AC-15: exports only the public service and never the repository', async () => {
    module = await compile();

    const exported = (Reflect.getMetadata('exports', ProviderCredentialsModule) ?? []) as unknown[];
    expect(exported).not.toContain(PROVIDER_CREDENTIAL_REPOSITORY);
    expect(exported).not.toContain(PrismaProviderCredentialRepository);
    expect(exported).toEqual([ProviderCredentialsService]);
  });

  it('AC-13: seals through the configured master key once one is set', async () => {
    module = await compile(MASTER_KEY);

    const store = module.get(LocalSecretStore);
    const sealed = store.seal('sk-test-abcdef123456');

    expect(store.open(sealed.encryptedKey)).toBe('sk-test-abcdef123456');
    expect(sealed.last4).toBe('3456');
  });
});
