import { EXIT_SIGINT } from './signals';

export interface SecretSpec {
  /** The option as the user types it, e.g. `--api-key`. */
  flag: string;
  /** Prompt label, e.g. `API key`. */
  label: string;
  /** Environment variable read when the flag is absent. Omit for no fallback. */
  envVar?: string;
}

export interface SecretIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stderr: { write(chunk: string): unknown };
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
}

export class SecretInputError extends Error {}

export const API_KEY_SECRET: SecretSpec = { flag: '--api-key', label: 'API key' };
export const LOGIN_API_KEY_SECRET: SecretSpec = { flag: '--api-key', label: 'API key', envVar: 'KODA_API_KEY' };
export const VCS_TOKEN_SECRET: SecretSpec = { flag: '--token', label: 'VCS token', envVar: 'KODA_VCS_TOKEN' };

const defaultIo = (): SecretIo => ({
  stdin: process.stdin,
  stderr: process.stderr,
  env: process.env,
  exit: (code: number) => process.exit(code),
});

/**
 * Resolve a secret option declared as `--flag [value]` without requiring the
 * secret on argv (where shell history and `ps` see it):
 *   --flag -        read stdin          --flag          hidden prompt (TTY only)
 *   (absent)        spec.envVar         --flag <value>  accepted, with a warning
 */
export async function resolveSecret(
  raw: string | boolean | undefined,
  spec: SecretSpec,
  io: SecretIo = defaultIo(),
): Promise<string | undefined> {
  if (raw === '-') return nonEmpty(await readAll(io.stdin), spec, 'stdin');
  if (raw === true) {
    if (!io.stdin.isTTY || !io.stdin.setRawMode) {
      throw new SecretInputError(
        `${spec.flag} needs a value when stdin is not a terminal: pipe it with ${spec.flag} -${spec.envVar ? ` or set ${spec.envVar}` : ''}`,
      );
    }
    return nonEmpty(await promptHidden(`${spec.label}: `, io), spec, 'the prompt');
  }
  if (typeof raw === 'string' && raw !== '') {
    io.stderr.write(
      `Warning: ${spec.flag} <value> puts the secret in shell history and process lists. ` +
        `Use ${spec.flag} - to read stdin, or ${spec.flag} alone to be prompted` +
        `${spec.envVar ? `, or set ${spec.envVar}` : ''}.\n`,
    );
    return raw;
  }
  const fromEnv = spec.envVar ? io.env[spec.envVar] : undefined;
  return fromEnv ? fromEnv : undefined;
}

function nonEmpty(value: string, spec: SecretSpec, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SecretInputError(`${spec.flag}: no value read from ${source}`);
  return trimmed;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

/** Read one line in raw mode without echo. Ctrl+C restores the terminal and exits 130. */
function promptHidden(prompt: string, io: SecretIo): Promise<string> {
  const { stdin } = io;
  io.stderr.write(prompt);
  stdin.setRawMode?.(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish();
          io.exit(EXIT_SIGINT);
          return;
        }
        if (char === '\r' || char === '\n' || char === '\u0004') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    const onError = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      finish();
      reject(new SecretInputError(`could not read the hidden prompt: ${message}`));
    };
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}
