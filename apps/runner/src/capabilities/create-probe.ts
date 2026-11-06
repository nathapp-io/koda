import type { RunnerConfig } from '../config/runner-config';
import { createNaxCli, type NaxCli } from '../nax/nax-cli';
import type { Now } from '../time';
import type { AcpAgentProbe } from './acp-agent-probe';
import { StaticCapabilityProbe, type CapabilityProbe } from './capability-probe';
import { NaxCapabilityProbe, toolWorks } from './nax-probe';

/**
 * D95: a capabilities block in runner.json is the operator's override; without one the runner asks nax.
 * thread-agents-modes US-002: `acpProbe` is the ACP agent probe the daemon was given — a runner whose report comes
 * from runner.json does not probe ACP agents (that block cannot carry `threadBackends` anyway).
 * C10 US-010: `vaultHelper` is how the daemon checks its nax home; an override block cannot carry `providerVault`
 * either, so the static probe never reports it.
 */
export function createCapabilityProbe(
  config: Pick<RunnerConfig, 'capabilities' | 'naxCommand' | 'naxHome'>, now: Now, nax?: NaxCli, acpProbe?: AcpAgentProbe,
  vaultHelper?: () => Promise<boolean>,
): CapabilityProbe {
  if (config.capabilities) return new StaticCapabilityProbe(config.capabilities, now);
  return new NaxCapabilityProbe({
    nax: nax ?? createNaxCli(config.naxCommand, config.naxHome), naxHome: config.naxHome, now, toolWorks,
    ...(acpProbe === undefined ? {} : { acpProbe }),
    ...(vaultHelper === undefined ? {} : { vaultHelper }),
  });
}
