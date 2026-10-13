import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ThreadEventWriter } from '../../src/thread/thread-event-writer';

const testRoot = join(import.meta.dir, `.thread-event-writer-write-${crypto.randomUUID()}`);
const CLOCK = '2026-10-13T00:00:00.000Z';
const now = () => new Date(CLOCK);
const logs = { wake: (_jobId: string, _leaseEpoch: number) => undefined };

beforeAll(async () => mkdir(testRoot, { recursive: true }));
afterAll(async () => rm(testRoot, { recursive: true, force: true }));

/** A writer on a fresh stream file with the fixed clock; returns the file path and the writer. */
function makeWriter(): { path: string; writer: ThreadEventWriter } {
  const path = join(testRoot, crypto.randomUUID());
  const writer = new ThreadEventWriter({
    path,
    jobId: 'job-1',
    leaseEpoch: 1,
    logs,
    wakeGapMs: 10,
    now,
    sleep: async () => undefined,
    onCap: () => undefined,
    onWarn: () => undefined,
  });
  return { path, writer };
}

/** Every line of the stream file, parsed; the last one is the line the call under test wrote. */
async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, 'utf8');
  return content.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ThreadEventWriter write-path lines (US-002)', () => {
  test('US-002 AC-1: started with stale true writes a session_started line whose stale is true', async () => {
    const { path, writer } = makeWriter();
    writer.started({ resumed: false, backend: { kind: 'native' }, skillShas: [], stale: true });
    const last = (await readLines(path)).at(-1);
    expect(last).toMatchObject({ type: 'session_started', stale: true });
  });

  test('US-002 AC-2: started with stale false writes a session_started line that has no stale key', async () => {
    const { path, writer } = makeWriter();
    writer.started({ resumed: false, backend: { kind: 'native' }, skillShas: [], stale: false });
    const last = (await readLines(path)).at(-1) ?? {};
    expect(last).toEqual({ type: 'session_started', at: CLOCK, resumed: false, backend: { kind: 'native' }, skillShas: [] });
    expect('stale' in last).toBe(false);
  });

  test('US-002 AC-3: docWritten writes a write_doc line deep-equal to its path and byte count', async () => {
    const { path, writer } = makeWriter();
    writer.docWritten('docs/a.md', 12);
    expect((await readLines(path)).at(-1)).toEqual({ type: 'write_doc', at: CLOCK, path: 'docs/a.md', bytes: 12 });
  });

  test('US-002 AC-4: published writes a published line deep-equal to its result', async () => {
    const { path, writer } = makeWriter();
    writer.published({ sha: 'abc', paths: ['docs/a.md'], ignored: ['src/x.ts'], specPresent: false });
    expect((await readLines(path)).at(-1)).toEqual({
      type: 'published',
      at: CLOCK,
      sha: 'abc',
      paths: ['docs/a.md'],
      ignored: ['src/x.ts'],
      specPresent: false,
    });
  });

  test('US-002: oversized publication results write a bounded publish_failed line', async () => {
    const { path, writer } = makeWriter();
    writer.published({ sha: 'a'.repeat(64), paths: Array.from({ length: 2_000 }, (_, index) => `docs/${index}-${'x'.repeat(40)}.md`), ignored: [], specPresent: false });
    const bytes = await readFile(path);
    const lines = bytes.toString('utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(65_536);
    expect(JSON.parse(line)).toMatchObject({ type: 'publish_failed', reason: 'git_error' });
  });

  test('US-002 AC-5: publishFailed writes a publish_failed line deep-equal to its reason', async () => {
    const { path, writer } = makeWriter();
    writer.publishFailed('repo_busy');
    expect((await readLines(path)).at(-1)).toEqual({ type: 'publish_failed', at: CLOCK, reason: 'repo_busy' });
  });

  test('US-002 AC-6: discarded writes a discarded line deep-equal to its tip sha', async () => {
    const { path, writer } = makeWriter();
    writer.discarded('def');
    expect((await readLines(path)).at(-1)).toEqual({ type: 'discarded', at: CLOCK, tipSha: 'def' });
  });

  test('US-002 AC-7: discardFailed writes a discard_failed line deep-equal to its reason', async () => {
    const { path, writer } = makeWriter();
    writer.discardFailed('no_worktree');
    expect((await readLines(path)).at(-1)).toEqual({ type: 'discard_failed', at: CLOCK, reason: 'no_worktree' });
  });

  test('US-002 AC-8: a write-path line releases held text before it is written', async () => {
    const { path, writer } = makeWriter();
    writer.event({ type: 'text_delta', sessionId: 's', turnId: 't', at: CLOCK, metadata: {}, round: 1, text: 'held words' });
    writer.docWritten('docs/a.md', 3);
    const lines = await readLines(path);
    const heldIndex = lines.findIndex((line) => line.type === 'text_delta' && line.text === 'held words');
    const writeIndex = lines.findIndex((line) => line.type === 'write_doc');
    expect(heldIndex >= 0 && heldIndex < writeIndex).toBe(true);
  });
});
