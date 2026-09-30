import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeForge, type FakeForge } from '../../../../api/test/helpers/fake-forge';

export interface Forge {
  readonly forge: FakeForge;
  readonly keyFile: string;
}

export const HARNESS_TOKEN = 'ghs_harness';

/** A local GitHub: the App installation, the repo and the token route the API's registration check calls (fleet-repos.integration.spec.ts). */
export async function startForge(dir: string): Promise<Forge> {
  const forge = await startFakeForge();
  await mkdir(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = join(dir, 'github-app.pem');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  forge.routes.set('GET /repos/acme/app/installation', () => ({ status: 200, body: { id: 77 } }));
  forge.routes.set('GET /repos/acme/app', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'main' } }));
  forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: HARNESS_TOKEN, expires_at: '2099-01-01T00:00:00Z' } }));
  return { forge, keyFile };
}
