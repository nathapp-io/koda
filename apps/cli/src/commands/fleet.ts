import { Command } from 'commander';
import { registerFleetRunner } from './fleet-runner';

/** `koda fleet …`: runners, repos, dispatch and jobs (fleet S1 spec §11). */
export function fleetCommand(program: Command): Command {
  const fleet = program.command('fleet');
  fleet.description('Dispatch nax runs to fleet runners and follow the jobs');
  registerFleetRunner(fleet);
  return fleet;
}
