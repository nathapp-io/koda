import { sanitizeDiagnostic } from '../../diagnostics';
import { raiseIfInterrupted, type ProcResult } from './types';

export interface OpenPrInput {
  /** gh / glab in the clone, the job's shims first on PATH (D88), deadline bound (D484). */
  readonly run: (argv: readonly string[]) => Promise<ProcResult>;
  readonly provider: 'github' | 'gitlab';
  /** `owner/name`; a GitLab owner may be a group path. */
  readonly repoSlug: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string | null;
}

export type OpenPrResult = { ok: true; url: string } | { ok: false; output: string };

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

export function lastUrl(text: string): string | null {
  const candidate = text.match(URL_RE)?.at(-1);
  return candidate && URL.canParse(candidate) ? candidate : null;
}

async function existingUrl(input: OpenPrInput): Promise<string | null> {
  if (input.provider === 'github') {
    const view = await input.run(['gh', 'pr', 'view', input.head, '--repo', input.repoSlug, '--json', 'url', '--jq', '.url']);
    raiseIfInterrupted(view);
    return view.code === 0 ? lastUrl(view.stdout) : null;
  }
  const view = await input.run(['glab', 'mr', 'view', input.head, '--repo', input.repoSlug, '--output', 'json']);
  raiseIfInterrupted(view);
  if (view.code !== 0) return null;
  try {
    const doc = JSON.parse(view.stdout) as { web_url?: unknown };
    return typeof doc.web_url === 'string' ? lastUrl(doc.web_url) : null;
  } catch {
    return null;
  }
}

/**
 * S3 spec §5 step 8, D472: as nax's finish phase, through gh / glab. A retry after a crash finds the PR it opened
 * the first time. No footer: PrAttributionService comments on the PR.
 */
export async function openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
  const create = input.provider === 'github'
    ? ['gh', 'pr', 'create', '--repo', input.repoSlug, '--base', input.base, '--head', input.head, '--title', input.title, '--body', input.body ?? '']
    : ['glab', 'mr', 'create', '--repo', input.repoSlug, '--source-branch', input.head, '--target-branch', input.base, '--title', input.title, '--description', input.body ?? '', '--yes'];
  const created = await input.run(create);
  raiseIfInterrupted(created);
  const url = created.code === 0 ? lastUrl(created.stdout) : null;
  if (url) return { ok: true, url };
  const existing = await existingUrl(input);
  if (existing) return { ok: true, url: existing };
  const detail = sanitizeDiagnostic(`${create.slice(0, 3).join(' ')} failed (exit ${created.code}): ${created.stderr}${created.stdout}`).trim();
  return { ok: false, output: `${detail}\n(the branch is pushed; open the PR by hand)` };
}
