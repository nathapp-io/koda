import { setTimeout as delay } from 'node:timers/promises';
import { outputFixture, slowReader } from '../../test/helpers/output-child';

jest.setTimeout(30000);

const logs = '/api/projects/sample/fleet/jobs/job-1/logs';
const entries = logs + '/run/entries?cursor=';
const first = { text: 'first log entry' };
const final = { text: '終'.repeat(800000) + ' last log entry' };
const firstLine = JSON.stringify(first) + '\n';
const expected = Buffer.from(firstLine + JSON.stringify(final) + '\n');

it.each([false, true])('delivers both NDJSON pages on completion (follow=%s)', async follow => {
  const fixture = outputFixture({
    [logs]: { ret: 0, data: { attempts: [{ leaseEpoch: 1 }] } },
    [entries + '0']: { ret: 0, data: { entries: [first], nextCursor: 1, atEnd: follow, complete: false } },
    [entries + '1']: { ret: 0, data: { entries: [final], nextCursor: 2, atEnd: true, complete: true } },
  });
  try {
    const args = ['fleet', 'job', 'logs', 'job-1', '--json'];
    if (follow) args.push('--follow');
    const result = await fixture.run(args, follow ? async (stdout, stdin) => {
      const chunks: Buffer[] = [];
      let firstBytes = 0;
      for await (const chunk of stdout) {
        chunks.push(chunk);
        if (firstBytes < Buffer.byteLength(firstLine)) {
          firstBytes += chunk.length;
          if (firstBytes >= Buffer.byteLength(firstLine)) {
            expect(Buffer.concat(chunks).toString()).toBe(firstLine);
            stdin.end('deliver the final page');
          }
        }
        await delay(2);
      }
      return Buffer.concat(chunks);
    } : slowReader, follow ? entries + '1' : undefined);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(expected.length);
    expect(result.stdout.equals(expected)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

it('preserves exit 1 for an unreachable repository', async () => {
  const fixture = outputFixture({
    '/api/fleet/repos/fr1/check': { ret: 0, data: { repoId: 'fr1', reachable: false, reason: 'app_not_installed' } },
  });
  try {
    const result = await fixture.run(['fleet', 'repo', 'check', 'fr1', '--json'], slowReader);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ repoId: 'fr1', reachable: false });
  } finally {
    fixture.cleanup();
  }
});
