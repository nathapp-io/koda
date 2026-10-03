import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JobRow } from '../journal/types';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { assignFor } from '../../test/helpers/assign';
import { Journal } from '../journal/journal';
import { ApprovalRelay } from './approval-relay';
import { signNax } from './nax-callback';

const NOW = new Date('2026-10-04T10:00:00Z');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

let journal: Journal;
let relay: ApprovalRelay;
let nax: ReturnType<typeof Bun.serve> | null;
let answers: Array<{ path: string; body: unknown; sig: string | null }>;
let naxStatus: number;

beforeEach(() => {
  journal = Journal.open(':memory:', () => NOW);
  journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', bashMode: 'escalate' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/tmp/j1' });
  journal.updateJob('j1', 1, { state: 'RUNNING' });
  relay = new ApprovalRelay({ journal, log: silent, now: () => NOW, randomSecret: () => 'f'.repeat(64) });
  answers = []; naxStatus = 200;
  nax = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (req) => {
    answers.push({ path: new URL(req.url).pathname, body: await req.json(), sig: req.headers.get('x-nax-signature') });
    return new Response('OK', { status: naxStatus });
  } });
});
afterEach(() => { relay.stopAll(); nax?.stop(true); journal.close(); });

const job = () => journal.getJob('j1', 1) as JobRow;
const events = () => journal.pendingEvents('j1', 1, 1_000);
const callbackFor = (id: string) => `http://127.0.0.1:${nax?.port ?? 0}/nax/interact/${id}`;
const naxAsk = (id = 'ask-1f2e3d4c') => ({ ...fixtures.a_simple, id, callbackUrl: callbackFor(id) });
const prompt = (id: string) => ({ id, type: 'choose', featureName: 'fa', stage: 'pre-flight', summary: 's', createdAt: 1, timeout: 300_000, fallback: 'continue', callbackUrl: callbackFor(id) });
async function send(endpoint: { url: string; secret: string }, body: object): Promise<number> {
  const raw = JSON.stringify(body);
  return (await fetch(endpoint.url, { method: 'POST', headers: { 'x-nax-signature': signNax(endpoint.secret, raw) }, body: raw })).status;
}
const answerCommand = (choice: string, naxAskId = 'ask-1f2e3d4c') =>
  ({ commandId: 'c1', type: 'APPROVAL_ANSWER', jobId: 'j1', leaseEpoch: 1, payload: { approvalId: 'a1', naxAskId, choice } }) as never;

