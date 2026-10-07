/** Runtime mirror of packages/fleet-protocol/src/config-jobs.ts (fleet S3); nax-config-paths.spec.ts pins them equal. */
import type { ConfigJobKind, ConfigJobOutcome } from '@nathapp/fleet-protocol';

export type {
  ConfigEditMode, ConfigEditPayload, ConfigFileEdit, ConfigJobKind, ConfigJobOutcome, ConfigJobResult,
} from '@nathapp/fleet-protocol';

export const CONFIG_JOB_KINDS = ['CONFIG_EDIT', 'CONFIG_DRIFT'] as const;

export function isConfigKind(command: string): command is ConfigJobKind {
  return (CONFIG_JOB_KINDS as readonly string[]).includes(command);
}

export const CONFIG_COMPLETED_OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift'];

export const CONFIG_JOB_OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'];

export const CONFIG_RESULT_LIMITS = { maxFiles: 50, maxFileChars: 512, maxOutputBytes: 8_192 } as const;
