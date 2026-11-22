import { describe, expect, test } from 'bun:test';
import type { ThreadAcpOffer, ThreadAgent } from '@nathapp/fleet-protocol';
import type { AcpAgentProbe } from './acp-agent-probe';
import { ACP_LAST_GOOD_MAX_AGE_MS, createAcpOfferMemory } from './acp-offer-memory';

const T1 = '2026-11-22T02:00:00.000Z';
/** A time `minutes` after T1, as the probe would stamp it. */
const at = (minutes: number): string => new Date(Date.parse(T1) + minutes * 60_000).toISOString();

const confirmed = (t: string, agent: ThreadAgent = 'codex'): ThreadAcpOffer => ({
  agent, launchable: true, loggedIn: true, models: ['gpt-6-luna'], efforts: [], checkedAt: t,
});

const failed = (code: 'timeout' | 'unavailable' | 'error', t: string, agent: ThreadAgent = 'codex'): ThreadAcpOffer => ({
  agent, launchable: true, loggedIn: null, models: [], efforts: [], checkedAt: t, lastError: { code, at: t },
});

interface Steps {
  readonly probe: AcpAgentProbe;
  readonly now: () => Date;
}

/**
 * A probe answering one list per call (the last answer repeats). The wrapper's clock always equals the `checkedAt`
 * of the answer the probe returns on that call, as the story's fixtures require.
 */
function steps(...answers: ThreadAcpOffer[][]): Steps {
  let index = 0;
  let current = T1;
  const probe: AcpAgentProbe = async () => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? [];
    index += 1;
    const stamped = answer.find((offer) => offer.checkedAt !== undefined)?.checkedAt;
    if (stamped !== undefined) current = stamped;
    return answer;
  };
  return { probe, now: () => new Date(current) };
}

const memoryOver = (s: Steps, maxAgeMs?: number): AcpAgentProbe =>
  createAcpOfferMemory(s.probe, maxAgeMs === undefined ? { now: s.now } : { now: s.now, maxAgeMs });

describe('createAcpOfferMemory (US-004)', () => {
  test('AC-1: a confirmed offer passes through unchanged', async () => {
    const probe = memoryOver(steps([confirmed(T1)]));
    expect(await probe()).toEqual([confirmed(T1)]);
  });

  test('AC-2: a timeout within the max age reports the remembered offer with the new lastError', async () => {
    const probe = memoryOver(steps([confirmed(T1)], [failed('timeout', at(10))]));
    await probe();
    expect(await probe()).toEqual([{ ...confirmed(T1), lastError: { code: 'timeout', at: at(10) } }]);
  });

  test('AC-3: an unavailable agent likewise keeps the remembered offer and its code travels', async () => {
    const probe = memoryOver(steps([confirmed(T1)], [failed('unavailable', at(10))]));
    await probe();
    expect(await probe()).toEqual([{ ...confirmed(T1), lastError: { code: 'unavailable', at: at(10) } }]);
  });

  test('AC-4: a failure past ACP_LAST_GOOD_MAX_AGE_MS drops the memory and reports the failed offer', async () => {
    expect(ACP_LAST_GOOD_MAX_AGE_MS).toBe(1_800_000);
    const late = failed('timeout', at(31));
    const probe = memoryOver(steps([confirmed(T1)], [late]));
    await probe();
    expect(await probe()).toEqual([late]);
  });

  test('AC-5: a failure exactly at ACP_LAST_GOOD_MAX_AGE_MS still keeps the remembered offer', async () => {
    const probe = memoryOver(steps([confirmed(T1)], [failed('timeout', at(30))]));
    await probe();
    const offer = (await probe())[0];
    expect(offer?.loggedIn).toBe(true);
    expect(offer?.checkedAt).toBe(T1);
    expect(offer?.lastError?.code).toBe('timeout');
  });

  test('AC-6: once the memory is too old, a later failure is reported unchanged', async () => {
    const third = failed('timeout', at(32));
    const probe = memoryOver(steps([confirmed(T1)], [failed('timeout', at(31))], [third]));
    await probe();
    await probe();
    expect(await probe()).toEqual([third]);
  });

  test('AC-7: a logged-out offer clears the memory, so the next failure is reported unchanged', async () => {
    const loggedOut: ThreadAcpOffer = { agent: 'codex', launchable: true, loggedIn: false, models: [], efforts: [], checkedAt: at(5) };
    const third = failed('timeout', at(10));
    const probe = memoryOver(steps([confirmed(T1)], [loggedOut], [third]));
    await probe();
    await probe();
    expect(await probe()).toEqual([third]);
  });

  test('AC-8: a not-launchable offer clears the memory, so the next failure is reported unchanged', async () => {
    const gone: ThreadAcpOffer = { agent: 'codex', launchable: false, loggedIn: null, models: [], efforts: [], checkedAt: at(5) };
    const third = failed('timeout', at(10));
    const probe = memoryOver(steps([confirmed(T1)], [gone], [third]));
    await probe();
    await probe();
    expect(await probe()).toEqual([third]);
  });

  test('AC-9: a newer confirmed offer replaces the memory, models and checkedAt included', async () => {
    const better: ThreadAcpOffer = { ...confirmed(at(10)), models: ['gpt-6.1-sol'] };
    const probe = memoryOver(steps([confirmed(T1)], [better], [failed('error', at(20))]));
    await probe();
    await probe();
    const offer = (await probe())[0];
    expect(offer?.models).toEqual(['gpt-6.1-sol']);
    expect(offer?.checkedAt).toBe(at(10));
    expect(offer?.lastError?.code).toBe('error');
  });

  test('AC-10: each agent keeps its own memory, so one agent failing does not disturb another', async () => {
    const probe = memoryOver(steps(
      [confirmed(T1, 'claude'), confirmed(T1)],
      [{ ...failed('timeout', at(10)), agent: 'claude' }, confirmed(at(10))],
    ));
    await probe();
    const claude = (await probe()).find((offer) => offer.agent === 'claude');
    expect(claude?.loggedIn).toBe(true);
    expect(claude?.lastError?.code).toBe('timeout');
  });

  test('a remembered offer with an unparseable checkedAt is never kept', async () => {
    const stamped = [{ ...confirmed(T1), checkedAt: 'not-a-date' }];
    const late = failed('timeout', at(10));
    let call = 0;
    const probe = createAcpOfferMemory(async () => (call++ === 0 ? stamped : [late]), { now: () => new Date(at(10)) });
    await probe();
    expect(await probe()).toEqual([late]);
  });
});
