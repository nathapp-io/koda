import { parseThreadLine } from './thread-line';

const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);

describe('parseThreadLine write-path lines (US-002)', () => {
  it('US-002 AC-1: parses a write_doc line with its path and bytes', () => {
    expect(parseThreadLine('{"type":"write_doc","path":"docs/a.md","bytes":12}')).toEqual({ type: 'write_doc', path: 'docs/a.md', bytes: 12 });
  });

  it('US-002 AC-2: rejects a write_doc line with negative bytes', () => {
    expect(parseThreadLine('{"type":"write_doc","path":"docs/a.md","bytes":-1}')).toEqual({ bad: true });
  });

  it.each([
    ['an empty path', { path: '', bytes: 1 }],
    ['a path longer than 512 characters', { path: 'p'.repeat(513), bytes: 1 }],
    ['a non-integer byte count', { path: 'docs/a.md', bytes: 1.5 }],
    ['a non-string path', { path: 3, bytes: 1 }],
  ])('US-002 AC-2: rejects a write_doc line with %s', (_description, fields) => {
    expect(parseThreadLine(JSON.stringify({ type: 'write_doc', ...fields }))).toEqual({ bad: true });
  });

  it('US-002 AC-2: keeps a write_doc path of exactly 512 characters', () => {
    const path = 'p'.repeat(512);
    expect(parseThreadLine(JSON.stringify({ type: 'write_doc', path, bytes: 0 }))).toEqual({ type: 'write_doc', path, bytes: 0 });
  });

  it('US-002 AC-3: parses a published line with its sha, paths, ignored and specPresent', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'published', sha: SHA40, paths: ['docs/a.md'], ignored: [], specPresent: true,
    }))).toEqual({ type: 'published', sha: SHA40, paths: ['docs/a.md'], ignored: [], specPresent: true });
  });

  it('US-002 AC-3: accepts a 64-character lowercase hex sha on a published line', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'published', sha: SHA64, paths: [], ignored: [], specPresent: false,
    }))).toMatchObject({ type: 'published', sha: SHA64 });
  });

  it('US-002 AC-4: rejects a published line whose sha is not hex', () => {
    expect(parseThreadLine(JSON.stringify({ type: 'published', sha: 'xyz', paths: [], ignored: [], specPresent: false }))).toEqual({ bad: true });
  });

  it.each([
    ['an uppercase sha', 'A'.repeat(40)],
    ['a 39-character sha', 'a'.repeat(39)],
    ['a 41-character sha', 'a'.repeat(41)],
  ])('US-002 AC-4: rejects a published line whose sha is %s', (_description, sha) => {
    expect(parseThreadLine(JSON.stringify({ type: 'published', sha, paths: [], ignored: [], specPresent: false }))).toEqual({ bad: true });
  });

  it.each([
    ['paths holding more than 200 entries', { paths: Array.from({ length: 201 }, (_, i) => `d${i}.md`), ignored: [] }],
    ['an empty path entry', { paths: [''], ignored: [] }],
    ['a path entry longer than 512 characters', { paths: ['p'.repeat(513)], ignored: [] }],
    ['an ignored list that is not an array', { paths: [], ignored: 'x' }],
    ['a non-string ignored entry', { paths: [], ignored: [7] }],
  ])('US-002 AC-4: rejects a published line with %s', (_description, fields) => {
    expect(parseThreadLine(JSON.stringify({ type: 'published', sha: SHA40, specPresent: true, ...fields }))).toEqual({ bad: true });
  });

  it('US-002 AC-4: rejects a published line whose specPresent is not a boolean', () => {
    expect(parseThreadLine(JSON.stringify({ type: 'published', sha: SHA40, paths: [], ignored: [], specPresent: 'yes' }))).toEqual({ bad: true });
  });

  it('US-002 AC-5: parses a publish_failed line with its reason', () => {
    expect(parseThreadLine('{"type":"publish_failed","reason":"branch_moved"}')).toEqual({ type: 'publish_failed', reason: 'branch_moved' });
  });

  it.each([
    ['an empty reason', ''],
    ['a reason longer than 64 characters', 'r'.repeat(65)],
  ])('US-002 AC-5: rejects a publish_failed line with %s', (_description, reason) => {
    expect(parseThreadLine(JSON.stringify({ type: 'publish_failed', reason }))).toEqual({ bad: true });
  });

  it('US-002 AC-6: parses a discarded line with its tipSha', () => {
    expect(parseThreadLine(JSON.stringify({ type: 'discarded', tipSha: SHA40 }))).toEqual({ type: 'discarded', tipSha: SHA40 });
  });

  it('US-002 AC-6: rejects a discarded line whose tipSha is not hex', () => {
    expect(parseThreadLine('{"type":"discarded","tipSha":"xyz"}')).toEqual({ bad: true });
  });

  it('US-002 AC-6: rejects a discarded line with no tipSha', () => {
    expect(parseThreadLine('{"type":"discarded"}')).toEqual({ bad: true });
  });

  it('US-002 AC-6: parses a discard_failed line with its reason', () => {
    expect(parseThreadLine('{"type":"discard_failed","reason":"git_error"}')).toEqual({ type: 'discard_failed', reason: 'git_error' });
  });

  it('US-002 AC-6: rejects a discard_failed line with an empty reason', () => {
    expect(parseThreadLine('{"type":"discard_failed","reason":""}')).toEqual({ bad: true });
  });

  it('US-002 AC-7: keeps stale true on a session_started line', () => {
    expect(parseThreadLine('{"type":"session_started","resumed":false,"stale":true}')).toEqual({
      type: 'session_started', resumed: false, stale: true,
    });
  });

  it('US-002 AC-8: rejects a session_started line whose stale is false', () => {
    expect(parseThreadLine('{"type":"session_started","resumed":false,"stale":false}')).toEqual({ bad: true });
  });

  it('US-002 AC-8: rejects a session_started line whose stale is not a boolean', () => {
    expect(parseThreadLine('{"type":"session_started","resumed":false,"stale":"yes"}')).toEqual({ bad: true });
  });

  it('US-002: a session_started line without stale carries no stale key', () => {
    expect(parseThreadLine('{"type":"session_started","resumed":true}')).not.toHaveProperty('stale');
  });

  it('US-002: keeps a valid at on a write-path line and drops one that is not a date', () => {
    expect(parseThreadLine('{"type":"write_doc","at":"2026-10-15T00:00:00.000Z","path":"a.md","bytes":1}')).toEqual({
      type: 'write_doc', at: '2026-10-15T00:00:00.000Z', path: 'a.md', bytes: 1,
    });
    expect(parseThreadLine('{"type":"publish_failed","at":"garbage","reason":"git_error"}')).toEqual({
      type: 'publish_failed', reason: 'git_error',
    });
  });
});
