import type { ProfileNeeds, RunnerCredential, RunnerCredentialExec } from '@nathapp/fleet-protocol';

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Same bound as the server validator's strings (apps/api/src/fleet/common/capabilities.ts `isStr`). */
export const isProviderId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
export const MAX_PROVIDERS_PER_PROFILE = 16;

export interface Requirements {
  readonly transport: 'native' | 'acp';
  readonly providers: readonly string[];
  readonly sandbox: boolean;
}

/** `ConfigJsonReport.requirements` (nax SPEC-cli-json-output). null: not the documented shape. */
export function parseRequirements(report: Obj): Requirements | null {
  const r = report['requirements'];
  if (!isObj(r)) return null;
  const { transport, providers, sandbox } = r;
  if (transport !== 'native' && transport !== 'acp') return null;
  if (typeof sandbox !== 'boolean' || !Array.isArray(providers) || !providers.every(isProviderId)) return null;
  return { transport, providers: [...new Set(providers as string[])].sort(), sandbox };
}

/** Design §3.2: `ProfileNeeds.protocol` is nax's `requirements.transport`. */
export const toProfileNeeds = (r: Requirements): ProfileNeeds => ({ protocol: r.transport, providers: [...r.providers], sandbox: r.sandbox });

const EXEC_STATUS: ReadonlySet<string> = new Set(['served', 'declined', 'error']);

/** undefined: invalid. */
function toStored(v: unknown): RunnerCredential['stored'] | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const { kind, expired, expires } = v;
  if ((kind !== 'api-key' && kind !== 'oauth') || typeof expired !== 'boolean') return undefined;
  if (expires !== undefined && (typeof expires !== 'string' || Number.isNaN(Date.parse(expires)))) return undefined;
  return { kind, ...(typeof expires === 'string' ? { expires } : {}), expired };
}

/** undefined: no exec key; null: invalid. */
function toExec(v: unknown): RunnerCredentialExec | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  const { status } = v;
  return typeof status === 'string' && EXEC_STATUS.has(status) ? (status as RunnerCredentialExec) : null;
}

function toCredential(v: unknown): RunnerCredential | null {
  if (!isObj(v)) return null;
  const { providerId, available, ambient } = v;
  if (!isProviderId(providerId) || typeof available !== 'boolean' || typeof ambient !== 'boolean') return null;
  const stored = toStored(v['stored']);
  const exec = toExec(v['exec']);
  if (stored === undefined || exec === null) return null;
  return { providerId, available, stored, ...(exec ? { exec } : {}), ambient };
}

/** `AuthListReport` -> `RunnerCredential[]` (design §1.1): account labels and helper codes are not carried (D99). */
export function parseAuthList(report: Obj): { credentials: RunnerCredential[]; skipped: number } | null {
  const providers = report['providers'];
  if (!Array.isArray(providers)) return null;
  const credentials = providers.map(toCredential).filter((c): c is RunnerCredential => c !== null);
  return { credentials, skipped: providers.length - credentials.length };
}

/** D99: a provider nax could not list is unavailable (placement queues), never missing (placement 422s a pin). */
export const unavailableCredential = (providerId: string): RunnerCredential => ({ providerId, available: false, stored: null, ambient: false });

const MAX_SANDBOX_ERROR = 200;

/** `nax sandbox probe --json` (nax SPEC-sandbox-probe-json). */
export function parseSandboxProbe(report: Obj): { available: boolean; error?: string } | null {
  const available = report['available'];
  if (typeof available !== 'boolean') return null;
  if (available) return { available: true };
  const reason = report['reason'];
  return { available: false, error: (typeof reason === 'string' && reason !== '' ? reason : 'unavailable').slice(0, MAX_SANDBOX_ERROR) };
}

/** `nax trust check --json` (nax SPEC-project-trust-gate). */
export function parseTrustCheck(report: Obj): { trusted: boolean; root: string } | null {
  const { trusted, root } = report;
  return typeof trusted === 'boolean' && typeof root === 'string' ? { trusted, root } : null;
}
