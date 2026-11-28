import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessCodeExtractor } from './child-process-code-extractor';
import { isNaxSandboxed } from '../../test/helpers/test-environment';

const root = mkdtempSync(join(tmpdir(), 'koda-extraction-child-'));
let fixtures = 0;

/** Writes a fixture child script and returns the command that runs it. */
function commandFor(source: string): string[] {
  const path = join(root, `fixture-${(fixtures += 1)}.cjs`);
  writeFileSync(path, source, 'utf8');
  return [process.execPath, path];
}

/** A child that records its process id and then never exits. */
function hangingCommand(pidFile: string): string[] {
  return commandFor(
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function goneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}

const echoResults = commandFor(`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { files } = JSON.parse(input);
  process.stdout.write(JSON.stringify({ results: files.map((file) => ({ path: file.path, symbols: [] })) }));
});
`);

describe.skipIf(isNaxSandboxed())('ChildProcessCodeExtractor', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('AC-5: answers one result per file in request order', async () => {
    const extractor = new ChildProcessCodeExtractor(echoResults);

    const extracted = await extractor.extract([
      { path: 'a.ts', content: 'A' },
      { path: 'b.ts', content: 'B' },
    ]);

    expect(extracted).toEqual([
      { path: 'a.ts', symbols: [] },
      { path: 'b.ts', symbols: [] },
    ]);
  });

  it('AC-6: rejects with reason spawn when the child cannot be spawned', async () => {
    const extractor = new ChildProcessCodeExtractor(['/nonexistent/koda-extraction-binary']);

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'spawn',
    });
  });

  it('rejects with reason spawn when the command cannot be run at all', async () => {
    const extractor = new ChildProcessCodeExtractor([]);

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'spawn',
    });
  });

  it('AC-7: rejects with reason exit when the child exits with a non-zero code', async () => {
    // A valid response before the bad exit code: only the exit status can explain the rejection.
    const extractor = new ChildProcessCodeExtractor(
      commandFor("process.stdout.write('{\"results\":[{\"path\":\"a.ts\",\"symbols\":[]}]}'); process.exit(3);"),
    );

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'exit',
    });
  });

  it('AC-8: kills a child that outlives timeoutMs and rejects with reason timeout', async () => {
    const extractor = new ChildProcessCodeExtractor(hangingCommand(join(root, 'ac-8.pid')), 2000);

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'timeout',
    });
  });

  it('AC-9: the killed child is gone within a second of the rejection', async () => {
    const pidFile = join(root, 'ac-9.pid');
    const extractor = new ChildProcessCodeExtractor(hangingCommand(pidFile), 2000);

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'timeout',
    });

    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await expect(goneWithin(pid, 1000)).resolves.toBe(true);
  });

  it('AC-10: rejects with reason protocol when the child answers something that is not JSON', async () => {
    const extractor = new ChildProcessCodeExtractor(commandFor("process.stdout.write('not json');"));

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'protocol',
    });
  });

  it('AC-11: rejects with reason protocol when the answer holds fewer results than files', async () => {
    const extractor = new ChildProcessCodeExtractor(
      commandFor('process.stdout.write(JSON.stringify({ results: [] }));'),
    );

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'protocol',
    });
  });

  it('AC-12: rejects with reason protocol when the answer has no results array', async () => {
    const extractor = new ChildProcessCodeExtractor(commandFor("process.stdout.write('{\"ok\":true}');"));

    await expect(extractor.extract([{ path: 'a.ts', content: 'A' }])).rejects.toMatchObject({
      name: 'CodeExtractionError',
      reason: 'protocol',
    });
  });

  it('AC-13: rejects with reason exit and raises no uncaught exception when the child is gone before its request is written', async () => {
    const extractor = new ChildProcessCodeExtractor(commandFor('process.exit(0);'));
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);

    try {
      await expect(
        extractor.extract([{ path: 'a.ts', content: 'x'.repeat(2_000_000) }]),
      ).rejects.toMatchObject({ name: 'CodeExtractionError', reason: 'exit' });
      // A stray stdin error is reported after the rejection: give it room to surface.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught).toEqual([]);
  });

  it('AC-14: a second extract starts its child only after the first one settled', async () => {
    const logFile = join(root, 'ac-14.log');
    const extractor = new ChildProcessCodeExtractor(
      commandFor(`
const { appendFileSync } = require('node:fs');
const log = ${JSON.stringify(logFile)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(log, 'start\\n');
  setTimeout(() => {
    appendFileSync(log, 'end\\n');
    const { files } = JSON.parse(input);
    process.stdout.write(JSON.stringify({ results: files.map((file) => ({ path: file.path, symbols: [] })) }));
  }, 300);
});
`),
    );

    const [first, second] = await Promise.all([
      extractor.extract([{ path: 'a.ts', content: 'A' }]),
      extractor.extract([{ path: 'b.ts', content: 'B' }]),
    ]);

    expect(first).toEqual([{ path: 'a.ts', symbols: [] }]);
    expect(second).toEqual([{ path: 'b.ts', symbols: [] }]);
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
  });

  it('runs the next extraction after a rejected one', async () => {
    const extractor = new ChildProcessCodeExtractor(
      commandFor(`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { files } = JSON.parse(input);
  if (files[0].path === 'bad.ts') process.exit(3);
  process.stdout.write(JSON.stringify({ results: files.map((file) => ({ path: file.path, symbols: [] })) }));
});
`),
    );

    const rejected = extractor.extract([{ path: 'bad.ts', content: 'B' }]);
    const accepted = extractor.extract([{ path: 'a.ts', content: 'A' }]);

    await expect(rejected).rejects.toMatchObject({ name: 'CodeExtractionError', reason: 'exit' });
    await expect(accepted).resolves.toEqual([{ path: 'a.ts', symbols: [] }]);
  });
});
