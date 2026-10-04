import { afterAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { readPlanCost } from './plan-cost';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

async function ledger(files: Record<string, string> = {}): Promise<string> {
  const out = await tmp.make('plan-cost');
  await mkdir(join(out, 'cost'));
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(out, 'cost', name), text)));
  return out;
}

describe('readPlanCost (#203)', () => {
  test('sums every job ledger and rounds only the total to the snapshot precision', async () => {
    const out = await ledger({
      'b.jsonl': '{"callId":"other","costUsd":0.01}\n',
      'notes.txt': '{"costUsd":100}\n',
    });
    await copyFile(join(import.meta.dir, '../../test/fixtures/plan-cost.jsonl'), join(out, 'cost/a.jsonl'));
    expect(await readPlanCost(out)).toBe('0.0145');
    expect(await readPlanCost(out)).toBe('0.0145');
  });

  test('counts a callId only once across ledger files', async () => {
    const out = await ledger({
      'a.jsonl': '{"callId":"same","costUsd":0.0044}\n',
      'b.jsonl': '{"callId":"same","costUsd":0.0044}\n{"callId":"other","costUsd":0.01}',
    });
    expect(await readPlanCost(out)).toBe('0.0144');
  });

  test('missing or empty ledgers report zero', async () => {
    expect(await readPlanCost(await tmp.make('no-cost'))).toBe('0.0000');
    expect(await readPlanCost(await ledger())).toBe('0.0000');
  });

  test('ignores blank, malformed and invalid cost rows without losing valid spend', async () => {
    const out = await ledger({ 'a.jsonl': '\nnot json\nnull\n[]\n{"costUsd":-1}\n{"costUsd":"5"}\n{"costUsd":1e309}\n{"costUsd":0.0044}\n{"costUsd":0.01' });
    expect(await readPlanCost(out)).toBe('0.0044');
  });

  test('omits totals outside the snapshot cost range', async () => {
    expect(await readPlanCost(await ledger({ 'a.jsonl': '{"costUsd":100000000}\n' }))).toBeUndefined();
  });
});
