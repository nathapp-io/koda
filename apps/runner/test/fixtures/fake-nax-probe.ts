/**
 * The read-only nax commands the runner calls (D108): `config --json`, `auth list --json`, `sandbox probe --json`,
 * `trust check --json`. State lives in the nax home, so two in-process runners never share it:
 * - `<naxHome>/profiles/<name>.json` may carry `fakeRequirements` or `fakeError`; a name not there is looked up in
 *   `<dir>/.nax/fake-profiles/<name>.json` (a profile the repo provides; `dir` is `config -d`)
 * - `<naxHome>/fake-auth.json` is `{ "providers": [...] }` in nax's AuthListReport row shape
 * - `<naxHome>/fake-sandbox.json` is the whole probe document (default: available)
 * - `<naxHome>/fake-untrusted` makes every folder untrusted
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Requirements {
  transport: 'native' | 'acp';
  providers: string[];
  sandbox: boolean;
}

export interface ProbeAnswer {
  readonly stdout: string;
  readonly code: number;
}

const DEFAULT_REQUIREMENTS: Requirements = { transport: 'native', providers: [], sandbox: false };

const flagValue = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = (args: readonly string[], from: number): string[] => args.slice(from).filter((a) => !a.startsWith('-'));

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const answer = (value: unknown, code = 0): ProbeAnswer => ({ stdout: JSON.stringify(value), code });
const failure = (code: string): ProbeAnswer => answer({ error: { code, message: `fake-nax: ${code}` } }, 1);

function config(args: readonly string[], naxHome: string, cwd: string): ProbeAnswer {
  const dir = flagValue(args, '-d') ?? cwd;
  const chain = (flagValue(args, '--profile') ?? '').split(',').filter(Boolean);
  let requirements = DEFAULT_REQUIREMENTS;
  for (const name of chain) {
    const file = readJson(join(naxHome, 'profiles', `${name}.json`)) ?? readJson(join(dir, '.nax', 'fake-profiles', `${name}.json`));
    if (!file) return failure('PROFILE_NOT_FOUND');
    if (typeof file['fakeError'] === 'string') return failure(file['fakeError']);
    if (file['fakeRequirements']) requirements = file['fakeRequirements'] as Requirements;
  }
  return answer({
    profile: chain.length > 0 ? chain.join('+') : 'default', profileChain: chain, sources: { global: null, project: null },
    requirements: { agent: requirements.transport === 'native' ? 'native' : 'opencode', protocol: 'hybrid', ...requirements },
    config: {},
  });
}

function authList(args: readonly string[], naxHome: string): ProbeAnswer {
  const stored = (readJson(join(naxHome, 'fake-auth.json'))?.['providers'] ?? []) as Array<{ providerId?: unknown }>;
  const unlisted = positional(args, 2)
    .filter((id) => !stored.some((row) => row.providerId === id))
    .map((providerId) => ({ providerId, stored: null, ambient: false, available: false }));
  return answer({ source: 'file', providers: [...stored, ...unlisted] });
}

function sandboxProbe(naxHome: string): ProbeAnswer {
  const report = readJson(join(naxHome, 'fake-sandbox.json')) ?? { backend: 'srt', platform: process.platform, available: true };
  return answer(report, report['available'] === true ? 0 : 1);
}

function trustCheck(args: readonly string[], naxHome: string, cwd: string): ProbeAnswer {
  const root = positional(args, 2)[0] ?? cwd;
  const trusted = !existsSync(join(naxHome, 'fake-untrusted'));
  return answer({ root, trusted, coveredBy: trusted ? root : null }, trusted ? 0 : 1);
}

export function answerProbe(args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): ProbeAnswer | null {
  if (!args.includes('--json')) return null;
  const naxHome = env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
  const [command, sub] = args;
  if (command === 'config') return config(args, naxHome, cwd);
  if (command === 'auth' && sub === 'list') return authList(args, naxHome);
  if (command === 'sandbox' && sub === 'probe') return sandboxProbe(naxHome);
  if (command === 'trust' && sub === 'check') return trustCheck(args, naxHome, cwd);
  return null;
}
