import { Command } from 'commander';
import { registerFleetAnalytics } from './fleet-analytics';
import { registerFleetApproval } from './fleet-approval';
import { registerFleetBudget } from './fleet-budget';
import { registerFleetConfig } from './fleet-config';
import { registerFleetDispatch } from './fleet-dispatch';
import { registerFleetIngest } from './fleet-ingest';
import { registerFleetJob } from './fleet-job';
import { registerFleetRepo } from './fleet-repo';
import { registerFleetRunner } from './fleet-runner';
import { registerFleetSchedule } from './fleet-schedule';
import { registerFleetStatus } from './fleet-status';

/** `koda fleet …`: runners, repos, dispatch, jobs (fleet S1 spec §11), budgets (S1b §2.4), schedules (S1b §3.4), approvals (S1.5 §2.5) analytics (S2b §4.4) and status (S2b (c) §3). */
export function fleetCommand(program: Command): Command {
  const fleet = program.command('fleet');
  fleet.description('Dispatch nax runs to fleet runners and follow the jobs');
  registerFleetRunner(fleet);
  registerFleetRepo(fleet);
  registerFleetConfig(fleet);
  registerFleetDispatch(fleet);
  registerFleetJob(fleet);
  registerFleetBudget(fleet);
  registerFleetApproval(fleet);
  registerFleetSchedule(fleet);
  registerFleetAnalytics(fleet);
  registerFleetIngest(fleet);
  registerFleetStatus(fleet);
  return fleet;
}
