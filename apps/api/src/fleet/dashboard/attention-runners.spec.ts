import { DASH_NOW, DASH_THRESHOLDS, dashCaps, dashRunner, secAgo } from '../../common/test-helpers/fleet-dashboard';
import { latestOnlineCore, runnerUnhealthyItems } from './attention-runners';
import type { DashboardRunnerRow } from './dashboard.types';

const run = (runners: DashboardRunnerRow[], held = new Map<string, number>(), blocked = new Set<string>()) =>
  runnerUnhealthyItems(runners, held, blocked, DASH_NOW, DASH_THRESHOLDS);
const nax = (version: string) => dashCaps({ nax: { version, protocols: ['native'] } });

describe('runner_unhealthy (S2b (c) §2.4)', () => {
  it('raises nothing for a healthy runner or a disabled one', () => {
    expect(run([dashRunner(), dashRunner({ id: 'r2', enabled: false, lastSeenAt: secAgo(5000) })])).toEqual([]);
  });

  it('warns on an offline runner and errors when it still holds jobs', () => {
    const offline = dashRunner({ lastSeenAt: secAgo(91) });
    expect(run([offline])).toEqual([{
      key: 'runner_unhealthy:r1', kind: 'runner_unhealthy', severity: 'warning', subjectType: 'runner', subjectId: 'r1', subjectName: 'wk-mac',
      projectSlug: null, since: secAgo(91).toISOString(), conditions: [{ type: 'offline', jobsHeld: 0 }],
    }]);
    expect(run([offline], new Map([['r1', 2]]))[0]).toMatchObject({ severity: 'error', conditions: [{ type: 'offline', jobsHeld: 2 }] });
  });

  it('reports missing and unavailable providers of its own profiles only', () => {
    const caps = dashCaps({
      profiles: { fast: { protocol: 'native', providers: ['deepseek', 'anthropic'], sandbox: false } },
      credentials: [
        { providerId: 'deepseek', available: false, stored: null, ambient: false },
        { providerId: 'openai', available: false, stored: null, ambient: false },
      ],
    });
    expect(run([dashRunner({ capabilities: caps })])[0]).toMatchObject({
      severity: 'warning', since: null,
      conditions: [{ type: 'credential', providerId: 'anthropic', why: 'missing' }, { type: 'credential', providerId: 'deepseek', why: 'unavailable' }],
    });
  });

  it('flags an expired api-key but never OAuth expiry', () => {
    const caps = dashCaps({
      profiles: {},
      credentials: [
        { providerId: 'k', available: true, stored: { kind: 'api-key', expired: true }, ambient: false },
        { providerId: 'o', available: true, stored: { kind: 'oauth', expires: '2026-01-01T00:00:00Z', expired: true }, ambient: false },
      ],
    });
    expect(run([dashRunner({ capabilities: caps })])[0].conditions).toEqual([{ type: 'credential', providerId: 'k', why: 'expired' }]);
  });

  it('raises nothing for a runner with no profiles and an unavailable credential', () => {
    const caps = dashCaps({ profiles: {}, credentials: [{ providerId: 'x', available: false, stored: null, ambient: false }] });
    expect(run([dashRunner({ capabilities: caps })])).toEqual([]);
  });

  it('escalates a credential problem to error when it blocks an unplaced job', () => {
    const caps = dashCaps({ credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] });
    expect(run([dashRunner({ capabilities: caps })], new Map(), new Set(['r1']))[0].severity).toBe('error');
  });

  it('warns on a stale nax core version against the newest online runner', () => {
    const items = run([dashRunner({ id: 'a', name: 'a', capabilities: nax('0.83.10') }), dashRunner({ id: 'b', name: 'b', capabilities: nax('0.83.9') })]);
    expect(items).toEqual([expect.objectContaining({ subjectId: 'b', severity: 'warning', conditions: [{ type: 'stale_nax', version: '0.83.9', latest: '0.83.10' }] })]);
  });

  it('does not call a canary of the same core stale, ignores unparsable versions and offline runners for latest', () => {
    expect(run([dashRunner({ id: 'a', capabilities: nax('0.83.3') }), dashRunner({ id: 'b', capabilities: nax('0.83.3-canary.2') })])).toEqual([]);
    expect(run([dashRunner({ id: 'a', capabilities: nax('garbage') }), dashRunner({ id: 'b', capabilities: nax('0.1.0') })])).toEqual([]);
    expect(latestOnlineCore([dashRunner({ capabilities: nax('9.9.9'), lastSeenAt: secAgo(500) }), dashRunner({ id: 'b', capabilities: nax('0.1.0') })], DASH_NOW, 90))
      .toEqual([0, 1, 0]);
  });

  it('gives a runner with unreadable capabilities only the offline condition', () => {
    expect(run([dashRunner({ capabilities: null })])).toEqual([]);
    expect(run([dashRunner({ capabilities: null, lastSeenAt: secAgo(91) })])[0].conditions).toEqual([{ type: 'offline', jobsHeld: 0 }]);
  });
});
