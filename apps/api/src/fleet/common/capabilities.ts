import { ValidationAppException } from '@nathapp/nestjs-common';
import type { NaxProtocol, ProfileNeeds, RunnerCapabilities } from './protocol';

export const MAX_CAPABILITIES_BYTES = 65_536;
/** #161: bounded names (same rule as dispatch profiles, Task 11) and bounded collections. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_PROFILES = 64;
export const MAX_PROVIDERS_PER_PROFILE = 16;
export const MAX_CREDENTIALS = 64;
const PROTOCOLS: readonly NaxProtocol[] = ['acp', 'native'];
const EXECUTORS = ['host'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.capabilities');
}

function parseProfile(name: string, v: unknown): ProfileNeeds {
  if (!PROFILE_NAME_RE.test(name)) fail(`profile name ${name.slice(0, 70)}`);
  if (!isObj(v) || !PROTOCOLS.includes(v.protocol as NaxProtocol) || !isStrArray(v.providers) || !isBool(v.sandbox)) {
    fail(`profile ${name}`);
  }
  if ((v.providers as string[]).length > MAX_PROVIDERS_PER_PROFILE) fail(`profile ${name} providers`);
  return { protocol: v.protocol as NaxProtocol, providers: [...(v.providers as string[])], sandbox: v.sandbox as boolean };
}

/** Validates a runner's self-reported capabilities (untrusted input, spec §2.1) and returns a clean copy. */
export function parseCapabilities(raw: unknown): RunnerCapabilities {
  if (!isObj(raw)) fail('not an object');
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CAPABILITIES_BYTES) fail('too large');
  const { nax, sandbox, profiles, credentials, tools, executors } = raw;

  if (
    !isObj(nax) || !isStr(nax.version) || !Array.isArray(nax.protocols) || nax.protocols.length === 0 ||
    !nax.protocols.every((p) => PROTOCOLS.includes(p)) || new Set(nax.protocols).size !== nax.protocols.length
  ) fail('nax');
  if (!isObj(sandbox) || !isBool(sandbox.available) || !isStr(sandbox.probedAt) || (sandbox.error !== undefined && typeof sandbox.error !== 'string')) fail('sandbox');
  if (!isObj(profiles)) fail('profiles');
  if (Object.keys(profiles).length > MAX_PROFILES) fail('too many profiles');
  if (!Array.isArray(credentials)) fail('credentials');
  if (credentials.length > MAX_CREDENTIALS) fail('too many credentials');
  if (!isObj(tools) || !isBool(tools.git) || !isBool(tools.gh) || !isBool(tools.glab)) fail('tools');
  if (!Array.isArray(executors) || !executors.every((e) => (EXECUTORS as readonly unknown[]).includes(e))) fail('executors');

  const parsedCredentials = credentials.map((c, i) => {
    if (!isObj(c) || !isStr(c.providerId) || !isStr(c.kind) || (c.expires !== undefined && (!isStr(c.expires) || Number.isNaN(Date.parse(c.expires))))) fail(`credential ${i}`);
    const allowed = new Set(['providerId', 'kind', 'expires']);
    if (Object.keys(c).some((k) => !allowed.has(k))) fail(`credential ${i} has unexpected fields`);
    return { providerId: c.providerId as string, kind: c.kind as string, ...(c.expires ? { expires: c.expires as string } : {}) };
  });

  return {
    nax: { version: nax.version as string, protocols: [...(nax.protocols as NaxProtocol[])] },
    sandbox: {
      available: sandbox.available as boolean,
      probedAt: sandbox.probedAt as string,
      ...(sandbox.error !== undefined ? { error: sandbox.error as string } : {}),
    },
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, v]) => [name, parseProfile(name, v)])),
    credentials: parsedCredentials,
    tools: { git: tools.git as boolean, gh: tools.gh as boolean, glab: tools.glab as boolean },
    executors: [...(executors as Array<'host'>)],
  };
}
