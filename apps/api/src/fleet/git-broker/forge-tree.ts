/** Fleet S3 §4.1: one entry of a forge tree listing. `sha` is the git object id (what `git rev-parse HEAD:<path>` prints). */
export interface ForgeTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  /** GitHub reports blob sizes; GitLab tree listings do not (null). */
  size: number | null;
}

export interface ForgeFile {
  sha: string;
  size: number;
  content: Buffer;
}
