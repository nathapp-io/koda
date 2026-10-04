import { LineSpan } from './log-lines';
import { LogFilter, toEntry } from './log-entry';

const line = (o: object) => `${JSON.stringify(o)}\n`;
const span = (raw: string, start = 100, cut = false): LineSpan => ({ start, end: start + Buffer.byteLength(raw), cut });
const run = (raw: string, f: LogFilter = {}, cut = false) => toEntry('run', span(raw, 100, cut), Buffer.from(raw), f);
const entry = { timestamp: '2026-10-04T08:15:30.123Z', level: 'warn', stage: 'review', storyId: 'US-001', sessionRole: 'implementer', message: 'slow', data: { ms: 900 } };

describe('toEntry (spec §3.3, D339-D340)', () => {
  it('parses a nax LogEntry line; length includes the newline', () => {
    const raw = line(entry);
    expect(run(raw)).toEqual({ offset: 100, length: Buffer.byteLength(raw), ...entry });
  });

  it('keeps only string fields and data as written', () => {
    expect(run(line({ level: 'info', stage: 7, message: 'm', data: [1, 2] }))).toEqual({ offset: 100, length: expect.any(Number), level: 'info', message: 'm', data: [1, 2] });
  });

  it.each([
    ['not json', 'hello world\n'],
    ['an array', '[1,2]\n'],
    ['an unknown level', line({ level: 'trace', message: 'x' })],
    ['the silent level', line({ level: 'silent', message: 'x' })],
    ['a missing level', line({ message: 'x' })],
  ])('treats %s as unparsed text', (_name, raw) => {
    expect(run(raw)).toEqual({ offset: 100, length: Buffer.byteLength(raw), unparsed: true, text: raw.slice(0, -1) });
  });

  it('applies the minimum level', () => {
    expect(run(line({ ...entry, level: 'info' }), { level: 'warn' })).toBeNull();
    expect(run(line({ ...entry, level: 'warn' }), { level: 'warn' })).not.toBeNull();
    expect(run(line({ ...entry, level: 'error' }), { level: 'warn' })).not.toBeNull();
    expect(run(line({ ...entry, level: 'debug' }), { level: 'debug' })).not.toBeNull();
  });

  it('matches story, stage and role exactly', () => {
    const raw = line(entry);
    expect(run(raw, { storyId: 'US-001', stage: 'review', role: 'implementer' })).not.toBeNull();
    expect(run(raw, { storyId: 'US-00' })).toBeNull();
    expect(run(raw, { stage: 'Review' })).toBeNull();
    expect(run(raw, { role: 'reviewer' })).toBeNull();
  });

  it('matches q case-insensitively against the raw line, keys included (R11)', () => {
    const raw = line(entry);
    expect(run(raw, { q: 'STORYID' })).not.toBeNull();
    expect(run(raw, { q: 'SLOW' })).not.toBeNull();
    expect(run(raw, { q: 'nothing-here' })).toBeNull();
  });

  it('keeps unparsed lines only for q or no filter', () => {
    expect(run('boom\n')).toMatchObject({ unparsed: true });
    expect(run('boom\n', { q: 'BOO' })).toMatchObject({ unparsed: true, text: 'boom' });
    expect(run('boom\n', { level: 'debug' })).toBeNull();
    expect(run('boom\n', { storyId: 'US-001' })).toBeNull();
  });

  it('never parses a cut span; it is unparsed and flagged', () => {
    const raw = '{"level":"info","message":"par';
    expect(run(raw, {}, true)).toEqual({ offset: 100, length: raw.length, unparsed: true, truncatedLine: true, text: raw });
  });

  it('returns stdout and stderr lines as text; only q applies', () => {
    const raw = 'Compiling 3 files\n';
    expect(toEntry('stdout', span(raw), Buffer.from(raw), { level: 'error', storyId: 'x' })).toEqual({ offset: 100, length: 18, text: 'Compiling 3 files' });
    expect(toEntry('stderr', span(raw), Buffer.from(raw), { q: 'nope' })).toBeNull();
    expect(toEntry('stderr', span(raw, 0, true), Buffer.from(raw), {})).toMatchObject({ truncatedLine: true });
  });

  it('replaces invalid UTF-8 with U+FFFD', () => {
    const raw = Buffer.concat([Buffer.from('a'), Buffer.from([0xff]), Buffer.from('b\n')]);
    expect(toEntry('stdout', { start: 0, end: raw.length, cut: false }, raw, {})).toEqual({ offset: 0, length: 4, text: 'a�b' });
  });
});
