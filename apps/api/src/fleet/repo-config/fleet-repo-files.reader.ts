import { NotFoundAppException } from '@nathapp/nestjs-common';
import { NAX_CONFIG_LIMITS, naxPathGroup } from '../common/nax-config-paths';
import type { NaxPathGroup } from '../common/nax-config-paths';
import type { ForgeFile, ForgeTreeEntry } from '../git-broker/forge-tree';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { ForgeErrorException, NaxFileUnreadableException, RepoUnreachableException } from './repo-config.exceptions';

export const FLEET_REPO_FILES_READER = Symbol('FLEET_REPO_FILES_READER');

export interface NaxFileEntry { path: string; size: number | null; blobSha: string; group: NaxPathGroup }
export interface NaxFileList { baseSha: string; defaultBranch: string; files: NaxFileEntry[] }
export interface NaxFileContent { path: string; blobSha: string; content: string }

/** Fleet S3 §4.1: reads a fleet repo's allowlisted `.nax/` files through the forge API; no caching (D468). */
export interface FleetRepoFilesReader {
  list(repo: FleetRepoRef): Promise<NaxFileList>;
  /** `ref` is the commit the list call returned as baseSha. 404 when the file is absent at that ref. */
  read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent>;
}

const GROUP_ORDER: readonly NaxPathGroup[] = ['rules', 'context', 'config', 'profiles', 'constitution'];

export function toNaxEntries(entries: readonly ForgeTreeEntry[]): NaxFileEntry[] {
  return entries
    .flatMap((e): NaxFileEntry[] => {
      const group = e.type === 'blob' ? naxPathGroup(e.path) : null;
      return group ? [{ path: e.path, size: e.size, blobSha: e.sha, group }] : [];
    })
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.path.localeCompare(b.path));
}

export function decodeNaxFile(path: string, file: ForgeFile): NaxFileContent {
  if (file.content.length > NAX_CONFIG_LIMITS.maxFileBytes) throw new NaxFileUnreadableException('too_large');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    throw new NaxFileUnreadableException('not_text');
  }
  if (content.includes('\u0000')) throw new NaxFileUnreadableException('not_text');
  return { path, blobSha: file.sha, content };
}

const FORGE_DOWN = new Set(['provider_error', 'provider_unreachable']);

/** Maps forge/token failures: access problems -> 409 repo_unreachable, forge faults -> 502 (spec §4.1). */
export async function forgeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RepoCheckException) {
      throw FORGE_DOWN.has(error.reason) ? new ForgeErrorException() : new RepoUnreachableException(error.reason);
    }
    throw error;
  }
}

export function fileNotFound(): NotFoundAppException {
  return new NotFoundAppException({}, 'fleet.naxFile');
}
