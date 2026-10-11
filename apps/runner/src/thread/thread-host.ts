import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import { nativeModelsForProviders, readNativeModelConfig, type NativeModelConfig, type NativeModelSet } from './native-models';

/**
 * The capability report a probe produced, plus the tier map a report may carry beside its providers. The wire
 * report names providers (`credentials`), never models; the tiers themselves are the runner's nax config.
 */
type ReportWithTiers = RunnerCapabilities & { readonly tiers?: Readonly<Record<string, string>> };

/** The providers whose credential `available` is true: the wire's credential array, or a provider map. */
function availableProviders(credentials: unknown): ReadonlySet<string> {
  const available = new Set<string>();
  if (Array.isArray(credentials)) {
    for (const credential of credentials as Array<{ providerId?: unknown; available?: unknown }>) {
      if (credential.available === true && typeof credential.providerId === 'string') available.add(credential.providerId);
    }
    return available;
  }
  if (typeof credentials === 'object' && credentials !== null) {
    for (const [provider, value] of Object.entries(credentials as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null && (value as { available?: unknown }).available === true) available.add(provider);
    }
  }
  return available;
}

/** A report's own `models.native` tier map, parsed the way `readNativeModelConfig` parses the config's. */
function tiersFromReport(report: ReportWithTiers): NativeModelConfig['tiers'] {
  const tiers = report.tiers;
  if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers)) return [];
  const parsed: Array<{ key: string; model: string; provider: string }> = [];
  for (const [key, value] of Object.entries(tiers as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const model = value.replace(/\[[^\]]*\]$/, '');
    const separator = model.indexOf('/');
    if (separator <= 0) continue;
    parsed.push({ key, model, provider: model.slice(0, separator) });
  }
  return parsed;
}

/**
 * Fleet S5a §3: the native models a thread session may name, read from the nax home's `models.native` tiers and
 * filtered to the providers the last probe reported available. `latest()` is the bounded report of that probe
 * (start, every `capabilityProbeMs`, SIGHUP), so a provider logged in since is seen at the next probe; with no
 * report yet there is nothing to serve. Read on every call: the tiers and the report both change under a daemon.
 */
export function threadNativeModels(naxHome: string, latest: () => RunnerCapabilities | null): () => Promise<NativeModelSet> {
  return async () => {
    const report = latest();
    if (report === null) return { models: [], defaultModel: null };
    const configured = await readNativeModelConfig(naxHome);
    const tiers = configured.tiers.length > 0 ? configured.tiers : tiersFromReport(report);
    return nativeModelsForProviders({ tiers, providers: configured.providers }, availableProviders(report.credentials));
  };
}
