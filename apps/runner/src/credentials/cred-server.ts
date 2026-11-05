// apps/runner/src/credentials/cred-server.ts
import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

export type CredentialReply =
  | { ok: true; username: string; token: string; expiresAt: string; protocol: string; host: string }
  | { ok: false; reason: string };

/**
 * US-008: what a provider-key socket answers for one provider. `expiresAt` is epoch milliseconds (the sync wire
 * carries ISO); `account` is the nax account label the key is stored under.
 */
export type ProviderReply =
  | { ok: true; key: string; expiresAt: number; account: string }
  | { ok: false; reason: 'none' | 'revoked' | 'error' | 'bad request' };

/** D79: `get\n` is 4 bytes and `provider <id>\n` at most 58; anything this long without a newline is not a client of ours. */
export const MAX_REQUEST_BYTES = 64;

/** A nax provider id (spec US-006): the same rule the API validates a request with. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

const PROVIDER_PREFIX = 'provider ';

/**
 * The connection a request line arrives on. A `node:net` Socket satisfies it, and so does a test's stand-in: the line
 * protocol is the part worth testing, and a nax sandbox forbids binding a socket at all.
 */
export interface RequestSocket {
  setEncoding(encoding: 'utf8'): void;
  on(event: 'error' | 'data', listener: (chunk: string) => void): unknown;
  end(reply: string): unknown;
}

interface Replies<T> {
  readonly badRequest: T;
  readonly error: T;
}

/**
 * One request line in, one JSON reply line out (D79). `request` answers a line or returns null when the line is not
 * one this socket speaks; a rejection answers `error` and never the error's message: it could carry a token.
 */
export function serveRequest<T>(socket: RequestSocket, request: (line: string) => Promise<T> | null, replies: Replies<T>): void {
  let buffered = '';
  let answered = false;
  const answer = (value: T): void => {
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
      if (Buffer.byteLength(buffered, 'utf8') > MAX_REQUEST_BYTES) answer(replies.badRequest);
      return;
    }
    const pending = request(buffered.slice(0, newline).trim());
    if (pending === null) {
      answer(replies.badRequest);
      return;
    }
    pending.then(answer, () => answer(replies.error));
  });
}

type CredentialReplies = Replies<CredentialReply>;
type ProviderReplies = Replies<ProviderReply>;

const CREDENTIAL_REPLIES: CredentialReplies = { badRequest: { ok: false, reason: 'bad request' }, error: { ok: false, reason: 'error' } };
const PROVIDER_REPLIES: ProviderReplies = { badRequest: { ok: false, reason: 'bad request' }, error: { ok: false, reason: 'error' } };

/** The git-only protocol (D79): `get\n` and nothing else. */
export function serveCredentialRequests(socket: RequestSocket, reply: () => Promise<CredentialReply>): void {
  serveRequest(socket, (line) => (line === 'get' ? reply() : null), CREDENTIAL_REPLIES);
}

/** US-008: `provider <providerId>\n` and nothing else; an id that does not match is a bad request, never a lookup. */
export function serveProviderRequests(socket: RequestSocket, providerReply: (providerId: string) => Promise<ProviderReply>): void {
  serveRequest(socket, (line) => {
    if (!line.startsWith(PROVIDER_PREFIX)) return null;
    const providerId = line.slice(PROVIDER_PREFIX.length);
    return PROVIDER_ID_PATTERN.test(providerId) ? providerReply(providerId) : null;
  }, PROVIDER_REPLIES);
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
    return CredentialServer.bind(path, (socket) => serveCredentialRequests(socket, reply));
  }

  /** US-008: a job's provider-key socket, separate from its git credential socket and open for the whole job. */
  static async listenProviderKeys(path: string, providerReply: (providerId: string) => Promise<ProviderReply>): Promise<CredentialServer> {
    return CredentialServer.bind(path, (socket) => serveProviderRequests(socket, providerReply));
  }

  private static async bind(path: string, accept: (socket: Socket) => void): Promise<CredentialServer> {
    const open = new Set<Socket>();
    const server = createServer((socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      accept(socket);
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
