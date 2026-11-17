import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, HandoffRecordFile } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { handoffRunIds, restoreHandoffRecord } from './handoff-restore';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const RESULT_ENTRY: HandoffRecordFile = { runId: 'run-a', file: 'result.json', mtimeMs: 1763370000000, content: '{"schemaVersion":1}' };
const LEDGER_ENTRY: HandoffRecordFile = { runId: 'run-a', file: 'ledger.md', mtimeMs: 1763370000000, content: '# ledger\n' };
const OTHER_ENTRY: HandoffRecordFile = { runId: 'run-b', file: 'result.json', mtimeMs: 1763370001000, content: '{"schemaVersion":1,"run":"b"}' };
const RECORD: HandoffRecordFile[] = [RESULT_ENTRY, LEDGER_ENTRY, OTHER_ENTRY];

/** A checkout with the feature's directory in place. */
async function repo(): Promise<string> {
  const base = await tmp.make('handoff');
  const repoDir = join(base, 'repo');
  await mkdir(join(repoDir, '.nax', 'features', 'feat'), { recursive: true });
  return repoDir;
}

const workflowDir = (repoDir: string): string => join(repoDir, '.nax', 'features', 'feat', 'workflow');

describe('restoreHandoffRecord (flow-handoff US-007)', () => {
  test('AC-5: the workflow folder of an earlier job is gone after the restore', async () => {
    const repoDir = await repo();
    await mkdir(join(workflowDir(repoDir), 'old-run'), { recursive: true });
    await writeFile(join(workflowDir(repoDir), 'old-run', 'result.json'), '{"old":true}');
    await restoreHandoffRecord(repoDir, 'feat', RECORD);
    await expect(stat(join(workflowDir(repoDir), 'old-run'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('AC-5: the whole workflow folder is replaced, not merged into', async () => {
    const repoDir = await repo();
    await mkdir(join(workflowDir(repoDir), 'old-run'), { recursive: true });
    await writeFile(join(workflowDir(repoDir), 'old-run', 'feature-report.md'), 'old report');
    await restoreHandoffRecord(repoDir, 'feat', RECORD);
    await expect(stat(join(workflowDir(repoDir), 'old-run', 'feature-report.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await stat(join(workflowDir(repoDir), 'run-a', 'result.json'));
  });

  test('AC-6: every entry is written under .nax/features/<feature>/workflow/<runId>/<file>', async () => {
    const repoDir = await repo();
    await restoreHandoffRecord(repoDir, 'feat', RECORD);
    expect(await readFile(join(workflowDir(repoDir), 'run-a', 'result.json'), 'utf8')).toBe(RESULT_ENTRY.content);
    expect(await readFile(join(workflowDir(repoDir), 'run-a', 'ledger.md'), 'utf8')).toBe(LEDGER_ENTRY.content);
    expect(await readFile(join(workflowDir(repoDir), 'run-b', 'result.json'), 'utf8')).toBe(OTHER_ENTRY.content);
  });

  test('AC-7: every written file carries the entry\'s mtime', async () => {
    const repoDir = await repo();
    await restoreHandoffRecord(repoDir, 'feat', RECORD);
    const result = await stat(join(workflowDir(repoDir), 'run-a', 'result.json'));
    const ledger = await stat(join(workflowDir(repoDir), 'run-a', 'ledger.md'));
    const other = await stat(join(workflowDir(repoDir), 'run-b', 'result.json'));
    expect(Math.abs(result.mtimeMs - RESULT_ENTRY.mtimeMs)).toBeLessThan(1);
    expect(Math.abs(ledger.mtimeMs - LEDGER_ENTRY.mtimeMs)).toBeLessThan(1);
    expect(Math.abs(other.mtimeMs - OTHER_ENTRY.mtimeMs)).toBeLessThan(1);
  });

  test('the atime is restored with the mtime', async () => {
    const repoDir = await repo();
    await restoreHandoffRecord(repoDir, 'feat', [RESULT_ENTRY]);
    const st = await stat(join(workflowDir(repoDir), 'run-a', 'result.json'));
    expect(Math.abs(st.atimeMs - RESULT_ENTRY.mtimeMs)).toBeLessThan(1);
  });

  test('an empty record leaves an empty workflow folder behind', async () => {
    const repoDir = await repo();
    await restoreHandoffRecord(repoDir, 'feat', []);
    const entries = await stat(workflowDir(repoDir));
    expect(entries.isDirectory()).toBe(true);
  });

  test('the restore creates the feature folder when the checkout has none', async () => {
    const base = await tmp.make('handoff-empty');
    const repoDir = join(base, 'repo');
    await restoreHandoffRecord(repoDir, 'feat', RECORD);
    expect(await readFile(join(workflowDir(repoDir), 'run-a', 'result.json'), 'utf8')).toBe(RESULT_ENTRY.content);
  });

  test.each([
    ['a run id of ..', { ...RESULT_ENTRY, runId: '..' }],
    ['a run id with a slash', { ...RESULT_ENTRY, runId: 'a/b' }],
    ['a file outside the allowlist', { ...RESULT_ENTRY, file: 'prd.json' as never }],
    ['an mtime that is not an integer', { ...RESULT_ENTRY, mtimeMs: 1.5 }],
    ['an mtime beyond the Date range', { ...RESULT_ENTRY, mtimeMs: 8640000000000001 }],
    ['a content that is not a string', { ...RESULT_ENTRY, content: 5 as never }],
  ])('refuses %s before it touches the filesystem', async (_label, entry) => {
    const repoDir = await repo();
    await expect(restoreHandoffRecord(repoDir, 'feat', [entry])).rejects.toThrow();
    await expect(stat(workflowDir(repoDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a feature name that is not a path segment is refused', async () => {
    const repoDir = await repo();
    await expect(restoreHandoffRecord(repoDir, '../etc', RECORD)).rejects.toThrow();
  });
});

describe('handoffRunIds (flow-handoff US-007)', () => {
  const assign = (handoff?: AssignPayload['handoff']): AssignPayload => ({
    jobId: 'j1', command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
    ref: 'main', feature: 'feat', planFrom: null, profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600,
    gitIdentity: { name: 'n', email: 'e' }, ...(handoff ? { handoff } : {}),
  });

  test('the distinct run ids of the record', () => {
    expect([...handoffRunIds(assign({ record: RECORD }))].sort()).toEqual(['run-a', 'run-b']);
  });

  test('an assign without a handoff has no run ids', () => {
    expect([...handoffRunIds(assign())]).toEqual([]);
  });
});
