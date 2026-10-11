import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THREAD_LIMITS, THREAD_MODEL_ID_RE } from '@nathapp/fleet-protocol';

export interface NativeModelSet { models: string[]; defaultModel: string | null }

interface NativeTier { key: string; model: string; provider: string }

export interface NativeModelConfig {
  readonly tiers: readonly NativeTier[];
  readonly providers: readonly string[];
}

export async function readNativeModelConfig(naxHome: string): Promise<NativeModelConfig> {
  let text: string;
  try {
    text = await readFile(join(naxHome, 'config.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tiers: [], providers: [] };
    throw error;
  }

  let config: unknown;
  try {
    config = JSON.parse(text) as unknown;
  } catch {
    return { tiers: [], providers: [] };
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return { tiers: [], providers: [] };
  const models = (config as Record<string, unknown>).models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return { tiers: [], providers: [] };
  const native = (models as Record<string, unknown>).native;
  if (typeof native !== 'object' || native === null || Array.isArray(native)) return { tiers: [], providers: [] };

  const tiers: NativeTier[] = [];
  for (const [key, value] of Object.entries(native as Record<string, unknown>)) {
    const modelValue = typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).model
        : undefined;
    if (typeof modelValue !== 'string') continue;
    const model = modelValue.replace(/\[[^\]]*\]$/, '');
    const separator = model.indexOf('/');
    if (separator <= 0 || !THREAD_MODEL_ID_RE.test(model)) continue;
    tiers.push({ key, model, provider: model.slice(0, separator) });
  }
  return { tiers, providers: [...new Set(tiers.map((tier) => tier.provider))].sort() };
}

export function nativeModelsForProviders(config: NativeModelConfig, available: ReadonlySet<string>): NativeModelSet {
  const models: string[] = [];
  for (const tier of config.tiers) {
    if (!available.has(tier.provider) || models.includes(tier.model)) continue;
    if (models.length >= THREAD_LIMITS.maxNativeModels) break;
    models.push(tier.model);
  }
  const balanced = config.tiers.find((tier) => tier.key === 'balanced' && available.has(tier.provider) && models.includes(tier.model));
  return { models, defaultModel: balanced?.model ?? models[0] ?? null };
}

export async function readNativeModels(naxHome: string, available: ReadonlySet<string>): Promise<NativeModelSet> {
  return nativeModelsForProviders(await readNativeModelConfig(naxHome), available);
}

export async function nativeModelProviders(naxHome: string): Promise<string[]> {
  return [...(await readNativeModelConfig(naxHome)).providers];
}
