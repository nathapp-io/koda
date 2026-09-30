import { createHash } from 'node:crypto';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import type { StaticCapabilities } from '../config/runner-config';
import type { Journal } from '../journal/journal';
import type { CapabilityReport } from '../sync/sync-loop';
import type { Now } from '../time';

/** The 3b seam: `NaxCapabilityProbe` (nax --version, config --profile --json, auth list --json, sandbox probe) implements it. */
export interface CapabilityProbe {
  probe(): Promise<RunnerCapabilities>;
}

/** 3a: the operator declares the capabilities in runner.json; only the probe time is dynamic (D41). */
export class StaticCapabilityProbe implements CapabilityProbe {
  constructor(private readonly capabilities: StaticCapabilities, private readonly now: Now) {}

  async probe(): Promise<RunnerCapabilities> {
    const { sandbox, ...rest } = structuredClone(this.capabilities);
    return { ...rest, sandbox: { ...sandbox, probedAt: this.now().toISOString() } };
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** @design ENH-5: `sandbox.error` is currently folded into the hash. A transient error would flap the hash and
 *  cause the runner to keep resending its capabilities report. The 3b seam `NaxCapabilityProbe` should decide
 *  whether to strip `error` (recommended: keep it stable, retry transient ones internally). */
export function hashCapabilities(caps: RunnerCapabilities): string {
  const { probedAt: _probedAt, ...sandbox } = caps.sandbox;
  return createHash('sha256').update(stableStringify({ ...caps, sandbox })).digest('hex');
}

/** Slice 3 design §3.2: sent on the first sync after boot and whenever the hash (without probedAt) changes. */
export class CapabilityReporter {
  private current: CapabilityReport | null = null;
  private sentHash: string | null = null;

  constructor(private readonly probe: CapabilityProbe, private readonly journal: Pick<Journal, 'setMeta'>) {}

  async refresh(): Promise<void> {
    const capabilities = await this.probe.probe();
    this.current = { capabilities, hash: hashCapabilities(capabilities) };
  }

  report(): CapabilityReport | null {
    return this.current && this.current.hash !== this.sentHash ? this.current : null;
  }

  markSent(hash: string): void {
    this.sentHash = hash;
    this.journal.setMeta('last_capabilities_hash', hash);
  }
}
