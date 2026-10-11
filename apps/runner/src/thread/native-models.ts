import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THREAD_LIMITS, THREAD_MODEL_ID_RE } from '@nathapp/fleet-protocol';

export interface NativeModelSet { models: string[]; defaultModel: string | null }

type NativeTier = { key: string; model: string; provider: string };

async function nativeTiers(naxHome: string): Promise<NativeTier[]> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(naxHome, 'config.json'), 'utf8')) as unknown;
  } catch {
    return [];
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return [];
  const models = (config as Record<string, unknown>).models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return [];
  const native = (models as Record<string, unknown>).native;
  if (typeof native !== 'object' || native === null || Array.isArray(native)) return [];

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
  return tiers;
}

export async function readNativeModels(naxHome: string, available: ReadonlySet<string>): Promise<NativeModelSet> {
  const tiers = await nativeTiers(naxHome);
  const models: string[] = [];
  for (const tier of tiers) {
    if (!available.has(tier.provider) || models.includes(tier.model)) continue;
    if (models.length >= THREAD_LIMITS.maxNativeModels) break;
    models.push(tier.model);
  }
  const balanced = tiers.find((tier) => tier.key === 'balanced' && available.has(tier.provider) && models.includes(tier.model));
  return { models, defaultModel: balanced?.model ?? models[0] ?? null };
}

export async function nativeModelProviders(naxHome: string): Promise<string[]> {
  return [...new Set((await nativeTiers(naxHome)).map((tier) => tier.provider))].sort();
}
