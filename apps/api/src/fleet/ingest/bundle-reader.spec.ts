import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import { readBundleFiles, ENTRY_LIMIT_EXCEEDED, MAX_OVERSIZED_NAMES, slotOf } from './bundle-reader';
import { INGEST_LIMITS } from './domain/bundle-ingest.domain';

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

  it('sets the total kept-byte and per-slot limits', () => {
    expect(INGEST_LIMITS.totalBytes).toBe(67_108_864);
    expect(INGEST_LIMITS.maxFilesPerSlot).toBe(5_000);
  });

  const limits = { fileBytes: 100, totalBytes: 150, maxFilesPerSlot: 10 };
  const entry = (name: string, size: number) => ({ name, body: Buffer.alloc(size, 0x61) });

  it('caps total kept bytes and reports the rejected entry (AC-3/4)', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/cost/a.jsonl', 60), entry('nax-out/cost/b.jsonl', 60), entry('nax-out/cost/c.jsonl', 60),
    ])), limits);
    expect(files.cost.map((file) => file.name)).toEqual(['nax-out/cost/a.jsonl', 'nax-out/cost/b.jsonl']);
    expect(files.oversized).toEqual(['nax-out/cost/c.jsonl']);
  });

  it('does not charge skipped entries against the kept-byte budget (AC-5/6)', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/cost/a.jsonl', 60), entry('nax-out/cost/b.jsonl', 100), entry('nax-out/cost/c.jsonl', 40),
    ])), limits);
    expect(files.cost.map((file) => file.name)).toEqual(['nax-out/cost/a.jsonl', 'nax-out/cost/c.jsonl']);
    expect(files.oversized).toEqual(['nax-out/cost/b.jsonl']);
  });

  it('silently skips stdout after the total-byte cap (AC-7/8)', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/cost/a.jsonl', 60), entry('nax-out/metrics.json', 60), entry('nax.stdout', 60),
    ])), limits);
    expect(files.naxStdout).toBeNull();
    expect(files.oversized).not.toContain('nax.stdout');
  });

  it('caps the reviews slot and reports excess review files (AC-9/10)', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/review-audit/f/s1.json', 1), entry('nax-out/review-audit/f/s2.json', 1), entry('nax-out/review-audit/f/s3.json', 1),
    ])), { fileBytes: 100, totalBytes: 10_000, maxFilesPerSlot: 2 });
    expect(files.reviews.map((file) => file.name)).toEqual(['nax-out/review-audit/f/s1.json', 'nax-out/review-audit/f/s2.json']);
    expect(files.oversized).toEqual(['nax-out/review-audit/f/s3.json']);
  });

  it('caps bot-review files without reporting the excess (AC-11/12)', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/bot/pr-1/a/bot-review.json', 1), entry('nax-out/bot/pr-1/b/bot-review.json', 1), entry('nax-out/bot/pr-1/c/bot-review.json', 1),
    ])), { fileBytes: 100, totalBytes: 10_000, maxFilesPerSlot: 2 });
    expect(files.botReview?.map((file) => file.name)).toEqual(['nax-out/bot/pr-1/a/bot-review.json', 'nax-out/bot/pr-1/b/bot-review.json']);
    expect(files.oversized).toEqual([]);
  });

  it('does not charge a per-file oversized entry to total bytes (AC-13/14)', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/metrics.json', 60), entry('nax-out/cost/a.jsonl', 50), entry('nax-out/cost/b.jsonl', 50),
    ])), { fileBytes: 50, totalBytes: 100, maxFilesPerSlot: 10 });
    expect(files.cost.map((file) => file.name)).toEqual(['nax-out/cost/a.jsonl', 'nax-out/cost/b.jsonl']);
    expect(files.oversized).toEqual(['nax-out/metrics.json']);
  });

  it('drains entries skipped by a cap without buffering their bodies (AC-15)', async () => {
    const gz = await tarGz([entry('nax-out/metrics.json', 60)]);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const files = await readBundleFiles(stream(gz), { fileBytes: 100, totalBytes: 50, maxFilesPerSlot: 10 });
      expect(files.metrics).toBeNull();
      expect(files.oversized).toEqual(['nax-out/metrics.json']);
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
    }
  });

  it('drains entries skipped by a cap without buffering their bodies (AC-15)', async () => {
    const gz = await tarGz([entry('nax-out/metrics.json', 60)]);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const files = await readBundleFiles(stream(gz), { fileBytes: 100, totalBytes: 50, maxFilesPerSlot: 10 });
      expect(files.metrics).toBeNull();
      expect(files.oversized).toEqual(['nax-out/metrics.json']);
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
    }
  });

  it('B2 AC-1/2: stops reading at the entry ceiling and reports the bundle partial', async () => {
    const files = await readBundleFiles(stream(await tarGz([
      entry('nax-out/cost/a.jsonl', 1), entry('nax-out/cost/b.jsonl', 1),
      entry('nax-out/cost/c.jsonl', 1), entry('nax-out/metrics.json', 1),
    ])), { fileBytes: 100, totalBytes: 10_000, maxFilesPerSlot: 10, maxEntries: 2 });
    // The two entries under the ceiling are kept; the rest of the archive is never read.
    expect(files.cost.map((file) => file.name)).toEqual(['nax-out/cost/a.jsonl', 'nax-out/cost/b.jsonl']);
    expect(files.metrics).toBeNull();
    expect(files.oversized).toEqual([ENTRY_LIMIT_EXCEEDED]);
  });

  it('B2 AC-3/4: bounds the rejected-name list and keeps the partial signal', async () => {
    const rejected = Array.from({ length: MAX_OVERSIZED_NAMES + 5 }, (_, index) => entry(`nax-out/cost/${index}.jsonl`, 1));
    const files = await readBundleFiles(stream(await tarGz(rejected)),
      { fileBytes: 100, totalBytes: 10_000, maxFilesPerSlot: 1 });
    expect(files.cost.map((file) => file.name)).toEqual(['nax-out/cost/0.jsonl']);
    expect(files.oversized).toHaveLength(MAX_OVERSIZED_NAMES);
    expect(files.oversized[0]).toBe('nax-out/cost/1.jsonl');
    expect(files.oversized.at(-1)).toBe(`nax-out/cost/${MAX_OVERSIZED_NAMES}.jsonl`);
  });

  it('rejects a corrupt gzip', async () => {
    await expect(readBundleFiles(stream(Buffer.from('not gzip')))).rejects.toThrow();
  });
});
