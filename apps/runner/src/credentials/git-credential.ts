// apps/runner/src/credentials/git-credential.ts
import { createConnection } from 'node:net';
import type { CredentialReply } from './cred-server';

/** Longer than the server's own wait for a token (D79, 30 s), so the server's answer wins. */
export const CLIENT_TIMEOUT_MS = 40_000;
const MAX_REPLY_BYTES = 16_384;
const REPLY_FIELDS = ['username', 'token', 'expiresAt', 'protocol', 'host'] as const;

export function parseReply(text: string): CredentialReply {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>;
    if (value['ok'] === true && REPLY_FIELDS.every((field) => typeof value[field] === 'string')) {
      const [username, token, expiresAt, protocol, host] = REPLY_FIELDS.map((field) => value[field] as string);
      return { ok: true, username, token, expiresAt, protocol, host };
    }
    if (value['ok'] === false && typeof value['reason'] === 'string') return { ok: false, reason: value['reason'] };
  } catch {
    // fall through: not JSON
  }
  return { ok: false, reason: 'bad reply' };
}

/** D79: one `get` line, one JSON reply. Every failure is a reply, never a throw. */
export function requestCredential(path: string, timeoutMs: number = CLIENT_TIMEOUT_MS): Promise<CredentialReply> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let out = '';
    let done = false;
    const finish = (value: CredentialReply): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write('get\n'));
    socket.on('data', (chunk: string) => {
      out += chunk;
      if (Buffer.byteLength(out, 'utf8') > MAX_REPLY_BYTES) finish({ ok: false, reason: 'reply too large' });
    });
    socket.on('end', () => finish(parseReply(out)));
    socket.on('close', () => finish(parseReply(out)));   // a close without FIN must not wait for the timeout
    socket.on('error', () => finish({ ok: false, reason: 'unavailable' }));
  });
}

/** git-credential(1) input: `key=value` lines up to a blank line. */
export function parseCredentialInput(text: string): Readonly<Record<string, string>> {
  const lines = text.split('\n');
  const end = lines.indexOf('');
  return Object.fromEntries(
    (end < 0 ? lines : lines.slice(0, end))
      .filter((line) => line.indexOf('=') > 0)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
}

export interface GitCredIo {
  readonly readStdin: () => Promise<string>;
  readonly write: (text: string) => void;
  readonly request: (path: string) => Promise<CredentialReply>;
}

const SAFE = /^[^\n\r\0]+$/;

/**
 * `koda-runner git-cred <sock> <action>` (design §3.1, D80). git appends the action. Always exits 0: printing nothing
 * means "no credential"; git then authenticates with nothing and fails with its own authentication error.
 */
export async function runGitCred(args: readonly string[], io: GitCredIo): Promise<number> {
  try {
    const [sock, action] = args;
    const fields = parseCredentialInput(await io.readStdin());   // read first: git writes before it reads (no SIGPIPE)
    if (action !== 'get' || !sock) return 0;
    const reply = await io.request(sock);
    if (!reply.ok) return 0;
    if (fields['protocol'] !== reply.protocol || fields['host'] !== reply.host) return 0;
    if (!SAFE.test(reply.username) || !SAFE.test(reply.token)) return 0;
    io.write(`username=${reply.username}\npassword=${reply.token}\n`);
  } catch {
    // D80: the helper always exits 0; silence is "no credential", a throw would fail git's whole helper chain.
  }
  return 0;
}
