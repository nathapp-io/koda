import { describe, expect, it } from 'vitest';
import type { MemoryItem } from './memory-item-repository';
import { MAX_DECISIONS_FILE_BYTES, MAX_REVIEW_DECISIONS, REVIEW_EVENT_SOURCE, buildReviewDecisions, reviewRepoSubject } from './review-decisions';

function row(id: string, predicate: string, object?: string): MemoryItem {
  return { id, projectId: 'p1', scope: 'project', kind: 'DECISION', subject: 'project', predicate, object, status: 'active', confidence: 1, createdAt: new Date(0), updatedAt: new Date(0) };
}

describe('review decisions', () => {
  it('formats a repo subject', () => expect(reviewRepoSubject('r1')).toBe('repo:r1'));
  it('exports the review event source', () => expect(REVIEW_EVENT_SOURCE).toBe('review_event'));
  it('builds a decision with its memory source', () => {
    expect(buildReviewDecisions([row('m1', 'auth', 'tokens live in Redis')], [])).toEqual([{ id: 'm1', statement: 'auth: tokens live in Redis', source: 'koda:memory/m1' }]);
  });
  it.each([undefined, null, ''] as const)('uses predicate when object is %s', object => {
    expect(buildReviewDecisions([row('m1', 'auth', object ?? undefined)], [])[0]?.statement).toBe('auth');
  });
  it('truncates ASCII to 1997 characters and ellipsis', () => {
    const statement = `${'a'.repeat(10)}: ${'b'.repeat(2488)}`;
    const result = buildReviewDecisions([row('m1', 'a'.repeat(10), 'b'.repeat(2488))], [])[0]?.statement;
    expect(result).toHaveLength(2000);
    expect(result).toBe(`${statement.slice(0, 1997)}...`);
  });
  it('leaves exactly 2000 code units unchanged', () => {
    const statement = 'a'.repeat(2000);
    expect(buildReviewDecisions([row('m1', statement)], [])[0]?.statement).toBe(statement);
  });
  it('does not cut a surrogate pair', () => {
    const result = buildReviewDecisions([row('m1', '😀'.repeat(1250))], [])[0]?.statement ?? '';
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(result)).toBe(false);
  });
  it('keeps recorded before review-minted rows', () => {
    expect(buildReviewDecisions([row('m1', 'a'), row('m2', 'b')], [row('v1', 'c'), row('v2', 'd')]).map(x => x.id)).toEqual(['m1', 'm2', 'v1', 'v2']);
  });
  it('does not let review-minted rows displace 100 recorded rows', () => {
    const recorded = Array.from({ length: 100 }, (_, i) => row(`m${i}`, 'a'));
    expect(buildReviewDecisions(recorded, Array.from({ length: 5 }, (_, i) => row(`v${i}`, 'b'))).map(x => x.id)).toEqual(recorded.map(x => x.id));
  });
  it('fills remaining slots from review-minted rows in order', () => {
    const minted = Array.from({ length: 5 }, (_, i) => row(`v${i}`, 'b'));
    const result = buildReviewDecisions(Array.from({ length: 98 }, (_, i) => row(`m${i}`, 'a')), minted);
    expect(result).toHaveLength(100);
    expect(result.slice(-2).map(x => x.id)).toEqual(['v0', 'v1']);
  });
  it('defines the count cap', () => expect(MAX_REVIEW_DECISIONS).toBe(100));
  it('drops trailing decisions until the complete wrapper fits the byte cap', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`m${i}`, '漢'.repeat(2000)));
    const decisions = buildReviewDecisions(rows, []);
    expect(decisions.length).toBeLessThan(100);
    expect(decisions.map(x => x.id)).toEqual(rows.slice(0, decisions.length).map(x => x.id));
    expect(Buffer.byteLength(JSON.stringify({ version: 1, decisions }))).toBeLessThanOrEqual(MAX_DECISIONS_FILE_BYTES);
  });
  it('returns an empty list for no rows', () => expect(buildReviewDecisions([], [])).toEqual([]));
});
