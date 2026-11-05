import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppException, NotFoundAppException, ValidationAppException, type IPageOption } from '@nathapp/nestjs-common';
import { TRANSACTION_MANAGER, type IPageResult, type ITransactionManager } from '@nathapp/nestjs-data';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { PROVIDER_CREDENTIALS_CFG, type IProviderCredentialsConfig } from '../../config/provider-credentials.config';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ProviderCredentialDto } from './dto/provider-credential.dto';
import {
  NO_WHITESPACE_PATTERN,
  PROVIDER_CREDENTIAL_KEY_MAX_LENGTH,
  PROVIDER_CREDENTIAL_KEY_MIN_LENGTH,
  PROVIDER_CREDENTIAL_NAME_MAX_LENGTH,
  PROVIDER_CREDENTIAL_REPOSITORY,
  PROVIDER_ID_PATTERN,
  type IProviderCredentialRepository,
  type NewProviderCredential,
  type ProviderCredential,
  type ProviderCredentialLookup,
  type ProviderCredentialPatch,
} from './provider-credential.domain';
import type { SecretStore } from './secret-store';
import { LocalSecretStore } from './secret-store';

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

/** The write body a management route accepts; the scope belongs to the route, not the body. */
export interface CreateProviderCredentialBody {
  providerId: string;
  name: string;
  key: string;
}

/** Business operations for encrypted provider keys. Repository and plaintext stay inside the API. */
@Injectable()
export class ProviderCredentialsService {
  private readonly logger = new Logger(ProviderCredentialsService.name);

  constructor(
    @Inject(PROVIDER_CREDENTIAL_REPOSITORY) private readonly repository: IProviderCredentialRepository,
    @Inject(LocalSecretStore) private readonly secretStore: SecretStore,
    @Inject(PROVIDER_CREDENTIALS_CFG) private readonly config: IProviderCredentialsConfig,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
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

  /** One bounded page of GLOBAL rows, as write-only metadata. */
  async listGlobal(page: IPageOption): Promise<IPageResult<ProviderCredentialDto>> {
    const result = await this.repository.listGlobal(page);
    return { ...result, records: result.records.map(ProviderCredentialDto.from) };
  }

  /**
   * The GLOBAL create (`fleet.credential.create`), recorded like every other fleet write: the row, its
   * `credential.created` activity entry and its audit entry share one transaction, so an approval
   * execution and a direct call commit or roll back them together. The activity payload carries the
   * metadata the feed shows — `providerId`, `scope`, `name`, `fingerprint` — and never the key.
   */
  async createGlobal(actorId: string, input: CreateProviderCredentialBody): Promise<ProviderCredentialDto> {
    const created = await this.txManager.run(async () => {
      const row = await this.create({
        scope: 'GLOBAL',
        projectId: null,
        repoId: null,
        providerId: input.providerId,
        name: input.name,
        key: input.key,
        createdById: actorId,
      });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'credential.created', entityType: 'provider_credential',
        entityId: row.id, projectId: null,
        payload: { providerId: row.providerId, scope: row.scope, name: row.name, fingerprint: row.fingerprint },
      });
      await this.audit.record({
        key: 'fleet.credential.create', resourceType: 'provider_credential', resourceId: row.id,
        projectId: null, summary: `created ${row.providerId}`,
      });
      return row;
    });
    return ProviderCredentialDto.from(created);
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

  /** Rejects out-of-scope ids before approval creation; mutation handlers repeat this check transactionally. */
  async assertGlobal(id: string): Promise<void> {
    const row = await this.repository.findById(id);
    if (!row || row.scope !== 'GLOBAL') throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
  }

  async updateGlobal(id: string, input: UpdateProviderCredentialInput): Promise<ProviderCredentialDto> {
    this.assertEnabled();
    const updated = await this.txManager.run(async () => {
      const current = await this.repository.findById(id);
      if (!current || current.scope !== 'GLOBAL') throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
      const row = await this.update(id, input);
      const action = input.key !== undefined ? 'credential.rotated'
        : input.disabled !== undefined ? (input.disabled ? 'credential.disabled' : 'credential.enabled')
          : 'credential.updated';
      await this.activity.record({
        actorType: 'USER', actorId: input.updatedById, action, entityType: 'provider_credential', entityId: id,
        projectId: null,
        payload: { providerId: row.providerId, scope: row.scope, name: row.name, fingerprint: row.fingerprint },
      });
      await this.audit.record({ key: 'fleet.credential.update', resourceType: 'provider_credential', resourceId: id, projectId: null, summary: `${action} ${row.providerId}` });
      return row;
    });
    return ProviderCredentialDto.from(updated);
  }

  async removeGlobal(id: string, actorId: string): Promise<void> {
    this.assertEnabled();
    await this.txManager.run(async () => {
      const current = await this.repository.lockById(id);
      if (!current || current.scope !== 'GLOBAL') throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
      await this.remove(id);
      await this.activity.record({ actorType: 'USER', actorId, action: 'credential.deleted', entityType: 'provider_credential', entityId: id, projectId: null,
        payload: { providerId: current.providerId, scope: current.scope, name: current.name, fingerprint: current.fingerprint } });
      await this.audit.record({ key: 'fleet.credential.delete', resourceType: 'provider_credential', resourceId: id, projectId: null, summary: `deleted ${current.providerId}` });
    });
  }

  async remove(id: string): Promise<void> {
    this.assertEnabled();
    if (!(await this.repository.remove(id))) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
  }

  /**
   * Refuses a write while the vault is off (spec §"Failure Handling"): the API boots, management reads
   * keep working, and only an operation that would seal or open a secret answers 503. A gated route
   * calls this before it opens a request, so an approval cannot be granted for a call that cannot run.
   */
  assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, {}, 'fleet.providerCredentials.vaultOff', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  private validateKey(key: string): void {
    if (
      typeof key !== 'string' ||
      key.length < PROVIDER_CREDENTIAL_KEY_MIN_LENGTH ||
      key.length > PROVIDER_CREDENTIAL_KEY_MAX_LENGTH ||
      !NO_WHITESPACE_PATTERN.test(key)
    ) {
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
    // `{property}` is what the i18n sentence interpolates; the field's own key keeps the older
    // `{ <field>: 'invalid' }` shape US-002 settled, so both readers name the field.
    return new ValidationAppException({ [field]: 'invalid', property: field }, 'fleet.providerCredentials.validation');
  }
}
