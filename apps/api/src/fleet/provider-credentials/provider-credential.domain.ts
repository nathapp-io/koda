import type { IPageResult } from '@nathapp/nestjs-data';
import type { IPageOption } from '@nathapp/nestjs-common';

/**
 * Provider credential vault domain (spec §"US-001").
 *
 * The domain and the repository contract live here; the Prisma mapping lives in
 * `prisma-provider-credential.repository.ts` and is reachable only through
 * {@link PROVIDER_CREDENTIAL_REPOSITORY} inside `ProviderCredentialsModule`.
 */
export const PROVIDER_CREDENTIAL_REPOSITORY = Symbol('PROVIDER_CREDENTIAL_REPOSITORY');

/** `ProviderCredential.scope` values. A String column: Prisma enums are not used (common/enums.ts rule). */
export const PROVIDER_CREDENTIAL_SCOPES = ['GLOBAL', 'PROJECT', 'REPO'] as const;
export type ProviderCredentialScope = (typeof PROVIDER_CREDENTIAL_SCOPES)[number];

/** Scope key of a GLOBAL row; the other two are `project:<projectId>` and `repo:<repoId>`. */
export const GLOBAL_SCOPE_KEY = 'global';

/** `providerId` shape from spec §"US-001": lowercase, 1-48 chars, dots/dashes/underscores after the first. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export const PROVIDER_CREDENTIAL_NAME_MAX_LENGTH = 64;

/**
 * A key is 16-8192 characters with no whitespace (spec §"US-001"): 16 keeps `last4` to at most a
 * quarter of the key, and the upper bound is the length the nax helper contract accepts.
 */
export const PROVIDER_CREDENTIAL_KEY_MIN_LENGTH = 16;
export const PROVIDER_CREDENTIAL_KEY_MAX_LENGTH = 8192;
export const NO_WHITESPACE_PATTERN = /^\S+$/;

/**
 * Hard cap on one page of credentials. A management list is a bounded read: asking for more
 * returns a `hasNext` page of this size instead of fetching the whole table (api-data rule).
 */
export const PROVIDER_CREDENTIAL_PAGE_SIZE_MAX = 200;

export interface ProviderCredential {
  id: string;
  scope: ProviderCredentialScope;
  /** Computed from `scope`: `global`, `project:<projectId>` or `repo:<repoId>`. */
  scopeKey: string;
  projectId: string | null;
  repoId: string | null;
  providerId: string;
  name: string;
  /** AES-256-GCM `iv:tag:ciphertext`, hex. Never leaves the API surface. */
  encryptedKey: string;
  last4: string;
  fingerprint: string;
  createdById: string;
  updatedById: string;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields that decide which unique index row a credential occupies. */
export interface ProviderCredentialScopeRef {
  scope: ProviderCredentialScope;
  projectId?: string | null;
  repoId?: string | null;
}

export interface NewProviderCredential extends ProviderCredentialScopeRef {
  providerId: string;
  name: string;
  encryptedKey: string;
  last4: string;
  fingerprint: string;
  createdById: string;
  updatedById: string;
}

export interface ProviderCredentialPatch {
  name?: string;
  encryptedKey?: string;
  last4?: string;
  fingerprint?: string;
  updatedById?: string;
  disabledAt?: Date | null;
}

/** What a hand-out resolution asks for: the scope chain of one provider. */
export interface ProviderCredentialLookup {
  projectId: string;
  repoId: string | null;
  providerId: string;
}

export interface NewProviderCredentialIssue {
  jobId: string;
  credentialId: string;
  fingerprint: string;
}

/**
 * The uniqueness key of a credential.
 *
 * A unique index over `(projectId, repoId, providerId)` cannot work: Postgres treats NULLs as
 * distinct, so two GLOBAL rows (both NULL-scoped) would both be accepted. A single computed string
 * makes every scope collide where it should, which is why `@@unique([scopeKey, providerId])` holds.
 */
export function scopeKeyFor(ref: ProviderCredentialScopeRef): string {
  switch (ref.scope) {
    case 'GLOBAL':
      return GLOBAL_SCOPE_KEY;
    case 'PROJECT':
      if (!ref.projectId) throw new Error('A PROJECT provider credential requires projectId');
      return `project:${ref.projectId}`;
    case 'REPO':
      if (!ref.repoId) throw new Error('A REPO provider credential requires repoId');
      return `repo:${ref.repoId}`;
  }
}

/**
 * Module-internal repository contract. The service layer (US-002) is the only caller; the module
 * never exports this token.
 */
export interface IProviderCredentialRepository {
  findById(id: string): Promise<ProviderCredential | null>;
  /** Locks the row for the lifetime of the caller's transaction, then returns its current version. */
  lockById(id: string): Promise<ProviderCredential | null>;
  /** Active (not disabled) rows that can answer a lookup: the GLOBAL, PROJECT and REPO keys of one provider. */
  findActiveCandidates(lookup: ProviderCredentialLookup): Promise<ProviderCredential[]>;
  /** One bounded page of GLOBAL rows (the admin list). */
  listGlobal(page: IPageOption): Promise<IPageResult<ProviderCredential>>;
  /** One bounded page of a project's own scopes: its PROJECT rows and the REPO rows of its repos. */
  listForProject(projectId: string, page: IPageOption): Promise<IPageResult<ProviderCredential>>;
  /** Seals the caller's data under the uniqueness key its scope implies. Throws P2002 on a duplicate. */
  insert(data: NewProviderCredential): Promise<ProviderCredential>;
  /** Answers the updated row, or null when the row no longer exists. */
  patch(id: string, patch: ProviderCredentialPatch): Promise<ProviderCredential | null>;
  /** Hard-deletes one credential row; true when a row was deleted. */
  remove(id: string): Promise<boolean>;
  /** Records a hand-out, skip-on-duplicate; true only when the row was inserted (US-006 attribution). */
  recordIssue(data: NewProviderCredentialIssue): Promise<boolean>;
}
