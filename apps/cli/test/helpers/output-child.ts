import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

type OutputReader = (stdout: Readable, stdin: Writable) => Promise<Buffer>;

export async function slowReader(stdout: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdout) {
    chunks.push(chunk);
    await delay(2);
  }
  return Buffer.concat(chunks);
}

export function outputFixture(routes: Record<string, unknown>, profiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'koda-cli-output-'));
  mkdirSync(join(dir, '.koda'));
  mkdirSync(join(dir, 'project'));
  writeFileSync(join(dir, '.koda/config.json'), JSON.stringify({ profiles }));
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(routes));

  async function run(
    args: string[], reader?: OutputReader,
    options: { waitForRoute?: string; limitFileSize?: boolean } = {},
  ) {
    const file = join(dir, 'stdout');
    const fd = reader ? undefined : openSync(file, 'w');
    try {
      const nodeArgs = [
        '--require', join(__dirname, 'output-api.cjs'), '--import', 'tsx',
        'src/index.ts', '--cwd', join(dir, 'project'), ...args,
      ];
      // POSIX shells express this limit in blocks of 512 or 1024 bytes.
      const [executable, ...argv] = options.limitFileSize
        ? ['/bin/sh', '-c', 'ulimit -f 64 || exit 125; exec "$@"', 'sh', process.execPath, ...nodeArgs]
        : [process.execPath, ...nodeArgs];
      const child = spawn(executable, argv, {
        cwd: resolve(__dirname, '../..'),
        stdio: ['pipe', fd ?? 'pipe', 'pipe'],
        timeout: 20000,
        env: {
          // The file-size cap must apply to the command output without truncating the loader cache.
          TSX_DISABLE_CACHE: options.limitFileSize ? '1' : undefined,
          PATH: process.env.PATH, NODE_ENV: 'test', KODA_API_URL: 'http://fixture.invalid',
          KODA_API_KEY: 'fixture-key', KODA_PROJECT_SLUG: 'sample', KODA_TEST_HOME: dir,
          KODA_TEST_RESPONSES: join(dir, 'responses.json'), KODA_TEST_WAIT_FOR_READER: options.waitForRoute,
        },
      });
      const errors: Buffer[] = [];
      child.stderr!.on('data', chunk => errors.push(chunk));
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      try {
        const [code, piped] = await Promise.all([closed, reader?.(child.stdout!, child.stdin!)]);
        return { code, stdout: piped ?? readFileSync(file), stderr: Buffer.concat(errors).toString() };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
