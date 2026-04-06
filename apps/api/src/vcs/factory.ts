import { ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from './vcs-provider';
import { GitHubProvider } from './providers/github.provider';

/**
 * HTTP client interface for making requests
 */
export interface HttpClient {
  get(url: string, config: { headers: Record<string, string>; params?: Record<string, unknown> }): Promise<{ data: unknown }>;
  post(url: string, config: { headers: Record<string, string>; body: unknown }): Promise<{ data: unknown }>;
}

/**
 * Configuration for creating a VCS provider
 */
export interface VcsProviderConfig {
  provider: string;
  token: string;
  repoUrl: string;
  [key: string]: unknown;
  httpClient?: HttpClient;
}

/**
 * Create a default HTTP client using native fetch API
 */
function createDefaultHttpClient(): HttpClient {
  return {
    async get(url: string, config: { headers: Record<string, string>; params?: Record<string, unknown> }): Promise<{ data: unknown }> {
      const urlObj = new URL(url);
      if (config.params) {
        Object.entries(config.params).forEach(([key, value]) => {
          urlObj.searchParams.append(key, String(value));
        });
      }

      const response = await fetch(urlObj.toString(), {
        method: 'GET',
        headers: config.headers,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        (error as unknown as Record<string, unknown>).response = { status: response.status };
        throw error;
      }

      const data = await response.json();
      return { data };
    },
    async post(url: string, config: { headers: Record<string, string>; body: unknown }): Promise<{ data: unknown }> {
      const response = await fetch(url, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify(config.body),
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        (error as unknown as Record<string, unknown>).response = { status: response.status };
        throw error;
      }

      const data = await response.json();
      return { data };
    },
  };
}

/**
 * Factory function to create VCS provider instances
 */
export function createVcsProvider(
  providerType: string | null | undefined,
  config: VcsProviderConfig,
): IVcsProvider {
  if (!providerType || typeof providerType !== 'string') {
    throw new ValidationAppException({}, 'vcs');
  }

  if (providerType.toLowerCase() === 'github') {
    // Parse repoUrl to extract owner and repo
    // Expected format: https://github.com/owner/repo
    const urlMatch = config.repoUrl?.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    const repoOwner = urlMatch[1];
    const repoName = urlMatch[2];

    if (!repoOwner || !repoName) {
      throw new ValidationAppException({}, 'vcs');
    }

    // Create a default HTTP client using fetch
    let httpClient = config.httpClient;
    if (!httpClient) {
      httpClient = createDefaultHttpClient();
    }

    return new GitHubProvider(repoOwner, repoName, config.token, httpClient);
  }

  if (providerType.toLowerCase() === 'gitlab') {
    throw new ValidationAppException({}, 'vcs');
  }

  throw new ValidationAppException({}, 'vcs');
}
