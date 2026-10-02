import { Command } from 'commander';
import { registerFleetBudget } from './fleet-budget';
import { registerFleetDispatch } from './fleet-dispatch';
import { registerFleetJob } from './fleet-job';
import { registerFleetRepo } from './fleet-repo';
import { registerFleetRunner } from './fleet-runner';

/** `koda fleet …`: runners, repos, dispatch, jobs (fleet S1 spec §11) and budgets (S1b §2.4). */
export function fleetCommand(program: Command): Command {
  const fleet = program.command('fleet');
  fleet.description('Dispatch nax runs to fleet runners and follow the jobs');
  registerFleetRunner(fleet);
  registerFleetRepo(fleet);
  registerFleetDispatch(fleet);
  registerFleetJob(fleet);
  registerFleetBudget(fleet);
  return fleet;
}
