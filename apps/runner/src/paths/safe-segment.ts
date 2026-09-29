import { join, relative, resolve, sep } from 'node:path';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** nax validateFeatureName, as the server's FEATURE_RE (apps/api/src/fleet/jobs/dispatch-input.ts). */
const FEATURE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function assertSegment(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !SEGMENT.test(value) || value === '.' || value === '..') {
    throw new PathError(`invalid ${label}`);
  }
  return value;
}

/** A GitLab owner may be a group/subgroup path; every piece is a checked segment (D29). */
export function assertOwner(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new PathError('invalid owner');
  const parts = value.split('/');
  parts.forEach((part) => assertSegment('owner', part));
  if (parts[0].startsWith('.')) throw new PathError('invalid owner');
  return value;
}

export function assertFeature(value: unknown): string {
  if (typeof value !== 'string' || !FEATURE.test(value) || value.includes('..')) throw new PathError('invalid feature');
  return value;
}

export function assertRelativePath(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.startsWith('/') || value.startsWith('-') || /[\\\0]/.test(value)) {
    throw new PathError(`invalid ${label}`);
  }
  if (value.split('/').some((piece) => piece === '' || piece === '.' || piece === '..')) throw new PathError(`invalid ${label}`);
  return value;
}

export function repoDirFor(workspaceRoot: string, owner: string, name: string): string {
  return join(resolve(workspaceRoot), ...assertOwner(owner).split('/'), assertSegment('repo', name));
}

export function jobDirFor(workspaceRoot: string, jobId: string): string {
  return join(resolve(workspaceRoot), '.jobs', assertSegment('jobId', jobId));
}

export function featureDirFor(repoDir: string, feature: string): string {
  return join(repoDir, '.nax', 'features', assertFeature(feature));
}

export function assertInside(root: string, candidate: string): string {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) {
    throw new PathError('path escapes its root');
  }
  return resolve(candidate);
}
