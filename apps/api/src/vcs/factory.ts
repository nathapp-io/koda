import { ValidationAppException } from '@nathapp/nestjs-common';
import { IVcsProvider } from './vcs-provider';
import { GitHubProvider } from './providers/github.provider';

/**
 * Configuration for creating a VCS provider
 */
export interface VcsProviderConfig {
  provider: string;
  token: string;
  repoUrl: string;
  [key: string]: any;
}

/**
 * Factory function to create VCS provider instances
 */
export function createVcsProvider(
  providerType: string | null | undefined,
  config: VcsProviderConfig,
): IVcsProvider {
  if (!providerType || typeof providerType !== 'string') {
    throw new ValidationAppException('Provider type must be a non-empty string');
  }

  if (providerType.toLowerCase() === 'github') {
    // Parse repoUrl to extract owner and repo
    // Expected format: https://github.com/owner/repo
    const urlMatch = config.repoUrl?.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    const repoOwner = urlMatch[1];
    const repoName = urlMatch[2];

    if (!repoOwner || !repoName) {
      throw new ValidationAppException(
        'Invalid GitHub repository URL format. Expected: https://github.com/owner/repo',
      );
    }

    // Create a default HTTP client using axios
    let httpClient = config.httpClient;
    if (!httpClient) {
      try {
        // Dynamically import axios if httpClient not provided
        const axios = require('axios');
        httpClient = axios.create();
      } catch {
        throw new ValidationAppException('HTTP client not available for GitHub provider');
      }
    }

    return new GitHubProvider(repoOwner, repoName, config.token, httpClient);
  }

  if (providerType.toLowerCase() === 'gitlab') {
    throw new ValidationAppException('GitLab VCS provider is not yet supported');
  }

  throw new ValidationAppException(`Unsupported VCS provider: ${providerType}`);
}
