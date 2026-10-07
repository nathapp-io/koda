/** Fleet S3 §1, §3: config edit and drift jobs. The API mirrors the runtime values in apps/api/src/fleet/common/config-jobs.ts. */
export const CONFIG_JOB_KINDS = ['CONFIG_EDIT', 'CONFIG_DRIFT'] as const;
export type ConfigJobKind = (typeof CONFIG_JOB_KINDS)[number];

export function isConfigKind(command: string): command is ConfigJobKind {
  return (CONFIG_JOB_KINDS as readonly string[]).includes(command);
}

export type ConfigEditMode = 'edit' | 'regenerate' | 'drift';

/** `baseSha` is the git blob SHA the file was loaded at, or null for a file that did not exist. */
export interface ConfigFileEdit { path: string; op: 'put' | 'delete'; content?: string; baseSha: string | null }

/** `GET /fleet/runner/jobs/:jobId/config-edit` (spec §3). */
export interface ConfigEditPayload { mode: ConfigEditMode; edits: ConfigFileEdit[]; prTitle: string | null; prBody: string | null; baseSha: string }

export type ConfigJobOutcome = 'ok' | 'no_changes' | 'drift' | 'conflict' | 'invalid' | 'push_failed' | 'pr_failed' | 'timeout';

/** These end COMPLETED; every other outcome ends FAILED with stateReason = outcome (D471). */
export const CONFIG_COMPLETED_OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift'];

/** Every outcome a config job may report (spec §3); the COMPLETED prefix above is a subset. */
export const CONFIG_JOB_OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'];

/** Rides the snapshot event (D475). */
export interface ConfigJobResult { outcome: ConfigJobOutcome; files?: string[]; output?: string }

export const CONFIG_RESULT_LIMITS = { maxFiles: 50, maxFileChars: 512, maxOutputBytes: 8_192 } as const;
