import { afterAll, describe, expect, test } from 'bun:test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { IdentityError, newBootId, readIdentity, writeIdentity } from './identity-store';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const identity = { runnerId: 'r1', apiKey: 'kr_abc', serverUrl: 'https://koda.example.com', name: 'box-1', enrolledAt: '2026-10-01T00:00:00.000Z' };

describe('identity store', () => {
  test('a missing file reads as null', async () => {
    expect(await readIdentity(join(await tmp.make('id'), 'identity.json'))).toBeNull();
  });
  test('round-trips, creating the directory 0700 and the file 0600', async () => {
    const path = join(await tmp.make('id'), 'sub', 'identity.json');
    await writeIdentity(path, identity);
    expect(await readIdentity(path)).toEqual(identity);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
  });
  test('a loose mode is tightened on read', async () => {
    const path = join(await tmp.make('id'), 'identity.json');
    await writeIdentity(path, identity);
    await Bun.$`chmod 644 ${path}`;
    await readIdentity(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  test.each(['{', '[]', '{"runnerId":"r"}', '{"runnerId":1,"apiKey":"k","serverUrl":"u","name":"n","enrolledAt":"t"}'])('rejects a damaged file %j', async (text) => {
    const path = join(await tmp.make('id'), 'identity.json');
    await writeFile(path, text);
    await expect(readIdentity(path)).rejects.toBeInstanceOf(IdentityError);
  });
  test('boot ids are distinct uuids', () => {
    expect(newBootId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newBootId()).not.toBe(newBootId());
  });
});
