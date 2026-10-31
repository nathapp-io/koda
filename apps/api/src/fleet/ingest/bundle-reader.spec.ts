import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import { readBundleFiles, slotOf } from './bundle-reader';

const stream = (b: Buffer) => Readable.from([b]);

describe('readBundleFiles (spec §2.3)', () => {
  it('AC-1 maps review artifact and stdout slots', () => {
    expect(slotOf('nax-out/bot/pr-42/r1/bot-review.json')).toBe('botReview');
    expect(slotOf('nax.stdout')).toBe('naxStdout');
  });
  it('AC-2 silently skips oversized review artifact and stdout files', async () => {
    const big = Buffer.alloc(33_554_433, 0x61);
    const gz = await tarGz([
      { name: 'nax.stdout', body: big },
      { name: 'nax-out/bot/pr-42/r1/bot-review.json', body: big },
    ]);
    const files = await readBundleFiles(stream(gz));
    expect(files.oversized).toEqual([]);
    expect(files.botReview).toEqual([]);
    expect(files.naxStdout).toBeNull();
  });

  it('AC-7 assigns the exact result path to its own slot', () => {
    expect(slotOf('workflow/result.json')).toBe('workflowResult');
  });
  it('AC-1 maps the two workflow outcome files to their own slots', () => {
    expect(slotOf('workflow/feature-report.md')).toBe('featureReport');
    expect(slotOf('workflow/decisions.jsonl')).toBe('decisions');
    expect(slotOf('workflow/x/feature-report.md')).toBeNull();
  });
  it('AC-2 reads the feature report and the decisions log as single files', async () => {
    const decisions = '{"id":"D1","kind":"ruling"}\n';
    const gz = await tarGz([
      { name: 'workflow/feature-report.md', body: '# R' },
      { name: 'workflow/decisions.jsonl', body: decisions },
    ]);
    const files = await readBundleFiles(stream(gz));
    expect(files.featureReport).toEqual({ name: 'workflow/feature-report.md', text: '# R' });
    expect(files.decisions).toEqual({ name: 'workflow/decisions.jsonl', text: decisions });
  });

  it('AC-3 answers null for both when the bundle carries neither file', async () => {
    const gz = await tarGz([{ name: 'workflow/result.json', body: '{"schemaVersion":1}' }]);
    const files = await readBundleFiles(stream(gz));
    expect(files.featureReport).toBeNull();
    expect(files.decisions).toBeNull();
  });

  it('collects only allowlisted paths, normalising a leading ./', async () => {
    const gz = await tarGz([
      { name: './nax-out/cost/a.jsonl', body: '{"x":1}\n' },
      { name: 'nax-out/cost/b.jsonl', body: '{"x":2}\n' },
      { name: 'nax-out/metrics.json', body: '[]' },
      { name: 'nax-out/review-audit/f/1-r.json', body: '{}' },
      { name: 'nax-out/finish-audit/f/run-1.result.json', body: '{}' },
      { name: 'nax-out/finish-audit/f/last.json', body: '{}' },
      { name: 'nax-out/finish-audit/f/run-1.jsonl', body: 'ignored' },
      { name: 'nax-out/status.json', body: '{}' },
      { name: 'workflow/result.json', body: '{"schemaVersion":1}' },
      { name: 'nax-out/tool-audit/f/x.json', body: 'ignored' },
      { name: 'nax.stdout', body: 'ignored' },
    ]);
    const files = await readBundleFiles(stream(gz));
    expect(files.cost.map((f) => f.name).sort()).toEqual(['nax-out/cost/a.jsonl', 'nax-out/cost/b.jsonl']);
    expect(files.metrics).toEqual({ name: 'nax-out/metrics.json', text: '[]' });
    expect(files.reviews.map((f) => f.name)).toEqual(['nax-out/review-audit/f/1-r.json']);
    expect(files.finishResults.map((f) => f.name)).toEqual(['nax-out/finish-audit/f/run-1.result.json']);
    expect(files.finishLast.map((f) => f.name)).toEqual(['nax-out/finish-audit/f/last.json']);
    expect(files.status?.text).toBe('{}');
    expect(files.workflowResult).toEqual({ name: 'workflow/result.json', text: '{"schemaVersion":1}' });
    expect(files.oversized).toEqual([]);
  });

  it('ignores traversal, absolute, backslash and symlink entries (Review Focus 3)', async () => {
    const gz = await tarGz([
      { name: 'nax-out/cost/../../etc/passwd.jsonl', body: 'x' },
      { name: '/nax-out/metrics.json', body: '[1]' },
      { name: 'nax-out\\metrics.json', body: '[2]' },
      { name: 'nax-out/metrics.json', type: 'symlink', linkname: '/etc/passwd' },
    ]);
    const files = await readBundleFiles(stream(gz));
    expect(files.cost).toEqual([]);
    expect(files.metrics).toBeNull();
  });

  it('skips an allowed file larger than the cap without reading it into memory (Review Focus 3)', async () => {
    const big = Buffer.alloc(33_554_433, 0x61);
    const gz = await tarGz([{ name: 'nax-out/metrics.json', body: big }, { name: 'nax-out/status.json', body: '{}' }]);
    const files = await readBundleFiles(stream(gz));
    expect(files.metrics).toBeNull();
    expect(files.oversized).toEqual(['nax-out/metrics.json']);
    expect(files.status?.text).toBe('{}');
  });

  it('rejects a corrupt gzip', async () => {
    await expect(readBundleFiles(stream(Buffer.from('not gzip')))).rejects.toThrow();
  });
});
