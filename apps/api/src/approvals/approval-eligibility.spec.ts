import { decideEligibility } from './approval-eligibility';
import type { DeciderRef } from './approval-eligibility';

type EligibilityRequest = Parameters<typeof decideEligibility>[0];

const ACTOR = { type: 'AGENT' as const, id: 'a1' };
const USER = (id: string): DeciderRef => ({ type: 'USER', id });
const AGENT = (id: string): DeciderRef => ({ type: 'AGENT', id });

/** The default case the story states: label.delete, actor AGENT/a1, no on-behalf-of, mode agent. */
function request(patch: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return {
    permissionKey: 'label.delete',
    actor: ACTOR,
    onBehalfOf: null,
    requiredMode: 'agent',
    approverMustHoldAction: true,
    requireDistinctApprover: false,
    ...patch,
  };
}

const keys = (...entries: string[]): ReadonlySet<string> => new Set(entries);

/** The bash ask the runner raises for a job (US-007): actor `SYSTEM/runner`, on behalf of a principal. */
const BASH = 'fleet.job.shell.escalate';
function askRequest(patch: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return request({ permissionKey: BASH, actor: { type: 'SYSTEM', id: 'runner' }, ...patch });
}

describe('decideEligibility', () => {
  it('AC-1: a user holding decide and the action satisfies a human tier', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide', 'label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it('AC-2: an agent holding decide and the action contributes the agent tier', () => {
    expect(decideEligibility(request(), AGENT('a2'), keys('approval.decide', 'label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'agent' });
  });

  it('AC-3: the actor contributes self, which is below a required agent tier', () => {
    expect(decideEligibility(request(), ACTOR, keys('label.delete')))
      .toEqual({ ok: false, reason: 'tier-too-low' });
  });

  it('AC-4: the actor satisfies a self tier without the decide permission', () => {
    expect(decideEligibility(request({ requiredMode: 'self' }), ACTOR, keys('label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'self' });
  });

  it('AC-5: an agent cannot satisfy a required human tier', () => {
    expect(decideEligibility(request({ requiredMode: 'human' }), AGENT('a2'), keys('approval.decide', 'label.delete')))
      .toEqual({ ok: false, reason: 'tier-too-low' });
  });

  it('AC-6: a decider with the action but no decide permission is refused', () => {
    expect(decideEligibility(request(), USER('u1'), keys('label.delete')))
      .toEqual({ ok: false, reason: 'missing-decide-permission' });
  });

  it('AC-7: a decide pattern matching the action key grants the decide permission', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide@label.*', 'label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it('AC-8: a decide pattern for another prefix does not grant the decide permission', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide@ticket.*', 'label.delete')))
      .toEqual({ ok: false, reason: 'missing-decide-permission' });
  });

  it('AC-9: approverMustHoldAction refuses a decider without the action key', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide')))
      .toEqual({ ok: false, reason: 'missing-action-permission' });
  });

  it('AC-10: without approverMustHoldAction the decide permission alone suffices', () => {
    expect(decideEligibility(request({ approverMustHoldAction: false }), USER('u1'), keys('approval.decide')))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it('AC-11: requireDistinctApprover refuses the actor before any tier check', () => {
    expect(decideEligibility(
      request({ requireDistinctApprover: true, requiredMode: 'self' }),
      ACTOR,
      keys('label.delete'),
    )).toEqual({ ok: false, reason: 'distinct-approver-required' });
  });

  it('AC-12: the on-behalf-of user of an assistant request approves as human with the action only', () => {
    const assistant = request({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u9' }, requiredMode: 'human' });
    expect(decideEligibility(assistant, USER('u9'), keys('label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it.each(['human', 'agent'] as const)('on-behalf-of agents contribute self, not %s', (requiredMode) => {
    const assistant = request({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: ACTOR, requiredMode });
    expect(decideEligibility(assistant, ACTOR, keys('label.delete', 'approval.decide')))
      .toEqual({ ok: false, reason: 'tier-too-low' });
  });

  it('on-behalf-of agents may confirm self without approval.decide', () => {
    const assistant = request({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: ACTOR, requiredMode: 'self' });
    expect(decideEligibility(assistant, ACTOR, keys('label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'self' });
  });

  it('distinct approval also refuses the on-behalf-of agent confirming self', () => {
    const assistant = request({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: ACTOR, requiredMode: 'self', requireDistinctApprover: true });
    expect(decideEligibility(assistant, ACTOR, keys('label.delete', 'approval.decide')))
      .toEqual({ ok: false, reason: 'distinct-approver-required' });
  });

  it('AC-13: a system decider is not a principal', () => {
    expect(decideEligibility(request(), { type: 'SYSTEM', id: 'expiry' }, keys('approval.decide', 'label.delete')))
      .toEqual({ ok: false, reason: 'not-a-principal' });
  });

  it('AC-14: another decider cannot use the .own form to hold the action', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide', 'label.delete.own')))
      .toEqual({ ok: false, reason: 'missing-action-permission' });
  });

  it('AC-15: the actor holds the action through its .own form', () => {
    expect(decideEligibility(request({ requiredMode: 'self' }), ACTOR, keys('label.delete.own')))
      .toEqual({ ok: true, satisfiedBy: 'self' });
  });

  it('refuses a runner decider as not-a-principal even with every key', () => {
    expect(decideEligibility(request(), { type: 'RUNNER', id: 'r1' }, keys('*', 'approval.decide', 'label.delete')))
      .toEqual({ ok: false, reason: 'not-a-principal' });
  });

  it('accepts an exact decide pattern', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide@label.delete', 'label.delete')))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it('does not treat a decide pattern as a substring or prefix match without the dot', () => {
    expect(decideEligibility(request(), USER('u1'), keys('approval.decide@lab.*', 'label.delete')))
      .toEqual({ ok: false, reason: 'missing-decide-permission' });
  });

  it('a non-actor holding only the .own action passes when approverMustHoldAction is false', () => {
    expect(decideEligibility(
      request({ approverMustHoldAction: false }),
      USER('u1'),
      keys('approval.decide', 'label.delete.own'),
    )).toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it('does not treat a user as the on-behalf-of user when the actor is not the assistant', () => {
    const agentOnBehalf = request({ onBehalfOf: { type: 'USER', id: 'u9' }, requiredMode: 'human' });
    expect(decideEligibility(agentOnBehalf, USER('u9'), keys('label.delete')))
      .toEqual({ ok: false, reason: 'missing-decide-permission' });
  });
});

describe('decideEligibility on a system ask', () => {
  it('US-007 AC-1: the user a runner ask is on behalf of approves as human with the action key only', () => {
    expect(decideEligibility(askRequest({ onBehalfOf: { type: 'USER', id: 'u1' } }), USER('u1'), keys(BASH)))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });

  it('US-007 AC-2: the agent a runner ask is on behalf of contributes self, below the agent tier', () => {
    expect(decideEligibility(askRequest({ onBehalfOf: AGENT('a1') }), AGENT('a1'), keys(BASH, 'approval.decide')))
      .toEqual({ ok: false, reason: 'tier-too-low' });
  });

  it('US-007 AC-3: another agent holding the narrowed decide entry approves a runner ask', () => {
    expect(decideEligibility(
      askRequest({ onBehalfOf: AGENT('a1') }),
      AGENT('a2'),
      keys(BASH, 'approval.decide@fleet.job.shell.escalate'),
    )).toEqual({ ok: true, satisfiedBy: 'agent' });
  });

  it('an unrelated decider holding only the action still needs a decide permission', () => {
    expect(decideEligibility(askRequest(), USER('u2'), keys(BASH)))
      .toEqual({ ok: false, reason: 'missing-decide-permission' });
  });

  it('requireDistinctApprover refuses the on-behalf-of agent of a system ask', () => {
    expect(decideEligibility(
      askRequest({ onBehalfOf: AGENT('a1'), requiredMode: 'self', requireDistinctApprover: true }),
      AGENT('a1'),
      keys(BASH, 'approval.decide'),
    )).toEqual({ ok: false, reason: 'distinct-approver-required' });
  });

  it('gives a system ask with no on-behalf-of principal no own-request exception', () => {
    expect(decideEligibility(askRequest(), USER('u1'), keys(BASH, 'approval.decide')))
      .toEqual({ ok: true, satisfiedBy: 'human' });
  });
});
