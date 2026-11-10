import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
  join(__dirname, '../../../../..', '.github/workflows/ci.yml'),
  'utf8',
);

const shardBlock = (() => {
  const start = workflow.indexOf('  integration-shards:');
  if (start < 0) throw new Error('integration-shards job not found');
  const end = workflow.indexOf('\n  integration:', start);
  if (end < 0) throw new Error('integration aggregator job not found');
  return workflow.slice(start, end);
})();

describe('CI integration shard matrix', () => {
  it('lists exactly the shard indexes the denominator asks Vitest to run', () => {
    const shardList = shardBlock.match(/shard: \[([^\]]+)\]/)?.[1];
    const denominator = shardBlock.match(/shards: \[(\d+)\]/)?.[1];
    if (shardList === undefined) throw new Error('shard list not found');
    if (denominator === undefined) throw new Error('shard denominator not found');

    const indexes = shardList.split(',').map((value) => Number(value.trim()));
    const count = Number(denominator);
    expect(indexes).toEqual(Array.from({ length: count }, (_, index) => index + 1));
  });

  it('fails the job when the matrix job count does not match the denominator', () => {
    expect(shardBlock).toContain('name: Verify shard matrix');
    expect(shardBlock).toContain('strategy.job-total');
  });
});
