import { PassThrough } from 'stream';
import { resolveSecret, SecretInputError, SecretIo, SecretSpec } from './secret-input';

const SPEC: SecretSpec = { flag: '--token', label: 'VCS token', envVar: 'KODA_VCS_TOKEN' };

function makeIo(options: { tty?: boolean; env?: Record<string, string> } = {}) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: jest.Mock };
  if (options.tty) {
    stdin.isTTY = true;
    stdin.setRawMode = jest.fn();
  }
  const written: string[] = [];
  const exit = jest.fn();
  const io: SecretIo = {
    stdin,
    stderr: { write: (chunk: string) => written.push(chunk) },
    env: options.env ?? {},
    exit: exit as unknown as (code: number) => never,
  };
  return { io, stdin, written, exit };
}

describe('resolveSecret', () => {
  it("reads '-' from stdin and trims the trailing newline", async () => {
    const { io, stdin } = makeIo();
    const pending = resolveSecret('-', SPEC, io);
    stdin.end('ghp_secret\n');
    await expect(pending).resolves.toBe('ghp_secret');
  });

  it("rejects an empty stdin for '-'", async () => {
    const { io, stdin } = makeIo();
    const pending = resolveSecret('-', SPEC, io);
    stdin.end('\n');
    await expect(pending).rejects.toThrow(SecretInputError);
  });

  it('prompts without echo on a TTY and restores the terminal', async () => {
    const { io, stdin, written } = makeIo({ tty: true });
    const pending = resolveSecret(true, SPEC, io);
    stdin.write('abcx');
    stdin.write('\u007f');
    stdin.write('d\r');
    await expect(pending).resolves.toBe('abcd');
    expect(written.join('')).toContain('VCS token: ');
    expect(written.join('')).not.toContain('abcd');
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('exits 130 and restores the terminal on Ctrl+C in the prompt', async () => {
    const { io, stdin, exit } = makeIo({ tty: true });
    void resolveSecret(true, SPEC, io);
    stdin.write('ab\u0003');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('refuses a bare flag when stdin is not a terminal', async () => {
    const { io } = makeIo();
    await expect(resolveSecret(true, SPEC, io)).rejects.toThrow("--token - or set KODA_VCS_TOKEN");
  });

  it('returns a literal value but warns on stderr', async () => {
    const { io, written } = makeIo();
    await expect(resolveSecret('ghp_literal', SPEC, io)).resolves.toBe('ghp_literal');
    expect(written.join('')).toContain('Warning: --token');
    expect(written.join('')).not.toContain('ghp_literal');
  });

  it('falls back to the environment variable when the flag is absent', async () => {
    const { io } = makeIo({ env: { KODA_VCS_TOKEN: 'from-env' } });
    await expect(resolveSecret(undefined, SPEC, io)).resolves.toBe('from-env');
  });

  it('ignores an empty environment variable', async () => {
    const { io } = makeIo({ env: { KODA_VCS_TOKEN: '' } });
    await expect(resolveSecret(undefined, SPEC, io)).resolves.toBeUndefined();
  });

  it('has no environment fallback when the spec names none', async () => {
    const { io } = makeIo({ env: { KODA_API_KEY: 'from-env' } });
    await expect(resolveSecret(undefined, { flag: '--api-key', label: 'API key' }, io)).resolves.toBeUndefined();
  });
});
