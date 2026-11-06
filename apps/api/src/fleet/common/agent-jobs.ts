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

export function isModelAliasTarget(value: unknown): value is string {
  return typeof value === 'string' && AGENT_MODEL_ALIAS_TARGET_RE.test(value);
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
