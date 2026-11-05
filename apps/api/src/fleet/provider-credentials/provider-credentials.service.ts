import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { PROVIDER_CREDENTIALS_CFG, type IProviderCredentialsConfig } from '../../config/provider-credentials.config';
import {
  PROVIDER_CREDENTIAL_REPOSITORY,
  PROVIDER_ID_PATTERN,
  PROVIDER_CREDENTIAL_NAME_MAX_LENGTH,
  type IProviderCredentialRepository,
  type NewProviderCredential,
  type ProviderCredential,
  type ProviderCredentialLookup,
  type ProviderCredentialPatch,
} from './provider-credential.domain';
import type { SecretStore } from './secret-store';
import { LocalSecretStore } from './secret-store';

const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 8192;

export interface CreateProviderCredentialInput {
  scope: NewProviderCredential['scope'];
  projectId?: string | null;
  repoId?: string | null;
  providerId: string;
  name: string;
  key: string;
  createdById: string;
}

export interface UpdateProviderCredentialInput {
  name?: string;
  key?: string;
  disabled?: boolean;
  updatedById: string;
}

/** Business operations for encrypted provider keys. Repository and plaintext stay inside the API. */
@Injectable()
export class ProviderCredentialsService {
  private readonly logger = new Logger(ProviderCredentialsService.name);

  constructor(
    @Inject(PROVIDER_CREDENTIAL_REPOSITORY) private readonly repository: IProviderCredentialRepository,
    @Inject(LocalSecretStore) private readonly secretStore: SecretStore,
    @Inject(PROVIDER_CREDENTIALS_CFG) private readonly config: IProviderCredentialsConfig,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.encryptionKey);
  }

  async resolve(lookup: ProviderCredentialLookup): Promise<ProviderCredential | null> {
    if (!this.isEnabled()) return null;
    const candidates = await this.repository.findActiveCandidates(lookup);
    const priorities = lookup.repoId ? ['REPO', 'PROJECT', 'GLOBAL'] : ['PROJECT', 'GLOBAL'];
    for (const scope of priorities) {
      const credential = candidates.find((candidate) =>
        candidate.providerId === lookup.providerId &&
        candidate.disabledAt === null &&
        candidate.scope === scope &&
        (scope !== 'PROJECT' || candidate.projectId === lookup.projectId) &&
        (scope !== 'REPO' || candidate.repoId === lookup.repoId),
      );
      if (credential) return credential;
    }
    return null;
  }

  /** Decryption is intentionally a nullable boundary: one corrupt row must not break runner sync. */
  issueKey(credential: ProviderCredential): string | null {
    try {
      return this.secretStore.open(credential.encryptedKey);
    } catch {
      this.logger.warn(`Unable to decrypt provider credential ${credential.id}`);
      return null;
    }
  }

  async create(input: CreateProviderCredentialInput): Promise<ProviderCredential> {
    this.assertEnabled();
    this.validateProviderId(input.providerId);
    this.validateName(input.name);
    this.validateKey(input.key);
    const sealed = this.secretStore.seal(input.key);
    const data: NewProviderCredential = {
      scope: input.scope,
      projectId: input.projectId ?? null,
      repoId: input.repoId ?? null,
      providerId: input.providerId,
      name: input.name,
      ...sealed,
      createdById: input.createdById,
      updatedById: input.createdById,
    };
    try {
      return await this.repository.insert(data);
    } catch (error) {
      if (isUniqueViolation(error, 'scopeKey') || isUniqueViolation(error, 'providerId')) {
        throw new ConflictAppException({}, 'fleet.providerCredentials.duplicate');
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateProviderCredentialInput): Promise<ProviderCredential> {
    this.assertEnabled();
    const current = await this.repository.findById(id);
    if (!current) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
    const patch: ProviderCredentialPatch = { updatedById: input.updatedById };
    if (input.name !== undefined) {
      this.validateName(input.name);
      patch.name = input.name;
    }
    if (input.key !== undefined) {
      this.validateKey(input.key);
      const sealed = this.secretStore.seal(input.key);
      patch.encryptedKey = sealed.encryptedKey;
      patch.last4 = sealed.last4;
      patch.fingerprint = sealed.fingerprint;
    }
    if (input.disabled !== undefined) {
      if (typeof input.disabled !== 'boolean') throw this.validationError('disabled');
      patch.disabledAt = input.disabled ? new Date() : null;
    }
    const updated = await this.repository.patch(id, patch);
    if (!updated) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.assertEnabled();
    if (!(await this.repository.remove(id))) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, {}, 'fleet.providerCredentials.vaultOff', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      throw this.validationError('key');
    }
  }

  private validateProviderId(providerId: string): void {
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
      throw this.validationError('providerId');
    }
  }

  private validateName(name: string): void {
    if (typeof name !== 'string' || name.length < 1 || name.length > PROVIDER_CREDENTIAL_NAME_MAX_LENGTH) {
      throw this.validationError('name');
    }
  }

  private validationError(field: string): ValidationAppException {
    return new ValidationAppException({ [field]: 'invalid' }, 'fleet.providerCredentials.validation');
  }
}
