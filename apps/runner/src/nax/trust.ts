import { parseTrustCheck } from '../capabilities/nax-json';
import type { RunnerConfig } from '../config/runner-config';
import { StartupError } from '../errors';
import { parseNaxJson, type NaxCli } from './nax-cli';

export type TrustVerdict = { readonly trusted: true } | { readonly trusted: false; readonly reason: string };

/** D103: nax's own verdict for the folder (nax #2293). The runner never trusts a folder itself. */
export async function checkTrust(nax: NaxCli, path: string): Promise<TrustVerdict> {
  const json = parseNaxJson(await nax.run(['trust', 'check', '--json', path], { cwd: path }));
  if (!json.ok) return { trusted: false, reason: `trust check failed: ${json.code}` };
  const verdict = parseTrustCheck(json.value);
  if (!verdict) return { trusted: false, reason: 'trust check failed: NAX_OUTPUT_UNPARSEABLE' };
  return verdict.trusted ? { trusted: true } : { trusted: false, reason: 'project untrusted' };
}

export class WorkspaceUntrustedError extends StartupError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceUntrustedError';
  }
}

/** D103: every clone lives under workspaceRoot, so one trust entry there covers them all. */
export async function assertWorkspaceTrusted(nax: NaxCli, config: Pick<RunnerConfig, 'workspaceRoot' | 'naxHome'>): Promise<void> {
  const verdict = await checkTrust(nax, config.workspaceRoot);
  if (verdict.trusted) return;
  throw new WorkspaceUntrustedError(
    `nax does not trust ${config.workspaceRoot} (${verdict.reason}), so every job would stop before it starts. `
    + `As the runner's user, run: NAX_GLOBAL_CONFIG_DIR=${config.naxHome} nax trust add ${config.workspaceRoot} --yes `
    + '(or pass --trust-workspace to koda-runner install-service)',
  );
}
