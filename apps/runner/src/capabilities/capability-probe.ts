import { createHash } from 'node:crypto';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import type { StaticCapabilities } from '../config/runner-config';
import type { Journal } from '../journal/journal';
import type { Logger } from '../logger';
import type { CapabilityReport } from '../sync/sync-loop';
import type { Now } from '../time';

/** What a probe found, and what it had to leave out (D98, D99). */
export interface ProbeResult {
  readonly capabilities: RunnerCapabilities;
  readonly warnings: readonly string[];
}

/** Design §3.2: `NaxCapabilityProbe` asks nax; `StaticCapabilityProbe` reads runner.json (D95). */
export interface CapabilityProbe {
  probe(): Promise<ProbeResult>;
}

/** D95: the operator declares the capabilities in runner.json; only the probe time is dynamic (D41). */
export class StaticCapabilityProbe implements CapabilityProbe {
  constructor(private readonly capabilities: StaticCapabilities, private readonly now: Now) {}

  async probe(): Promise<ProbeResult> {
    const { sandbox, ...rest } = structuredClone(this.capabilities);
    // S3 §3: config jobs are a feature of this runner build, not something runner.json declares.
    return { capabilities: { ...rest, configJobs: true, sandbox: { ...sandbox, probedAt: this.now().toISOString() } }, warnings: [] };
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

/** D100: `sandbox.error` stays in the hash: nax's reasons are deterministic, so a changed reason is a real change. */
export function hashCapabilities(caps: RunnerCapabilities): string {
  const { probedAt: _probedAt, ...sandbox } = caps.sandbox;
  return createHash('sha256').update(stableStringify({ ...caps, sandbox })).digest('hex');
}

/**
 * Slice 3 design §3.2: sent on the first sync after boot and whenever the hash (without probedAt) changes. D102:
 * refreshes are serialised, a request while one runs queues exactly one more, and warnings are logged only when the
 * set changes.
 */
export class CapabilityReporter {
  private current: CapabilityReport | null = null;
  private sentHash: string | null = null;
  private warned = '';
  private tail: Promise<unknown> = Promise.resolve();
  private queued: Promise<boolean> | null = null;

  constructor(private readonly probe: CapabilityProbe, private readonly journal: Pick<Journal, 'setMeta'>, private readonly log?: Logger) {}

  /** Resolves true when the report's hash changed; rejects when the probe throws (the last report stays). */
  refresh(): Promise<boolean> {
    if (this.queued) return this.queued;
    const next = this.tail.catch(() => undefined).then(() => {
      this.queued = null;
      return this.probeOnce();
    });
    this.queued = next;
    this.tail = next;
    return next;
  }

  report(): CapabilityReport | null {
    return this.current && this.current.hash !== this.sentHash ? this.current : null;
  }

  /** The last probed capabilities; the job check compares a job's needs with them (D104). */
  latest(): RunnerCapabilities | null {
    return this.current?.capabilities ?? null;
  }

  markSent(hash: string): void {
    this.sentHash = hash;
    this.journal.setMeta('last_capabilities_hash', hash);
  }

  private async probeOnce(): Promise<boolean> {
    const { capabilities, warnings } = await this.probe.probe();
    const hash = hashCapabilities(capabilities);
    const changed = this.current?.hash !== hash;
    this.current = { capabilities, hash };
    const key = warnings.join('\n');
    if (key !== this.warned) {
      this.warned = key;
      for (const detail of warnings) this.log?.warn('capability probe', { detail });
    }
    return changed;
  }
}
