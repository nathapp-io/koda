import { DASH_NOW, DASH_THRESHOLDS, dashJob, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { jobApprovalItems, jobSilentItems } from './attention-jobs';
import type { DashboardRunnerRow } from './dashboard.types';

const runners = (...rows: DashboardRunnerRow[]) => new Map(rows.map((r) => [r.id, r] as const));
const ONLINE = runners(dashRunner());

describe('job_silent (S2b (c) §2.1)', () => {
  it('stays quiet while a RUNNING heartbeat is within FLEET_JOB_SILENT_SEC (nax beats every 60 s)', () => {
    expect(jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(179) })], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });

  it('warns past the silent threshold with the stage, the age and the runner', () => {
    expect(jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(181) })], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([{
      key: 'job_silent:j1', kind: 'job_silent', severity: 'warning', subjectType: 'job', subjectId: 'j1', subjectName: 'add-auth',
      projectSlug: 'web', since: secAgo(181).toISOString(), stage: 'running', silentSec: 181, runnerName: 'wk-mac',
    }]);
  });

  it('turns into an error past FLEET_JOB_SILENT_ERROR_SEC', () => {
    const [item] = jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(601) })], ONLINE, DASH_NOW, DASH_THRESHOLDS);
    expect(item.severity).toBe('error');
  });

  it('reads the error threshold as max(error, silent): an inverted config goes straight to error', () => {
    const t = { ...DASH_THRESHOLDS, jobSilentSec: 180, jobSilentErrorSec: 60 };
    expect(jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(179) })], ONLINE, DASH_NOW, t)).toEqual([]);
    const [item] = jobSilentItems([dashJob({ lastHeartbeatAt: secAgo(181) })], ONLINE, DASH_NOW, t);
    expect(item.severity).toBe('error');
  });

  it('measures from startedAt before the first heartbeat', () => {
    const [item] = jobSilentItems([dashJob({ lastHeartbeatAt: null, startedAt: secAgo(200) })], ONLINE, DASH_NOW, DASH_THRESHOLDS);
    expect(item).toMatchObject({ silentSec: 200, since: secAgo(200).toISOString() });
  });

  it('flags an ASSIGNED job that has not started after FLEET_JOB_START_SEC', () => {
    const job = dashJob({ state: 'ASSIGNED', assignedAt: secAgo(301), startedAt: null, lastHeartbeatAt: null });
    expect(jobSilentItems([job], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([
      expect.objectContaining({ severity: 'warning', stage: 'starting', silentSec: 301, since: secAgo(301).toISOString() }),
    ]);
    expect(jobSilentItems([{ ...job, assignedAt: secAgo(299) }], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });

  it('never flags UPLOADING or QUEUED jobs', () => {
    const old = secAgo(5000);
    expect(jobSilentItems([dashJob({ state: 'UPLOADING', lastHeartbeatAt: old }), dashJob({ id: 'j2', state: 'QUEUED', runnerId: null })], ONLINE, DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });

  it('leaves jobs of an offline or missing runner to the runner item (no double reporting)', () => {
    const silent = dashJob({ lastHeartbeatAt: secAgo(5000) });
    expect(jobSilentItems([silent], runners(dashRunner({ lastSeenAt: secAgo(91) })), DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
    expect(jobSilentItems([silent], runners(), DASH_NOW, DASH_THRESHOLDS)).toEqual([]);
  });
});

describe('job_waiting_approval (S2b (c) §2.2)', () => {
  it('raises an error with the count and the oldest ask age', () => {
    const pending = new Map([['j1', { jobId: 'j1', count: 2, oldestRequestedAt: secAgo(190) }]]);
    expect(jobApprovalItems([dashJob(), dashJob({ id: 'j2' })], pending, DASH_NOW)).toEqual([{
      key: 'job_waiting_approval:j1', kind: 'job_waiting_approval', severity: 'error', subjectType: 'job', subjectId: 'j1',
      subjectName: 'add-auth', projectSlug: 'web', since: secAgo(190).toISOString(), pending: 2, oldestSec: 190,
    }]);
  });
});
