import type { RunnerConfig } from '../config/runner-config';
import { createNaxCli, type NaxCli } from '../nax/nax-cli';
import type { Now } from '../time';
import { StaticCapabilityProbe, type CapabilityProbe } from './capability-probe';
import { NaxCapabilityProbe, toolWorks } from './nax-probe';

/** D95: a capabilities block in runner.json is the operator's override; without one the runner asks nax. */
export function createCapabilityProbe(config: Pick<RunnerConfig, 'capabilities' | 'naxCommand' | 'naxHome'>, now: Now, nax?: NaxCli): CapabilityProbe {
  if (config.capabilities) return new StaticCapabilityProbe(config.capabilities, now);
  return new NaxCapabilityProbe({ nax: nax ?? createNaxCli(config.naxCommand, config.naxHome), naxHome: config.naxHome, now, toolWorks });
}
