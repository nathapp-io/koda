import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialAuthConfig, CredentialsConfig } from '@nathapp/nax-agent';

const DEFAULT_AUTH: CredentialAuthConfig = { source: 'file', onChange: 'warn' };

function isAuthConfig(value: unknown): value is CredentialAuthConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  if ((auth.source !== 'file' && auth.source !== 'exec') || (auth.onChange !== 'warn' && auth.onChange !== 'refuse')) return false;
  if (auth.exec === undefined) return true;
  if (typeof auth.exec !== 'object' || auth.exec === null || Array.isArray(auth.exec)) return false;
  const exec = auth.exec as Record<string, unknown>;
  return Array.isArray(exec.command) && exec.command.every((item) => typeof item === 'string') &&
    typeof exec.timeoutMs === 'number' && Number.isFinite(exec.timeoutMs);
}

export function naxCredentialsConfig(naxHome: string): CredentialsConfig {
  return {
    configDir: () => naxHome,
    readAuthConfig: async () => {
      try {
        const config: unknown = JSON.parse(await readFile(join(naxHome, 'config.json'), 'utf8'));
        if (typeof config !== 'object' || config === null || Array.isArray(config)) return DEFAULT_AUTH;
        const auth = (config as Record<string, unknown>).auth;
        return isAuthConfig(auth) ? auth : DEFAULT_AUTH;
      } catch {
        return DEFAULT_AUTH;
      }
    },
  };
}
