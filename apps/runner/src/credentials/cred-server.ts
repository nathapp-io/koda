// apps/runner/src/credentials/cred-server.ts
import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

export type CredentialReply =
  | { ok: true; username: string; token: string; expiresAt: string; protocol: string; host: string }
  | { ok: false; reason: string };

/** D79: `get\n` is 4 bytes; anything this long without a newline is not a client of ours. */
export const MAX_REQUEST_BYTES = 64;

function serve(socket: Socket, reply: () => Promise<CredentialReply>): void {
  let buffered = '';
  let answered = false;
  const answer = (value: CredentialReply): void => {
    if (answered) return;
    answered = true;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);   // a client that hangs up early is not our problem
  socket.on('data', (chunk: string) => {
    if (answered) return;
    buffered += chunk;
    const newline = buffered.indexOf('\n');
    if (newline < 0) {
      if (buffered.length > MAX_REQUEST_BYTES) answer({ ok: false, reason: 'bad request' });
      return;
    }
    if (buffered.slice(0, newline).trim() !== 'get') {
      answer({ ok: false, reason: 'bad request' });
      return;
    }
    // Never the error's message: it could carry a token (Global Constraints).
    reply().then(answer, () => answer({ ok: false, reason: 'error' }));
  });
}

/** One job's credential socket (design §3.1, D79). */
export class CredentialServer {
  private constructor(
    private readonly server: Server,
    private readonly open: Set<Socket>,
    readonly path: string,
    private readonly inode: number,
  ) {}

  /**
   * Listens on a private staging name in the same directory, makes it 0600, then renames it onto `path`. Closing a
   * node:net unix server unlinks the name it was bound to, so a server bound to `path` itself would delete a newer
   * server's socket when it closes late (a crashed daemon's servers close while the restarted one listens, D90).
   * The rename also replaces a stale file a dead daemon left at `path`.
   */
  static async listen(path: string, reply: () => Promise<CredentialReply>): Promise<CredentialServer> {
    const open = new Set<Socket>();
    const server = createServer((socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      serve(socket, reply);
    });
    const staging = join(dirname(path), `.${randomBytes(3).toString('hex')}`);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(staging, () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      await chmod(staging, 0o600);
      await rename(staging, path);
    } catch (error) {
      server.close();
      throw error;
    }
    return new CredentialServer(server, open, path, (await lstat(path)).ino);
  }

  /**
   * Ends every open connection (a reply still waiting for a token is dropped) and stops listening (which unlinks only
   * the staging name, long renamed away). The public file is removed only while its inode is still this server's, so a
   * newer server on the same path keeps its socket (D90).
   */
  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const current = await lstat(this.path).catch(() => null);
    if (current?.ino === this.inode) await rm(this.path, { force: true });
  }
}
