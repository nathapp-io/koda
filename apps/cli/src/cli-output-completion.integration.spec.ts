import { once } from 'node:events';
import { outputFixture, slowReader } from '../test/helpers/output-child';

jest.setTimeout(30000);

const longText = '文'.repeat(8000);
const rows = Array.from({ length: 100 }, (_, id) => ({ id, content: longText }));
const summary = {
  precisionAt5_avg: 0.1, precisionAt5_p50: 0.1, precisionAt5_p95: 0.1, totalQueries: 100,
  results: rows.map(row => ({ query: row.content, intent: 'search', precisionAt5: 0.1 })),
};
const profiles = Object.fromEntries(rows.map(row => [
  'profile-' + row.id, { apiUrl: 'https://example.invalid/' + longText, apiKey: 'fixture-key' },
]));

describe('ordinary CLI output', () => {
  let fixture: ReturnType<typeof outputFixture>;
  beforeAll(() => {
    fixture = outputFixture({
      '/api/projects/sample/kb/documents': { ret: 0, data: rows },
      '/api/projects/sample/kb/evaluate/retrieval': { ret: 0, data: summary },
    }, profiles);
  });
  afterAll(() => fixture.cleanup());

  it.each([
    { args: ['kb', 'list', '--json'], expected: JSON.stringify(rows, null, 2) + '\n' },
    { args: ['config', 'profile', 'list'], expected: 'Name\tApiUrl\n' + Object.entries(profiles)
      .map(([name, profile]) => name + '\t' + profile.apiUrl + '\n').join('') },
    { args: ['evaluate', '--json'], expected: JSON.stringify(summary, null, 2) + '\n' },
  ])('delivers $args completely to a slow reader', async ({ args, expected }) => {
    const file = await fixture.run(args);
    expect(file.stderr).toBe('');
    expect(file.code).toBe(0);
    expect(file.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(file.stdout.equals(Buffer.from(expected))).toBe(true);
    const pipe = await fixture.run(args, slowReader);
    expect(pipe.stderr).toBe('');
    expect(pipe.code).toBe(0);
    expect(pipe.stdout.length).toBe(file.stdout.length);
    expect(pipe.stdout.equals(file.stdout)).toBe(true);
  });

  const posixTest = process.platform === 'win32' ? it.skip : it;
  posixTest('reports a short regular-file write at the file size limit', async () => {
    const result = await fixture.run(['kb', 'list', '--json'], undefined, { limitFileSize: true });
    expect([32768, 65536]).toContain(result.stdout.length);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^Failed to write CLI output:/);
  });

  it('exits 1 if a consumer closes during a large JSON result', async () => {
    const result = await fixture.run(['kb', 'list', '--json'], async stdout => {
      await once(stdout, 'readable');
      stdout.destroy();
      return Buffer.alloc(0);
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^Failed to write CLI output:/);
  });
});
