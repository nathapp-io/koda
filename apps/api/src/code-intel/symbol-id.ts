/**
 * M13: a symbol's stored id. The project comes first, so two projects indexing
 * the same repository never share (and overwrite) a row.
 */
export function symbolFullId(projectId: string, repoId: string, file: string, localId: string): string {
  return `${projectId}:${repoId}:${file}::${localId}`;
}
