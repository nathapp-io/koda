import { resolveContext, ResolveContextFlags, ResolvedContext } from '../config';
import { configureApiClient } from './api-client';
import { handleApiError } from './error';

export interface WithContextOptions {
  /**
   * When false, a resolvable project slug is not required (commands that are
   * not project-scoped, e.g. auth me, agent me). Default: true.
   */
  requireProject?: boolean;
}

/**
 * BUG-7: one bootstrap for every command action.
 *
 * Performs the canonical context resolution in a single place instead of
 * ~40 duplicated copies across command modules:
 * - resolves project/api key/api url (flags → env → profile → global;
 *   H10: apiUrl/apiKey from project-local `.koda/config.json` are ignored)
 * - short-circuits with the correct config error + exit code when project
 *   (default) or API key is missing
 * - wires the generated client (base URL + Authorization header)
 */
export function withContext(
  flags: ResolveContextFlags,
): Promise<ResolvedContext & { projectSlug: string; apiKey: string }>;
export function withContext(
  flags: ResolveContextFlags,
  options: WithContextOptions & { requireProject: false },
): Promise<ResolvedContext & { apiKey: string }>;
export async function withContext(
  flags: ResolveContextFlags,
  options?: WithContextOptions,
): Promise<ResolvedContext> {
  const ctx = await resolveContext(flags);

  if (options?.requireProject !== false && !ctx.projectSlug) {
    handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
    // Defensive: handleApiError exits via process.exit, which tests mock
    // away (swallowing the exit) — never reached in production.
    throw new Error('Project not configured. Run: koda init');
  }

  if (!ctx.apiKey || !ctx.apiUrl) {
    handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
    throw new Error('API key or URL not configured. Run: koda login --api-key <key>');
  }

  configureApiClient(ctx.apiUrl.replace(/\/api\/?$/, ''), ctx.apiKey);

  return ctx;
}
