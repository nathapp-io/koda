import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import { readBundleFiles } from './bundle-reader';

const stream = (b: Buffer) => Readable.from([b]);

describe('readBundleFiles (spec §2.3)', () => {
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
