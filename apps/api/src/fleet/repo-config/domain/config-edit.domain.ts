import type { ConfigEditMode, ConfigFileEdit, ConfigJobResult } from '../../common/config-jobs';

export const CONFIG_EDIT_REPOSITORY = Symbol('CONFIG_EDIT_REPOSITORY');

export interface ConfigEditRecord {
  id: string;
  jobId: string;
  mode: ConfigEditMode;
  edits: ConfigFileEdit[];
  prTitle: string | null;
  prBody: string | null;
  baseSha: string;
  result: ConfigJobResult | null;
  createdAt: Date;
}

export type NewConfigEdit = Pick<ConfigEditRecord, 'jobId' | 'mode' | 'edits' | 'prTitle' | 'prBody' | 'baseSha'>;

export interface IConfigEditRepository {
  /** Inside the dispatch transaction. */
  create(data: NewConfigEdit): Promise<ConfigEditRecord>;
  findByJobId(jobId: string): Promise<ConfigEditRecord | null>;
}
