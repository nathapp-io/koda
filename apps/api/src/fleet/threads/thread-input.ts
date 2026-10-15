import { ValidationAppException } from '@nathapp/nestjs-common';
import { FEATURE_RE, GIT_REF_RE } from '../jobs/dispatch-input';
import { MODEL_ID_RE, type ChatThreadKind, type ThreadBackend } from '../common/thread-jobs';

export interface CreateThreadInput { kind?: ChatThreadKind; repoId?: string; feature?: string; baseRef?: string; title: string; maxCostUsd?: number; backend: ThreadBackend }

/**
 * The validated create input (fleet S5b §1a-R4): a REPO thread carries the repo, the branch and the nax feature; a
 * PROJECT thread (fleet S5b-R3) carries none of them and its backend is always native (1a-R2: ACP sessions get no
 * tools, nax#2444).
 */
export type NormalizedCreateThread =
  | { kind: 'REPO'; repoId: string; feature: string; baseRef: string; title: string; maxCostUsd: string; backend: ThreadBackend }
  | { kind: 'PROJECT'; title: string; maxCostUsd: string; backend: ThreadBackend & { kind: 'native' } };

/** 0.0001..10000 with at most 4 decimals (shared by create and the cap PATCH). */
export const MAX_COST_USD_MIN = 0.0001;
export const MAX_COST_USD_MAX = 10000;
const COST_DECIMALS_RE = /^\d+(?:\.\d{1,4})?$/;

export function isMaxCostUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MAX_COST_USD_MIN && value <= MAX_COST_USD_MAX && COST_DECIMALS_RE.test(String(value));
}

function fail(reason: string): never { throw new ValidationAppException({ reason }, 'threads.input'); }

/** A field the client actually sent; a missing key and a JSON null are both "absent". */
function present(value: unknown): boolean { return value !== undefined && value !== null; }

/**
 * Validates the create body and normalizes it to a discriminated value. Checks run in the documented order and the
 * first failure wins; `defaultBranch` is the repo's branch for a REPO thread (create re-runs the second pass with the
 * resolved repo) and is unused for PROJECT.
 *
 * The kind overloads let the caller that already knows the kind read the matching variant without a cast.
 */
export function validateCreateThread(value: CreateThreadInput & { kind?: 'REPO' }, defaultBranch: string): Extract<NormalizedCreateThread, { kind: 'REPO' }>;
export function validateCreateThread(value: CreateThreadInput & { kind: 'PROJECT' }, defaultBranch: string): Extract<NormalizedCreateThread, { kind: 'PROJECT' }>;
export function validateCreateThread(value: CreateThreadInput, defaultBranch: string): NormalizedCreateThread;
export function validateCreateThread(value: CreateThreadInput, defaultBranch: string): NormalizedCreateThread {
  const kind = value.kind ?? 'REPO';
  if (kind !== 'REPO' && kind !== 'PROJECT') fail('kind');
  // Checked before the shared tail so the order stays repoId/feature/baseRef → title → maxCostUsd → backend.
  let repo: { repoId: string; feature: string; baseRef: string } | null = null;
  if (kind === 'REPO') {
    if (typeof value.repoId !== 'string') fail('repoId');
    if (typeof value.feature !== 'string' || !FEATURE_RE.test(value.feature) || value.feature.includes('..') || !GIT_REF_RE.test(`feat/${value.feature}`)) fail('feature');
    const baseRef = value.baseRef ?? defaultBranch;
    if (typeof baseRef !== 'string' || !GIT_REF_RE.test(baseRef)) fail('baseRef');
    repo = { repoId: value.repoId, feature: value.feature, baseRef };
  } else if (present(value.repoId) || present(value.feature) || present(value.baseRef)) {
    fail('projectFields');
  }
  if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 200 || [...value.title].some((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127; })) fail('title');
  const max = value.maxCostUsd ?? 5;
  if (!isMaxCostUsd(max)) fail('maxCostUsd');
  const backend = value.backend as unknown;
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) fail('backend');
  const b = backend as Record<string, unknown>;
  const allowed = b.kind === 'native' ? ['kind', 'model', 'effort'] : b.kind === 'acp' ? ['kind', 'agent', 'model', 'effort'] : [];
  if (!allowed.length || Object.keys(b).some((key) => !allowed.includes(key))) fail('backend');
  if (b.kind === 'acp' && b.agent !== 'claude' && b.agent !== 'codex') fail('backend');
  if (b.model !== undefined && (typeof b.model !== 'string' || !MODEL_ID_RE.test(b.model))) fail('backend');
  if (b.effort !== undefined && (typeof b.effort !== 'string' || !/^[a-z]{1,16}$/.test(b.effort))) fail('backend');
  if (repo) return { kind: 'REPO', repoId: repo.repoId, feature: repo.feature, baseRef: repo.baseRef, title: value.title, maxCostUsd: String(max), backend: value.backend };
  // 1a-R2: ACP sessions get no tools, so a PROJECT thread is native-only.
  if (value.backend.kind !== 'native') fail('backend');
  return { kind: 'PROJECT', title: value.title, maxCostUsd: String(max), backend: value.backend };
}
