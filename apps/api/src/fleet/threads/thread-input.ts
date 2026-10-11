import { ValidationAppException } from '@nathapp/nestjs-common';
import { FEATURE_RE, GIT_REF_RE } from '../jobs/dispatch-input';
import { MODEL_ID_RE, type ThreadBackend } from '../common/thread-jobs';

export interface CreateThreadInput { repoId: string; feature: string; baseRef?: string; title: string; maxCostUsd?: number; backend: ThreadBackend }

/** 0.0001..10000 with at most 4 decimals (shared by create and the cap PATCH). */
export const MAX_COST_USD_MIN = 0.0001;
export const MAX_COST_USD_MAX = 10000;
const COST_DECIMALS_RE = /^\d+(?:\.\d{1,4})?$/;

export function isMaxCostUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MAX_COST_USD_MIN && value <= MAX_COST_USD_MAX && COST_DECIMALS_RE.test(String(value));
}

function fail(reason: string): never { throw new ValidationAppException({ reason }, 'threads.input'); }

export function validateCreateThread(value: CreateThreadInput, defaultBranch: string): Omit<CreateThreadInput, 'baseRef' | 'maxCostUsd'> & { baseRef: string; maxCostUsd: string } {
  if (typeof value.feature !== 'string' || !FEATURE_RE.test(value.feature) || value.feature.includes('..') || !GIT_REF_RE.test(`feat/${value.feature}`)) fail('feature');
  const baseRef = value.baseRef ?? defaultBranch;
  if (typeof baseRef !== 'string' || !GIT_REF_RE.test(baseRef)) fail('baseRef');
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
  return { ...value, baseRef, maxCostUsd: String(max) };
}
