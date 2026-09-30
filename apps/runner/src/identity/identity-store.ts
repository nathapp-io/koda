import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface RunnerIdentityFile {
  readonly runnerId: string;
  readonly apiKey: string;
  readonly serverUrl: string;
  readonly name: string;
  readonly enrolledAt: string;
}

const FIELDS = ['runnerId', 'apiKey', 'serverUrl', 'name', 'enrolledAt'] as const;

export async function readIdentity(path: string): Promise<RunnerIdentityFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdentityError(`${path} is not valid JSON`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || FIELDS.some((f) => typeof record[f] !== 'string' || record[f] === '')) {
    throw new IdentityError(`${path} is not a runner identity`);
  }
  await chmod(path, 0o600).catch(() => undefined);
  return { runnerId: record['runnerId'] as string, apiKey: record['apiKey'] as string, serverUrl: record['serverUrl'] as string, name: record['name'] as string, enrolledAt: record['enrolledAt'] as string };
}

export async function writeIdentity(path: string, identity: RunnerIdentityFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export function newBootId(): string {
  return randomUUID();
}
