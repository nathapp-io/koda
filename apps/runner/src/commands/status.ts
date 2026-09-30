import { access } from 'node:fs/promises';
import { loadRunnerConfig, resolveHome } from '../config/runner-config';
import { errorMessage } from '../errors';
import { readIdentity } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import type { ServerClient } from '../sync/http';

export interface StatusReport {
  home: string;
  enrolled: boolean;
  name?: string;
  runnerId?: string;
  serverUrl?: string;
  workspaceRoot?: string;
  journal?: { activeJobs: number; pendingEvents: number; jobs: Array<{ jobId: string; leaseEpoch: number; command: string; feature: string; state: string }> };
  server?: { reachable: boolean; capacity?: number; enabled?: boolean; error?: string };
}

export async function collectStatus(
  homeOverride: string | undefined,
  deps: { env: NodeJS.ProcessEnv; makeClient: (serverUrl: string, apiKey: string) => Pick<ServerClient, 'me'> },
): Promise<StatusReport> {
  const home = resolveHome(deps.env, homeOverride);
  const identity = await readIdentity(home.identityPath).catch(() => null);
  if (!identity) return { home: home.dir, enrolled: false };
  const report: StatusReport = { home: home.dir, enrolled: true, name: identity.name, runnerId: identity.runnerId, serverUrl: identity.serverUrl };
  const config = await loadRunnerConfig(home.configPath, deps.env).catch(() => null);
  if (config) report.workspaceRoot = config.workspaceRoot;
  if (await access(home.journalPath).then(() => true, () => false)) {
    // D72: read-only, so status never creates, migrates or locks the journal a running daemon owns.
    try {
      const journal = Journal.openReadOnly(home.journalPath);
      try {
        report.journal = {
          ...journal.stats(),
          jobs: journal.activeJobs().map((j) => ({ jobId: j.jobId, leaseEpoch: j.leaseEpoch, command: j.command, feature: j.assign.feature, state: j.state })),
        };
      } finally {
        journal.close();
      }
    } catch {
      // an unreadable journal must not hide the rest of the report
    }
  }
  try {
    const me = await deps.makeClient(identity.serverUrl, identity.apiKey).me(AbortSignal.timeout(5_000));
    report.server = { reachable: true, capacity: me.capacity, enabled: me.enabled };
  } catch (error) {
    report.server = { reachable: false, error: errorMessage(error) };
  }
  return report;
}

export function formatStatus(report: StatusReport): string {
  if (!report.enrolled) return `not enrolled (home ${report.home}); run "koda-runner enroll --server <url> --token <token>"\n`;
  const lines = [`runner ${report.name} (${report.runnerId})`, `server ${report.serverUrl}`, `home   ${report.home}`];
  if (report.workspaceRoot) lines.push(`work   ${report.workspaceRoot}`);
  if (report.server) lines.push(report.server.reachable ? `server reachable: capacity ${report.server.capacity}, ${report.server.enabled ? 'enabled' : 'disabled'}` : `server unreachable: ${report.server.error}`);
  if (report.journal) {
    lines.push(`jobs   ${report.journal.activeJobs} active, ${report.journal.pendingEvents} events waiting to be acknowledged`);
    for (const job of report.journal.jobs) lines.push(`  ${job.jobId} epoch ${job.leaseEpoch} ${job.command} ${job.feature} ${job.state}`);
  }
  return `${lines.join('\n')}\n`;
}
