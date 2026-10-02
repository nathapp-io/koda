import { Command } from 'commander';
import { registerFleetApproval } from './fleet-approval';
import { registerFleetBudget } from './fleet-budget';
import { registerFleetDispatch } from './fleet-dispatch';
import { registerFleetJob } from './fleet-job';
import { registerFleetRepo } from './fleet-repo';
import { registerFleetRunner } from './fleet-runner';
import { registerFleetSchedule } from './fleet-schedule';

/** `koda fleet …`: runners, repos, dispatch, jobs (fleet S1 spec §11), budgets (S1b §2.4) and schedules (S1b §3.4). */
export function fleetCommand(program: Command): Command {
  const fleet = program.command('fleet');
  fleet.description('Dispatch nax runs to fleet runners and follow the jobs');
  registerFleetRunner(fleet);
  registerFleetRepo(fleet);
  registerFleetDispatch(fleet);
  registerFleetJob(fleet);
  registerFleetBudget(fleet);
  registerFleetApproval(fleet);
  registerFleetSchedule(fleet);
  return fleet;
}
