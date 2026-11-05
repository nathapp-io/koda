// apps/runner/src/credentials/provider-cred.ts
import { createConnection } from 'node:net';
import { PROVIDER_ID_PATTERN } from './cred-server';

/**
 * US-009: the environment entry that points nax's exec helper at the job's provider-key socket. Only the socket path
 * ever reaches nax's environment or argv — never a key (design §5.4, §6).
 */
export const PROVIDER_CRED_SOCKET_ENV = 'KODA_PROVIDER_CRED_SOCKET';

/**
 * nax kills the helper at its `timeoutMs` (60000, its schema maximum) and the socket holds a reply open for at most
 * 55 s (`PROVIDER_KEY_WAIT_MS`), so the helper's own bound sits between the two: a wedged socket ends with our line
 * before nax's own kill, which would leave no explanation in nax's diagnostic.
 */
export const PROVIDER_CRED_TIMEOUT_MS = 57_000;

/**
 * The most a socket reply may occupy before it is called unusable. It must fit every reply nax's helper schema accepts,
 * not just a plain-ASCII one: an 8192-character key serialized with JSON escapes (`\u0000`, 6 bytes per character) is
 * 49 152 bytes, plus a 200-character account, so nax's own 64 KiB helper-output limit is the bound — and the buffer
 * stays bounded at it.
 */
export const MAX_PROVIDER_REPLY_BYTES = 65_536;
/** nax's helper schema (`helper-protocol`): a longer key or account is a reply nax refuses. */
const MAX_KEY_CHARS = 8_192;
const MAX_ACCOUNT_CHARS = 200;

/** True once the answer read so far cannot be a reply nax's schema would accept (a socket that never ends is not ours). */
export function replyTooLarge(buffered: string): boolean {
  return Buffer.byteLength(buffered, 'utf8') > MAX_PROVIDER_REPLY_BYTES;
}
const DECLINE = { version: 1, decline: true } as const;

/** What the job's socket answers, plus the failures only the client can see (the socket is gone, or unusable). */
export type ProviderCredReply =
  | { readonly ok: true; readonly key: string; readonly expiresAt: number; readonly account: string }
  | { readonly ok: false; readonly reason: 'none' | 'revoked' | 'error' | 'bad request' | 'unavailable' | 'timeout' | 'reply too large' | 'bad reply' };

/**
 * One line of nax's helper answer, one JSON reply. Every failure is a reply, never a throw: the caller decides
 * whether silence or a failure is right, and a thrown error would escape as an unhandled rejection with no code.
 */
export function parseProviderReply(text: string): ProviderCredReply {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>;
    if (value['ok'] === true && typeof value['key'] === 'string' && typeof value['expiresAt'] === 'number' && typeof value['account'] === 'string') {
      return { ok: true, key: value['key'], expiresAt: value['expiresAt'], account: value['account'] };
    }
    if (value['ok'] === false && (value['reason'] === 'none' || value['reason'] === 'revoked' || value['reason'] === 'error' || value['reason'] === 'bad request')) {
      return { ok: false, reason: value['reason'] };
    }
  } catch {
    // fall through: not JSON
  }
  return { ok: false, reason: 'bad reply' };
}

/** `provider <providerId>\n`, the same line `CredentialServer.listenProviderKeys` answers (US-008). */
export function requestProviderKey(path: string, providerId: string, timeoutMs: number = PROVIDER_CRED_TIMEOUT_MS): Promise<ProviderCredReply> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let out = '';
    let done = false;
    const finish = (value: ProviderCredReply): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`provider ${providerId}\n`));
    socket.on('data', (chunk: string) => {
      out += chunk;
      if (replyTooLarge(out)) finish({ ok: false, reason: 'reply too large' });
    });
    socket.on('end', () => finish(parseProviderReply(out)));
    socket.on('close', () => finish(parseProviderReply(out)));   // a close without FIN must not wait for the timeout
    socket.on('error', () => finish({ ok: false, reason: 'unavailable' }));
  });
}

export type ParsedProviderRequest = { readonly ok: true; readonly providerId: string } | { readonly ok: false };

