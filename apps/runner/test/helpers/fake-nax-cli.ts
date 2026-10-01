import type { NaxCli, NaxResult } from '../../src/nax/nax-cli';

export const json = (value: unknown, code = 0): NaxResult => ({ code, stdout: JSON.stringify(value), stderr: '', timedOut: false });
export const naxError = (code: string): NaxResult => json({ error: { code, message: `fake ${code}` } }, 1);
export const TIMED_OUT: NaxResult = { code: 137, stdout: '', stderr: '', timedOut: true };

export interface FakeRequirements {
  readonly transport: 'native' | 'acp';
  readonly providers: readonly string[];
  readonly sandbox: boolean;
}

export interface NaxAnswers {
  /** `--version` output (default 0.83.1), or a raw result. */
  version?: string | NaxResult;
  /** Keyed by the `--profile` value as passed (a chain keeps its commas; no flag is `default`). */
  config?: Readonly<Record<string, FakeRequirements | NaxResult>>;
  /** AuthListReport rows; a requested provider without a row is listed unavailable, as nax does. */
  auth?: readonly unknown[] | NaxResult;
  /** The sandbox probe document (default: available), or a raw result. */
  sandbox?: Readonly<Record<string, unknown>> | NaxResult;
  /** trust check verdict (default true), or a raw result. */
  trusted?: boolean | NaxResult;
}

const isResult = (v: unknown): v is NaxResult => typeof v === 'object' && v !== null && 'timedOut' in v;
const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** A scripted nax (D96): records every call and answers from `answers`, which a test may replace between calls. */
export class FakeNaxCli implements NaxCli {
  readonly calls: Array<{ args: string[]; cwd: string; timeoutMs?: number }> = [];

  constructor(public answers: NaxAnswers = {}) {}

  async run(args: readonly string[], options: { cwd: string; timeoutMs?: number }): Promise<NaxResult> {
    this.calls.push({ args: [...args], cwd: options.cwd, timeoutMs: options.timeoutMs });
    return this.answer(args);
  }

  private answer(args: readonly string[]): NaxResult {
    const a = this.answers;
    const [command] = args;
    if (command === '--version') return isResult(a.version) ? a.version : { code: 0, stdout: `${a.version ?? '0.83.1'}\n`, stderr: '', timedOut: false };
    if (command === 'config') {
      const chain = flag(args, '--profile') ?? 'default';
      const entry = a.config?.[chain];
      if (entry === undefined) return naxError('PROFILE_NOT_FOUND');
      if (isResult(entry)) return entry;
      return json({ profile: chain, profileChain: chain.split(','), sources: { global: null, project: null }, requirements: { agent: 'native', protocol: 'hybrid', ...entry }, config: {} });
    }
    if (command === 'auth') {
      if (isResult(a.auth)) return a.auth;
      const rows = (a.auth ?? []) as ReadonlyArray<{ providerId?: unknown }>;
      const missing = args.slice(3).filter((id) => !rows.some((r) => r.providerId === id));
      return json({ source: 'file', providers: [...rows, ...missing.map((providerId) => ({ providerId, stored: null, ambient: false, available: false }))] });
    }
    if (command === 'sandbox') {
      if (isResult(a.sandbox)) return a.sandbox;
      const report = a.sandbox ?? { backend: 'srt', platform: 'darwin', available: true };
      return json(report, report['available'] === true ? 0 : 1);
    }
    if (command === 'trust') {
      if (isResult(a.trusted)) return a.trusted;
      const trusted = a.trusted ?? true;
      const root = args[args.length - 1] ?? '';
      return json({ root, trusted, coveredBy: trusted ? root : null }, trusted ? 0 : 1);
    }
    return naxError('UNKNOWN_COMMAND');
  }
}
