import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../../../../..');
const manifests = ['docker-compose.yml', 'deployments/example/docker-compose.yml'] as const;
const work = mkdtempSync(join(tmpdir(), 'koda-compose-email-'));
const supplied = {
  SMTP_URL: 'smtps://synthetic-user:synthetic-password@mail.example.test:465',
  EMAIL_FROM: 'Koda <noreply@example.test>',
  WEB_PUBLIC_URL: 'https://app.example.test',
};
const credentials = {
  JWT_SECRET: 'synthetic-jwt-secret', JWT_REFRESH_SECRET: 'synthetic-refresh-secret',
  API_KEY_SECRET: 'synthetic-api-key-secret', POSTGRES_PASSWORD: 'synthetic-postgres-password',
};

afterAll(() => rmSync(work, { recursive: true, force: true }));

type Rendered = { services: Record<string, { environment?: Record<string, string> }> };
function render(manifest: string, label: string, values: Record<string, string>): Rendered {
  const envFile = join(work, `${label}.env`);
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
  // `docker compose` — the Compose v2 plugin — is what a GitHub runner ships. The legacy
  // `docker-compose` binary exists only where a desktop install adds it, so naming it fails
  // with ENOENT on CI. `DOCKER_CONFIG` stays inherited: the plugin is discovered through the
  // CLI configuration (desktop installs register it there), and rendering needs no daemon.
  const result = execFileSync('docker', ['compose', '-f', resolve(root, manifest), '--env-file', envFile, '-p', `koda-email-${label}`, 'config', '--format', 'json'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work },
    encoding: 'utf8',
  });
  return JSON.parse(result) as Rendered;
}

describe('Compose optional email configuration', () => {
  for (const [index, manifest] of manifests.entries()) {
    it(`renders optional mail settings only into api for ${manifest}`, () => {
      const configured = render(manifest, `configured-${index}`, { ...credentials, ...supplied, JWT_EXPIRES_IN: '5m' });
      const apiEnv = configured.services.api?.environment;
      expect(apiEnv).toMatchObject({ ...supplied, JWT_EXPIRES_IN: '5m' });
      expect(configured.services.web?.environment).not.toHaveProperty('SMTP_URL');
      expect(configured.services.postgres?.environment).not.toHaveProperty('SMTP_URL');

      const minimal = render(manifest, `minimal-${index}`, credentials);
      expect(minimal.services.api?.environment).toBeDefined();
      for (const name of Object.keys(supplied)) expect(minimal.services.api?.environment?.[name]).toBeFalsy();
      expect(minimal.services.web?.environment).not.toHaveProperty('SMTP_URL');
      expect(minimal.services.postgres?.environment).not.toHaveProperty('SMTP_URL');
    });

    it(`still requires JWT_SECRET for ${manifest}`, () => {
      let stderr = '';
      try {
        render(manifest, `missing-jwt-${index}`, {
          JWT_REFRESH_SECRET: credentials.JWT_REFRESH_SECRET,
          API_KEY_SECRET: credentials.API_KEY_SECRET,
          POSTGRES_PASSWORD: credentials.POSTGRES_PASSWORD,
        });
      } catch (error) {
        stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
        // An empty stderr means the CLI never ran (a missing binary, not a refused render):
        // fail with that error instead of an assertion that hides the real cause.
        if (!stderr) throw error;
      }
      expect(stderr).toContain('set JWT_SECRET');
    });
  }
});
