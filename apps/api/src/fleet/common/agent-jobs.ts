/** Structural mirrors of the agent job fields in @nathapp/fleet-protocol. */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AGENT_TASK_MAX_LENGTH = 16_384;
export const AGENT_MODEL_MAX_LENGTH = 200;
export const AGENT_MODEL_ALIAS_MAX_ENTRIES = 8;
export const AGENT_MODEL_ALIAS_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Mirrors nax's schemas-model-alias target grammar. */
export const AGENT_MODEL_ALIAS_TARGET_RE = /^(?:(?!acp:)[^\s/\x5B\x5D]+\/[^\s/\x5B\x5D]+(?:\[[^\s\x5B\x5D]+\])?|acp:(?:claude|codex|cursor)(?:\/[^\s/\x5B\x5D]+)?(?:\[[^\s\x5B\x5D]+\])?)$/;
export const AGENT_TIMEOUT_MIN_SEC = 60;
export const AGENT_TIMEOUT_MAX_SEC = 86_400;

/** Serialized result bounds; pinned to packages/fleet-protocol by protocol.spec.ts. */
export const AGENT_RESULT_LIMITS = {
  budgetBytes: 12_288,
  maxOutputBytes: 8_192,
  maxDeniedAsks: 10,
  maxAskChars: 500,
  maxToolChars: 128,
  maxModelChars: 200,
} as const;

/**
 * Every agent text field is stored in a jsonb column, and PostgreSQL answers SQLSTATE 22P05 ("unsupported Unicode
 * escape sequence") for U+0000 — a database error at insert, not a validation response. The config-edit
 * `content must be text` rule is the precedent. Kept as a string test rather than a `[^\u0000]` character class so the
 * skip is visible here, and so the mirrored grammar above stays exactly nax's.
 */
export const hasNul = (value: string): boolean => value.includes('\u0000');

export function isModelAliasTarget(value: unknown): value is string {
  return typeof value === 'string' && !hasNul(value) && AGENT_MODEL_ALIAS_TARGET_RE.test(value);
}

export interface AgentJobInput {
  name: string;
  task: string;
  model?: string;
  modelAliases?: Record<string, string>;
  timeoutSec?: number;
}

export type AgentDeniedAsk =
  | { kind: 'approval'; tool: string; summary: string }
  | { kind: 'question'; text: string };

export interface AgentJobResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  model?: string;
  output: string;
  truncated: boolean;
  deniedAsks: AgentDeniedAsk[];
  deniedAsksTruncated: boolean;
  costUsd?: string;
}
