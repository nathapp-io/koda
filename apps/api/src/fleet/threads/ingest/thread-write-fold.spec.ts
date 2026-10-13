import { writeLinePatch, type WriteFoldState } from './thread-write-fold';
import type { WriteLine } from './thread-write-fold';
import type { ThreadSession } from '../domain/chat-thread.domain';

const SHA = 'c'.repeat(40);
const CTX = { jobId: 'J', at: '2026-10-15T01:00:00.000Z' };
const EMPTY: WriteFoldState = { writtenPaths: [], session: null };

const session = (over: Partial<ThreadSession> = {}): ThreadSession => ({
  jobId: 'J', state: 'live', resumed: false, contextReset: false, reason: null, at: 'A', ...over,
});

describe('writeLinePatch (US-002)', () => {
  it('US-002 AC-10: a write_doc line on a thread already holding 200 paths returns a patch with no writtenPaths key', () => {
    const writtenPaths = Array.from({ length: 200 }, (_, i) => `d${i}.md`);
    const patch = writeLinePatch({ writtenPaths, session: null }, { type: 'write_doc', path: 'new.md', bytes: 1 }, CTX);
    expect(patch).not.toHaveProperty('writtenPaths');
  });

  it('US-002 AC-10: a write_doc line for a 201st distinct path is dropped, not appended', () => {
    const writtenPaths = Array.from({ length: 200 }, (_, i) => `d${i}.md`);
    const patch = writeLinePatch({ writtenPaths, session: null }, { type: 'write_doc', path: 'd200.md', bytes: 1 }, CTX);
    expect(patch).toEqual({});
  });

  it('US-002 AC-10: a write_doc line for a path already held at the 200 cap leaves writtenPaths unchanged', () => {
    const writtenPaths = Array.from({ length: 200 }, (_, i) => `d${i}.md`);
    const patch = writeLinePatch({ writtenPaths, session: null }, { type: 'write_doc', path: 'd7.md', bytes: 1 }, CTX);
    expect(patch).not.toHaveProperty('writtenPaths');
  });

  it('US-002: a write_doc line below the cap appends its path', () => {
    const patch = writeLinePatch({ writtenPaths: ['docs/a.md'], session: null }, { type: 'write_doc', path: 'docs/b.md', bytes: 3 }, CTX);
    expect(patch).toEqual({ writtenPaths: ['docs/a.md', 'docs/b.md'] });
  });

  it('US-002: a write_doc line for a path already present leaves writtenPaths unchanged', () => {
    const patch = writeLinePatch({ writtenPaths: ['docs/a.md'], session: null }, { type: 'write_doc', path: 'docs/a.md', bytes: 3 }, CTX);
    expect(patch).not.toHaveProperty('writtenPaths');
  });

  it('US-002: a published line sets the sha, specPublished, empties writtenPaths and records lastWrite', () => {
    const patch = writeLinePatch(
      { writtenPaths: ['docs/a.md'], session: null },
      { type: 'published', sha: SHA, paths: ['docs/a.md'], ignored: [], specPresent: true },
      CTX,
    );
    expect(patch).toEqual({
      publishedSha: SHA, specPublished: true, writtenPaths: [],
      lastWrite: { kind: 'published', jobId: 'J', at: CTX.at, sha: SHA, paths: ['docs/a.md'], ignored: [] },
    });
  });

  it('US-002: a publish_failed line sets lastWrite and leaves writtenPaths and the sha alone', () => {
    const patch = writeLinePatch(EMPTY, { type: 'publish_failed', reason: 'branch_moved' }, CTX);
    expect(patch).toEqual({ lastWrite: { kind: 'publish_failed', jobId: 'J', at: CTX.at, reason: 'branch_moved' } });
  });

  it('US-002: a discarded line empties writtenPaths, records the tip as sha and drops a stale flag from the session', () => {
    const patch = writeLinePatch(
      { writtenPaths: ['docs/a.md'], session: session({ stale: true }) },
      { type: 'discarded', tipSha: SHA },
      CTX,
    );
    expect(patch).toEqual({
      writtenPaths: [],
      lastWrite: { kind: 'discarded', jobId: 'J', at: CTX.at, sha: SHA },
      session: session(),
    });
    expect(patch.session).not.toHaveProperty('stale');
  });

  it('US-002: a discarded line on a session without stale leaves the session out of the patch', () => {
    const patch = writeLinePatch({ writtenPaths: [], session: session() }, { type: 'discarded', tipSha: SHA }, CTX);
    expect(patch).not.toHaveProperty('session');
  });

  it('US-002: a discarded line with no stored session leaves the session out of the patch', () => {
    const patch = writeLinePatch(EMPTY, { type: 'discarded', tipSha: SHA }, CTX);
    expect(patch).not.toHaveProperty('session');
  });

  it('US-002: a discard_failed line sets lastWrite and nothing else', () => {
    const patch = writeLinePatch(EMPTY, { type: 'discard_failed', reason: 'git_error' }, CTX);
    expect(patch).toEqual({ lastWrite: { kind: 'discard_failed', jobId: 'J', at: CTX.at, reason: 'git_error' } });
  });

  it("US-002: a write-path line's own at wins over the fold clock", () => {
    const line: WriteLine = { type: 'publish_failed', at: '2026-01-01T00:00:00.000Z', reason: 'git_error' };
    expect(writeLinePatch(EMPTY, line, CTX)).toEqual({
      lastWrite: { kind: 'publish_failed', jobId: 'J', at: '2026-01-01T00:00:00.000Z', reason: 'git_error' },
    });
  });
});
