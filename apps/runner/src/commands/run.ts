import { ConfigError, loadRunnerConfig, resolveHome } from '../config/runner-config';
import { probeAcpAgents } from '../capabilities/acp-agent-probe';
import type { DaemonHandle, DaemonOptions } from '../daemon/daemon';
import { errorMessage, StartupError } from '../errors';
import { IdentityError, readIdentity } from '../identity/identity-store';
import type { Logger } from '../logger';
import { LAUNCHD_SUPERVISOR, SUPERVISOR_ENV } from '../service/units';

export interface RunDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
  readonly start: (options: DaemonOptions) => Promise<DaemonHandle>;
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) => void;
}

/** Exit codes: 0 clean stop (also a server stop under launchd, which must not be restarted), 1 not enrolled, bad config, nax missing or too old, or workspace untrusted, 2 stopped by the server (426 or 401). */
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
    // thread-agents-modes US-002: the production runner is the one caller that advertises its ACP agents.
    daemon = await deps.start({ home, config, identity, log: deps.log, acpProbe: probeAcpAgents });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof IdentityError || error instanceof StartupError) {
      deps.log.error(error.message);
      return 1;
    }
    deps.log.error('could not start', { error: errorMessage(error) });
    return 1;
  }
  const stopOnSignal = (): void => { void daemon.stop(); };
  deps.onSignal('SIGTERM', stopOnSignal);
  deps.onSignal('SIGINT', stopOnSignal);
  deps.onSignal('SIGHUP', () => { void daemon.reprobe(); });   // D102: systemctl reload, launchctl kill HUP
  const reason = await daemon.stopped;
  await daemon.stop();
  if (reason === 'stopped') return 0;
  deps.log.error(`stopped by the server (${reason.kind}): ${reason.message}`);
  // OPS-1: the launchd plist keeps the runner alive only on a failed exit (KeepAlive/SuccessfulExit=false), so a
  // refusal — which no restart can fix — is reported as success and launchd stops restarting it. systemd gets the
  // same meaning from `RestartPreventExitStatus=2`, so every other supervisor keeps exit 2.
  return deps.env[SUPERVISOR_ENV] === LAUNCHD_SUPERVISOR ? 0 : 2;
}
