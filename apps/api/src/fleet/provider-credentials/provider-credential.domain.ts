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

/**
 * The credential board's `kodaKeys` read (C10 US-007) is paged, because creation accepts any valid
 * provider id and nothing bounds the GLOBAL inventory: a single page would silently hide keys that
 * exist. `@@unique([scopeKey, providerId])` keeps it to one row per provider, so both numbers are far
 * above any real installation.
 */
export const PROVIDER_KEY_SUMMARY_PAGE_SIZE = 200;

/**
 * Safety bound on that paging. Reaching it means the inventory is pathological, and the read then
 * fails loudly rather than answering a board that lost keys (api-data: no unbounded page loops).
 */
export const PROVIDER_KEY_SUMMARY_MAX_PAGES = 50;

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

/**
 * One job scope, without a provider: the shape every availability answer is keyed by, and the shape the
 * scope-chain predicate judges (C10 branch review B3).
 */
export interface ProviderLookupScope {
  projectId: string;
  repoId: string | null;
}

/**
 * The key one scope's availability answer is filed under. Placement and the dashboard dry-run resolve
 * many job scopes in one read and each answer must be found again by the scope it came from, so the key
 * is the pair itself — never a single field, because two jobs can share a project and differ by repo.
 */
export function providerScopeLookupKey(scope: ProviderLookupScope): string {
  return `${scope.projectId}\u0000${scope.repoId ?? ''}`;
}

/**
 * Whether an active row is inside a lookup's scope chain (spec §"Resolution"): a GLOBAL key answers every
 * scope, a PROJECT key only its own project, a REPO key only its own repo. `resolve` and the availability
 * read share this predicate so a hand-out and a placement can never disagree about what koda holds.
 */
export function isApplicableScope(
  candidate: Pick<ProviderCredential, 'scope' | 'projectId' | 'repoId'>,
  lookup: ProviderLookupScope,
): boolean {
  switch (candidate.scope) {
    case 'GLOBAL':
      return true;
    case 'PROJECT':
      return candidate.projectId === lookup.projectId;
    case 'REPO':
      return lookup.repoId !== null && candidate.repoId === lookup.repoId;
  }
}

/** One active row's scope, as the availability read sees it: metadata only, never the key. */
export interface ActiveProviderScope {
  scope: ProviderCredentialScope;
  projectId: string | null;
  repoId: string | null;
  providerId: string;
}

/** The scopes one availability read covers; the GLOBAL scope is always part of an answer. */
export interface ActiveProviderScopeQuery {
  projectIds: readonly string[];
  repoIds: readonly string[];
}

/**
 * Hard cap on one availability read. It covers at most the job scopes the caller named (a dashboard
 * window is `QUEUED_SCAN_LIMIT` jobs) times the providers they hold, so 2000 is far above any real
 * installation; a truncated answer under-reports what the vault can serve, which keeps a local
 * credential refusal in place (the safe direction) and is logged.
 */
export const PROVIDER_AVAILABILITY_MAX_ROWS = 2000;

/**
 * One active GLOBAL key as the credential board's `kodaKeys` column shows it (C10 US-007): metadata
 * only. Neither the key nor its ciphertext is a field here, and `updatedAt` is already an ISO string
 * because this projection crosses the API boundary as-is.
 */
export interface ProviderKeySummary {
  providerId: string;
  name: string;
  last4: string;
  updatedAt: string;
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
  /**
   * The project a fleet repo belongs to, or null when there is no such repo. A REPO key may only be
   * created for a repo of the project the route pinned (spec §"US-005"), and the answer is a 404 — so
   * this reads one column and never the repo itself.
   */
  findRepoProject(repoId: string): Promise<string | null>;
  /** Active (not disabled) rows that can answer a lookup: the GLOBAL, PROJECT and REPO keys of one provider. */
  findActiveCandidates(lookup: ProviderCredentialLookup): Promise<ProviderCredential[]>;
  /**
   * Every active row in the given scopes plus every active GLOBAL row, as scope metadata (C10 branch
   * review B3). This is the one read behind "which providers can the vault serve this job", and it is
   * bounded by {@link PROVIDER_AVAILABILITY_MAX_ROWS}: a caller that named no scope gets no row.
   */
  listActiveScopes(query: ActiveProviderScopeQuery): Promise<ActiveProviderScope[]>;
  /** One bounded page of GLOBAL rows (the admin list). */
  listGlobal(page: IPageOption): Promise<IPageResult<ProviderCredential>>;
  /**
   * Every active GLOBAL row for the credential board's koda column (C10 US-007), read in bounded
   * pages so an inventory larger than one page is still answered whole; disabled rows are excluded by
   * the filter. The caller projects the rows to metadata.
   */
  listActiveGlobal(): Promise<ProviderCredential[]>;
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