/** nax's `{"version":1,"providerId":"<id>"}`; anything else is not a request this helper may forward. */
export function parseProviderRequest(text: string): ParsedProviderRequest {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>;
    if (value['version'] !== 1) return { ok: false };
    const providerId = value['providerId'];
    return typeof providerId === 'string' && PROVIDER_ID_PATTERN.test(providerId) ? { ok: true, providerId } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface ProviderCredIo {
  readonly readStdin: () => Promise<string>;
  readonly write: (text: string) => void;
  /** One line to stderr, without its newline. */
  readonly warn: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly request: (path: string, providerId: string) => Promise<ProviderCredReply>;
}

/** Why the helper exits non-zero, in a fixed vocabulary: a reason a human reads, never a value from the reply. */
const FAILURE_LINES: Readonly<Record<string, string>> = {
  revoked: 'koda provider key unavailable: the key was disabled or deleted',
  error: 'koda provider key unavailable: the runner could not resolve a key',
  'bad request': 'koda provider key unavailable: the runner refused the request',
  unavailable: 'koda provider key unavailable: the job\'s provider-key socket is not reachable',
  timeout: 'koda provider key unavailable: the job\'s provider-key socket did not answer in time',
  'reply too large': 'koda provider key unavailable: the job\'s provider-key socket sent an unusable reply',
  'bad reply': 'koda provider key unavailable: the job\'s provider-key socket sent an unusable reply',
};
const OVERSIZED_LINE = 'koda provider key unavailable: the key does not fit nax\'s helper schema';
const REQUEST_LINE = 'koda-runner provider-cred: not a nax provider request';
const ACTION_LINE = 'koda-runner provider-cred: only the "get" action is supported';
const SOCKET_ARG_LINE = 'koda-runner provider-cred: --socket needs a path';

/** `--socket <path>` before the action (US-011 passes it for a thread session); the environment is the default. */
function socketFrom(args: readonly string[]): { readonly action: string | undefined; readonly socket: string | undefined } | null {
  let socket: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--socket') {
      socket = args[i + 1];
      i += 1;
      if (socket === undefined || socket === '') return null;   // a flag without its path is a usage error
      continue;
    }
    rest.push(args[i] as string);
  }
  return { action: rest[0], socket };
}

/** The reply nax accepts for a granted key, or null when it would not fit nax's schema. */
function apiKeyLine(reply: Extract<ProviderCredReply, { ok: true }>): string | null {
  if (reply.key.length > MAX_KEY_CHARS || reply.account.length > MAX_ACCOUNT_CHARS || !Number.isFinite(reply.expiresAt)) return null;
  return `${JSON.stringify({ version: 1, kind: 'api-key', key: reply.key, expiresAt: reply.expiresAt, account: reply.account })}\n`;
}

/**
 * US-009: `koda-runner provider-cred [--socket <path>] get` — the exec helper nax calls for a model key (design §5.4).
 * stdin is nax's request, stdout its one-line answer. A helper with no socket (someone ran nax by hand on the machine)
 * and a job koda holds no key for both decline, so nax uses the machine's own credentials file; a job that lost its
 * socket, a revoked key and a runner error exit non-zero, so a running job fails loudly instead of switching identity.
 */
export async function runProviderCred(args: readonly string[], io: ProviderCredIo): Promise<number> {
  const fail = (line: string): number => {
    io.warn(line);
    return 1;
  };
  // Read stdin before anything can exit: nax writes its request before it reads, and an early exit would be SIGPIPE.
  const stdin = await io.readStdin().catch(() => '');
  const parsed = socketFrom(args);
  if (parsed === null) return fail(SOCKET_ARG_LINE);
  if (parsed.action !== 'get') return fail(ACTION_LINE);
  const socket = parsed.socket ?? io.env[PROVIDER_CRED_SOCKET_ENV];
  if (socket === undefined || socket === '') {
    io.write(`${JSON.stringify(DECLINE)}\n`);
    return 0;
  }
  const request = parseProviderRequest(stdin);
  if (!request.ok) return fail(REQUEST_LINE);
  let reply: ProviderCredReply;
  try {
    reply = await io.request(socket, request.providerId);
  } catch {
    reply = { ok: false, reason: 'unavailable' };   // a client that throws is an unreachable socket, never a decline
  }
  if (reply.ok) {
    const line = apiKeyLine(reply);
    if (line === null) return fail(OVERSIZED_LINE);
    io.write(line);
    return 0;
  }
  if (reply.reason === 'none') {
    io.write(`${JSON.stringify(DECLINE)}\n`);
    return 0;
  }
  return fail(FAILURE_LINES[reply.reason] ?? FAILURE_LINES['bad reply'] as string);
}
