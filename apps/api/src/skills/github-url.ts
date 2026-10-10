import { ValidationAppException } from '@nathapp/nestjs-common';

/** Built by concatenation, never a template literal (see vcs/provider-construction-sites.spec.ts). */
const GITHUB_WEB_BASE = 'https://github.com/';

const URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
/** `.` and `..` are path traversal; `.git` alone would strip to an empty repo name. */
const DOT_SEGMENTS = new Set(['.', '..', '.git']);

/**
 * Accepts only `https://github.com/<owner>/<repo>` with an optional trailing `.git` or `/`.
 * Returns the owner and repo lowercased, and the normalized web URL.
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string; gitUrl: string } {
  const match = URL_PATTERN.exec(url);
  if (!match) throw unsupportedHost();
  const owner = match[1];
  const repo = match[2];
  if (!isValidSegment(owner) || !isValidSegment(repo)) throw unsupportedHost();
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    gitUrl: GITHUB_WEB_BASE + normalizedOwner + '/' + normalizedRepo,
  };
}

function isValidSegment(segment: string): boolean {
  return SEGMENT_PATTERN.test(segment) && !DOT_SEGMENTS.has(segment);
}

function unsupportedHost(): ValidationAppException {
  return new ValidationAppException({}, 'skills.unsupportedHost');
}
