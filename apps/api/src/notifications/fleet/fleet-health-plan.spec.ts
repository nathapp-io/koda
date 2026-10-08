import type { RunnerCapabilities } from '../../fleet/common/protocol';
import { planHealthChanges } from './fleet-health-plan';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const caps = (credentials: RunnerCapabilities['credentials']): RunnerCapabilities => ({
  nax: { version: '0.83.5', protocols: ['native'] }, sandbox: { available: true, probedAt: NOW.toISOString() }, profiles: {},
  credentials, tools: { git: true, gh: true, glab: true }, executors: ['host'],
} as RunnerCapabilities);
const oauth = (providerId: string, expires: string, available = true) => ({ providerId, available, stored: { kind: 'oauth' as const, expires, expired: false }, ambient: false });
const runner = (over: Partial<{ id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }> = {}) => ({
  id: 'rn1', name: 'wk-mac', enabled: true, online: true, capabilities: caps([]), ...over,
});
const base = { now: NOW, warnDays: 7, inBootGrace: false, openAlerts: [] };

describe('planHealthChanges (S4a §2.4, D507, D515)', () => {
  it('opens an offline alert for an enabled offline runner', () => {
    expect(planHealthChanges({ ...base, runners: [runner({ online: false })] })).toEqual({
      open: [{ kind: 'runner_offline', subjectKey: 'rn1', runner: 'wk-mac', provider: null, expiresAt: null }], close: [],
    });
  });

  it('never alerts for a disabled runner and closes its open alert', () => {
    const plan = planHealthChanges({ ...base, runners: [runner({ online: false, enabled: false })], openAlerts: [{ id: 'al1', kind: 'runner_offline', subjectKey: 'rn1' }] });
    expect(plan).toEqual({ open: [], close: ['al1'] });
  });

  it('does not reopen an alert that is already open, and closes it when the runner is back', () => {
    const open = [{ id: 'al1', kind: 'runner_offline' as const, subjectKey: 'rn1' }];
    expect(planHealthChanges({ ...base, runners: [runner({ online: false })], openAlerts: open })).toEqual({ open: [], close: [] });
    expect(planHealthChanges({ ...base, runners: [runner()], openAlerts: open })).toEqual({ open: [], close: ['al1'] });
  });

  it('boot grace: neither opens nor closes offline alerts (stale lastSeenAt after an API restart)', () => {
    const open = [{ id: 'al1', kind: 'runner_offline' as const, subjectKey: 'rn2' }];
    const plan = planHealthChanges({ ...base, inBootGrace: true, runners: [runner({ online: false }), runner({ id: 'rn2', name: 'b', online: false })], openAlerts: open });
    expect(plan).toEqual({ open: [], close: [] });
  });

  it('opens a credential alert per expiring available OAuth credential, keyed runner:provider', () => {
    const plan = planHealthChanges({ ...base, runners: [runner({ capabilities: caps([oauth('openai-codex', '2026-10-11T00:00:00.000Z'), oauth('anthropic', '2026-12-01T00:00:00.000Z'), oauth('gone', '2026-10-10T00:00:00.000Z', false)]) })] });
    expect(plan.open).toEqual([{ kind: 'credential_expiring', subjectKey: 'rn1:openai-codex', runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11T00:00:00.000Z' }]);
  });

  it('closes a credential alert once refreshed; holds it while capabilities are unreadable', () => {
    const open = [{ id: 'c1', kind: 'credential_expiring' as const, subjectKey: 'rn1:openai-codex' }];
    expect(planHealthChanges({ ...base, runners: [runner({ capabilities: caps([oauth('openai-codex', '2026-12-31T00:00:00.000Z')]) })], openAlerts: open }).close).toEqual(['c1']);
    expect(planHealthChanges({ ...base, runners: [runner({ capabilities: null })], openAlerts: open }).close).toEqual([]);
  });

  it('closes alerts of runners that no longer exist', () => {
    const open = [{ id: 'al9', kind: 'runner_offline' as const, subjectKey: 'deleted' }, { id: 'c9', kind: 'credential_expiring' as const, subjectKey: 'deleted:x' }];
    expect(planHealthChanges({ ...base, runners: [], openAlerts: open }).close).toEqual(['al9', 'c9']);
  });
});
