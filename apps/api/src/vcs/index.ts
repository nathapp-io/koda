/**
 * VCS Provider interface and type exports
 * This module contains the contracts for all VCS provider implementations
 */

export { IVcsProvider } from './vcs-provider';
export type { VcsIssue } from './types';
export type { VcsPullRequest, CreatePrParams } from './types';
export { VCS_REPOSITORY } from './domain/vcs.repository';
export type { IVcsRepository } from './domain/vcs.repository';
