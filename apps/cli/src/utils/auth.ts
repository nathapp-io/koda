import { resolveContext } from '../config';

export interface AuthResolution {
  apiKey: string;
  apiUrl: string;
}

/**
 * @deprecated Use `resolveContext` from `config.ts` for full precedence
 * (flags → env → local `.koda/config.json` → profile → global). This shim
 * remains so existing call sites keep working, but its precedence is now
 * identical to `resolveContext` — fixing CLI-02 where it previously
 * skipped project config and profiles.
 */
export async function resolveAuth(options: {
  apiKey?: string;
  apiUrl?: string;
}): Promise<AuthResolution> {
  const { apiKey, apiUrl } = await resolveContext({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
  });
  return { apiKey, apiUrl };
}
