import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { KnowledgeIndexState, KnowledgeIndexStatus, KnowledgeProjectState, KnowledgeRepoRef } from './knowledge-index.domain';

/** `never` is the member-facing name for "no pass has run yet" — no `KnowledgeRepoIndex` row exists. */
export type KnowledgeRepoStatus = KnowledgeIndexStatus | 'never';

/** One repository of the project with its index state (1c-c-D12). Never carries a lease or provider secret. */
export class KnowledgeRepoStateDto {
  @ApiProperty() repoId: string;
  @ApiProperty() owner: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: 'Forge of the repository', enum: ['github', 'gitlab'] }) provider: KnowledgeRepoRef['provider'];
  @ApiProperty({ description: 'Index status, or `never` when no pass has run for this repository', enum: ['idle', 'running', 'failed', 'skipped', 'never'] }) status: KnowledgeRepoStatus;
  @ApiPropertyOptional({ description: 'Commit the last successful pass indexed; null before the first pass', nullable: true, type: String }) indexedSha: string | null;
  @ApiProperty({ description: 'Indexed files of the last finished pass' }) fileCount: number;
  @ApiProperty({ description: 'Chunks stored for those files' }) chunkCount: number;
  @ApiProperty({ description: 'Chunks stored without an embedding and retried on the next pass' }) unembeddedCount: number;
  @ApiProperty({ description: 'Files the allowlist skipped (too large, unsafe path, past the cap)' }) skippedCount: number;
  @ApiPropertyOptional({ description: 'Why the last pass failed or was skipped; null after a healthy pass', nullable: true, type: String }) lastError: string | null;
  @ApiPropertyOptional({ description: 'Start of the pass that wrote this state', nullable: true, type: String, format: 'date-time' }) startedAt: Date | null;
  @ApiPropertyOptional({ description: 'End of the last pass that wrote this state', nullable: true, type: String, format: 'date-time' }) finishedAt: Date | null;
}

/** `enabled` is the kill switch, so a client can word "indexing is off" without a second request. */
export class KnowledgeRepoStatesDto {
  @ApiProperty({ description: 'True when repository knowledge indexing is on' }) enabled: boolean;
  @ApiProperty({ type: [KnowledgeRepoStateDto] }) repos: KnowledgeRepoStateDto[];
}

export class KnowledgeReindexResultDto {
  @ApiProperty({ description: 'True when the pass was queued; a full queue answers true and drops it (1c-c-D10)' }) queued: boolean;
}

const ZEROED_STATE = {
  status: 'never' as KnowledgeRepoStatus,
  indexedSha: null,
  fileCount: 0,
  chunkCount: 0,
  unembeddedCount: 0,
  skippedCount: 0,
  lastError: null,
  startedAt: null,
  finishedAt: null,
};

/** Pure mapping from the domain pair to the response shape: `never` stands in for a missing state row. */
export function toKnowledgeRepoState({ repo, state }: KnowledgeProjectState): KnowledgeRepoStateDto {
  return {
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    provider: repo.provider,
    ...fromState(state),
  };
}

function fromState(state: KnowledgeIndexState | null): Omit<KnowledgeRepoStateDto, 'repoId' | 'owner' | 'name' | 'provider'> {
  if (state === null) return { ...ZEROED_STATE };
  return {
    status: state.status,
    indexedSha: state.indexedSha,
    fileCount: state.fileCount,
    chunkCount: state.chunkCount,
    unembeddedCount: state.unembeddedCount,
    skippedCount: state.skippedCount,
    lastError: state.lastError,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}
