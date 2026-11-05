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
  PROVIDER_KEY_SUMMARY_LIMIT,
  type IProviderCredentialRepository,
  type NewProviderCredential,
  type NewProviderCredentialIssue,
  type ProviderCredential,
  type ProviderCredentialLookup,
  type ProviderCredentialPatch,
  type ProviderKeySummary,
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

/** The project route's body: the same write, plus the repo that makes it a REPO key. */
export interface CreateProjectProviderCredentialBody extends CreateProviderCredentialBody {
  repoId?: string | null;
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

  /**
   * Records one hand-out for attribution (spec §"US-006"): true only when the row was inserted, so a
   * replayed sync of the same key to the same job records nothing. The caller runs it inside its
   * transaction, next to the activity entry the row unlocks.
   */
  async recordIssue(issue: NewProviderCredentialIssue): Promise<boolean> {
    return this.repository.recordIssue(issue);
  }

  /** One bounded page of GLOBAL rows, as write-only metadata. */
  async listGlobal(page: IPageOption): Promise<IPageResult<ProviderCredentialDto>> {
    const result = await this.repository.listGlobal(page);
    return { ...result, records: result.records.map(ProviderCredentialDto.from) };
  }

  /**
   * The credential board's `kodaKeys` (C10 US-007): the active GLOBAL keys as `{ providerId, name,
   * last4, updatedAt }`. With the vault off there is nothing to show — the board then has no koda
   * column at all, so this answers an empty list without reading the table. PROJECT and REPO rows are
   * outside a board that a global admin reads, and a disabled row is not in effect, so both are absent.
   */
  async listActiveGlobalKeys(): Promise<ProviderKeySummary[]> {
    if (!this.isEnabled()) return [];
    const rows = await this.repository.listActiveGlobal();
    if (rows.length === PROVIDER_KEY_SUMMARY_LIMIT) {
      // A GLOBAL key is unique per provider, so this only fires on an inventory no installation has;
      // say so rather than answering a column that silently lost rows.
      this.logger.warn(`Credential board koda keys capped at ${PROVIDER_KEY_SUMMARY_LIMIT} providers`);
    }
    return rows.map((row) => ({
      providerId: row.providerId,
      name: row.name,
      last4: row.last4,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * One bounded page of a project's own rows (spec §"US-005"): its PROJECT keys and the REPO keys of
   * its repos. GLOBAL keys and another project's rows are outside the filter by construction.
   */
  async listProject(projectId: string, page: IPageOption): Promise<IPageResult<ProviderCredentialDto>> {
    const result = await this.repository.listForProject(projectId, page);
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

  /**
   * The project create (`project.credential.create`, spec §"US-005"): a PROJECT key for the pinned
   * project, or a REPO key when the body names one of its repos. Both the repo scope and the writes
   * are re-read inside the transaction, so a repo moved, a project deleted or an approval redeemed
   * later cannot widen the scope the route pinned.
   */
  async createProject(
    actorId: string,
    projectId: string,
    input: CreateProjectProviderCredentialBody,
  ): Promise<ProviderCredentialDto> {
    this.assertEnabled();
    const repoId = input.repoId ?? null;
    const created = await this.txManager.run(async () => {
      if (repoId !== null) await this.assertRepoInProject(projectId, repoId);
      const row = await this.create({
        scope: repoId === null ? 'PROJECT' : 'REPO',
        projectId,
        repoId,
        providerId: input.providerId,
        name: input.name,
        key: input.key,
        createdById: actorId,
      });
      await this.recordProjectWrite('project.credential.create', 'credential.created', row, actorId, 'created');
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
   * Rejects an id that is not this project's before approval creation; the mutation handlers repeat the
   * check transactionally. A GLOBAL row and another project's row answer the same 404, so a caller that
   * may not touch a credential cannot learn from an id that it exists (spec §"US-005").
   */
  async assertProject(projectId: string, id: string): Promise<void> {
    const row = await this.repository.findById(id);
    if (!row || row.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
  }

  /** A REPO key may only name a repo of the pinned project; any other repo is a 404 (`fleet.repos`). */
  async assertRepoInProject(projectId: string, repoId: string): Promise<void> {
    const owner = await this.repository.findRepoProject(repoId);
    if (owner === null || owner !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
  }

  /** The project patch (`project.credential.update`): rotate, rename, disable or enable one own row. */
  async updateProject(projectId: string, id: string, input: UpdateProviderCredentialInput): Promise<ProviderCredentialDto> {
    this.assertEnabled();
    const updated = await this.txManager.run(async () => {
      await this.assertProject(projectId, id);
      const row = await this.update(id, input);
      const action = input.key !== undefined ? 'credential.rotated'
        : input.disabled !== undefined ? (input.disabled ? 'credential.disabled' : 'credential.enabled')
          : 'credential.updated';
      await this.recordProjectWrite('project.credential.update', action, row, input.updatedById, action);
      return row;
    });
    return ProviderCredentialDto.from(updated);
  }

  /** The project delete (`project.credential.delete`), with the row locked for a stable activity record. */
  async removeProject(projectId: string, id: string, actorId: string): Promise<void> {
    this.assertEnabled();
    await this.txManager.run(async () => {
      const current = await this.repository.lockById(id);
      if (!current || current.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
      if (!(await this.repository.remove(id))) throw new NotFoundAppException({}, 'fleet.providerCredentials.notFound');
      await this.recordProjectWrite('project.credential.delete', 'credential.deleted', current, actorId, 'deleted');
    });
  }

  /**
   * The activity and audit entry of one project credential write, inside the caller's transaction: the
   * same entity type, action vocabulary and non-secret payload the GLOBAL writes record, plus the
   * project on both rows so a project feed shows the write and the audit trail scopes it.
   */
  private async recordProjectWrite(
    key: string,
    action: string,
    row: ProviderCredential,
    actorId: string,
    summary: string,
  ): Promise<void> {
    await this.activity.record({
      actorType: 'USER', actorId, action, entityType: 'provider_credential', entityId: row.id,
      projectId: row.projectId,
      payload: { providerId: row.providerId, scope: row.scope, name: row.name, fingerprint: row.fingerprint },
    });
    await this.audit.record({
      key, resourceType: 'provider_credential', resourceId: row.id, projectId: row.projectId,
      summary: `${summary} ${row.providerId}`,
    });
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
