import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { API_DIR } from './database';

export interface RunningApi {
  readonly url: string;
  output(): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** D39: the built API (`bunx turbo run build --filter=@nathapp/koda-api`), an explicit environment, no `.env` files. */
export async function startApi(env: Record<string, string>, cwd: string): Promise<RunningApi> {
  const entry = join(API_DIR, 'dist', 'main.js');
  if (!existsSync(entry)) throw new Error('apps/api/dist is missing; build it first: bunx turbo run build --filter=@nathapp/koda-api');
  const port = await freePort();
  const proc = Bun.spawn(['bun', '--no-env-file', entry], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: String(port), ...env },
  });
  let captured = '';
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) captured = (captured + decoder.decode(chunk)).slice(-20_000);
  };
  void collect(proc.stdout);
  void collect(proc.stderr);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`the API exited during start-up (${proc.exitCode}):\n${captured}`);
    try {
      if ((await fetch(`${url}/api/health`)).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`the API did not become healthy in 90 s:\n${captured}`);
    }
    await Bun.sleep(250);
  }
  return {
    url,
    output: () => captured,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => null)]);
      if (exited === null) proc.kill('SIGKILL');
    },
  };
}
