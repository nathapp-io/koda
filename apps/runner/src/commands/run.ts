import { ConfigError, loadRunnerConfig, resolveHome } from '../config/runner-config';
import type { DaemonHandle, DaemonOptions } from '../daemon/daemon';
import { errorMessage } from '../errors';
import { IdentityError, readIdentity } from '../identity/identity-store';
import type { Logger } from '../logger';

export interface RunDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
  readonly start: (options: DaemonOptions) => Promise<DaemonHandle>;
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

/** Exit codes: 0 clean stop, 1 not enrolled or bad config, 2 stopped by the server (426 or 401). */
export async function runCommand(homeOverride: string | undefined, deps: RunDeps): Promise<number> {
  const home = resolveHome(deps.env, homeOverride);
  let daemon: DaemonHandle;
  try {
    const config = await loadRunnerConfig(home.configPath, deps.env);
    const identity = await readIdentity(home.identityPath);
    if (!identity) throw new ConfigError(`this machine is not enrolled; run "koda-runner enroll" first (looked for ${home.identityPath})`);
    if (new URL(identity.serverUrl).origin !== new URL(config.serverUrl).origin) {
      throw new ConfigError(`identity.json was issued by ${identity.serverUrl} but runner.json points at ${config.serverUrl}`);
    }
    daemon = await deps.start({ home, config, identity, log: deps.log });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof IdentityError) {
      deps.log.error(error.message);
      return 1;
    }
    deps.log.error('could not start', { error: errorMessage(error) });
    return 1;
  }
  const stopOnSignal = (): void => { void daemon.stop(); };
  deps.onSignal('SIGTERM', stopOnSignal);
  deps.onSignal('SIGINT', stopOnSignal);
  const reason = await daemon.stopped;
  await daemon.stop();
  if (reason === 'stopped') return 0;
  deps.log.error(`stopped by the server (${reason.kind}): ${reason.message}`);
  return 2;
}