describe('ApprovalRelay (spec §4)', () => {
  test('open journals the port and secret and returns the /ask url; open again is the same endpoint', async () => {
    const endpoint = await relay.open(job());
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ask$/);
    expect(endpoint.secret).toBe('f'.repeat(64));
    expect(journal.getApprovalReceiver('j1', 1)?.port).toBe(Number(new URL(endpoint.url).port));
    expect(await relay.open(job())).toEqual(endpoint);
  });

  test('a re-prepare whose stored port is taken gets a fresh port and secret (D286)', async () => {
    const endpoint = await relay.open(job());
    relay.stopAll();
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(endpoint.url).port), fetch: () => new Response('x') });
    try {
      const fresh = new ApprovalRelay({ journal, log: silent, now: () => NOW, randomSecret: () => '0'.repeat(64) });
      const reopened = await fresh.open(job());
      expect(reopened.url).not.toBe(endpoint.url);
      expect(reopened.secret).toBe('0'.repeat(64));
      expect(journal.getApprovalReceiver('j1', 1)?.port).toBe(Number(new URL(reopened.url).port));
      fresh.stopAll();
    } finally {
      squatter.stop(true);
    }
  });

  test('an ask is journalled, appended once as approval_request, and answered 200', async () => {
    const endpoint = await relay.open(job());
    expect(await send(endpoint, naxAsk())).toBe(200);
    expect(await send(endpoint, naxAsk())).toBe(200);   // a re-sent POST: no second event (D286)
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toEqual(expect.objectContaining({ deadlineAt: new Date(fixtures.a_simple.createdAt + fixtures.a_simple.timeout).toISOString() }));
    expect(events().filter((e) => e.type === 'approval_request')).toHaveLength(1);
    expect(events().at(-1)).toEqual(expect.objectContaining({ type: 'approval_request', payload: expect.objectContaining({ naxAskId: 'ask-1f2e3d4c', command: 'bun run test' }) }));
  });

  test('a foreign callbackUrl is refused 400 and nothing is journalled (D274)', async () => {
    const endpoint = await relay.open(job());
    expect(await send(endpoint, { ...naxAsk(), callbackUrl: 'http://10.0.0.1:1/nax/interact/ask-1f2e3d4c' })).toBe(400);
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toBeNull();
  });

  test('size gate and paused prompts get the headless answers; any other prompt gets skip (D277, Review Focus 6)', async () => {
    const endpoint = await relay.open(job());
    expect(await send(endpoint, prompt('ix-US-001-size-gate'))).toBe(200);
    expect(await send(endpoint, prompt('ix-US_1.2-paused-resume'))).toBe(200);
    expect(await send(endpoint, { ...prompt('trigger-cost-warning-1-abcdef12'), type: 'confirm', metadata: { trigger: 'cost-warning' } })).toBe(200);
    await Bun.sleep(100);
    const byPath = Object.fromEntries(answers.map((a) => [a.path.split('/').pop(), a.body]));
    expect(byPath['ix-US-001-size-gate']).toEqual(expect.objectContaining({ action: 'approve' }));
    expect(byPath['ix-US_1.2-paused-resume']).toEqual(expect.objectContaining({ action: 'choose', value: 'keep' }));
    expect(byPath['trigger-cost-warning-1-abcdef12']).toEqual(expect.objectContaining({ action: 'skip' }));
    expect(events().filter((e) => e.type === 'approval_request')).toHaveLength(0);
  });

  test('answer POSTs the signed choice, acks ok and clears the ask', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, naxAsk());
    expect(await relay.answer(answerCommand('allow'))).toEqual({ result: 'ok' });
    expect(answers[0]?.body).toEqual({ requestId: 'ask-1f2e3d4c', action: 'choose', value: 'allow', respondedBy: 'koda', respondedAt: expect.any(Number) });
    expect(answers[0]?.sig).toBe(signNax('f'.repeat(64), JSON.stringify(answers[0]?.body)));
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toBeNull();
  });

  test('an unknown ask is rejected ask_not_pending', async () => {
    await relay.open(job());
    expect(await relay.answer(answerCommand('allow', 'ask-99999999'))).toEqual({ result: 'rejected', detail: 'ask_not_pending' });
  });

  test('a job that is no longer RUNNING is rejected job_not_running', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, naxAsk());
    journal.updateJob('j1', 1, { state: 'UPLOADING' });
    expect(await relay.answer(answerCommand('allow'))).toEqual({ result: 'rejected', detail: 'job_not_running' });
    expect(answers).toHaveLength(0);
  });

  test('a 429 from nax is callback_failed:429 and the ask stays journalled', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, naxAsk());
    naxStatus = 429;
    expect(await relay.answer(answerCommand('deny'))).toEqual({ result: 'rejected', detail: 'callback_failed:429' });
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).not.toBeNull();
  });

  test('a malformed answer payload is rejected, never posted', async () => {
    await relay.open(job());
    expect(await relay.answer({ ...(answerCommand('allow') as object), payload: { approvalId: 'a1', naxAskId: 'ask-1f2e3d4c', choice: 'yes' } } as never))
      .toEqual({ result: 'rejected', detail: 'invalid payload' });
  });

  test('close stops that epoch receiver and deletes only its journal state (D285)', async () => {
    const endpoint = await relay.open(job());
    journal.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 2, port: 1, secret: 's' });
    await relay.close('j1', 1);
    expect(journal.getApprovalReceiver('j1', 1)).toBeNull();
    expect(journal.getApprovalReceiver('j1', 2)).not.toBeNull();
    await expect(fetch(endpoint.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  test('resume re-binds the journalled port and secret (Review Focus 3); a taken port throws', async () => {
    const endpoint = await relay.open(job());
    relay.stopAll();                       // the daemon died; the journal survives
    const fresh = new ApprovalRelay({ journal, log: silent, now: () => NOW, randomSecret: () => '0'.repeat(64) });
    await fresh.resume(job());
    expect(await send(endpoint, naxAsk())).toBe(200);   // same url, same secret
    fresh.stopAll();
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(endpoint.url).port), fetch: () => new Response('x') });
    try {
      await expect(new ApprovalRelay({ journal, log: silent, now: () => NOW }).resume(job())).rejects.toThrow();
    } finally {
      squatter.stop(true);
    }
  });

  test('sweepOrphans deletes state of (job, epoch) pairs that are not active', async () => {
    await relay.open(job());
    journal.putApprovalReceiver({ jobId: 'old', leaseEpoch: 3, port: 1, secret: 's' });
    relay.sweepOrphans([job()]);
    expect(journal.approvalStateKeys()).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
});
