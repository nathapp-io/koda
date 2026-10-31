import type { BundleFiles } from '../bundle-reader';
import { parseBotReview } from './bot-review.parser';

const event = (overrides: Record<string, unknown> = {}) => ({
  type: 'finding-withdrawn', key: 'f-12345678', threadId: 'thread-1', finding: 'finding', reason: 'reason', disagreedBy: ['alice'], ...overrides,
});
const artifact = (events: unknown[] = [event()], overrides: Record<string, unknown> = {}) => ({
  version: 3, pr: { number: 42 }, trusted: true, events, ...overrides,
});
const files = (artifacts: Array<{ name: string; text: string }>, stdout: string | null = null): BundleFiles => ({
  cost: [], metrics: null, reviews: [], finishResults: [], finishLast: [], status: null, workflowResult: null, oversized: [],
  botReview: artifacts, naxStdout: stdout ? { name: 'nax.stdout', text: stdout } : null,
});
const run = (name: string, value: unknown = artifact()) => ({ name: `nax-out/bot/pr-42/${name}/bot-review.json`, text: JSON.stringify(value) });

describe('parseBotReview', () => {
  it('AC-3 rejects non-nax finding keys', () => expect(parseBotReview(files([run('r1', artifact([event({ key: 'review-pr-1' })]))]), 42)).toMatchObject({ outcome: 'done', events: [] }));
  it('AC-4 replaces every control character before clipping', () => expect(parseBotReview(files([run('r1', artifact([event({ finding: 'a\nb\u0007c' })]))]), 42)).toMatchObject({ events: [{ finding: 'a b c' }] }));
  it('AC-5 parses one valid artifact', () => expect(parseBotReview(files([run('r1')]), 42)).toEqual({ outcome: 'done', trusted: true, events: [{ key: 'f-12345678', threadId: 'thread-1', finding: 'finding', reason: 'reason', disagreedBy: ['alice'] }] }));
  it('AC-6 selects the artifact named by stdout', () => expect(parseBotReview(files([run('r1', artifact([event({ threadId: 'one' })])), run('r2', artifact([event({ threadId: 'two' })]))], 'nax bot review: artifact /x/out/bot/pr-42/r2/bot-review.json'), 42)).toMatchObject({ events: [{ threadId: 'two' }] }));
  it('AC-6 reports ambiguity when stdout names a missing artifact', () => expect(parseBotReview(files([run('r1')], 'nax bot review: artifact /x/out/other-review.json'), 42)).toEqual({ outcome: 'invalid', reason: 'artifact-ambiguous' }));
  it('AC-7 reports ambiguity without a success line', () => expect(parseBotReview(files([run('r1'), run('r2')], 'ordinary output'), 42)).toEqual({ outcome: 'invalid', reason: 'artifact-ambiguous' }));
  it('AC-8 reports absent when no artifact exists', () => expect(parseBotReview(files([]), 42)).toEqual({ outcome: 'absent' }));
  it('AC-9 rejects malformed JSON', () => expect(parseBotReview(files([{ ...run('r1'), text: '{' }]), 42)).toEqual({ outcome: 'invalid', reason: 'artifact-invalid' }));
  it('AC-10 validates PR number', () => expect(parseBotReview(files([run('r1', { ...artifact(), pr: { number: 43 } })]), 42)).toEqual({ outcome: 'invalid', reason: 'artifact-invalid' }));
  it('AC-11 validates trusted boolean', () => expect(parseBotReview(files([run('r1', artifact([], { trusted: 'yes' }))]), 42)).toEqual({ outcome: 'invalid', reason: 'artifact-invalid' }));
  it('AC-12 ignores other event types', () => expect(parseBotReview(files([run('r1', artifact([event(), event({ type: 'finding-agreed', threadId: 'ignored' })]))]), 42)).toMatchObject({ events: [{ threadId: 'thread-1' }] }));
  it('AC-13 filters invalid logins', () => expect(parseBotReview(files([run('r1', artifact([event({ disagreedBy: ['alice', 'bad login', 'bob'] })]))]), 42)).toMatchObject({ events: [{ disagreedBy: ['alice', 'bob'] }] }));
  it('AC-14 caps events to the first 50', () => {
    const events = Array.from({ length: 60 }, (_, i) => event({ threadId: `thread-${i}` }));
    expect(parseBotReview(files([run('r1', artifact(events))]), 42)).toMatchObject({ events: Array.from({ length: 50 }, (_, i) => expect.objectContaining({ threadId: `thread-${i}` })) });
  });
});
