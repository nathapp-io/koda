import { afterAll, describe, expect, test } from 'bun:test';
import { lstat, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { findWorkflowResult, parseWorkflowResult } from './workflow-result';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const validDraft = (runId: string, reasons: unknown = ['ok']) => ({
  schemaVersion: 1,
  runId,
  feature: 'f',
  stories: {},
  verdict: { workflowPassed: true, outcome: 'draft', reasons },
});

describe('parseWorkflowResult (US-001)', () => {
  test('AC-12: 25 string reasons and one 600-char reason returns 20 reasons, none longer than 500', () => {
    const reasons = ['x'.repeat(600), ...Array.from({ length: 25 }, (_, i) => `reason-${i}`)];
    const parsed = parseWorkflowResult({ schemaVersion: 1, runId: 'r1', verdict: { workflowPassed: true, outcome: 'draft', reasons } });
    expect(parsed?.outcome).toBe('draft');
    expect(parsed?.reasons).toHaveLength(20);
    for (const r of parsed?.reasons ?? []) expect(r.length).toBeLessThanOrEqual(500);
    expect((parsed?.reasons ?? [])[0]).toHaveLength(500);
  });

  test('AC-13: schemaVersion 2, no verdict, or outcome failed returns null', () => {
    expect(parseWorkflowResult({ schemaVersion: 2, runId: 'r', verdict: { outcome: 'draft', reasons: [] } })).toBeNull();
    expect(parseWorkflowResult({ schemaVersion: 1, runId: 'r' })).toBeNull();
    expect(parseWorkflowResult({ schemaVersion: 1, runId: 'r', verdict: { outcome: 'failed', reasons: [] } })).toBeNull();
  });
});

describe('findWorkflowResult (US-001)', () => {
  test('AC-14: returns b with runDir ending in workflow/b; with only a and c it returns null', async () => {
    const featureDir = await tmp.make('wf14');
    const wf = join(featureDir, 'workflow');
    await mkdir(join(wf, 'a'), { recursive: true });
    await mkdir(join(wf, 'b'), { recursive: true });
    await mkdir(join(wf, 'c'), { recursive: true });
    await writeFile(join(wf, 'a', 'result.json'), JSON.stringify(validDraft('run-a')));
    await writeFile(join(wf, 'b', 'result.json'), JSON.stringify(validDraft('run-b')));
    await writeFile(join(wf, 'c', 'result.json'), JSON.stringify(validDraft('run-c')));
    // turn c/result.json into a symlink
    await rm(join(wf, 'c', 'result.json'));
    await symlink(join(wf, 'b', 'result.json'), join(wf, 'c', 'result.json'));
    const sinceMs = Date.now();
    // a before, b after, c symlink after (lstat mtime of symlink is now, after sinceMs)
    await utimes(join(wf, 'a', 'result.json'), new Date(sinceMs - 10_000), new Date(sinceMs - 10_000));
    await utimes(join(wf, 'b', 'result.json'), new Date(sinceMs + 10_000), new Date(sinceMs + 10_000));

    const found = await findWorkflowResult(featureDir, sinceMs);
    expect(found?.result.runId).toBe('run-b');
    expect(found?.runDir.endsWith(join('workflow', 'b'))).toBe(true);

    // with only a and c present it returns null
    await rm(join(wf, 'b', 'result.json'));
    // c is still a symlink, a is too old
    expect(await findWorkflowResult(featureDir, sinceMs)).toBeNull();
    expect((await lstat(join(wf, 'c', 'result.json')).catch(() => null)) !== null).toBe(true);
  });

  test('AC-15: newest verdict-less, too-large, and symlinked dir are skipped for old', async () => {
    const featureDir = await tmp.make('wf15');
    const wf = join(featureDir, 'workflow');
    await mkdir(join(wf, 'new'), { recursive: true });
    await mkdir(join(wf, 'old'), { recursive: true });
    await mkdir(join(wf, 'big'), { recursive: true });
    await mkdir(join(wf, 'target'), { recursive: true });
    await writeFile(join(wf, 'new', 'result.json'), JSON.stringify({ schemaVersion: 1, runId: 'run-new' }));
    await writeFile(join(wf, 'old', 'result.json'), JSON.stringify(validDraft('run-old', ['push failed'])));
    await writeFile(join(wf, 'big', 'result.json'), 'x'.repeat(1024 * 1024 + 1));
    await writeFile(join(wf, 'target', 'result.json'), JSON.stringify(validDraft('run-link')));
    await symlink(join(wf, 'target'), join(wf, 'link'));
    const sinceMs = Date.now();
    await utimes(join(wf, 'old', 'result.json'), new Date(sinceMs + 1_000), new Date(sinceMs + 1_000));
    await utimes(join(wf, 'new', 'result.json'), new Date(sinceMs + 2_000), new Date(sinceMs + 2_000));
    await utimes(join(wf, 'big', 'result.json'), new Date(sinceMs + 3_000), new Date(sinceMs + 3_000));

    const found = await findWorkflowResult(featureDir, sinceMs);
    expect(found?.result.runId).toBe('run-old');
    expect(found?.runDir.endsWith(join('workflow', 'old'))).toBe(true);
  });
});
