import { checkBashDecision } from './bash-decision';

const payload = (over: Record<string, unknown> = {}) => ({ command: 'bun run test', commandTruncated: false, options: ['allow', 'allow-remember', 'deny'], ...over });

describe('checkBashDecision (spec §1.3, plan D267)', () => {
  it('maps the three decisions', () => {
    expect(checkBashDecision(payload(), 'allow')).toEqual({ ok: true, choice: 'allow', status: 'approved' });
    expect(checkBashDecision(payload(), 'allow_for_job')).toEqual({ ok: true, choice: 'allow-remember', status: 'approved' });
    expect(checkBashDecision(payload(), 'deny')).toEqual({ ok: true, choice: 'deny', status: 'rejected' });
  });
  it('refuses allow on a truncated command, still allows deny', () => {
    expect(checkBashDecision(payload({ commandTruncated: true }), 'allow')).toEqual({ ok: false, reason: 'the command was truncated; it can only be denied' });
    expect(checkBashDecision(payload({ commandTruncated: true }), 'allow_for_job').ok).toBe(false);
    expect(checkBashDecision(payload({ commandTruncated: true }), 'deny').ok).toBe(true);
  });
  it('refuses allow when nax did not offer it (defence in depth)', () => {
    expect(checkBashDecision(payload({ options: ['deny'] }), 'allow')).toEqual({ ok: false, reason: 'nax did not offer allow for this ask' });
  });
  it('refuses allow_for_job when nax did not offer allow-remember', () => {
    expect(checkBashDecision(payload({ options: ['allow', 'deny'] }), 'allow_for_job')).toEqual({ ok: false, reason: 'nax did not offer allow-remember for this ask' });
  });
  it.each(['raise_budget_and_resume', 'keep_paused'] as const)('refuses the budget decision %s', (d) => {
    expect(checkBashDecision(payload(), d)).toEqual({ ok: false, reason: `${d} does not apply to a bash approval` });
  });
});
